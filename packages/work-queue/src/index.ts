import type { WorkFeedClient, WorkItem } from "@aguil/agents-tracker";
import type { WorkflowDefinition } from "@aguil/agents-workflow";
import {
  ensureIssueWorkspace,
  removeIssueWorkspace,
  type WorkspaceHooks,
  writeWorkItemMarker,
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
  readonly abortController: AbortController;
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
  readonly signal?: AbortSignal;
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
  /** Max concurrent dispatches per `WorkItem.kind` (feed kind). */
  readonly perFeedMaxConcurrent?: Readonly<Record<string, number>>;
  readonly filterCandidates?: (
    items: readonly WorkItem[],
  ) => Promise<readonly WorkItem[]>;
}

/** Poll-based scheduler (Symphony coordination layer; ADR 0003). */
export class WorkQueueOrchestrator {
  private definition: WorkflowDefinition;
  private feeds: readonly WorkFeedClient[];
  private perFeedMaxConcurrent?: Readonly<Record<string, number>>;
  private workspaceHooks?: WorkspaceHooks;
  private readonly running = new Map<string, RunningEntry>();
  private readonly claimed = new Set<string>();
  private readonly retryAttempts = new Map<string, RetryEntry>();
  private readonly completed = new Set<string>();
  /** Stall fired before dispatch settled; retry after in-flight worker exits. */
  private readonly stallAwaitingSettlement = new Map<
    string,
    {
      readonly item: WorkItem;
      readonly attempt: number;
      readonly error: string;
    }
  >();
  private pendingDispatches = 0;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly options: WorkQueueOrchestratorOptions) {
    this.definition = options.definition;
    this.feeds = options.feeds;
    this.perFeedMaxConcurrent = options.perFeedMaxConcurrent;
    this.workspaceHooks = options.hooks;
  }

  private countRunningForKind(kind: string): number {
    let count = 0;
    for (const entry of this.running.values()) {
      if (entry.item.kind === kind) {
        count += 1;
      }
    }
    return count;
  }

  private availableAgentSlots(): number {
    return Math.max(
      0,
      this.definition.maxConcurrentAgents -
        this.running.size -
        this.pendingDispatches,
    );
  }

  private reservePendingDispatch(): void {
    this.pendingDispatches += 1;
  }

  private releasePendingDispatch(): void {
    if (this.pendingDispatches > 0) {
      this.pendingDispatches -= 1;
    }
  }

  snapshot(): WorkQueueSnapshot {
    return {
      running: [...this.running.values()],
      retryQueue: [...this.retryAttempts.values()],
      claimedCount: this.claimed.size,
    };
  }

  start(): void {
    void this.tick().finally(() => this.scheduleNext());
  }

  private inFlightDispatches = new Set<Promise<void>>();

  stop(): void {
    this.stopped = true;
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  async stopAndDrain(
    input: { readonly timeoutMs?: number } = {},
  ): Promise<void> {
    this.stop();
    const timeoutMs = input.timeoutMs ?? 60_000;
    const pending = [...this.inFlightDispatches];
    if (pending.length === 0) {
      return;
    }
    console.log(
      JSON.stringify({
        event: "agentsd_stopping",
        in_flight: pending.length,
        timeout_ms: timeoutMs,
      }),
    );
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs);
      }),
    ]);
  }

  private scheduleNext(): void {
    if (this.stopped) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext());
    }, this.definition.pollingIntervalMs);
  }

  async tick(): Promise<void> {
    await this.reconcile();
    const candidates = await this.fetchAllCandidates();
    const sorted = sortCandidates(candidates);
    const slots = this.availableAgentSlots();
    const dispatchPromises: Promise<void>[] = [];
    let dispatched = 0;
    for (const item of sorted) {
      if (dispatched >= slots) {
        break;
      }
      if (
        this.completed.has(item.id) ||
        this.running.has(item.id) ||
        this.claimed.has(item.id) ||
        this.stallAwaitingSettlement.has(item.id)
      ) {
        continue;
      }
      const feedCap = this.perFeedMaxConcurrent?.[item.kind];
      if (
        feedCap !== undefined &&
        this.countRunningForKind(item.kind) >= feedCap
      ) {
        continue;
      }
      const rendered = this.options.renderPrompt(item, null);
      if (!rendered.ok) {
        continue;
      }
      this.claimed.add(item.id);
      dispatched += 1;
      this.reservePendingDispatch();
      const promise = this.dispatch(item, rendered.prompt, null);
      dispatchPromises.push(promise);
      this.trackDispatch(promise);
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
    const batches = await Promise.all(
      this.feeds.map(async (feed) => {
        try {
          return await feed.fetchCandidates();
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.warn(`[work-queue] feed ${feed.feedKind} failed: ${message}`);
          return [];
        }
      }),
    );
    const flat = batches.flat();
    if (this.options.filterCandidates !== undefined) {
      return [...(await this.options.filterCandidates(flat))];
    }
    return flat;
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
      const supersededAttempt = entry.attempt ?? 0;
      console.warn(
        JSON.stringify({
          event: "implementation_worker_stalled",
          work_item_id: id,
          identifier: entry.item.identifier,
          elapsed_ms: now - entry.startedAtMs,
          stall_timeout_ms: stallMs,
          superseded_attempt: supersededAttempt,
        }),
      );
      entry.abortController.abort();
      this.running.delete(id);
      this.stallAwaitingSettlement.set(id, {
        item: entry.item,
        attempt: supersededAttempt + 1,
        error: "implementation worker exceeded stall timeout",
      });
    }
  }

  private async reconcile(): Promise<void> {
    this.reconcileStalledWorkers();
    const ids = [...this.running.keys()];
    if (ids.length === 0) {
      return;
    }
    const states: WorkItem[] = [];
    for (const feed of this.feeds) {
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
        this.running.delete(id);
        this.claimed.delete(id);
        this.completed.add(id);
        continue;
      }
      if (isTerminalState(fresh.state)) {
        this.running.delete(id);
        this.claimed.delete(id);
        this.completed.add(id);
        await removeIssueWorkspace({
          workspaceRoot: this.definition.workspaceRoot,
          identifier: entry.item.identifier,
          hooks: this.workspaceHooks,
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
      const hooks = this.workspaceHooks;
      const ws = await ensureIssueWorkspace({
        workspaceRoot: this.definition.workspaceRoot,
        identifier: item.identifier,
        hooks,
      });
      workspacePath = ws.path;
      await writeWorkItemMarker(workspacePath, {
        identifier: item.identifier,
        kind: item.kind,
      });
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
      this.releasePendingDispatch();
      this.claimed.delete(item.id);
      const message = error instanceof Error ? error.message : String(error);
      this.scheduleRetry(item, 1, message);
      return;
    }

    this.releasePendingDispatch();
    const startedAtMs = now;
    const abortController = new AbortController();
    this.running.set(item.id, {
      item,
      workspacePath,
      startedAtMs,
      attempt,
      workerKind: resolveWorkerKindForItem(item, this.definition.workers),
      abortController,
    });

    const clearRunningIfCurrent = (): void => {
      const current = this.running.get(item.id);
      if (current !== undefined && current.startedAtMs === startedAtMs) {
        this.running.delete(item.id);
      }
    };

    const stalledWhileRunning = (): boolean =>
      this.stallAwaitingSettlement.has(item.id);

    try {
      const result = await this.options.worker({
        item,
        workspacePath,
        attempt,
        prompt,
        signal: abortController.signal,
      });
      clearRunningIfCurrent();
      const stallPending = this.stallAwaitingSettlement.get(item.id);
      if (stallPending !== undefined) {
        this.stallAwaitingSettlement.delete(item.id);
        this.scheduleRetry(
          stallPending.item,
          stallPending.attempt,
          stallPending.error,
          0,
        );
        return;
      }
      if (result.status === "succeeded") {
        if (await this.shouldMarkCompleted(item)) {
          this.completed.add(item.id);
        }
        this.claimed.delete(item.id);
      } else {
        this.scheduleRetry(item, (attempt ?? 0) + 1, result.error ?? "failed");
      }
    } catch (error) {
      clearRunningIfCurrent();
      const stallPending = this.stallAwaitingSettlement.get(item.id);
      if (stallPending !== undefined) {
        this.stallAwaitingSettlement.delete(item.id);
        this.scheduleRetry(
          stallPending.item,
          stallPending.attempt,
          stallPending.error,
          0,
        );
        return;
      }
      if (stalledWhileRunning() || abortController.signal.aborted) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.scheduleRetry(item, (attempt ?? 0) + 1, message);
    } finally {
      if (this.workspaceHooks?.afterRun !== undefined) {
        const { runWorkspaceHook } = await import("@aguil/agents-workspace");
        await runWorkspaceHook(
          "afterRun",
          this.workspaceHooks.afterRun,
          workspacePath,
          this.workspaceHooks,
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
        this.definition.maxRetryBackoffMs,
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
    const due: { readonly id: string; readonly entry: RetryEntry }[] = [];
    for (const [id, entry] of this.retryAttempts) {
      if (entry.dueAtMs <= now) {
        due.push({ id, entry });
      }
    }
    const resolved = await Promise.all(
      due.map(async ({ id, entry }) => ({
        id,
        entry,
        item: await this.findCandidateById(id),
      })),
    );
    const dispatchPromises: Promise<void>[] = [];
    let slots = this.availableAgentSlots();
    for (const { id, entry, item } of resolved) {
      if (
        this.completed.has(id) ||
        this.stallAwaitingSettlement.has(id) ||
        slots <= 0
      ) {
        continue;
      }
      this.retryAttempts.delete(id);
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
      this.reservePendingDispatch();
      const promise = this.dispatch(item, rendered.prompt, entry.attempt);
      dispatchPromises.push(promise);
      this.trackDispatch(promise);
    }
    if (dispatchPromises.length > 0) {
      void Promise.all(dispatchPromises).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          JSON.stringify({
            event: "work_queue_retry_dispatch_batch_error",
            error: message,
          }),
        );
      });
    }
  }

  private async findCandidateById(id: string): Promise<WorkItem | undefined> {
    for (const feed of this.feeds) {
      const states = await feed.fetchStates([id]);
      if (states.length > 0) {
        return states[0];
      }
    }
    const all = await this.fetchAllCandidates();
    return all.find((i) => i.id === id);
  }

  private async shouldMarkCompleted(item: WorkItem): Promise<boolean> {
    if (item.kind === "github_pr_feedback") {
      const states = await this.fetchStatesForItem(item.id);
      return states.length === 0;
    }
    if (item.kind === "github_issue" || item.kind === "github_pr_review") {
      return true;
    }
    const states = await this.fetchStatesForItem(item.id);
    if (states.length === 0) {
      return true;
    }
    return isTerminalState(states[0].state);
  }

  private async fetchStatesForItem(id: string): Promise<readonly WorkItem[]> {
    const states: WorkItem[] = [];
    for (const feed of this.feeds) {
      try {
        states.push(...(await feed.fetchStates([id])));
      } catch {
        // ignore per-feed errors
      }
    }
    return states;
  }

  private trackDispatch(promise: Promise<void>): void {
    this.inFlightDispatches.add(promise);
    void promise.finally(() => {
      this.inFlightDispatches.delete(promise);
    });
  }

  updateDefinition(
    definition: WorkflowDefinition,
    feedConfig?: {
      readonly feeds: readonly WorkFeedClient[];
      readonly perFeedMaxConcurrent?: Readonly<Record<string, number>>;
      readonly hooks?: WorkspaceHooks;
    },
  ): void {
    this.definition = definition;
    if (feedConfig !== undefined) {
      this.feeds = feedConfig.feeds;
      this.perFeedMaxConcurrent = feedConfig.perFeedMaxConcurrent;
      if (feedConfig.hooks !== undefined) {
        this.workspaceHooks = feedConfig.hooks;
      }
    }
  }

  /** Await in-flight dispatches (for tests and shutdown). */
  async flush(): Promise<void> {
    await Promise.all([...this.inFlightDispatches]);
  }

  private release(id: string, _identifier: string): void {
    this.running.delete(id);
    this.claimed.delete(id);
    this.retryAttempts.delete(id);
    this.stallAwaitingSettlement.delete(id);
  }

  async startupTerminalCleanup(): Promise<void> {
    for (const feed of this.feeds) {
      try {
        const terminal = await feed.fetchTerminal({
          workspaceRoot: this.definition.workspaceRoot,
        });
        for (const item of terminal) {
          await removeIssueWorkspace({
            workspaceRoot: this.definition.workspaceRoot,
            identifier: item.identifier,
            hooks: this.workspaceHooks,
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
