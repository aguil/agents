import { createAgentEvent, ensureDirectory, writeJsonFile } from "@aguil/agents-core";
import type { AgentEvent, Finding } from "@aguil/agents-core";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

export interface AdapterCapabilities {
  readonly streaming: boolean;
  readonly structuredOutput: boolean;
  readonly readOnlyMode: boolean;
  readonly mcp: boolean;
  readonly cancellation: boolean;
}

export interface AgentRunRequest {
  readonly runId: string;
  readonly roleId: string;
  readonly prompt: string;
  readonly workspacePath: string;
  readonly contextBundlePath: string;
  readonly scratchpadPath: string;
  readonly timeoutMs: number;
  readonly allowedCommands: readonly string[];
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface AgentRunResult {
  readonly status: "completed" | "failed" | "timed_out" | "cancelled";
  readonly findings: readonly Finding[];
  readonly artifacts: readonly string[];
}

export interface AgentAdapter {
  readonly name: string;
  capabilities(): AdapterCapabilities;
  run(request: AgentRunRequest): AsyncIterable<AgentEvent>;
}

export interface FindingValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export function isFinding(value: unknown): value is Finding {
  return validateFinding(value).valid;
}

function coerceFindingShape(raw: Record<string, unknown>): Partial<Finding> {
  const o: Record<string, unknown> = { ...raw };

  if (o.file === null || o.file === undefined) {
    delete o.file;
  } else if (typeof o.file === "string") {
    const t = o.file.trim();
    if (t.length === 0) {
      delete o.file;
    } else {
      o.file = t;
    }
  }

  if (o.line === null || o.line === undefined) {
    delete o.line;
  } else if (typeof o.line === "string") {
    const trimmed = o.line.trim();
    if (/^\d+$/.test(trimmed)) {
      o.line = Number.parseInt(trimmed, 10);
    }
  }

  return o as Partial<Finding>;
}

export function validateFinding(value: unknown): FindingValidationResult {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) {
    return { valid: false, errors: ["finding must be an object"] };
  }

  const candidate = coerceFindingShape(value as Record<string, unknown>);
  requireString(candidate.id, "id", errors);
  if (candidate.severity !== "critical" && candidate.severity !== "warning") {
    errors.push("severity must be critical or warning");
  }
  requireString(candidate.title, "title", errors);
  requireString(candidate.description, "description", errors);
  requireString(candidate.evidence, "evidence", errors);
  requireString(candidate.sourceRole, "sourceRole", errors);

  if (candidate.file !== undefined) {
    if (typeof candidate.file !== "string") {
      errors.push("file must be a string when present");
    } else {
      requireString(candidate.file, "file", errors);
    }
  }
  if (
    candidate.line !== undefined &&
    (!Number.isInteger(candidate.line) || candidate.line < 1)
  ) {
    errors.push("line must be a positive integer when present");
  }

  if (typeof candidate.validation !== "object" || candidate.validation === null) {
    errors.push("validation must be an object");
  } else {
    const validation = candidate.validation as Partial<Finding["validation"]>;
    if (
      validation.status !== "verified" &&
      validation.status !== "not_reproduced" &&
      validation.status !== "not_run"
    ) {
      errors.push("validation.status must be verified, not_reproduced, or not_run");
    }
    requireString(validation.details, "validation.details", errors);
  }

  return { valid: errors.length === 0, errors };
}

