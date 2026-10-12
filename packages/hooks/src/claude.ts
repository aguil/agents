import {
  HOOK_EVENT_CLASSES,
  type HookEvent,
  type HookEventClass,
  type HookHandlerSpec,
  type HooksSpec,
} from "@aguil/agents-harness-config";
import { adapterHookCapabilities } from "./adapter-table";
import { hookGateCommand, shellWord } from "./gate";

/** Claude Code hook event names we emit. */
export type ClaudeHookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SessionStart";

export interface ClaudeHookHandler {
  readonly type: "command";
  readonly command: string;
  readonly timeout?: number;
}

export interface ClaudeMatcherGroup {
  readonly matcher?: string;
  readonly hooks: readonly ClaudeHookHandler[];
}

export interface ClaudeSettingsConfig {
  readonly hooks: Readonly<
    Partial<Record<ClaudeHookEvent, readonly ClaudeMatcherGroup[]>>
  >;
}

export interface GenerateClaudeHooksOptions {
  readonly hooks: HooksSpec;
  readonly policyBridge?: boolean;
  /**
   * The agents CLI the bridge and the hook gate run: one executable, or an
   * argv prefix such as `[bun, entry]`. Each element is single-quoted as one
   * shell word.
   */
  readonly agentsCli?: string | readonly string[];
  /**
   * The run's workspace root. The bridge relativizes absolute file paths
   * inside it before evaluation (#219), because Claude Code sends absolute
   * paths and filesystem rules are workspace-relative globs.
   */
  readonly workspaceRoot?: string;
}

export interface GeneratedClaudeHooks {
  readonly config: ClaudeSettingsConfig;
  readonly skippedEvents: readonly HookEvent[];
  /**
   * Each distinct gate command, with `--probe`, for the start-up check (ADR
   * 0028 decision 7).
   */
  readonly gateProbes: readonly string[];
}

const CLAUDE_EVENT_MAPPING: Readonly<
  Partial<Record<HookEvent, readonly ClaudeHookEvent[]>>
> = (() => {
  const row = adapterHookCapabilities("claude");
  if (row === undefined) {
    return {};
  }
  const out: Partial<Record<HookEvent, readonly ClaudeHookEvent[]>> = {};
  for (const [event, natives] of Object.entries(row.nativeEvents) as Array<
    [HookEvent, readonly string[]]
  >) {
    if (natives.length > 0) {
      out[event] = natives as readonly ClaudeHookEvent[];
    }
  }
  return out;
})();

/**
 * Classes → Claude tool-name matcher: the native matcher of every gated
 * registration (ADR 0028 decision 6). The gate applies the handler's own
 * `matcher`.
 */
function classMatcher(classes: readonly HookEventClass[]): string | undefined {
  const parts: string[] = [];
  if (classes.includes("shell")) {
    parts.push("Bash");
  }
  if (classes.includes("mcp")) {
    parts.push("mcp__.*");
  }
  if (classes.includes("edit")) {
    parts.push("Edit", "Write", "NotebookEdit");
  }
  return parts.length === 0 ? undefined : parts.join("|");
}

function policyBridgeHandler(
  options: GenerateClaudeHooksOptions,
): ClaudeHookHandler | undefined {
  if (options.policyBridge !== true) {
    return undefined;
  }
  const agentsCli = options.agentsCli ?? "agents";
  const cli = (typeof agentsCli === "string" ? [agentsCli] : agentsCli)
    .map(shellWord)
    .join(" ");
  // Format is explicit (ADR 0023 decision 6); never inferred from stdin. So
  // is the workspace root: the payload's `cwd` is not trusted.
  const workspace =
    options.workspaceRoot === undefined
      ? ""
      : ` --workspace ${shellWord(options.workspaceRoot)}`;
  return {
    type: "command",
    command: `${cli} policy-eval --format claude${workspace}`,
  };
}

function toClaudeHandler(
  handler: HookHandlerSpec,
  command: string = handler.command,
): ClaudeHookHandler {
  return {
    type: "command",
    command,
    ...(handler.timeoutS === undefined ? {} : { timeout: handler.timeoutS }),
  };
}

/**
 * The classes one registration carries: the event's, narrowed by the
 * handler's `applies_to`; absence means all of them (ADR 0009 decision 1).
 */
function registrationClasses(
  handler: HookHandlerSpec,
): readonly HookEventClass[] {
  return HOOK_EVENT_CLASSES.filter(
    (eventClass) =>
      handler.appliesTo === undefined || handler.appliesTo.includes(eventClass),
  );
}

/**
 * Project canonical harness hooks (+ builtin policy bridge) into Claude Code's
 * settings `hooks` shape (ADR 0023). Output is run-scoped via `--settings`.
 */
