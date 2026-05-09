import type { CliOptions, ParsedCodeReviewArgv } from "./code-review-cli-models";

const STRING_OPTION_TO_KEY: Readonly<Record<string, keyof CliOptions>> = {
  workspace: "workspace",
  scratchpad: "scratchpad",
  "context-bundle": "contextBundle",
  result: "result",
  consensus: "consensus",
  adapter: "adapter",
  model: "model",
  variant: "variant",
  agent: "agent",
  opencode: "opencode",
  claude: "claude",
  "claude-args": "claudeArgs",
  cursor: "cursor",
  "cursor-args": "cursorArgs",
  "cursor-mode": "cursorMode",
  log: "log",
  pr: "pr",
  "post-pr": "postPr",
  "review-summary": "reviewSummary",
};

const FLAG_TO_KEY: Readonly<Record<string, keyof CliOptions>> = {
  "dry-run": "dryRun",
  "no-confirm": "noConfirm",
  "replace-pending-review": "replacePendingReview",
  "no-deterministic": "noDeterministic",
  strict: "strict",
  "pending-review": "pendingReview",
  pure: "pure",
  "print-logs": "printLogs",
};

/**
 * `argvTail` is everything after `agents code-review`.
 * Leading token may be subcommand `post`, or options when the slice starts with `-`.
 */
export function peelCodeReviewSubcommand(argvTail: readonly string[]):
  | { readonly ok: true; readonly postSubcommand: boolean; readonly optionArgv: readonly string[] }
  | { readonly ok: false; readonly error: string } {
  const head = argvTail[0];
  if (head === undefined || head.startsWith("-")) {
    return { ok: true, postSubcommand: false, optionArgv: argvTail };
  }
  if (head === "post") {
    return { ok: true, postSubcommand: true, optionArgv: argvTail.slice(1) };
  }
  return {
    ok: false,
    error:
      `Unknown 'code-review' subcommand '${head}'. Expected 'post' or options beginning with '-'.`,
  };
}

/** Parse argv after optional `post` peel (same slice `optionArgv`). */
export function parseCodeReviewArgv(argv: readonly string[]): ParsedCodeReviewArgv {
  const stringOptions: Record<string, string> = {};
  const flags = new Set<string>();
  const explicitKeys = new Set<keyof CliOptions>();
  let presetName: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    const nextIsFlag = next === undefined || next.startsWith("--");
    if (nextIsFlag) {
      flags.add(key);
      const flagKey = FLAG_TO_KEY[key];
      if (flagKey !== undefined) {
        explicitKeys.add(flagKey);
      }
      continue;
    }

    const value = next;
    index += 1;

    if (key === "preset") {
      presetName = value.trim().length === 0 ? undefined : value;
      continue;
    }

    stringOptions[key] = value;
    const optKey = STRING_OPTION_TO_KEY[key];
    if (optKey !== undefined) {
      explicitKeys.add(optKey);
    }
  }

  const options: CliOptions = {
    workspace: stringOptions.workspace,
    scratchpad: stringOptions.scratchpad,
    dryRun: flags.has("dry-run"),
    contextBundle: stringOptions["context-bundle"],
    result: stringOptions.result,
    consensus: stringOptions.consensus,
    adapter: stringOptions.adapter,
    model: stringOptions.model,
    variant: stringOptions.variant,
    agent: stringOptions.agent,
    opencode: stringOptions.opencode,
    claude: stringOptions.claude,
    claudeArgs: stringOptions["claude-args"],
    cursor: stringOptions.cursor,
    cursorArgs: stringOptions["cursor-args"],
    cursorMode: stringOptions["cursor-mode"],
    log: stringOptions.log,
    pr: stringOptions.pr,
    postPr: stringOptions["post-pr"],
    reviewSummary: stringOptions["review-summary"],
    postOnly: false,
    noConfirm: flags.has("no-confirm"),
    replacePendingReview: flags.has("replace-pending-review"),
    noDeterministic: flags.has("no-deterministic"),
    strict: flags.has("strict"),
    pendingReview: flags.has("pending-review"),
    pure: flags.has("pure"),
    printLogs: flags.has("print-logs"),
  };

  return { options, explicitKeys, presetName };
}
