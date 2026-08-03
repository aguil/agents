import type {
  HookEvent,
  HookEventClass,
  HookHandlerSpec,
  HooksSpec,
} from "@aguil/agents-harness-config";
import { adapterHookCapabilities } from "./adapter-table";

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
  readonly agentsCli?: string;
}

export interface GeneratedClaudeHooks {
  readonly config: ClaudeSettingsConfig;
  readonly skippedEvents: readonly HookEvent[];
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
 * Spec v0.2 `applies_to` → Claude tool-name matcher. Unscoped handlers omit
 * the matcher (all tools). A handler that already sets `matcher` keeps it.
 */
function appliesToMatcher(
  appliesTo: readonly HookEventClass[] | undefined,
): string | undefined {
  if (appliesTo === undefined) {
    return undefined;
  }
  const parts: string[] = [];
  if (appliesTo.includes("shell")) {
    parts.push("Bash");
  }
  if (appliesTo.includes("mcp")) {
    parts.push("mcp__.*");
  }
  if (appliesTo.includes("edit")) {
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
  const cli = JSON.stringify(options.agentsCli ?? "agents");
  // Format is explicit (ADR 0023 decision 6); never inferred from stdin.
  return { type: "command", command: `${cli} policy-eval --format claude` };
}

function toClaudeHandler(handler: HookHandlerSpec): ClaudeHookHandler {
  return {
    type: "command",
    command: handler.command,
    ...(handler.timeoutS === undefined ? {} : { timeout: handler.timeoutS }),
  };
}

function matcherFor(
  handler: HookHandlerSpec,
  claudeEvent: ClaudeHookEvent,
): string | undefined {
  // Stop / SessionStart ignore matchers; do not emit a misleading field.
  if (claudeEvent === "Stop" || claudeEvent === "SessionStart") {
    return undefined;
  }
  if (handler.matcher !== undefined) {
    return handler.matcher;
  }
  return appliesToMatcher(handler.appliesTo);
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
    // First on every mapped tool event (ADR 0006 §3), unscoped.
    for (const event of ["PreToolUse", "PostToolUse"] as const) {
      push(event, { hooks: [bridge] });
    }
  }

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
        // applies_to on tool events: if the class list produces no matcher
        // parts, skip (empty intersection). Unscoped / explicit matcher always
        // register.
        if (
          handler.appliesTo !== undefined &&
          handler.matcher === undefined &&
          (claudeEvent === "PreToolUse" || claudeEvent === "PostToolUse")
        ) {
          const projected = appliesToMatcher(handler.appliesTo);
          if (projected === undefined) {
            continue;
          }
        }
        const matcher = matcherFor(handler, claudeEvent);
        push(claudeEvent, {
          ...(matcher === undefined ? {} : { matcher }),
          hooks: [toClaudeHandler(handler)],
        });
      }
    }
  }

  return {
    config: { hooks: groups },
    skippedEvents,
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
