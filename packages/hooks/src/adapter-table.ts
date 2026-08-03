import { HOOK_EVENTS, type HookEvent } from "@aguil/agents-harness-config";

/**
 * Adapters that participate in the hook-generation / enforcement matrix
 * (ADR 0023). `fake` is listed so the refusal consults data rather than a
 * hard-coded name comparison; it cannot deny.
 */
export const HOOK_ADAPTER_IDS = [
  "cursor",
  "claude",
  "opencode",
  "fake",
] as const;

export type HookAdapterId = (typeof HOOK_ADAPTER_IDS)[number];

/**
 * Per-adapter capability and event-dispatch row (ADR 0023 decisions 1–2, 8).
 * Adding a `HookEvent` without filling every adapter column fails the drift
 * test that consumes this table.
 */
export interface AdapterHookCapabilities {
  readonly adapter: HookAdapterId;
  /**
   * Whether the adapter's hook mechanism can return a blocking verdict.
   * The enforcement refusal consults this bit rather than comparing names.
   */
  readonly canDeny: boolean;
  /** Why `canDeny` is false, when it is — surfaced in the refusal message. */
  readonly cannotDenyReason?: string;
  /**
   * Native event names this adapter maps each canonical `HookEvent` onto.
   * Empty array = explicitly unmappable (skipped, never silently dropped).
   * `run_start` / `run_end` stay empty for every adapter (ADR 0024).
   */
  readonly nativeEvents: Readonly<Record<HookEvent, readonly string[]>>;
}

/**
 * Cursor native events used by generation. Kept as string[] in the matrix so
 * the drift test can treat every adapter uniformly.
 */
const CURSOR_NATIVE: Readonly<Record<HookEvent, readonly string[]>> = {
  pre_tool_call: ["beforeShellExecution", "beforeMCPExecution"],
  post_tool_call: ["afterFileEdit"],
  role_start: [],
  role_stop: ["stop"],
  run_start: [],
  run_end: [],
};

const CLAUDE_NATIVE: Readonly<Record<HookEvent, readonly string[]>> = {
  pre_tool_call: ["PreToolUse"],
  post_tool_call: ["PostToolUse"],
  role_start: ["SessionStart"],
  role_stop: ["Stop"],
  run_start: [],
  run_end: [],
};

const EMPTY_NATIVE: Readonly<Record<HookEvent, readonly string[]>> = {
  pre_tool_call: [],
  post_tool_call: [],
  role_start: [],
  role_stop: [],
  run_start: [],
  run_end: [],
};

/**
 * Source of truth for enforcement claims and event vocabulary (ADR 0023).
 * `agents hooks test` and the generators derive from this rather than
 * restating lists.
 */
export const ADAPTER_HOOK_CAPABILITIES: readonly AdapterHookCapabilities[] = [
  {
    adapter: "cursor",
    canDeny: true,
    nativeEvents: CURSOR_NATIVE,
  },
  {
    adapter: "claude",
    canDeny: true,
    nativeEvents: CLAUDE_NATIVE,
  },
  {
    adapter: "opencode",
    canDeny: false,
    cannotDenyReason:
      "OpenCode's extension surface is an installed plugin (executable JS in the user tree), not run-scoped declarative hook config (ADR 0023 decision 8)",
    nativeEvents: EMPTY_NATIVE,
  },
  {
    adapter: "fake",
    canDeny: false,
    cannotDenyReason: "the fake adapter has no hook mechanism",
    nativeEvents: EMPTY_NATIVE,
  },
] as const;

export function adapterHookCapabilities(
  adapter: string,
): AdapterHookCapabilities | undefined {
  return ADAPTER_HOOK_CAPABILITIES.find((row) => row.adapter === adapter);
}

export function adapterCanDeny(adapter: string): boolean {
  return adapterHookCapabilities(adapter)?.canDeny === true;
}

/** Canonical events this adapter's generator maps onto at least one native event. */
export function adapterDispatchableEvents(
  adapter: string,
): ReadonlySet<HookEvent> {
  const row = adapterHookCapabilities(adapter);
  if (row === undefined) {
    return new Set();
  }
  return new Set(
    HOOK_EVENTS.filter((event) => (row.nativeEvents[event]?.length ?? 0) > 0),
  );
}

/**
 * Every event name `agents hooks test` / the bridge should accept for an
 * adapter — native names plus canonical names (so probes can use either).
 */
export function adapterProbeEventNames(adapter: string): ReadonlySet<string> {
  const row = adapterHookCapabilities(adapter);
  const names = new Set<string>(HOOK_EVENTS);
  if (row === undefined) {
    return names;
  }
  for (const event of HOOK_EVENTS) {
    for (const native of row.nativeEvents[event]) {
      names.add(native);
    }
  }
  return names;
}

/** Union of probe event names across adapters that can deny (plus canonical). */
export function allEnforceableProbeEventNames(): ReadonlySet<string> {
  const names = new Set<string>(HOOK_EVENTS);
  for (const row of ADAPTER_HOOK_CAPABILITIES) {
    if (!row.canDeny) {
      continue;
    }
    for (const event of HOOK_EVENTS) {
      for (const native of row.nativeEvents[event]) {
        names.add(native);
      }
    }
  }
  return names;
}
