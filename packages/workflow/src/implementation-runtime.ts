import { resolveShellCommand } from "./resolve-vars";
import type {
  AgentRuntimeMode,
  ImplementationExecutionConfig,
  ImplementationSubprocessAdapter,
} from "./types";

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function parseRuntimeMode(value: unknown): AgentRuntimeMode {
  if (value === "app_server" || value === "app-server") {
    return "app_server";
  }
  return "subprocess";
}

function parseSubprocessAdapter(
  value: unknown,
): ImplementationSubprocessAdapter {
  if (
    value === "opencode" ||
    value === "claude" ||
    value === "cursor" ||
    value === "fake"
  ) {
    return value;
  }
  return "fake";
}

function positiveIntOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return null;
}

/** Map Symphony `codex:` front matter into agent fields when not already set. */
export function applyCodexAlias(
  agent: Record<string, unknown>,
  codex: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...agent };
  if (out.command === undefined && typeof codex.command === "string") {
    out.command = codex.command;
  }
  if (out.runtime === undefined && codex.command !== undefined) {
    out.runtime = "app_server";
  }
  if (
    out.turn_timeout_ms === undefined &&
    codex.turn_timeout_ms !== undefined
  ) {
    out.turn_timeout_ms = codex.turn_timeout_ms;
  }
  if (
    out.stall_timeout_ms === undefined &&
    codex.stall_timeout_ms !== undefined
  ) {
    out.stall_timeout_ms = codex.stall_timeout_ms;
  }
  return out;
}

export function parseImplementationExecution(input: {
  readonly config: Readonly<Record<string, unknown>>;
  readonly workflowDir: string;
  readonly env: NodeJS.ProcessEnv;
}): ImplementationExecutionConfig {
  let agent = asRecord(input.config.agent);
  const codex = asRecord(input.config.codex);
  if (Object.keys(codex).length > 0) {
    agent = applyCodexAlias(agent, codex);
  }

  const execution = asRecord(input.config.execution);
  const impl = asRecord(execution.implementation);

  const mode = parseRuntimeMode(impl.mode ?? agent.runtime);
  const adapter = parseSubprocessAdapter(
    impl.adapter ?? agent.implementation_adapter,
  );

  const command =
    resolveShellCommand(agent.command, { env: input.env }) ?? null;

  const protocol =
    typeof agent.protocol === "string" && agent.protocol.length > 0
      ? agent.protocol
      : null;

  const stallTimeoutMs =
    positiveIntOrNull(agent.stall_timeout_ms) ??
    positiveIntOrNull(codex.stall_timeout_ms) ??
    300_000;

  const turnTimeoutMs =
    positiveIntOrNull(agent.turn_timeout_ms) ??
    positiveIntOrNull(codex.turn_timeout_ms);

  return {
    mode,
    adapter,
    command,
    protocol,
    turnTimeoutMs,
    stallTimeoutMs,
  };
}

export function validateImplementationRuntime(
  impl: ImplementationExecutionConfig,
): string | undefined {
  if (impl.mode === "app_server") {
    if (impl.command === null || impl.command.trim().length === 0) {
      return "agent.command is required when agent.runtime is app_server";
    }
  }
  return undefined;
}
