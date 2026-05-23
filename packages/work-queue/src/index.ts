import type { WorkFeedClient, WorkItem } from "@aguil/agents-tracker";
import type { WorkflowDefinition } from "@aguil/agents-workflow";
import {
  ensureIssueWorkspace,
  removeIssueWorkspace,
  type WorkspaceHooks,
} from "@aguil/agents-workspace";

export type RunAttemptStatus =
  | "preparing"
  | "running"
  | "succeeded"
  | "failed"
  | "retry_queued"
  | "released";

export interface RetryEntry {
  readonly issueId: string;
  readonly identifier: string;
  readonly attempt: number;
  readonly dueAtMs: number;
  readonly error: string | null;
}

export interface RunningEntry {
  readonly item: WorkItem;
  readonly workspacePath: string;
  readonly startedAtMs: number;
  readonly attempt: number | null;
  readonly workerKind: string;
}

export interface WorkQueueSnapshot {
  readonly running: readonly RunningEntry[];
  readonly retryQueue: readonly RetryEntry[];
  readonly claimedCount: number;
}

export type WorkQueueWorker = (input: {
  readonly item: WorkItem;
  readonly workspacePath: string;
  readonly attempt: number | null;
  readonly prompt: string;
}) => Promise<{
  readonly status: "succeeded" | "failed";
  readonly error?: string;
}>;

export interface WorkQueueOrchestratorOptions {
  readonly definition: WorkflowDefinition;
  readonly feeds: readonly WorkFeedClient[];
  readonly worker: WorkQueueWorker;
  readonly hooks?: WorkspaceHooks;
  readonly renderPrompt: (
    item: WorkItem,
    attempt: number | null,
  ) =>
    | { readonly ok: true; readonly prompt: string }
    | { readonly ok: false; readonly error: string };
  readonly now?: () => number;
  /** Abort implementation dispatches running longer than this (ms). */
  readonly implementationStallTimeoutMs?: number;
}

