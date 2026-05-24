import type {
  AgentSessionClient,
  SessionContinueParams,
  SessionEvent,
  SessionStartParams,
} from "./agent-session-client";

/**
 * Line-delimited JSON-RPC session driver over a provider subprocess stdio.
 * Contract-tested with an in-process fake server; no live Codex required in CI.
 */
export class JsonRpcAgentSessionClient implements AgentSessionClient {
  readonly protocol: string;

  constructor(
    private readonly options: {
      readonly command: string;
      readonly protocol?: string;
    },
  ) {
    this.protocol = options.protocol ?? "json_rpc_session_v1";
  }

  async *startSession(params: SessionStartParams): AsyncIterable<SessionEvent> {
    yield* this.exchange({
      method: "session.start",
      params: {
        workspace_path: params.workspacePath,
        prompt: params.prompt,
        run_id: params.runId,
      },
      runId: params.runId,
      startType: "session_started",
    });
  }

  async *continueTurn(
    params: SessionContinueParams,
  ): AsyncIterable<SessionEvent> {
    yield* this.exchange({
      method: "session.continue",
      params: {
        run_id: params.runId,
        guidance: params.guidance,
        turn_index: params.turnIndex,
      },
      runId: params.runId,
      startType: "turn_completed",
    });
  }

  private async *exchange(input: {
    readonly method: string;
    readonly params: Record<string, unknown>;
    readonly runId: string;
    readonly startType: SessionEvent["type"];
  }): AsyncIterable<SessionEvent> {
    const parts = this.options.command
      .trim()
      .split(/\s+/)
      .filter((p: string) => p.length > 0);
    if (parts.length === 0) {
      yield {
        type: "turn_failed",
        timestamp: new Date().toISOString(),
        sessionId: `failed-${input.runId}`,
        threadId: `thread-${input.runId}`,
        turnId: "turn-0",
        message: "empty agent.command",
      };
      return;
    }

    const request = {
      jsonrpc: "2.0",
      id: input.runId,
      method: input.method,
      params: input.params,
    };

    const proc = Bun.spawn({
      cmd: parts,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.stdin.write(`${JSON.stringify(request)}\n`);
    proc.stdin.end();

    const stdout = await new Response(proc.stdout).text();
    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const result =
        typeof parsed.result === "object" && parsed.result !== null
          ? (parsed.result as Record<string, unknown>)
          : {};
      const eventType =
        typeof result.event === "string" ? result.event : input.startType;
      const now = new Date().toISOString();
      const sessionId =
        typeof result.session_id === "string"
          ? result.session_id
          : `session-${input.runId}`;
      const threadId =
        typeof result.thread_id === "string"
          ? result.thread_id
          : `thread-${input.runId}`;
      const turnId =
        typeof result.turn_id === "string" ? result.turn_id : "turn-0";

      if (eventType === "session_started" || eventType === "turn_completed") {
        yield {
          type: eventType,
          timestamp: now,
          sessionId,
          threadId,
          turnId,
          usage: {
            inputTokens: Number(result.input_tokens ?? 0),
            outputTokens: Number(result.output_tokens ?? 0),
            totalTokens: Number(result.total_tokens ?? 0),
          },
        };
      }
      if (eventType === "turn_failed" || eventType === "turn_stalled") {
        yield {
          type: eventType,
          timestamp: now,
          sessionId,
          threadId,
          turnId,
          message:
            typeof result.message === "string" ? result.message : eventType,
        };
      }
    }

    await proc.exited;
  }
}