export function generateClaudeHooksConfig(
  options: GenerateClaudeHooksOptions,
): GeneratedClaudeHooks {
  const groups: Partial<Record<ClaudeHookEvent, ClaudeMatcherGroup[]>> = {};
  const skippedEvents: HookEvent[] = [];

  const push = (event: ClaudeHookEvent, group: ClaudeMatcherGroup): void => {
    const existing = groups[event];
    if (existing === undefined) {
      groups[event] = [group];
    } else {
      existing.push(group);
    }
  };

  const bridge = policyBridgeHandler(options);
  if (bridge !== undefined) {
    // First and unscoped, but on PreToolUse only: ADR 0023 decision 9 is the
    // exception to ADR 0006 §3's "first on every mapped tool event". By
    // PostToolUse no verdict can stop the tool, and Claude Code records the
    // PreToolUse-shaped response there as a failed hook.
    push("PreToolUse", { hooks: [bridge] });
  }

  const agentsCli = options.agentsCli ?? "agents";
  const gateProbes = new Set<string>();
  for (const [event, handlers] of Object.entries(
    options.hooks,
  ) as ReadonlyArray<[HookEvent, readonly HookHandlerSpec[]]>) {
    const claudeEvents = CLAUDE_EVENT_MAPPING[event];
    if (claudeEvents === undefined || claudeEvents.length === 0) {
      skippedEvents.push(event);
      continue;
    }
    for (const claudeEvent of claudeEvents) {
      for (const handler of handlers) {
        // Lifecycle events are not gated, and Stop / SessionStart ignore
        // matchers, so no misleading field is emitted.
        if (claudeEvent !== "PreToolUse" && claudeEvent !== "PostToolUse") {
          push(claudeEvent, { hooks: [toClaudeHandler(handler)] });
          continue;
        }
        const classes = registrationClasses(handler);
        const matcher = classMatcher(classes);
        if (matcher === undefined) {
          continue;
        }
        const gate = {
          adapter: "claude",
          event: claudeEvent,
          classes,
          ...(handler.matcher === undefined
            ? {}
            : { matcher: handler.matcher }),
          command: handler.command,
        } as const;
        gateProbes.add(hookGateCommand(agentsCli, gate, { probe: true }));
        push(claudeEvent, {
          matcher,
          hooks: [toClaudeHandler(handler, hookGateCommand(agentsCli, gate))],
        });
      }
    }
  }

  return {
    config: { hooks: groups },
    skippedEvents,
    gateProbes: [...gateProbes],
  };
}

/**
 * Fail the run if the generated settings cannot be shown well-formed
 * (ADR 0023 decision 4). Claude Code silently ignores invalid settings under
 * `--print`, so an unnoticed malformation is an unenforced run.
 */
export function assertWellFormedClaudeSettings(
  config: ClaudeSettingsConfig,
): void {
  const allowed = new Set<string>([
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SessionStart",
  ]);
  if (typeof config !== "object" || config === null || !("hooks" in config)) {
    throw new Error("claude settings: missing hooks object");
  }
  const hooks = config.hooks;
  if (typeof hooks !== "object" || hooks === null) {
    throw new Error("claude settings: hooks must be an object");
  }
  for (const [event, groups] of Object.entries(hooks)) {
    if (!allowed.has(event)) {
      throw new Error(`claude settings: unsupported hook event "${event}"`);
    }
    if (!Array.isArray(groups)) {
      throw new Error(`claude settings: hooks.${event} must be an array`);
    }
    for (const [index, group] of groups.entries()) {
      if (typeof group !== "object" || group === null) {
        throw new Error(
          `claude settings: hooks.${event}[${index}] must be an object`,
        );
      }
      if (group.matcher !== undefined && typeof group.matcher !== "string") {
        throw new Error(
          `claude settings: hooks.${event}[${index}].matcher must be a string`,
        );
      }
      if (!Array.isArray(group.hooks) || group.hooks.length === 0) {
        throw new Error(
          `claude settings: hooks.${event}[${index}].hooks must be a non-empty array`,
        );
      }
      for (const [hIndex, handler] of group.hooks.entries()) {
        if (handler.type !== "command") {
          throw new Error(
            `claude settings: hooks.${event}[${index}].hooks[${hIndex}].type must be "command"`,
          );
        }
        if (
          typeof handler.command !== "string" ||
          handler.command.length === 0
        ) {
          throw new Error(
            `claude settings: hooks.${event}[${index}].hooks[${hIndex}].command must be a non-empty string`,
          );
        }
        if (
          handler.timeout !== undefined &&
          (typeof handler.timeout !== "number" ||
            !Number.isFinite(handler.timeout) ||
            handler.timeout <= 0)
        ) {
          throw new Error(
            `claude settings: hooks.${event}[${index}].hooks[${hIndex}].timeout must be a positive number`,
          );
        }
      }
    }
  }
  // Round-trip JSON to catch non-serializable values before the CLI sees them.
  JSON.parse(JSON.stringify(config));
}

export function renderClaudeSettingsConfig(
  config: ClaudeSettingsConfig,
): string {
  assertWellFormedClaudeSettings(config);
  return `${JSON.stringify(config, null, 2)}\n`;
}