function requireString(value: unknown, field: string, errors: string[]): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${field} must be a non-empty string`);
  }
}

export class FakeAgentAdapter implements AgentAdapter {
  readonly name = "fake";

  constructor(
    private readonly findingsByRole: Readonly<Record<string, readonly Finding[]>> = {},
  ) {}

  capabilities(): AdapterCapabilities {
    return {
      streaming: true,
      structuredOutput: true,
      readOnlyMode: true,
      mcp: false,
      cancellation: true,
    };
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    yield createAgentEvent({
      runId: request.runId,
      roleId: request.roleId,
      type: "started",
      message: `${request.roleId} review started`,
    });

    for (const finding of this.findingsByRole[request.roleId] ?? []) {
      yield createAgentEvent({
        runId: request.runId,
        roleId: request.roleId,
        type: "finding",
        message: finding.title,
        data: finding,
      });
    }

    yield createAgentEvent({
      runId: request.runId,
      roleId: request.roleId,
      type: "completed",
      message: `${request.roleId} review completed`,
    });
  }
}

export interface CommandSpec {
  readonly cmd: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface SubprocessAgentAdapterOptions {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  buildCommand(request: AgentRunRequest, requestPath: string): CommandSpec;
  readonly heartbeatIntervalMs?: number;
  readonly idleWarningThresholdMs?: number;
}

export class SubprocessAgentAdapter implements AgentAdapter {
  readonly name: string;

  constructor(private readonly options: SubprocessAgentAdapterOptions) {
    this.name = options.name;
  }

  capabilities(): AdapterCapabilities {
    return this.options.capabilities;
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    await ensureDirectory(request.scratchpadPath);
    const requestPath = join(request.scratchpadPath, `${request.roleId}.request.json`);
    const stdoutLogPath = join(request.scratchpadPath, "stdout.log");
    const stderrLogPath = join(request.scratchpadPath, "stderr.log");
    await writeJsonFile(requestPath, request);

    yield createAgentEvent({
      runId: request.runId,
      roleId: request.roleId,
      type: "started",
      message: `${this.name} started ${request.roleId}`,
      data: { requestPath },
    });

    const command = this.options.buildCommand(request, requestPath);
    yield createAgentEvent({
      runId: request.runId,
      roleId: request.roleId,
      type: "tool",
      message: `${this.name} command prepared`,
      data: {
        kind: "command",
        phase: "before",
        cmd: command.cmd,
        cwd: command.cwd ?? request.workspacePath,
      },
    });
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn({
        cmd: [...command.cmd],
        cwd: command.cwd ?? request.workspacePath,
        stdin: "ignore",
        env: {
          ...Bun.env,
          ...command.env,
          AGENTS_REQUEST_PATH: requestPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      yield createAgentEvent({
        runId: request.runId,
        roleId: request.roleId,
        type: "error",
        message: `${this.name} failed to start subprocess`,
        data: {
          reason: "spawn_failed",
          command: command.cmd,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }

    const queue = new AsyncEventQueue<AgentEvent>();
    let timedOut = false;
    let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let lastOutputTimestamp: string | undefined;
    const stdoutTail = createTailBuffer(25);
    const stderrTail = createTailBuffer(25);
    const startedAtMs = Date.now();

    const timeoutTimer = request.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");
          hardKillTimer = setTimeout(() => proc.kill("SIGKILL"), 1_000);
        }, request.timeoutMs)
      : undefined;

    const heartbeatInterval = this.options.heartbeatIntervalMs ?? 15_000;
    const idleWarningThresholdMs = this.options.idleWarningThresholdMs ?? 90_000;
    const heartbeatTimer = setInterval(() => {
      const elapsedMs = Date.now() - startedAtMs;
      const lastOutputMs = lastOutputTimestamp === undefined
        ? startedAtMs
        : Date.parse(lastOutputTimestamp);
      const idleDurationMs = Date.now() - lastOutputMs;
      const isIdle = idleDurationMs >= idleWarningThresholdMs;
      queue.push(
        createAgentEvent({
          runId: request.runId,
          roleId: request.roleId,
          type: "tool",
          message: isIdle
            ? `${this.name} idle warning (${Math.floor(idleDurationMs / 1000)}s without output)`
            : `${this.name} heartbeat`,
          data: {
            kind: isIdle ? "idle_warning" : "heartbeat",
            elapsedMs,
            stdoutBytes,
            stderrBytes,
            lastOutputTimestamp,
            ...(isIdle ? { idleDurationMs } : {}),
          },
        }),
      );
    }, heartbeatInterval);

    const stdoutWriter = new BatchedLogWriter(stdoutLogPath);
    const stderrWriter = new BatchedLogWriter(stderrLogPath);

    const stdoutDrainer = drainProcessStream(proc.stdout, async (line) => {
      stdoutBytes += Buffer.byteLength(line, "utf8") + 1;
      lastOutputTimestamp = new Date().toISOString();
      stdoutTail.push(line);
      await stdoutWriter.writeLine(line);
      for (const event of normalizeAgentOutputLine(request, line)) {
        queue.push(event);
      }
    });

    const stderrDrainer = drainProcessStream(proc.stderr, async (line) => {
      stderrBytes += Buffer.byteLength(line, "utf8") + 1;
      lastOutputTimestamp = new Date().toISOString();
      stderrTail.push(line);
      await stderrWriter.writeLine(line);
      queue.push(
        createAgentEvent({
          runId: request.runId,
          roleId: request.roleId,
          type: "stderr",
          message: line,
        }),
      );
    });

    let exitCode = 0;
    try {
      [exitCode] = await Promise.all([proc.exited, stdoutDrainer, stderrDrainer]);
    } finally {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
      if (hardKillTimer !== undefined) {
        clearTimeout(hardKillTimer);
      }
      clearInterval(heartbeatTimer);
      await Promise.all([stdoutWriter.flushAndClose(), stderrWriter.flushAndClose()]);
    }

    if (timedOut) {
      queue.push(createAgentEvent({
        runId: request.runId,
        roleId: request.roleId,
        type: "error",
        message: `${this.name} timed out after ${request.timeoutMs}ms`,
        data: {
          reason: "timed_out",
          timeoutMs: request.timeoutMs,
          elapsedMs: Date.now() - startedAtMs,
          exitCode,
          command: command.cmd,
          cwd: command.cwd ?? request.workspacePath,
          stdoutBytes,
          stderrBytes,
          lastOutputTimestamp,
          stdoutTail: stdoutTail.values(),
          stderrTail: stderrTail.values(),
          stdoutLogPath,
          stderrLogPath,
        },
      }));
      queue.close();
      for await (const event of queue) {
        yield event;
      }
      return;
    }

    if (exitCode === 0) {
      queue.push(createAgentEvent({
        runId: request.runId,
        roleId: request.roleId,
        type: "completed",
        message: `${this.name} completed ${request.roleId}`,
        data: {
          elapsedMs: Date.now() - startedAtMs,
          exitCode,
          command: command.cmd,
          cwd: command.cwd ?? request.workspacePath,
          stdoutBytes,
          stderrBytes,
          stdoutLogPath,
          stderrLogPath,
        },
      }));
      queue.close();
      for await (const event of queue) {
        yield event;
      }
      return;
    }

    queue.push(createAgentEvent({
      runId: request.runId,
      roleId: request.roleId,
      type: "error",
      message: `${this.name} exited with code ${exitCode}`,
      data: {
        exitCode,
        elapsedMs: Date.now() - startedAtMs,
        command: command.cmd,
        cwd: command.cwd ?? request.workspacePath,
        stdoutBytes,
        stderrBytes,
        lastOutputTimestamp,
        stdoutTail: stdoutTail.values(),
        stderrTail: stderrTail.values(),
        stdoutLogPath,
        stderrLogPath,
      },
    }));
    queue.close();
    for await (const event of queue) {
      yield event;
    }
  }
}

export interface CollectedAgentRun {
  readonly result: AgentRunResult;
  readonly events: readonly AgentEvent[];
}

export async function collectAgentRun(
  adapter: AgentAdapter,
  request: AgentRunRequest,
): Promise<CollectedAgentRun> {
  const events: AgentEvent[] = [];
  const findings: Finding[] = [];
  let status: AgentRunResult["status"] = "completed";

  for await (const event of adapter.run(request)) {
    events.push(event);
    if (event.type === "finding" && isFinding(event.data)) {
      findings.push(event.data);
    }
    if (event.type === "error") {
      status = hasTimedOut(event.data) ? "timed_out" : "failed";
    }
  }

  return {
    events,
    result: {
      status,
      findings,
      artifacts: [request.scratchpadPath],
    },
  };
}

export function normalizeAgentOutputLine(
  request: AgentRunRequest,
  line: string,
): readonly AgentEvent[] {
  try {
    const parsed = JSON.parse(line) as unknown;
    const findingEnvelope = readFindingEnvelope(parsed);
    if (findingEnvelope !== undefined) {
      if (!findingEnvelope.validation.valid) {
        return [
          createAgentEvent({
            runId: request.runId,
            roleId: request.roleId,
            type: "error",
            message: "invalid finding envelope",
            data: { errors: findingEnvelope.validation.errors, finding: findingEnvelope.value },
          }),
        ];
      }
      return [createAgentEvent({
        runId: request.runId,
        roleId: request.roleId,
        type: "finding",
        message: findingEnvelope.value.title,
        data: findingEnvelope.value,
      })];
    }
    if (isAgentEventEnvelope(parsed)) {
      return [createAgentEvent({
        runId: parsed.runId ?? request.runId,
        roleId: parsed.roleId ?? request.roleId,
        type: parsed.type,
        message: parsed.message,
        data: parsed.data,
      })];
    }

    const nestedFindings = extractFindingEnvelopes(parsed).map((envelope) => {
      if (!envelope.validation.valid) {
        return createAgentEvent({
          runId: request.runId,
          roleId: request.roleId,
          type: "error",
          message: "invalid nested finding envelope",
          data: { errors: envelope.validation.errors, finding: envelope.value },
        });
      }
      return createAgentEvent({
        runId: request.runId,
        roleId: request.roleId,
        type: "finding",
        message: envelope.value.title,
        data: envelope.value,
      });
    });
    if (nestedFindings.length > 0) {
      return nestedFindings;
    }

    return [createAgentEvent({
      runId: request.runId,
      roleId: request.roleId,
      type: "stdout",
      message: line,
      data: parsed,
    })];
  } catch {
    return [createAgentEvent({
      runId: request.runId,
      roleId: request.roleId,
      type: "stdout",
      message: line,
    })];
  }
}

interface ParsedFindingEnvelope {
  readonly value: Finding;
  readonly validation: FindingValidationResult;
}

function readFindingEnvelope(value: unknown): ParsedFindingEnvelope | undefined {
  if (typeof value !== "object" || value === null || !("finding" in value)) {
    return undefined;
  }
  const rawFinding = (value as { readonly finding?: unknown }).finding;
  if (typeof rawFinding !== "object" || rawFinding === null) {
    return undefined;
  }
  const coerced = coerceFindingShape(rawFinding as Record<string, unknown>);
  const validation = validateFinding(rawFinding);
  return { value: coerced as Finding, validation };
}

function extractFindingEnvelopes(value: unknown): readonly ParsedFindingEnvelope[] {
  const envelopes: ParsedFindingEnvelope[] = [];
  const texts = extractTextCandidates(value);
  for (const text of texts) {
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      try {
        const envelope = readFindingEnvelope(JSON.parse(line) as unknown);
        if (envelope !== undefined) {
          envelopes.push(envelope);
        }
      } catch {
        // Non-JSON text inside an agent event is expected.
      }
    }
  }
  return envelopes;
}

function extractTextCandidates(value: unknown): readonly string[] {
  const texts: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      texts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const child of Object.values(node)) {
        visit(child);
      }
    }
  };
  visit(value);
  return texts;
}

function isAgentEventEnvelope(
  value: unknown,
): value is Partial<AgentEvent> & Pick<AgentEvent, "type"> {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }

  const event = value as Partial<AgentEvent>;
  return (
    event.type === "started" ||
    event.type === "stdout" ||
    event.type === "stderr" ||
    event.type === "tool" ||
    event.type === "finding" ||
    event.type === "completed" ||
    event.type === "error"
  );
}

function hasTimedOut(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { readonly reason?: unknown }).reason === "timed_out"
  );
}

export interface OpenCodeAdapterOptions {
  readonly executable?: string;
  readonly model?: string;
  readonly variant?: string;
  readonly agent?: string;
  readonly pure?: boolean;
  readonly printLogs?: boolean;
}

export interface ClaudeCodeAdapterOptions {
  readonly executable?: string;
  readonly model?: string;
  readonly argsTemplate?: readonly string[];
}

export interface CursorAdapterOptions {
  readonly executable?: string;
  readonly model?: string;
  readonly argsTemplate?: readonly string[];
  readonly mode?: "agent" | "plan" | "ask";
  readonly force?: boolean;
  readonly sandbox?: "enabled" | "disabled";
}

export class OpenCodeAdapter extends SubprocessAgentAdapter {
  constructor(options: OpenCodeAdapterOptions = {}) {
    super({
      name: "opencode",
      capabilities: {
        streaming: true,
        structuredOutput: true,
        readOnlyMode: true,
        mcp: false,
        cancellation: true,
      },
      buildCommand: (request, requestPath) => ({
        cmd: buildOpenCodeCommand(request, requestPath, options),
        cwd: request.workspacePath,
      }),
    });
  }
}

export class ClaudeCodeAdapter extends SubprocessAgentAdapter {
  constructor(options: ClaudeCodeAdapterOptions = {}) {
    super({
      name: "claude",
      capabilities: {
        streaming: true,
        structuredOutput: true,
        readOnlyMode: true,
        mcp: false,
        cancellation: true,
      },
      buildCommand: (request, requestPath) => ({
        cmd: buildClaudeCodeCommand(request, requestPath, options),
        cwd: request.workspacePath,
      }),
    });
  }
}

export class CursorAdapter extends SubprocessAgentAdapter {
  constructor(options: CursorAdapterOptions = {}) {
    super({
      name: "cursor",
      capabilities: {
        streaming: true,
        structuredOutput: true,
        readOnlyMode: true,
        mcp: true,
        cancellation: true,
      },
      buildCommand: (request, requestPath) => ({
        cmd: buildCursorCommand(request, requestPath, options),
        cwd: request.workspacePath,
      }),
    });
  }
}

export function buildOpenCodeCommand(
  request: AgentRunRequest,
  requestPath: string,
  options: OpenCodeAdapterOptions = {},
): readonly string[] {
  const cmd = [
    options.executable ?? "opencode",
    "run",
    "--format",
    "json",
    "--dir",
    request.workspacePath,
    "--file",
    request.contextBundlePath,
    "--file",
    requestPath,
    "--title",
    `code-review:${request.roleId}`,
  ];

  if (options.model !== undefined) {
    cmd.push("--model", options.model);
  }
  if (options.variant !== undefined) {
    cmd.push("--variant", options.variant);
  }
  if (options.agent !== undefined) {
    cmd.push("--agent", options.agent);
  }
  if (options.pure === true) {
    cmd.push("--pure");
  }
  if (options.printLogs === true) {
    cmd.push("--print-logs");
  }

  cmd.push(buildOpenCodePrompt(request));
  return cmd;
}

export function buildOpenCodePrompt(request: AgentRunRequest): string {
  const vcsMode = request.metadata?.vcs_mode;
  const vcsGuidance = vcsMode === "jj"
    ? "- This workspace uses jujutsu. Prefer `jj diff`/`jj log` and avoid `git diff`/`git log` here."
    : vcsMode === "git"
    ? "- This workspace uses git. Prefer `git diff`/`git log`."
    : "";

  return `${request.prompt}

