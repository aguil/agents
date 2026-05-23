import { join } from "node:path";
import type { AgentEvent } from "@aguil/agents-core";
import { createAgentEvent, ensureDirectory } from "@aguil/agents-core";
import type {
  AdapterCapabilities,
  AgentAdapter,
  AgentRunRequest,
} from "./index";

export interface SessionAgentAdapterOptions {
  readonly command?: readonly string[] | string;
  readonly protocol?: string;
  readonly stallTimeoutMs?: number;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly appServerPid?: string | null;
}

/**
 * App-server-style session driver (stdio protocol stub). Provider command and
 * protocol come from WORKFLOW `agent.command` / `agent.protocol`.
 */
export class SessionAgentAdapter implements AgentAdapter {
  readonly name = "session";

  constructor(private readonly options: SessionAgentAdapterOptions = {}) {}

  capabilities(): AdapterCapabilities {
    return {
      streaming: true,
      structuredOutput: true,
      readOnlyMode: false,
      mcp: true,
      cancellation: false,
    };
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    await ensureDirectory(request.scratchpadPath);
    const threadId = this.options.threadId ?? `thread-${request.runId}`;
    const turnId = this.options.turnId ?? `turn-${request.roleId}`;
    const sessionId = `${threadId}-${turnId}`;
    const command = normalizeCommand(this.options.command);

    yield createAgentEvent({
      runId: request.runId,
      roleId: request.roleId,
      type: "started",
      message: "session_started",
      data: {
        session_id: sessionId,
        thread_id: threadId,
        turn_id: turnId,
        protocol: this.options.protocol ?? null,
        app_server_pid: this.options.appServerPid ?? null,
      },
    });

    yield createAgentEvent({
      runId: request.runId,
      roleId: request.roleId,
      type: "tool",
      message: "session turn streaming",
      data: {
        event: "turn_completed",
        workspace_path: request.workspacePath,
        prompt_path: join(
          request.scratchpadPath,
          `${request.roleId}.prompt.txt`,
        ),
        stall_timeout_ms: this.options.stallTimeoutMs ?? 300_000,
        command,
      },
    });

    yield createAgentEvent({
      runId: request.runId,
      roleId: request.roleId,
      type: "completed",
      message: "session turn_completed",
      data: {
        session_id: sessionId,
        usage_input_tokens: 0,
        usage_output_tokens: 0,
        usage_total_tokens: 0,
        turn_count: 1,
      },
    });
  }
}

/** @deprecated Use {@link SessionAgentAdapter}. */
export const AppServerAgentAdapter = SessionAgentAdapter;

/** @deprecated Use {@link SessionAgentAdapterOptions}. */
export type AppServerAdapterOptions = SessionAgentAdapterOptions;

/** Codex app-server profile alias. */
export const CodexAppServerAdapter = SessionAgentAdapter;

export type CodexAppServerAdapterOptions = SessionAgentAdapterOptions;

function normalizeCommand(
  command: readonly string[] | string | undefined,
): readonly string[] {
  if (command === undefined) {
    return [];
  }
  if (typeof command === "string") {
    return command.split(/\s+/).filter((p) => p.length > 0);
  }
  return command;
}
