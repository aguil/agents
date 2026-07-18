import type {
  HookEvent,
  HookHandlerSpec,
  HooksSpec,
} from "@aguil/agents-harness-config";

/** Cursor hook events we target (subset relevant to command handlers). */
export type CursorHookEvent =
  | "beforeShellExecution"
  | "beforeMCPExecution"
  | "afterFileEdit"
  | "stop";

/**
 * Canonical → Cursor event projection (dotagents-compatible mapping).
 * Events with no Cursor equivalent are reported as skipped, never silently
 * dropped.
 */
const CURSOR_EVENT_MAPPING: Readonly<
  Partial<Record<HookEvent, readonly CursorHookEvent[]>>
> = {
  pre_tool_call: ["beforeShellExecution", "beforeMCPExecution"],
  post_tool_call: ["afterFileEdit"],
  role_stop: ["stop"],
};

export interface CursorHookEntry {
  readonly command: string;
  readonly timeout?: number;
}

export interface CursorHooksConfig {
  readonly version: 1;
  readonly hooks: Readonly<
    Partial<Record<CursorHookEvent, readonly CursorHookEntry[]>>
  >;
}

export interface GenerateCursorHooksOptions {
  readonly hooks: HooksSpec;
  /**
   * When true, registers the builtin env-carried policy bridge as the FIRST
   * handler on every mapped tool event. The bridge reads AGENTS_POLICY_ID /
   * AGENTS_AGENTS_DIR from its inherited process environment, so the generated
   * file is role- and run-invariant.
   */
  readonly policyBridge?: boolean;
  /** CLI executable used for the builtin bridge (default: "agents"). */
  readonly agentsCli?: string;
}

export interface GeneratedCursorHooks {
  readonly config: CursorHooksConfig;
  /** Canonical events that have no Cursor equivalent. */
  readonly skippedEvents: readonly HookEvent[];
}

function policyBridgeEntry(
  options: GenerateCursorHooksOptions,
): CursorHookEntry | undefined {
  if (options.policyBridge !== true) {
    return undefined;
  }
  // Defense in depth: this command lands in a shell-executed config file,
  // so quote the CLI token, which may be an operator-supplied path with spaces
  // or metacharacters.
  const cli = JSON.stringify(options.agentsCli ?? "agents");
  return { command: `${cli} policy-eval` };
}

function toCursorEntry(handler: HookHandlerSpec): CursorHookEntry {
  // Cursor's hook schema has no matcher field, so the matcher is projected
  // into the command itself as a HOOK_MATCHER environment variable the
  // handler script can filter on (hook payloads carry the tool name).
  const command =
    handler.matcher === undefined
      ? handler.command
      : `HOOK_MATCHER=${JSON.stringify(handler.matcher)} ${handler.command}`;
  return {
    command,
    ...(handler.timeoutS === undefined ? {} : { timeout: handler.timeoutS }),
  };
}

/**
 * Project canonical harness hooks (+ builtin policy bridge) into Cursor's
 * `.cursor/hooks.json` shape.
 */
export function generateCursorHooksConfig(
  options: GenerateCursorHooksOptions,
): GeneratedCursorHooks {
  const entries: Partial<Record<CursorHookEvent, CursorHookEntry[]>> = {};
  const skippedEvents: HookEvent[] = [];

  const push = (cursorEvent: CursorHookEvent, entry: CursorHookEntry): void => {
    const existing = entries[cursorEvent];
    if (existing === undefined) {
      entries[cursorEvent] = [entry];
    } else {
      existing.push(entry);
    }
  };

  const bridge = policyBridgeEntry(options);
  if (bridge !== undefined) {
    // ADR 0006 §3: the policy bridge is the first handler on EVERY mapped
    // tool event, not just pre-tool projections — post_tool_call's
    // afterFileEdit needs policy evaluation before user hooks too.
    const toolEvents: readonly HookEvent[] = [
      "pre_tool_call",
      "post_tool_call",
    ];
    const seen = new Set<CursorHookEvent>();
    for (const event of toolEvents) {
      for (const cursorEvent of CURSOR_EVENT_MAPPING[event] ?? []) {
        if (!seen.has(cursorEvent)) {
          seen.add(cursorEvent);
          push(cursorEvent, bridge);
        }
      }
    }
  }

  for (const [event, handlers] of Object.entries(
    options.hooks,
  ) as ReadonlyArray<[HookEvent, readonly HookHandlerSpec[]]>) {
    const cursorEvents = CURSOR_EVENT_MAPPING[event];
    if (cursorEvents === undefined) {
      skippedEvents.push(event);
      continue;
    }
    for (const cursorEvent of cursorEvents) {
      for (const handler of handlers) {
        push(cursorEvent, toCursorEntry(handler));
      }
    }
  }

  return {
    config: { version: 1, hooks: entries },
    skippedEvents,
  };
}

export function renderCursorHooksConfig(config: CursorHooksConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}
