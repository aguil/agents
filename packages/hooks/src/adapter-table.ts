import {
  HOOK_EVENTS,
  type HookEvent,
  type HookEventClass,
} from "@aguil/agents-harness-config";

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
  /**
   * Every native tool-call event in `nativeEvents`, with the classes it
   * carries and where its payload names the tool (ADR 0028 decision 3).
   */
  readonly toolEvents: Readonly<Record<string, NativeToolEvent>>;
  /**
   * The names this adapter's tools carry in hook payloads that belong to no
   * class: a gated hook skips them silently. A name in no class and not here
   * is one the gate cannot tell, and reports (ADR 0028 decision 2).
   */
  readonly otherToolNames: readonly string[];
}

/**
 * Where a native tool event's payload names the tool (ADR 0028 decision 3):
 * - `none`: it does not; the call is tested against its class's names;
 * - `mcp-fields`: `mcp_server_name` and `tool_name`, read as
 *   `mcp__<server>__<tool>`;
 * - `tool-name`: `tool_name`, classed by `toolNameClass`.
 */
export type ToolNameSource = "none" | "mcp-fields" | "tool-name";

export interface NativeToolEvent {
  readonly classes: readonly HookEventClass[];
  readonly toolName: ToolNameSource;
  /**
   * A user-hook event (ADR 0028 decisions 3 and 5): the policy bridge is
   * never written here, the policy probe vocabulary leaves it out, and it is
   * written only on a CLI version measured to fire it.
   */
  readonly userHooksOnly?: true;
}

/**
 * The names a call of each class is tested against, the same on every
 * adapter (ADR 0028 decision 3). An mcp call is tested against
 * `mcp__<server>__<tool>`, built from its payload, so the class has no list.
 */
export const HOOK_CLASS_TOOL_NAMES: Readonly<
  Record<Exclude<HookEventClass, "mcp">, readonly string[]>
> = {
  shell: ["Bash", "Shell"],
  edit: ["Write", "Edit", "NotebookEdit", "Delete"],
};

/**
 * Cursor native events used by generation. Kept as string[] in the matrix so
 * the drift test can treat every adapter uniformly.
 */