/** Poll-based scheduler (Symphony coordination layer; ADR 0003). */
export class WorkQueueOrchestrator {
  private readonly running = new Map<string, RunningEntry>();
  private readonly claimed = new Set<string>();
  private readonly retryAttempts = new Map<string, RetryEntry>();
  private readonly completed = new Set<string>();
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly options: WorkQueueOrchestratorOptions) {}

  snapshot(): WorkQueueSnapshot {
    return {
      running: [...this.running.values()],
      retryQueue: [...this.retryAttempts.values()],
      claimedCount: this.claimed.size,
    };
  }

  start(): void {
    void this.tick();
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext());
    }, this.options.definition.pollingIntervalMs);
  }

  async tick(): Promise<void> {
    await this.reconcile();
    const candidates = await this.fetchAllCandidates();
    const sorted = sortCandidates(candidates);
    const slots = Math.max(
      0,
      this.options.definition.maxConcurrentAgents - this.running.size,
    );
    const dispatchPromises: Promise<void>[] = [];
    let dispatched = 0;
    for (const item of sorted) {
      if (dispatched >= slots) {
        break;
      }
      if (this.running.has(item.id) || this.claimed.has(item.id)) {
        continue;
      }
      const rendered = this.options.renderPrompt(item, null);
      if (!rendered.ok) {
        continue;
      }
      this.claimed.add(item.id);
      dispatched += 1;
      dispatchPromises.push(this.dispatch(item, rendered.prompt, null));
    }
    if (dispatchPromises.length > 0) {
      void Promise.all(dispatchPromises).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          JSON.stringify({
            event: "work_queue_dispatch_batch_error",
            error: message,
          }),
        );
      });
    }
    await this.processDueRetries();
  }

  private async fetchAllCandidates(): Promise<WorkItem[]> {
    const all: WorkItem[] = [];
    for (const feed of this.options.feeds) {
      try {
        const batch = await feed.fetchCandidates();
        all.push(...batch);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[work-queue] feed ${feed.feedKind} failed: ${message}`);
      }
    }
    return all;
  }

  private reconcileStalledWorkers(): void {
    const stallMs = this.options.implementationStallTimeoutMs;
    if (stallMs === undefined || stallMs <= 0) {
      return;
    }
    const now = this.options.now?.() ?? Date.now();
    for (const [id, entry] of this.running) {
      if (entry.workerKind !== "implementation") {
        continue;
      }
      if (now - entry.startedAtMs <= stallMs) {
        continue;
      }
      console.warn(
        JSON.stringify({
          event: "implementation_worker_stalled",
          work_item_id: id,
          identifier: entry.item.identifier,
          elapsed_ms: now - entry.startedAtMs,
          stall_timeout_ms: stallMs,
        }),
      );
      this.running.delete(id);
      this.scheduleRetry(
        entry.item,
        (entry.attempt ?? 0) + 1,
        "implementation worker exceeded stall timeout",
        0,
      );
    }
  }

  private async reconcile(): Promise<void> {
    this.reconcileStalledWorkers();
    const ids = [...this.running.keys()];
    if (ids.length === 0) {
      return;
    }
    const states: WorkItem[] = [];
    for (const feed of this.options.feeds) {
      try {
        states.push(...(await feed.fetchStates(ids)));
      } catch {
        // keep workers running until next tick
      }
    }
    const byId = new Map(states.map((s) => [s.id, s]));
    for (const [id, entry] of this.running) {
      const fresh = byId.get(id);
      if (fresh === undefined) {
        this.release(id, entry.item.identifier);
        continue;
      }
      if (isTerminalState(fresh.state)) {
        this.running.delete(id);
        this.claimed.delete(id);
        await removeIssueWorkspace({
          workspaceRoot: this.options.definition.workspaceRoot,
          identifier: entry.item.identifier,
          hooks: this.options.hooks,
        });
      }
    }
  }

  private async dispatch(
    item: WorkItem,
    prompt: string,
    attempt: number | null,
  ): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    let workspacePath: string;
    try {
      const hooks = this.options.hooks;
      const ws = await ensureIssueWorkspace({
        workspaceRoot: this.options.definition.workspaceRoot,
        identifier: item.identifier,
        hooks,
      });
      workspacePath = ws.path;
      if (hooks?.beforeRun !== undefined) {
        const { runWorkspaceHook } = await import("@aguil/agents-workspace");
        await runWorkspaceHook(
          "beforeRun",
          hooks.beforeRun,
          workspacePath,
          hooks,
        );
      }
    } catch (error) {
      this.claimed.delete(item.id);
      const message = error instanceof Error ? error.message : String(error);
      this.scheduleRetry(item, 1, message);
      return;
    }

    const startedAtMs = now;
    this.running.set(item.id, {
      item,
      workspacePath,
      startedAtMs,
      attempt,
      workerKind: resolveWorkerKindForItem(
        item,
        this.options.definition.workers,
      ),
    });

    const clearRunningIfCurrent = (): void => {
      const current = this.running.get(item.id);
      if (current !== undefined && current.startedAtMs === startedAtMs) {
        this.running.delete(item.id);
      }
    };

    try {
      const result = await this.options.worker({
        item,
        workspacePath,
        attempt,
        prompt,
      });
      clearRunningIfCurrent();
      if (result.status === "succeeded") {
        this.completed.add(item.id);
        this.claimed.delete(item.id);
      } else {
        this.scheduleRetry(item, (attempt ?? 0) + 1, result.error ?? "failed");
      }
    } catch (error) {
      clearRunningIfCurrent();
      const message = error instanceof Error ? error.message : String(error);
      this.scheduleRetry(item, (attempt ?? 0) + 1, message);
    } finally {
      if (this.options.hooks?.afterRun !== undefined) {
        const { runWorkspaceHook } = await import("@aguil/agents-workspace");
        await runWorkspaceHook(
          "afterRun",
          this.options.hooks.afterRun,
          workspacePath,
          this.options.hooks,
        );
      }
    }
  }

  private scheduleRetry(
    item: WorkItem,
    attempt: number,
    error: string | null,
    delayOverrideMs?: number,
  ): void {
    const existing = this.retryAttempts.get(item.id);
    if (existing !== undefined) {
      this.retryAttempts.delete(item.id);
    }
    const now = this.options.now?.() ?? Date.now();
    const delay =
      delayOverrideMs ??
      Math.min(
        10_000 * 2 ** Math.max(0, attempt - 1),
        this.options.definition.maxRetryBackoffMs,
      );
    this.retryAttempts.set(item.id, {
      issueId: item.id,
      identifier: item.identifier,
      attempt,
      dueAtMs: now + delay,
      error,
    });
    this.claimed.add(item.id);
  }

  private async processDueRetries(): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    const dispatchPromises: Promise<void>[] = [];
    let slots = Math.max(
      0,
      this.options.definition.maxConcurrentAgents - this.running.size,
    );
    for (const [id, entry] of this.retryAttempts) {
      if (entry.dueAtMs > now) {
        continue;
      }
      if (this.completed.has(id) || slots <= 0) {
        continue;
      }
      this.retryAttempts.delete(id);
      const item = await this.findCandidateById(id);
      if (item === undefined) {
        this.release(id, entry.identifier);
        continue;
      }
      const rendered = this.options.renderPrompt(item, entry.attempt);
      if (!rendered.ok) {
        this.release(id, entry.identifier);
        continue;
      }
      slots -= 1;
      dispatchPromises.push(
        this.dispatch(item, rendered.prompt, entry.attempt),
      );
    }
    await Promise.all(dispatchPromises);
  }

  private async findCandidateById(id: string): Promise<WorkItem | undefined> {
    for (const feed of this.options.feeds) {
      const states = await feed.fetchStates([id]);
      if (states.length > 0) {
        return states[0];
      }
    }
    const all = await this.fetchAllCandidates();
    return all.find((i) => i.id === id);
  }

  private release(id: string, _identifier: string): void {
    this.running.delete(id);
    this.claimed.delete(id);
    this.retryAttempts.delete(id);
  }

  async startupTerminalCleanup(): Promise<void> {
    for (const feed of this.options.feeds) {
      try {
        const terminal = await feed.fetchTerminal();
        for (const item of terminal) {
          await removeIssueWorkspace({
            workspaceRoot: this.options.definition.workspaceRoot,
            identifier: item.identifier,
            hooks: this.options.hooks,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[work-queue] terminal cleanup for ${feed.feedKind}: ${message}`,
        );
      }
    }
  }
}

function sortCandidates(items: readonly WorkItem[]): WorkItem[] {
  return [...items].sort((a, b) => {
    const pa = a.priority ?? 999;
    const pb = b.priority ?? 999;
    if (pa !== pb) {
      return pa - pb;
    }
    const ca = a.createdAt ?? "";
    const cb = b.createdAt ?? "";
    if (ca !== cb) {
      return ca.localeCompare(cb);
    }
    return a.identifier.localeCompare(b.identifier);
  });
}

function isTerminalState(state: string): boolean {
  const s = state.toLowerCase();
  return ["closed", "done", "cancelled", "canceled", "merged"].includes(s);
}

function resolveWorkerKindForItem(
  item: WorkItem,
  workers: Readonly<Record<string, string>>,
): string {
  const mapped = workers[item.kind];
  if (mapped !== undefined) {
    return mapped;
  }
  switch (item.kind) {
    case "github_pr_review":
      return "code_review";
    case "github_pr_feedback":
      return "pr_feedback";
    default:
      return "implementation";
  }
}
