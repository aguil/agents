import {
  HOOK_EVENT_CLASSES,
  type HookEventClass,
} from "@aguil/agents-harness-config";
import {
  adapterHookCapabilities,
  HOOK_CLASS_TOOL_NAMES,
  type NativeToolEvent,
  toolNameClass,
} from "./adapter-table";

/** Adapters whose generated hooks run behind the gate (ADR 0028 decision 1). */
export type HookGateAdapter = "cursor" | "claude";

/** What the gate needs to place one call in a handler's scope. */
export interface HookGateArgs {
  readonly adapter: HookGateAdapter;
  readonly event: string;
  readonly classes: readonly HookEventClass[];
  readonly matcher?: string;
  readonly command: string;
  readonly probe: boolean;
}

/**
 * Quote one word for a POSIX shell: single quotes expand nothing, so `$`,
 * `$(...)` and backticks reach the program as written.
 */
export function shellWord(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * The generated command for one gated registration (ADR 0028 decision 2),
 * every value a single-quoted word. `cli` is the agents CLI: one executable
 * or an argv prefix such as `[bun, entry]`.
 */
export function hookGateCommand(
  cli: string | readonly string[],
  args: Omit<HookGateArgs, "probe">,
  options: { readonly probe?: boolean } = {},
): string {
  const words = [
    ...(typeof cli === "string" ? [cli] : cli).map(shellWord),
    "hook-gate",
    ...(options.probe === true ? ["--probe"] : []),
    "--adapter",
    shellWord(args.adapter),
    "--event",
    shellWord(args.event),
    "--classes",
    shellWord(args.classes.join(",")),
    ...(args.matcher === undefined
      ? []
      : ["--matcher", shellWord(args.matcher)]),
    "--",
    shellWord(args.command),
  ];
  return words.join(" ");
}

/**
 * A handler's `matcher` as the gate applies it: a JavaScript regular
 * expression that must match the whole tool name (ADR 0028 decision 9).
 * Throws when it does not compile.
 */
export function compileHookMatcher(matcher: string): RegExp {
  // Compile it alone first: `a)|(b` is not a regex, though it would compile
  // once wrapped.
  new RegExp(matcher);
  return new RegExp(`^(?:${matcher})$`);
}

function nativeToolEvent(
  adapter: string,
  event: string,
): NativeToolEvent | undefined {
  const row = adapterHookCapabilities(adapter);
  return row === undefined || !Object.hasOwn(row.toolEvents, event)
    ? undefined
    : row.toolEvents[event];
}

/** Parse `hook-gate`'s argv; a string is the usage error. */
export function parseHookGateArgv(
  argv: readonly string[],
): HookGateArgs | string {
  let adapter: string | undefined;
  let event: string | undefined;
  let classesRaw: string | undefined;
  let matcher: string | undefined;
  let probe = false;
  let command: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      const rest = argv.slice(index + 1);
      if (rest.length !== 1) {
        return "hook-gate: expected exactly one handler command after --";
      }
      command = rest[0];
      break;
    }
    if (arg === "--probe") {
      probe = true;
      continue;
    }
    const value = argv[index + 1];
    if (
      arg !== "--adapter" &&
      arg !== "--event" &&
      arg !== "--classes" &&
      arg !== "--matcher"
    ) {
      return `hook-gate: unknown argument "${arg}"`;
    }
    if (value === undefined) {
      return `hook-gate: ${arg} requires a value`;
    }
    index += 1;
    if (arg === "--adapter") {
      adapter = value;
    } else if (arg === "--event") {
      event = value;
    } else if (arg === "--classes") {
      classesRaw = value;
    } else {
      matcher = value;
    }
  }
  if (adapter !== "cursor" && adapter !== "claude") {
    return 'hook-gate: --adapter must be "cursor" or "claude"';
  }
  if (event === undefined) {
    return "hook-gate: --event is required";
  }
  const toolEvent = nativeToolEvent(adapter, event);
  if (toolEvent === undefined) {
    return `hook-gate: "${event}" is not a ${adapter} tool-call event`;
  }
  if (classesRaw === undefined || classesRaw === "") {
    return "hook-gate: --classes is required";
  }
  const classes = classesRaw.split(",");
  for (const eventClass of classes) {
    if (!(HOOK_EVENT_CLASSES as readonly string[]).includes(eventClass)) {
      return `hook-gate: unknown class "${eventClass}" in --classes`;
    }
    if (!(toolEvent.classes as readonly string[]).includes(eventClass)) {
      return `hook-gate: ${adapter} ${event} carries no ${eventClass} calls`;
    }
  }
  if (matcher !== undefined) {
    try {
      compileHookMatcher(matcher);
    } catch (error) {
      return `hook-gate: --matcher is not a valid regular expression: ${(error as Error).message}`;
    }
  }
  if (command === undefined) {
    return "hook-gate: missing -- <handler command>";
  }
  return {
    adapter,
    event,
    classes: classes as HookEventClass[],
    ...(matcher === undefined ? {} : { matcher }),
    command,
    probe,
  };
}

