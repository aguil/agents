import {
  HOOK_EVENT_CLASSES,
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
  bridgeRunsOn,
  HOOK_CLASS_TOOL_NAMES,
} from "./adapter-table";
import { compileHookMatcher, hookGateCommand, shellWord } from "./gate";

export {
  ADAPTER_HOOK_CAPABILITIES,
  type AdapterHookCapabilities,
  adapterCanDeny,
  adapterDispatchableEvents,
  adapterHookCapabilities,
  adapterProbeEventNames,
  allEnforceableProbeEventNames,
  bridgeRunsOn,
  HOOK_ADAPTER_IDS,
  HOOK_CLASS_TOOL_NAMES,
  type HookAdapterId,
  type NativeToolEvent,
  type ToolNameSource,
  toolNameClass,
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
export {
  compileHookMatcher,
  decideHookGate,
  type HookGateAdapter,
  type HookGateArgs,
  type HookGateDecision,
  hookGateCommand,
  parseHookGateArgv,
  shellWord,
} from "./gate";

/** Cursor hook events we target (subset relevant to command handlers). */
export type CursorHookEvent =
  | "beforeShellExecution"
  | "beforeMCPExecution"
  | "beforeReadFile"
  | "preToolUse"
  | "afterFileEdit"
  | "afterShellExecution"
  | "afterMCPExecution"
  | "stop";

/**
 * `cursor-agent` versions measured to fire `beforeReadFile` headless and to
 * block a read on `{"permission":"deny"}` (#198). Exact versions only, never
 * "this or later": an event the installed CLI does not know silently stops
 * every other hook in the workspace, the shell bridge included (#239). A new
 * version joins this list by re-running that measurement on it.
 */
export const CURSOR_READ_HOOK_VERSIONS: readonly string[] = [
  "2026.10.01-14929f9",
];

/** Whether `beforeReadFile` may be registered for this `cursor-agent --version`. */
export function cursorSupportsReadHook(version: string): boolean {
  return CURSOR_READ_HOOK_VERSIONS.includes(version.trim());
}

/**
 * The warning printed when `beforeReadFile` is withheld (#198): native reads
 * on this CLI go unchecked, as they did before the hook existed.
 */
export function cursorReadHookWithheldWarning(version: string): string {
  const found = version.trim();
  const why =
    found === ""
      ? "the installed cursor-agent's version could not be read"
      : `cursor-agent ${found} is not a version measured to support it`;
  return (
    `hooks: beforeReadFile withheld — ${why} ` +
    `(supported: ${CURSOR_READ_HOOK_VERSIONS.join(", ")}), so Cursor's ` +
    "native file reads are not checked against filesystem rules in this run"
  );
}

/**
 * `cursor-agent` versions measured to fire the user-hook events ADR 0028
 * adds, `preToolUse`, `afterShellExecution` and `afterMCPExecution`, headless.
 * Exact versions only, as for `CURSOR_READ_HOOK_VERSIONS`, which measures a
 * different property: an event the installed CLI does not know silently
 * stops every other hook in the workspace, the bridge included (#239).
 */
export const CURSOR_USER_HOOK_EVENT_VERSIONS: readonly string[] = [
  "2026.10.01-14929f9",
];

/** Whether ADR 0028's added user-hook events may be written for this version. */
export function cursorSupportsUserHookEvents(version: string): boolean {
  return CURSOR_USER_HOOK_EVENT_VERSIONS.includes(version.trim());
}

/**
 * The warning printed when the added user-hook events are withheld (ADR 0028
 * decision 5): the harness's tool-call hooks miss those calls on this CLI.
 */
export function cursorUserHookEventsWithheldWarning(
  version: string,
  withheld: readonly string[],
): string {
  const found = version.trim();
  const why =
    found === ""
      ? "the installed cursor-agent's version could not be read"
      : `cursor-agent ${found} is not a version measured to fire them`;
  return (
    `hooks: ${withheld.join(", ")} withheld — ${why} ` +
    `(supported: ${CURSOR_USER_HOOK_EVENT_VERSIONS.join(", ")}), so the ` +
    "harness's tool-call hooks do not run on those events' calls in this run (ADR 0028)"
  );
}

/**
 * Canonical → Cursor event projection (dotagents-compatible mapping).
 * Derived from `ADAPTER_HOOK_CAPABILITIES` so the generator and the drift
 * matrix cannot disagree (ADR 0023 decision 1).
 */
const CURSOR_EVENT_MAPPING: Readonly<
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
 * Canonical lifecycle hook events that may be inert under a given adapter
 * (ADR 0024). This is the checklist `undispatchableLifecycleHookWarnings`
 * walks — not a claim that every entry is undispatchable on every adapter.
 *
 * - `run_start` / `run_end` are never mapped by any generator (orchestrator
 *   territory; an adapter session cannot identify a run boundary).
 * - `role_start` is adapter-dependent: Claude maps `SessionStart`; Cursor
 *   has no equivalent. Whether a declared handler warns depends on the
 *   active adapter's row in `ADAPTER_HOOK_CAPABILITIES`.
 * - `role_stop` is adapter-dependent the same way: Cursor and Claude map it,
 *   and an adapter with no generator (`opencode`, `fake`) cannot.
 */
export const LIFECYCLE_HOOK_EVENTS = [
  "role_start",
  "role_stop",
  "run_start",
  "run_end",
] as const satisfies readonly HookEvent[];

export type LifecycleHookEvent = (typeof LIFECYCLE_HOOK_EVENTS)[number];

const LIFECYCLE_REASON: Readonly<Record<LifecycleHookEvent, string>> = {
  role_start:
    "no adapter event mapping exists for role_start under the active generator",
  role_stop:
    "no adapter event mapping exists for role_stop under the active generator",
  run_start:
    "run-level lifecycle is the orchestrator's to dispatch; an adapter session cannot identify a run boundary",
  run_end:
    "run-level lifecycle is the orchestrator's to dispatch; an adapter session cannot identify a run boundary",
};

/**
 * Harness-declared lifecycle events that cannot fire under the active
 * adapter's generator (ADR 0024), in `LIFECYCLE_HOOK_EVENTS` order. The
 * setup warnings and the run result's `undeliverable_hooks` record both read
 * this list, so they cannot disagree. Defaults to Cursor when no adapter is
 * named (the historical path).
 */
export function undeliverableLifecycleHookEvents(
  hooks: HooksSpec,
  adapter: string = "cursor",
): readonly LifecycleHookEvent[] {
  const dispatchable = adapterDispatchableEvents(adapter);
  return LIFECYCLE_HOOK_EVENTS.filter(
    (event) => (hooks[event]?.length ?? 0) > 0 && !dispatchable.has(event),
  );
}

/**
 * Warnings for harness-declared lifecycle handlers that cannot fire under
 * the active adapter's generator (ADR 0024), one per event from
 * `undeliverableLifecycleHookEvents`.
 */
export function undispatchableLifecycleHookWarnings(
  hooks: HooksSpec,
  adapter: string = "cursor",
): readonly string[] {
  return undeliverableLifecycleHookEvents(hooks, adapter).map(
    (event) =>
      `hooks.${event}: declared handler cannot fire — ${LIFECYCLE_REASON[event]} (ADR 0024)`,
  );
}

/**
 * Warnings for tool-call handlers whose `matcher` can never select a shell or
 * edit call on this adapter (ADR 0028 decision 8, #220). Each handler is
 * checked against the shell and edit names of the classes it registers on,
 * tested whole as the gate tests them. MCP names are an open set, so a
 * handler whose only class is mcp is not checked, and one that also
 * registers on mcp is told it runs only on matching MCP calls. An adapter
 * with no gated events (`opencode`, `fake`) gets none.
 */
export function unmatchableMatcherWarnings(
  hooks: HooksSpec,
  adapter: string = "cursor",
): readonly string[] {
  const row = adapterHookCapabilities(adapter);
  if (row === undefined) {
    return [];
  }
  const warnings: string[] = [];
  for (const event of ["pre_tool_call", "post_tool_call"] as const) {
    for (const [index, handler] of (hooks[event] ?? []).entries()) {
      if (handler.matcher === undefined) {
        continue;
      }
      const classes = new Set<HookEventClass>();
      for (const native of row.nativeEvents[event]) {
        const toolEvent = row.toolEvents[native];
        for (const eventClass of toolEvent === undefined
          ? []
          : registrationClasses(handler, toolEvent.classes)) {
          classes.add(eventClass);
        }
      }
      const named = HOOK_EVENT_CLASSES.filter(
        (eventClass): eventClass is "shell" | "edit" =>
          eventClass !== "mcp" && classes.has(eventClass),
      );
      if (named.length === 0) {
        continue;
      }
      const names = named.flatMap((eventClass) => [
        ...HOOK_CLASS_TOOL_NAMES[eventClass],
      ]);
      let regex: RegExp;
      try {
        regex = compileHookMatcher(handler.matcher);
      } catch {
        // The loader rejects it first; nothing to add here.
        continue;
      }
      if (names.some((name) => regex.test(name))) {
        continue;
      }
      const scope =
        handler.appliesTo === undefined
          ? "no applies_to (every class)"
          : `applies_to [${handler.appliesTo.join(", ")}]`;
      const listed = named
        .map(
          (eventClass) =>
            `${eventClass}: ${HOOK_CLASS_TOOL_NAMES[eventClass].join(", ")}`,
        )
        .join("; ");
      const outcome = classes.has("mcp")
        ? "so it never runs on a shell or edit call, and runs only on MCP calls whose mcp__<server>__<tool> name it matches"
        : "so it never runs";
      warnings.push(
        `hooks.${event}[${index}]: matcher ${JSON.stringify(handler.matcher)} ` +
          `matches no ${named.join(" or ")} tool name on adapter ${adapter} ` +
          `(${listed}) with ${scope}, ${outcome} (ADR 0028)`,
      );
    }
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
 * (ADR 0023 decision 1 / ADR 0024 §4).
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
   * handler on every mapped tool event but the user-hook events. The bridge reads AGENTS_POLICY_ID /
   * AGENTS_AGENTS_DIR from its inherited process environment, so the generated
   * file is role- and run-invariant.
   */
  readonly policyBridge?: boolean;
  /**
   * CLI executable used for the builtin bridge and the hook gate (default:
   * "agents", on the hook's PATH).
   */
  readonly agentsCli?: string;
  /**
   * Workspace root passed to the bridge as `--workspace`, so absolute paths
   * inside it are classified as workspace-relative, as on Claude (#198).
   */
  readonly workspaceRoot?: string;
  /**
   * Register the bridge, and only the bridge, on `beforeReadFile`. Set it only
   * when `cursorSupportsReadHook` holds for the installed CLI. No
   * user-declared handler attaches to the event: it carries the file's
   * content, and no `applies_to` class scopes a handler away from reads.
   */
  readonly readHook?: boolean;
  /**
   * Write ADR 0028's added user-hook events. Set it only when
   * `cursorSupportsUserHookEvents` holds for the installed CLI; otherwise
   * they are withheld and returned in `withheldEvents`.
   */
  readonly userHookEvents?: boolean;
}

export interface GeneratedCursorHooks {
  readonly config: CursorHooksConfig;
  /** Canonical events that have no Cursor equivalent. */
  readonly skippedEvents: readonly HookEvent[];
  /**
   * User-hook events a declared handler would register on but that were not
   * written, because `userHookEvents` was not set (ADR 0028 decision 5).
   */
  readonly withheldEvents: readonly CursorHookEvent[];
  /**
   * Each distinct gate command, with `--probe`, for the start-up check (ADR
   * 0028 decision 7).
   */
  readonly gateProbes: readonly string[];
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
  // The root comes from the run, never the payload, and is single-quoted so a
  // shell expands nothing in it.
  const workspace =
    options.workspaceRoot === undefined
      ? ""
      : ` --workspace '${options.workspaceRoot.replaceAll("'", "'\\''")}'`;
  return { command: `${cli} policy-eval${workspace}` };
}

function toCursorEntry(
  handler: HookHandlerSpec,
  command: string,
): CursorHookEntry {
  return {
    command,
    ...(handler.timeoutS === undefined ? {} : { timeout: handler.timeoutS }),
  };
}

/**
 * A lifecycle handler is not gated (ADR 0028 decision 1). Its `matcher`
 * still reaches it as `HOOK_MATCHER`, single-quoted so the shell expands
 * nothing in it.
 */
function lifecycleCommand(handler: HookHandlerSpec): string {
  return handler.matcher === undefined
    ? handler.command
    : `HOOK_MATCHER=${shellWord(handler.matcher)} ${handler.command}`;
}

/**
 * The classes one registration carries: the event's, narrowed by the
 * handler's `applies_to`; absence means all of them (ADR 0009 decision 1).
 */
function registrationClasses(
  handler: HookHandlerSpec,
  eventClasses: readonly HookEventClass[],
): readonly HookEventClass[] {
  return eventClasses.filter(
    (eventClass) =>
      handler.appliesTo === undefined || handler.appliesTo.includes(eventClass),
  );
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

  const row = adapterHookCapabilities("cursor");
  const bridge = policyBridgeEntry(options);
  if (bridge !== undefined) {
    // ADR 0006 §3: the policy bridge is the first handler on every mapped
    // tool event, not just pre-tool projections — post_tool_call's
    // afterFileEdit needs policy evaluation before user hooks too. ADR 0028
    // is the exception: its user-hook events carry no bridge.
    const toolEvents: readonly HookEvent[] = [
      "pre_tool_call",
      "post_tool_call",
    ];
    const seen = new Set<CursorHookEvent>();
    for (const event of toolEvents) {
      for (const cursorEvent of CURSOR_EVENT_MAPPING[event] ?? []) {
        if (row !== undefined && !bridgeRunsOn(row, cursorEvent)) {
          continue;
        }
        if (!seen.has(cursorEvent)) {
          seen.add(cursorEvent);
          push(cursorEvent, bridge);
        }
      }
    }
    // Native reads reach the bridge alone. The event is not in the canonical
    // mapping, so the user-handler loop below never attaches to it.
    if (options.readHook === true) {
      push("beforeReadFile", bridge);
    }
  }

  const agentsCli = options.agentsCli ?? "agents";
  const withheld = new Set<CursorHookEvent>();
  const gateProbes = new Set<string>();
  for (const [event, handlers] of Object.entries(
    options.hooks,
  ) as ReadonlyArray<[HookEvent, readonly HookHandlerSpec[]]>) {
    const cursorEvents = CURSOR_EVENT_MAPPING[event];
    if (cursorEvents === undefined || cursorEvents.length === 0) {
      skippedEvents.push(event);
      continue;
    }
    for (const cursorEvent of cursorEvents) {
      const toolEvent = row?.toolEvents[cursorEvent];
      for (const handler of handlers) {
        if (toolEvent === undefined) {
          push(cursorEvent, toCursorEntry(handler, lifecycleCommand(handler)));
          continue;
        }
        // Each registration carries only its event's classes, so no call
        // reaches a handler twice (ADR 0028 decision 5).
        const classes = registrationClasses(handler, toolEvent.classes);
        if (classes.length === 0) {
          continue;
        }
        if (
          toolEvent.userHooksOnly === true &&
          options.userHookEvents !== true
        ) {
          withheld.add(cursorEvent);
          continue;
        }
        const gate = {
          adapter: "cursor",
          event: cursorEvent,
          classes,
          ...(handler.matcher === undefined
            ? {}
            : { matcher: handler.matcher }),
          command: handler.command,
        } as const;
        gateProbes.add(hookGateCommand(agentsCli, gate, { probe: true }));
        push(
          cursorEvent,
          toCursorEntry(handler, hookGateCommand(agentsCli, gate)),
        );
      }
    }
  }

  return {
    config: { version: 1, hooks: entries },
    skippedEvents,
    withheldEvents: [...withheld],
    gateProbes: [...gateProbes],
  };
}

export function renderCursorHooksConfig(config: CursorHooksConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}