const CURSOR_NATIVE: Readonly<Record<HookEvent, readonly string[]>> = {
  pre_tool_call: ["beforeShellExecution", "beforeMCPExecution", "preToolUse"],
  post_tool_call: ["afterFileEdit", "afterShellExecution", "afterMCPExecution"],
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

const CURSOR_TOOL_EVENTS: Readonly<Record<string, NativeToolEvent>> = {
  beforeShellExecution: { classes: ["shell"], toolName: "none" },
  beforeMCPExecution: { classes: ["mcp"], toolName: "mcp-fields" },
  preToolUse: { classes: ["edit"], toolName: "tool-name", userHooksOnly: true },
  afterFileEdit: { classes: ["edit"], toolName: "none" },
  afterShellExecution: {
    classes: ["shell"],
    toolName: "none",
    userHooksOnly: true,
  },
  afterMCPExecution: {
    classes: ["mcp"],
    toolName: "mcp-fields",
    userHooksOnly: true,
  },
};

/**
 * Tool names `cursor-agent` 2026.10.01-14929f9 puts in `preToolUse`
 * payloads outside every class, from its bundle: each local tool's wrapper
 * names itself. `Shell`, `Write` and `Delete` are class names, and MCP tools
 * arrive as `MCP:<tool>`.
 */
const CURSOR_OTHER_TOOL_NAMES: readonly string[] = [
  "WriteShellStdin",
  "Read",
  "Grep",
  "List",
  "Fetch",
  "ReadLints",
  "ComputerUse",
  "RecordScreen",
  "ListMcpResources",
  "FetchMcpResource",
];

const CLAUDE_TOOL_EVENTS: Readonly<Record<string, NativeToolEvent>> = {
  PreToolUse: { classes: ["shell", "mcp", "edit"], toolName: "tool-name" },
  PostToolUse: { classes: ["shell", "mcp", "edit"], toolName: "tool-name" },
};

/**
 * Tool names Claude Code 2.1.296 documents outside every class (its tools
 * reference). `Bash`, `Write`, `Edit` and `NotebookEdit` are class names,
 * and MCP tools arrive as `mcp__<server>__<tool>`.
 */
const CLAUDE_OTHER_TOOL_NAMES: readonly string[] = [
  "Agent",
  "Artifact",
  "AskUserQuestion",
  "CronCreate",
  "CronDelete",
  "CronList",
  "EndConversation",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "ListAgents",
  "ListMcpResourcesTool",
  "LSP",
  "Monitor",
  "PowerShell",
  "PushNotification",
  "Read",
  "ReadMcpResourceTool",
  "RemoteTrigger",
  "ReportFindings",
  "ScheduleWakeup",
  "SendFeedback",
  "SendMessage",
  "SendUserFile",
  "ShareOnboardingGuide",
  "Skill",
  "SubagentHandback",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TodoWrite",
  "ToolSearch",
  "WaitForMcpServers",
  "WebFetch",
  "WebSearch",
  "Workflow",
];

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
    toolEvents: CURSOR_TOOL_EVENTS,
    otherToolNames: CURSOR_OTHER_TOOL_NAMES,
  },
  {
    adapter: "claude",
    canDeny: true,
    nativeEvents: CLAUDE_NATIVE,
    toolEvents: CLAUDE_TOOL_EVENTS,
    otherToolNames: CLAUDE_OTHER_TOOL_NAMES,
  },
  {
    adapter: "opencode",
    canDeny: false,
    cannotDenyReason:
      "OpenCode's extension surface is an installed plugin (executable JS in the user tree), not run-scoped declarative hook config (ADR 0023 decision 8)",
    nativeEvents: EMPTY_NATIVE,
    toolEvents: {},
    otherToolNames: [],
  },
  {
    adapter: "fake",
    canDeny: false,
    cannotDenyReason: "the fake adapter has no hook mechanism",
    nativeEvents: EMPTY_NATIVE,
    toolEvents: {},
    otherToolNames: [],
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

/** Whether the policy bridge may be written on this native event. */
export function bridgeRunsOn(
  row: AdapterHookCapabilities,
  native: string,
): boolean {
  return row.toolEvents[native]?.userHooksOnly !== true;
}

/**
 * Every event name `agents hooks test` / the bridge should accept for an
 * adapter — native names plus canonical names (so probes can use either).
 * User-hook events carry no bridge, so they are not in it (ADR 0028).
 */
export function adapterProbeEventNames(adapter: string): ReadonlySet<string> {
  const row = adapterHookCapabilities(adapter);
  const names = new Set<string>(HOOK_EVENTS);
  if (row === undefined) {
    return names;
  }
  for (const event of HOOK_EVENTS) {
    for (const native of row.nativeEvents[event]) {
      if (bridgeRunsOn(row, native)) {
        names.add(native);
      }
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
        if (bridgeRunsOn(row, native)) {
          names.add(native);
        }
      }
    }
  }
  return names;
}

/**
 * The class a tool name belongs to on this adapter (ADR 0028 decision 3):
 * a class, `"other"` for a known name outside every class, or undefined for
 * a name the table does not know.
 */
export function toolNameClass(
  adapter: string,
  name: string,
): HookEventClass | "other" | undefined {
  if (HOOK_CLASS_TOOL_NAMES.shell.includes(name)) {
    return "shell";
  }
  if (HOOK_CLASS_TOOL_NAMES.edit.includes(name)) {
    return "edit";
  }
  if (adapter === "claude" && name.startsWith("mcp__")) {
    return "mcp";
  }
  if (adapter === "cursor" && name.startsWith("MCP:")) {
    return "mcp";
  }
  return adapterHookCapabilities(adapter)?.otherToolNames.includes(name)
    ? "other"
    : undefined;
}
