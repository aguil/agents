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
      signal: params.signal,
      timeoutMs: params.timeoutMs,
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
      signal: params.signal,
      timeoutMs: params.timeoutMs,
    });
  }

  private async *exchange(input: {
    readonly method: string;
    readonly params: Record<string, unknown>;
    readonly runId: string;
    readonly startType: SessionEvent["type"];
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  }): AsyncIterable<SessionEvent> {
    const parts = this.options.command
      .trim()
      .split(/\s+/)
      .filter((p: string) => p.length > 0);
    if (parts.length === 0) {
      yield failedEvent(input.runId, "empty agent.command");
      return;
    }

    if (input.signal?.aborted) {
      yield failedEvent(input.runId, "aborted");
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

    let abortHardKillTimer: ReturnType<typeof setTimeout> | undefined;
    let aborted = false;
    let timedOut = false;
    const killProc = (): void => {
      proc.kill("SIGTERM");
      abortHardKillTimer = setTimeout(() => proc.kill("SIGKILL"), 1_000);
    };
    const onAbort = (): void => {
      aborted = true;
      killProc();
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    let turnTimer: ReturnType<typeof setTimeout> | undefined;
    if (input.timeoutMs !== undefined && input.timeoutMs > 0) {
      turnTimer = setTimeout(() => {
        timedOut = true;
        aborted = true;
        killProc();
      }, input.timeoutMs);
    }

    proc.stdin.write(`${JSON.stringify(request)}\n`);
    proc.stdin.end();

    const stderrDone = drainStderr(proc.stderr);

    let emitted = false;
    try {
      for await (const line of readStdoutLines(
        proc.stdout,
        input.signal,
        killProc,
      )) {
        if (aborted || input.signal?.aborted) {
          break;
        }
        for (const event of parseSessionEventsFromLine(line, input)) {
          emitted = true;
          yield event;
        }
      }

      if (aborted || input.signal?.aborted) {
        yield failedEvent(input.runId, timedOut ? "turn timeout" : "aborted");
        await stderrDone;
        await settleAbortedSubprocess(proc, abortHardKillTimer);
        return;
      }

      const exitCode = await proc.exited;
      const stderr = await stderrDone;
      if (exitCode !== 0 || !emitted) {
        yield failedEvent(
          input.runId,
          exitCode !== 0
            ? `json-rpc subprocess exited ${exitCode}${stderr.trim().length > 0 ? `: ${stderr.trim()}` : ""}`
            : "json-rpc subprocess produced no session events",
        );
      }
    } catch (error) {
      if (isAbortError(error) || aborted || input.signal?.aborted) {
        yield failedEvent(input.runId, timedOut ? "turn timeout" : "aborted");
        await stderrDone;
        await settleAbortedSubprocess(proc, abortHardKillTimer);
        return;
      }
      throw error;
    } finally {
      if (turnTimer !== undefined) {
        clearTimeout(turnTimer);
      }
      input.signal?.removeEventListener("abort", onAbort);
    }
  }
}

function failedEvent(runId: string, message: string): SessionEvent {
  return {
    type: "turn_failed",
    timestamp: new Date().toISOString(),
    sessionId: `failed-${runId}`,
    threadId: `thread-${runId}`,
    turnId: "turn-0",
    message,
  };
}

function* parseSessionEventsFromLine(
  line: string,
  input: {
    readonly runId: string;
    readonly startType: SessionEvent["type"];
  },
): Generator<SessionEvent> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (parsed.error !== undefined && parsed.error !== null) {
    const err = parsed.error;
    const message =
      typeof err === "object" &&
      err !== null &&
      typeof (err as { message?: unknown }).message === "string"
        ? (err as { message: string }).message
        : JSON.stringify(err);
    yield {
      type: "turn_failed",
      timestamp: new Date().toISOString(),
      sessionId: `session-${input.runId}`,
      threadId: `thread-${input.runId}`,
      turnId: "turn-0",
      message,
    };
    return;
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
  const turnId = typeof result.turn_id === "string" ? result.turn_id : "turn-0";

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
      message: typeof result.message === "string" ? result.message : eventType,
    };
  }
}

async function* readStdoutLines(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  onAbortKill: () => void,
): AsyncGenerator<string> {
  if (signal?.aborted) {
    onAbortKill();
    throw new DOMException("Aborted", "AbortError");
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) {
        onAbortKill();
        throw new DOMException("Aborted", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          yield line;
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail.length > 0) {
      yield tail;
    }
  } finally {
    reader.releaseLock();
  }
}

async function settleAbortedSubprocess(
  proc: ReturnType<typeof Bun.spawn>,
  hardKillTimer: ReturnType<typeof setTimeout> | undefined,
): Promise<void> {
  await Promise.race([
    proc.exited,
    new Promise<void>((resolve) => {
      setTimeout(resolve, hardKillTimer === undefined ? 0 : 1_100);
    }),
  ]);
  if (hardKillTimer !== undefined) {
    clearTimeout(hardKillTimer);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Keep a bounded tail for failure messages without unbounded buffering. */
const STDERR_TAIL_MAX_BYTES = 8_192;

function drainStderr(stream: ReadableStream<Uint8Array>): Promise<string> {
  return drainStreamTail(stream, STDERR_TAIL_MAX_BYTES).catch(() => "");
}

async function drainStreamTail(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      tail += decoder.decode(value, { stream: true });
      if (tail.length > maxBytes) {
        tail = tail.slice(-maxBytes);
      }
      if (totalBytes > maxBytes * 4) {
        reader.cancel().catch(() => {});
        break;
      }
    }
    tail += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return tail;
}