You are running as the ${request.roleId} code-review specialist inside an autonomous review harness.

Inputs attached to this session:
- Context bundle: ${request.contextBundlePath}
- Machine-readable run request: ${request.scratchpadPath}/${request.roleId}.request.json

Rules:
- Stay read-only. Do not edit files.
- Use generic repository commands only when useful: ${request.allowedCommands.join(", ") || "none"}.
- Prefer the provided context bundle and diff artifacts before ad-hoc shell exploration.
${vcsGuidance}
- Report only critical or warning issues with concrete evidence.
- Do not report nitpicks, style preferences, or speculative hardening ideas.
- Every finding must include validation details. Use validation.status "verified" only when you validated the issue.

- Formatting guidelines for findings:
- Break description into readable paragraphs when covering multiple aspects (use \n between sentences).
- For evidence with multiple code locations, list each reference on a new line with line numbers.
- Keep validation details concise but specific; separate distinct validation steps with newlines.
- Use natural prose for single-point findings; use bullet points (- prefix) only when listing 3+ items.

When you find an issue, emit it as a JSON line shaped like this example:
{"finding":{"id":"${request.roleId}-duplicate-calls","severity":"warning","title":"Fallback repeats expensive PR discovery","description":"Function re-runs discovery when patch fetch fails.\n\nThis adds avoidable process calls on a latency-sensitive path.","evidence":"Explicit-PR block calls at lines 359-360.\n\nFallback path repeats at lines 381-382.","sourceRole":"${request.roleId}","validation":{"status":"verified","details":"Verified by control-flow inspection.\n\nDuplicate calls are unconditional on fallback path."},"file":"src/index.ts","line":381}}