/**
 * What the gate does with one call (ADR 0028 decision 2): run the handler,
 * skip silently, or run it and report why the call's scope is unknown.
 */
export type HookGateDecision =
  | { readonly action: "run" }
  | { readonly action: "skip" }
  | { readonly action: "report"; readonly report: string };

/** The one stderr line the gate writes when it cannot tell (JC-8). */
function report(args: HookGateArgs, why: string): HookGateDecision {
  return {
    action: "report",
    report: `agents hook-gate: ${args.adapter} ${args.event}: ${why}, so the handler runs unfiltered (ADR 0028)`,
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Decide one call from its payload, the hook's stdin. */
export function decideHookGate(
  args: HookGateArgs,
  stdin: string,
): HookGateDecision {
  const toolEvent = nativeToolEvent(args.adapter, args.event);
  if (toolEvent === undefined) {
    return report(args, "the event is not in the gate's table");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch {
    payload = undefined;
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return report(args, "stdin is not a JSON object");
  }
  const fields = payload as Record<string, unknown>;

  let eventClass: HookEventClass | "other";
  let names: readonly string[];
  if (toolEvent.toolName === "none") {
    // The event says which class ran but not which tool, so any name in the
    // class may be the one (decision 3).
    const only = toolEvent.classes[0] as Exclude<HookEventClass, "mcp">;
    eventClass = only;
    names = HOOK_CLASS_TOOL_NAMES[only];
  } else if (toolEvent.toolName === "mcp-fields") {
    const server = nonEmptyString(fields.mcp_server_name);
    const tool = nonEmptyString(fields.tool_name);
    if (server === undefined) {
      return report(args, 'the payload has no "mcp_server_name"');
    }
    if (tool === undefined) {
      return report(args, 'the payload has no "tool_name"');
    }
    eventClass = "mcp";
    names = [`mcp__${server}__${tool}`];
  } else {
    const tool = nonEmptyString(fields.tool_name);
    if (tool === undefined) {
      return report(args, 'the payload has no "tool_name"');
    }
    const found = toolNameClass(args.adapter, tool);
    if (found === undefined) {
      return report(args, `tool "${tool}" is in no class the gate knows`);
    }
    eventClass = found;
    // The adapters name the same shell tool differently, so a shell call is
    // tested against both names.
    names = found === "shell" ? HOOK_CLASS_TOOL_NAMES.shell : [tool];
  }

  if (eventClass === "other" || !args.classes.includes(eventClass)) {
    return { action: "skip" };
  }
  if (args.matcher !== undefined) {
    const regex = compileHookMatcher(args.matcher);
    if (!names.some((name) => regex.test(name))) {
      return { action: "skip" };
    }
  }
  return { action: "run" };
}
