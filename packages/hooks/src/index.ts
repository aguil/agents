import {
  HOOK_EVENTS,
  type HookEvent,
  type HookEventClass,
  type HookHandlerSpec,
  type HooksSpec,
} from "@aguil/agents-harness-config";
import {
  ADAPTER_HOOK_CAPABILITIES,
  adapterDispatchableEvents,
  adapterHookCapabilities,
} from "./adapter-table";

export {
  ADAPTER_HOOK_CAPABILITIES,
  type AdapterHookCapabilities,
  adapterCanDeny,
  adapterDispatchableEvents,
  adapterHookCapabilities,
  adapterProbeEventNames,
  allEnforceableProbeEventNames,
  HOOK_ADAPTER_IDS,
  type HookAdapterId,
} from "./adapter-table";

export {
  assertWellFormedClaudeSettings,
  type ClaudeHookEvent,
  type ClaudeHookHandler,
  type ClaudeMatcherGroup,
  type ClaudeSettingsConfig,
  type GenerateClaudeHooksOptions,
  type GeneratedClaudeHooks,
  generateClaudeHooksConfig,
  renderClaudeSettingsConfig,
} from "./claude";

/** Cursor hook events we target (subset relevant to command handlers). */
export type CursorHookEvent =
  | "beforeShellExecution"
  | "beforeMCPExecution"
  | "afterFileEdit"
  | "stop";

/**
 * Canonical → Cursor event projection (dotagents-compatible mapping).
 * Derived from `ADAPTER_HOOK_CAPABILITIES` so the generator and the drift
 * matrix cannot disagree (ADR 0023 decision 1).
 */
export const CURSOR_EVENT_MAPPING: Readonly<
  Partial<Record<HookEvent, readonly CursorHookEvent[]>>
> = (() => {
  const row = adapterHookCapabilities("cursor");
  if (row === undefined) {
    return {};
  }
  const out: Partial<Record<HookEvent, readonly CursorHookEvent[]>> = {};
  for (const [event, natives] of Object.entries(row.nativeEvents) as Array<
    [HookEvent, readonly string[]]
  >) {
    if (natives.length > 0) {
      out[event] = natives as readonly CursorHookEvent[];
    }
  }
  return out;
})();

/**
 * Lifecycle events that stay undispatchable for *every* adapter today
 * (ADR 0024): run-level events must never map onto a session. `role_start`
 * is adapter-dependent — Claude maps `SessionStart`; Cursor does not.
 */
export const UNDISPATCHABLE_LIFECYCLE_EVENTS = [
  "role_start",
  "run_start",
  "run_end",
] as const satisfies readonly HookEvent[];

export type UndispatchableLifecycleEvent =
  (typeof UNDISPATCHABLE_LIFECYCLE_EVENTS)[number];

const LIFECYCLE_REASON: Readonly<Record<UndispatchableLifecycleEvent, string>> =
  {
    role_start:
      "no adapter event mapping exists for role_start under the active generator",
    run_start:
      "run-level lifecycle is the orchestrator's to dispatch; an adapter session cannot identify a run boundary",
    run_end:
      "run-level lifecycle is the orchestrator's to dispatch; an adapter session cannot identify a run boundary",
  };

/**
 * Warnings for harness-declared lifecycle handlers that cannot fire under
 * the active adapter's generator (ADR 0024). Defaults to Cursor when no
 * adapter is named (the historical path).
 */
export function undispatchableLifecycleHookWarnings(
  hooks: HooksSpec,
  adapter: string = "cursor",
): readonly string[] {
  const dispatchable = adapterDispatchableEvents(adapter);
  const warnings: string[] = [];
  for (const event of UNDISPATCHABLE_LIFECYCLE_EVENTS) {
    if ((hooks[event]?.length ?? 0) === 0) {
      continue;
    }
    if (dispatchable.has(event)) {
      continue;
    }
    warnings.push(
      `hooks.${event}: declared handler cannot fire — ${LIFECYCLE_REASON[event]} (ADR 0024)`,
    );
  }
  return warnings;
}

/** Whether Cursor generation maps this canonical event onto at least one native event. */
export function cursorMapsHookEvent(event: HookEvent): boolean {
  return (CURSOR_EVENT_MAPPING[event]?.length ?? 0) > 0;
}

/** Every canonical hook event and whether Cursor generation can dispatch it. */
export function cursorHookEventDispatchability(): ReadonlyArray<{
  readonly event: HookEvent;
  readonly dispatchable: boolean;
}> {
  return HOOK_EVENTS.map((event) => ({
    event,
    dispatchable: cursorMapsHookEvent(event),
  }));
}

/**
 * Drift matrix: every HookEvent × every adapter row, for the contract test
 * (ADR 0023 JC-7 / ADR 0024 §4).
 */
export function hookEventAdapterDispatchability(): ReadonlyArray<{
  readonly adapter: string;
  readonly event: HookEvent;
  readonly dispatchable: boolean;
  readonly canDeny: boolean;
}> {
  const rows: Array<{
    readonly adapter: string;
    readonly event: HookEvent;
    readonly dispatchable: boolean;
    readonly canDeny: boolean;
  }> = [];
  for (const caps of ADAPTER_HOOK_CAPABILITIES) {
    for (const event of HOOK_EVENTS) {
      rows.push({
        adapter: caps.adapter,
        event,
        dispatchable: (caps.nativeEvents[event]?.length ?? 0) > 0,
        canDeny: caps.canDeny,
      });
    }
  }
  return rows;
}

/**
 * Event-class classification of Cursor tool events (spec v0.2
 * `applies_to`). A handler scoped to a class list only registers on Cursor
 * events belonging to those classes, so a shell-only handler no longer
 * spawns on every MCP call (#71).
 */
const CURSOR_EVENT_CLASS: Readonly<
  Partial<Record<CursorHookEvent, HookEventClass>>
> = {
  beforeShellExecution: "shell",
  beforeMCPExecution: "mcp",
  afterFileEdit: "edit",
};

function handlerRegistersOn(
  handler: HookHandlerSpec,
  cursorEvent: CursorHookEvent,
): boolean {
  if (handler.appliesTo === undefined) {
    return true;
  }
  const eventClass = CURSOR_EVENT_CLASS[cursorEvent];
  // Non-tool events (e.g. stop) have no class; applies_to never narrows
  // them — the loader already rejects applies_to on non-tool-call events.
  return eventClass === undefined || handler.appliesTo.includes(eventClass);
}

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
  // or metacharacters. Default format stays Cursor (ADR 0023 decision 6).
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
    if (cursorEvents === undefined || cursorEvents.length === 0) {
      skippedEvents.push(event);
      continue;
    }
    for (const cursorEvent of cursorEvents) {
      for (const handler of handlers) {
        if (handlerRegistersOn(handler, cursorEvent)) {
          push(cursorEvent, toCursorEntry(handler));
        }
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