If there are no verified critical or warning findings, do not emit a finding line.`;
}

export function buildClaudeCodeCommand(
  request: AgentRunRequest,
  requestPath: string,
  options: ClaudeCodeAdapterOptions = {},
): readonly string[] {
  const prompt = buildClaudeCodePrompt(request, requestPath);
  const substitutions: Record<string, string> = {
    workspace: request.workspacePath,
    context_bundle: request.contextBundlePath,
    request: requestPath,
    role: request.roleId,
    prompt,
  };

  const template = options.argsTemplate ?? ["-p", "{prompt}"];
  const args = template.map((arg) => substituteTemplateArg(arg, substitutions));
  const hasPrompt = template.some((arg) => arg.includes("{prompt}"));
  const cmd = [options.executable ?? "claude", ...args];

  if (options.model !== undefined) {
    cmd.push("--model", options.model);
  }
  if (!hasPrompt) {
    cmd.push(prompt);
  }

  return cmd;
}

export function buildClaudeCodePrompt(
  request: AgentRunRequest,
  requestPath: string,
): string {
  const vcsMode = request.metadata?.vcs_mode;
  const vcsGuidance = vcsMode === "jj"
    ? "- This workspace uses jujutsu. Prefer `jj diff`/`jj log` and avoid `git diff`/`git log` here."
    : vcsMode === "git"
    ? "- This workspace uses git. Prefer `git diff`/`git log`."
    : "";

  return `${request.prompt}

