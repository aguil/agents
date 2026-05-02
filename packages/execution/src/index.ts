import { createAgentEvent, ensureDirectory, writeJsonFile } from "@aguil/agents-core";
import type { AgentEvent, Finding } from "@aguil/agents-core";
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

export function validateFinding(value: unknown): FindingValidationResult {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) {
    return { valid: false, errors: ["finding must be an object"] };
  }

  const candidate = value as Partial<Finding>;
  requireString(candidate.id, "id", errors);
  if (candidate.severity !== "critical" && candidate.severity !== "warning") {
    errors.push("severity must be critical or warning");
  }
  requireString(candidate.title, "title", errors);
  requireString(candidate.description, "description", errors);
  requireString(candidate.evidence, "evidence", errors);
  requireString(candidate.sourceRole, "sourceRole", errors);

  if (candidate.file !== undefined) {
    requireString(candidate.file, "file", errors);
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
    await writeJsonFile(requestPath, request);

    yield createAgentEvent({
      runId: request.runId,
      roleId: request.roleId,
      type: "started",
      message: `${this.name} started ${request.roleId}`,
      data: { requestPath },
    });

    const command = this.options.buildCommand(request, requestPath);
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

    let timedOut = false;
    let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutTimer = request.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");
          hardKillTimer = setTimeout(() => proc.kill("SIGKILL"), 1_000);
        }, request.timeoutMs)
      : undefined;

    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      [stdout, stderr, exitCode] = await Promise.all([
        readProcessText(proc.stdout),
        readProcessText(proc.stderr),
        proc.exited,
      ]);
    } finally {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
      if (hardKillTimer !== undefined) {
        clearTimeout(hardKillTimer);
      }
    }

    for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
      for (const event of normalizeAgentOutputLine(request, line)) {
        yield event;
      }
    }

    for (const line of stderr.split(/\r?\n/).filter(Boolean)) {
      yield createAgentEvent({
        runId: request.runId,
        roleId: request.roleId,
        type: "stderr",
        message: line,
      });
    }

    if (timedOut) {
      yield createAgentEvent({
        runId: request.runId,
        roleId: request.roleId,
        type: "error",
        message: `${this.name} timed out after ${request.timeoutMs}ms`,
        data: { reason: "timed_out", timeoutMs: request.timeoutMs, exitCode },
      });
      return;
    }

    if (exitCode === 0) {
      yield createAgentEvent({
        runId: request.runId,
        roleId: request.roleId,
        type: "completed",
        message: `${this.name} completed ${request.roleId}`,
      });
      return;
    }

    yield createAgentEvent({
      runId: request.runId,
      roleId: request.roleId,
      type: "error",
      message: `${this.name} exited with code ${exitCode}`,
      data: { exitCode },
    });
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
  const finding = (value as { readonly finding?: unknown }).finding;
  const validation = validateFinding(finding);
  return { value: finding as Finding, validation };
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
  readonly agent?: string;
  readonly pure?: boolean;
  readonly printLogs?: boolean;
}

export interface ClaudeCodeAdapterOptions {
  readonly executable?: string;
  readonly model?: string;
  readonly argsTemplate?: readonly string[];
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
  return `${request.prompt}

You are running as the ${request.roleId} code-review specialist inside an autonomous review harness.

Inputs attached to this session:
- Context bundle: ${request.contextBundlePath}
- Machine-readable run request: ${request.scratchpadPath}/${request.roleId}.request.json

Rules:
- Stay read-only. Do not edit files.
- Use generic repository commands only when useful: ${request.allowedCommands.join(", ") || "none"}.
- Report only critical or warning issues with concrete evidence.
- Do not report nitpicks, style preferences, or speculative hardening ideas.
- Every finding must include validation details. Use validation.status "verified" only when you validated the issue.

When you find an issue, emit it as a JSON line exactly shaped like:
{"finding":{"id":"${request.roleId}-short-stable-id","severity":"warning","title":"Concise title","description":"What is wrong and why it matters","evidence":"Specific code or command evidence","sourceRole":"${request.roleId}","validation":{"status":"verified","details":"How this was validated"},"file":"path/to/file.ts","line":1}}

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
  return `${request.prompt}

You are the ${request.roleId} specialist in an autonomous code-review harness.

Inputs:
- Context bundle: ${request.contextBundlePath}
- Machine-readable run request: ${requestPath}

Rules:
- Stay read-only. Do not edit files.
- Report only critical or warning findings with concrete evidence.
- Ignore style-only feedback and speculative nitpicks.
- Emit each finding as a single JSON line with a top-level \"finding\" object.

Required finding shape:
{"finding":{"id":"${request.roleId}-short-stable-id","severity":"warning","title":"Concise title","description":"What is wrong and why it matters","evidence":"Specific code or command evidence","sourceRole":"${request.roleId}","validation":{"status":"verified","details":"How this was validated"},"file":"path/to/file.ts","line":1}}

If no verified critical or warning findings exist, do not emit any finding JSON line.`;
}

function substituteTemplateArg(
  arg: string,
  substitutions: Readonly<Record<string, string>>,
): string {
  return arg.replaceAll(/\{([a-z_]+)\}/g, (full, key: string) => substitutions[key] ?? full);
}

async function readProcessText(
  stream: ReadableStream<Uint8Array> | number | undefined,
): Promise<string> {
  if (!(stream instanceof ReadableStream)) {
    return "";
  }
  return new Response(stream).text();
}
