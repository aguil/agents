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

export function isFinding(value: unknown): value is Finding {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<Finding>;
  return (
    typeof candidate.id === "string" &&
    (candidate.severity === "critical" || candidate.severity === "warning") &&
    typeof candidate.title === "string" &&
    typeof candidate.description === "string" &&
    typeof candidate.evidence === "string" &&
    typeof candidate.sourceRole === "string" &&
    typeof candidate.validation === "object" &&
    candidate.validation !== null
  );
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
    const proc = Bun.spawn({
      cmd: [...command.cmd],
      cwd: command.cwd ?? request.workspacePath,
      env: {
        ...Bun.env,
        ...command.env,
        AGENTS_REQUEST_PATH: requestPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
      yield normalizeStdoutLine(request, line);
    }

    for (const line of stderr.split(/\r?\n/).filter(Boolean)) {
      yield createAgentEvent({
        runId: request.runId,
        roleId: request.roleId,
        type: "stderr",
        message: line,
      });
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
      status = "failed";
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

function normalizeStdoutLine(request: AgentRunRequest, line: string): AgentEvent {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (isFindingEnvelope(parsed)) {
      return createAgentEvent({
        runId: request.runId,
        roleId: request.roleId,
        type: "finding",
        message: parsed.finding.title,
        data: parsed.finding,
      });
    }
    if (isAgentEventEnvelope(parsed)) {
      return createAgentEvent({
        runId: parsed.runId ?? request.runId,
        roleId: parsed.roleId ?? request.roleId,
        type: parsed.type,
        message: parsed.message,
        data: parsed.data,
      });
    }
    return createAgentEvent({
      runId: request.runId,
      roleId: request.roleId,
      type: "stdout",
      message: line,
      data: parsed,
    });
  } catch {
    return createAgentEvent({
      runId: request.runId,
      roleId: request.roleId,
      type: "stdout",
      message: line,
    });
  }
}

function isFindingEnvelope(value: unknown): value is { readonly finding: Finding } {
  return (
    typeof value === "object" &&
    value !== null &&
    "finding" in value &&
    isFinding((value as { readonly finding?: unknown }).finding)
  );
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