You are the ${request.roleId} specialist in an autonomous code-review harness.

Inputs:
- Context bundle: ${request.contextBundlePath}
- Machine-readable run request: ${requestPath}

Rules:
- Stay read-only. Do not edit files.
- Prefer the provided context bundle and diff artifacts before ad-hoc shell exploration.
${vcsGuidance}
- Report only critical or warning findings with concrete evidence.
- Ignore style-only feedback and speculative nitpicks.
- Emit each finding as a single JSON line with a top-level \"finding\" object.

- Formatting guidelines for findings:
- Break description into readable paragraphs when covering multiple aspects (use \n between sentences).
- For evidence with multiple code locations, list each reference on a new line with line numbers.
- Keep validation details concise but specific; separate distinct validation steps with newlines.
- Use natural prose for single-point findings; use bullet points (- prefix) only when listing 3+ items.

Required finding shape (example with formatting):
{"finding":{"id":"${request.roleId}-duplicate-calls","severity":"warning","title":"Fallback repeats expensive PR discovery","description":"Function re-runs discovery when patch fetch fails.\n\nThis adds avoidable process calls on a latency-sensitive path.","evidence":"Explicit-PR block calls at lines 359-360.\n\nFallback path repeats at lines 381-382.","sourceRole":"${request.roleId}","validation":{"status":"verified","details":"Verified by control-flow inspection.\n\nDuplicate calls are unconditional on fallback path."},"file":"src/index.ts","line":381}}

