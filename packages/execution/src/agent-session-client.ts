import type { AgentEvent } from "@aguil/agents-core";
import { createAgentEvent } from "@aguil/agents-core";
import {
  SessionAgentAdapter,
  type SessionAgentAdapterOptions,
} from "./session-agent-adapter";

export type SessionEventType =
  | "session_started"
  | "turn_completed"
  | "turn_failed"
  | "turn_stalled";

export interface SessionEvent {
  readonly type: SessionEventType;
  readonly timestamp: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly message?: string;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
}

export interface SessionStartParams {
  readonly runId: string;
  readonly workspacePath: string;
  readonly scratchpadPath: string;
  readonly prompt: string;
  readonly roleId?: string;
  readonly timeoutMs?: number;
}

export interface SessionContinueParams {
  readonly runId: string;
  readonly guidance: string;
  readonly turnIndex: number;
}

/** Multi-turn agent session protocol (app_server runtime). */
export interface AgentSessionClient {
  readonly protocol: string;
  startSession(params: SessionStartParams): AsyncIterable<SessionEvent>;
  continueTurn(params: SessionContinueParams): AsyncIterable<SessionEvent>;
}

export interface FakeAgentSessionClientOptions {
  readonly protocol?: string;
  readonly turnsBeforeComplete?: number;
}

export class FakeAgentSessionClient implements AgentSessionClient {
  readonly protocol: string;
  private turnCount = 0;

  constructor(options: FakeAgentSessionClientOptions = {}) {
    this.protocol = options.protocol ?? "fake_session";
  }

  async *startSession(params: SessionStartParams): AsyncIterable<SessionEvent> {
    this.turnCount = 0;
    yield* this.runTurn(params.runId, params.prompt, "session_started");
  }

  async *continueTurn(
    params: SessionContinueParams,
  ): AsyncIterable<SessionEvent> {
    yield* this.runTurn(params.runId, params.guidance, "turn_completed");
  }

  private async *runTurn(
    runId: string,
    _prompt: string,
    startType: SessionEventType,
  ): AsyncIterable<SessionEvent> {
    const threadId = `thread-${runId}`;
    const turnId = `turn-${this.turnCount}`;
    this.turnCount += 1;
    const now = new Date().toISOString();
    yield {
      type: startType,
      timestamp: now,
      sessionId: `${threadId}-${turnId}`,
      threadId,
      turnId,
    };
    yield {
      type: "turn_completed",
      timestamp: now,
      sessionId: `${threadId}-${turnId}`,
      threadId,
      turnId,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  }
}

export interface SessionAgentAdapterClientOptions
  extends SessionAgentAdapterOptions {
  readonly protocol: string;
}

/** Bridges SessionAgentAdapter to AgentSessionClient for multi-turn loops. */
export class SessionAgentAdapterClient implements AgentSessionClient {
  readonly protocol: string;
  private threadId: string | undefined;
  private workspacePath = "";
  private scratchpadPath = "";

  constructor(private readonly options: SessionAgentAdapterClientOptions) {
    this.protocol = options.protocol;
  }

  async *startSession(params: SessionStartParams): AsyncIterable<SessionEvent> {
    this.workspacePath = params.workspacePath;
    this.scratchpadPath = params.scratchpadPath;
    const adapter = new SessionAgentAdapter({
      ...this.options,
      threadId: `thread-${params.runId}`,
      turnId: "turn-0",
    });
    this.threadId = `thread-${params.runId}`;
    yield* this.mapAdapterEvents(
      adapter.run({
        runId: params.runId,
        roleId: params.roleId ?? "implementation",
        prompt: params.prompt,
        workspacePath: params.workspacePath,
        contextBundlePath: params.scratchpadPath,
        scratchpadPath: params.scratchpadPath,
        timeoutMs: params.timeoutMs ?? 3_600_000,
        allowedCommands: [],
      }),
      params.runId,
    );
  }

  async *continueTurn(
    params: SessionContinueParams,
  ): AsyncIterable<SessionEvent> {
    const threadId = this.threadId ?? `thread-${params.runId}`;
    const adapter = new SessionAgentAdapter({
      ...this.options,
      threadId,
      turnId: `turn-${params.turnIndex}`,
    });
    yield* this.mapAdapterEvents(
      adapter.run({
        runId: params.runId,
        roleId: "implementation",
        prompt: params.guidance,
        workspacePath: this.workspacePath,
        contextBundlePath: this.scratchpadPath,
        scratchpadPath: this.scratchpadPath,
        timeoutMs: 3_600_000,
        allowedCommands: [],
      }),
      params.runId,
    );
  }

  private async *mapAdapterEvents(
    events: AsyncIterable<AgentEvent>,
    runId: string,
  ): AsyncIterable<SessionEvent> {
    const threadId = this.threadId ?? `thread-${runId}`;
    for await (const event of events) {
      const data =
        typeof event.data === "object" && event.data !== null
          ? (event.data as Record<string, unknown>)
          : {};
      const turnId = typeof data.turn_id === "string" ? data.turn_id : "turn-0";
      const sessionId =
        typeof data.session_id === "string"
          ? data.session_id
          : `${threadId}-${turnId}`;
      if (event.type === "started") {
        yield {
          type: "session_started",
          timestamp: event.timestamp,
          sessionId,
          threadId,
          turnId,
          message: event.message,
        };
      }
      if (event.type === "completed") {
        yield {
          type: "turn_completed",
          timestamp: event.timestamp,
          sessionId,
          threadId,
          turnId,
          usage: {
            inputTokens: Number(data.usage_input_tokens ?? 0),
            outputTokens: Number(data.usage_output_tokens ?? 0),
            totalTokens: Number(data.usage_total_tokens ?? 0),
          },
        };
      }
      if (event.type === "error") {
        yield {
          type: "turn_failed",
          timestamp: event.timestamp,
          sessionId,
          threadId,
          turnId,
          message: event.message,
        };
      }
    }
  }
}

export function sessionEventToAgentEvent(
  runId: string,
  roleId: string,
  session: SessionEvent,
): AgentEvent {
  return createAgentEvent({
    runId,
    roleId,
    type:
      session.type === "turn_failed" || session.type === "turn_stalled"
        ? "error"
        : session.type === "session_started"
          ? "started"
          : "tool",
    message: session.message ?? session.type,
    data: {
      session_id: session.sessionId,
      thread_id: session.threadId,
      turn_id: session.turnId,
      session_event: session.type,
      ...(session.usage !== undefined
        ? {
            usage_input_tokens: session.usage.inputTokens,
            usage_output_tokens: session.usage.outputTokens,
            usage_total_tokens: session.usage.totalTokens,
          }
        : {}),
    },
  });
}