If no verified critical or warning findings exist, do not emit any finding JSON line.`;
}

export function buildCursorCommand(
  request: AgentRunRequest,
  requestPath: string,
  options: CursorAdapterOptions = {},
): readonly string[] {
  const prompt = buildCursorPrompt(request, requestPath);
  const substitutions: Record<string, string> = {
    workspace: request.workspacePath,
    context_bundle: request.contextBundlePath,
    request: requestPath,
    role: request.roleId,
    model: options.model ?? "",
    prompt,
  };

  const template = options.argsTemplate ?? [
    "--print",
    "--output-format",
    "stream-json",
    "--workspace",
    "{workspace}",
    "--trust",
    ...(options.force === false ? [] : ["--force"]),
    ...(options.mode !== undefined && options.mode !== "agent" ? ["--mode", options.mode] : []),
    ...(options.sandbox !== undefined ? ["--sandbox", options.sandbox] : []),
    ...(options.model !== undefined ? ["--model", "{model}"] : []),
    "{prompt}",
  ];

  const args = template.map((arg) => substituteTemplateArg(arg, substitutions));
  const hasPrompt = template.some((arg) => arg.includes("{prompt}"));
  const cmd = [options.executable ?? "agent", ...args];

  if (!hasPrompt) {
    cmd.push(prompt);
  }

  return cmd;
}

export function buildCursorPrompt(
  request: AgentRunRequest,
  requestPath: string,
): string {
  return buildClaudeCodePrompt(request, requestPath);
}

function substituteTemplateArg(
  arg: string,
  substitutions: Readonly<Record<string, string>>,
): string {
  return arg.replaceAll(/\{([a-z_]+)\}/g, (full, key: string) => substitutions[key] ?? full);
}

function createTailBuffer(limit: number): {
  push(value: string): void;
  values(): readonly string[];
} {
  const lines: string[] = [];
  return {
    push(value: string) {
      lines.push(value);
      if (lines.length > limit) {
        lines.shift();
      }
    },
    values() {
      return [...lines];
    },
  };
}

class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ done: true, value: undefined as T });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.values.length > 0) {
        const value = this.values.shift();
        if (value !== undefined) {
          yield value;
          continue;
        }
      }
      if (this.closed) {
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (next.done) {
        return;
      }
      yield next.value;
    }
  }
}

class BatchedLogWriter {
  private buffer = "";
  private flushPromise: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly path: string,
    private readonly flushThresholdBytes = 16_384,
    private readonly maxBufferBytes = 262_144,
  ) {}

  async writeLine(line: string): Promise<void> {
    if (this.closed) {
      return;
    }
    this.buffer += `${line}\n`;
    const bufferBytes = Buffer.byteLength(this.buffer, "utf8");
    if (bufferBytes >= this.flushThresholdBytes) {
      this.flushSoon();
    }
    if (bufferBytes >= this.maxBufferBytes && this.flushPromise !== undefined) {
      await this.flushPromise;
      if (Buffer.byteLength(this.buffer, "utf8") >= this.flushThresholdBytes) {
        this.flushSoon();
      }
    }
  }

  async flushAndClose(): Promise<void> {
    this.closed = true;
    this.flushSoon();
    if (this.flushPromise !== undefined) {
      await this.flushPromise;
    }
  }

  private flushSoon(): void {
    if (this.flushPromise !== undefined || this.buffer.length === 0) {
      return;
    }
    const chunk = this.buffer;
    this.buffer = "";
    this.flushPromise = appendFile(this.path, chunk, "utf8")
      .finally(() => {
        this.flushPromise = undefined;
        if (this.buffer.length > 0) {
          this.flushSoon();
        }
      });
  }
}

async function drainProcessStream(
  stream: ReadableStream<Uint8Array> | number | undefined,
  onLine: (line: string) => Promise<void> | void,
): Promise<void> {
  if (!(stream instanceof ReadableStream)) {
    return;
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (value !== undefined) {
      buffer += decoder.decode(value, { stream: true });
    }
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        await onLine(line);
      }
    }
  }
  buffer += decoder.decode();
  const finalLine = buffer.replace(/\r$/, "").trim();
  if (finalLine.length > 0) {
    await onLine(finalLine);
  }
}
