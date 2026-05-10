import type {
  CliOptions,
  ParsedCodeReviewArgv,
} from "./code-review-cli-models";

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

/** Tokens like `--preset`/`--dry-run`, including `--preset=value`: not argv values for prior string options (`--cursor-args`). */
function isBundledCodeReviewCliKey(token: string | undefined): boolean {
  if (token === undefined || !token.startsWith("--")) {
    return false;
  }
  const withoutLeading = token.slice(2);
  const optSegment = /^[^=]+/.exec(withoutLeading)?.[0] ?? withoutLeading;
  return (
    optSegment === "preset" ||
    optSegment in STRING_OPTION_TO_KEY ||
    optSegment in FLAG_TO_KEY
  );
}

export type PeeledCodeReviewArgv =
  | {
      readonly ok: true;
      readonly kind: "run";
      readonly optionArgv: readonly string[];
    }
  | {
      readonly ok: true;
      readonly kind: "post";
      readonly optionArgv: readonly string[];
    }
  | {
      readonly ok: true;
      readonly kind: "replay";
      readonly optionArgv: readonly string[];
    }
  | { readonly ok: false; readonly error: string };

/**
 * `argvTail` is everything after `agents code-review`.
 * Leading token may be subcommand `post` / `replay`, or options when the slice starts with `-`.
 *
 * For `replay`, an optional positional context-bundle path becomes `--context-bundle` + path
 * before the remaining flags (`replay ./bundle.json --adapter fake`).
 */
export function peelCodeReviewSubcommand(
  argvTail: readonly string[],
): PeeledCodeReviewArgv {
  const head = argvTail[0];
  if (head === undefined || head.startsWith("-")) {
    return { ok: true, kind: "run", optionArgv: argvTail };
  }
  if (head === "post") {
    return { ok: true, kind: "post", optionArgv: argvTail.slice(1) };
  }
  if (head === "replay") {
    const rest = argvTail.slice(1);
    const bundle =
      rest[0] !== undefined && !rest[0].startsWith("-") ? rest[0] : undefined;
    const tail = bundle !== undefined ? rest.slice(1) : rest;
    const optionArgv =
      bundle !== undefined ? ["--context-bundle", bundle, ...tail] : tail;
    return { ok: true, kind: "replay", optionArgv };
  }
  return {
    ok: false,
    error: `Unknown 'code-review' subcommand '${head}'. Expected 'post', 'replay', or options beginning with '-'.`,
  };
}

export type PeeledCodeReviewKind = Exclude<
  PeeledCodeReviewArgv,
  { readonly ok: false }
>["kind"];

/**
 * Resolved `postOnly` after merges: repo/env may set postOnly, but `replay` must still run the
 * replay path (finding generation from a bundle), not post-from-result plumbing.
 */
export function resolveEffectivePostOnly(
  peeledKind: PeeledCodeReviewKind,
  mergedPostOnly: boolean,
): boolean {
  return peeledKind === "post" || (peeledKind !== "replay" && mergedPostOnly);
}

/** Parse argv after optional peel (`optionArgv`). */
export function parseCodeReviewArgv(
  argv: readonly string[],
): ParsedCodeReviewArgv {
  const stringOptions: Record<string, string> = {};
  const flags = new Set<string>();
  const explicitKeys = new Set<keyof CliOptions>();
  let presetName: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }

    const equalsOption = /^--([^=]+)=(.*)$/.exec(arg);
    if (equalsOption !== null) {
      const nameEq = equalsOption[1];
      const valueEq = equalsOption[2];
      const stringKeyEq = STRING_OPTION_TO_KEY[nameEq];
      if (stringKeyEq !== undefined) {
        stringOptions[nameEq] = valueEq;
        explicitKeys.add(stringKeyEq);
        continue;
      }
      if (nameEq === "preset") {
        presetName = valueEq.trim().length === 0 ? undefined : valueEq.trim();
        continue;
      }
    }

    const optName = arg.slice(2);
    const next = argv[index + 1];

    const stringOptKey = STRING_OPTION_TO_KEY[optName];
    if (stringOptKey !== undefined) {
      const hasValue =
        next !== undefined &&
        (!next.startsWith("--") || !isBundledCodeReviewCliKey(next));
      if (hasValue) {
        stringOptions[optName] = next;
        explicitKeys.add(stringOptKey);
        index += 1;
      }
      continue;
    }

    if (optName === "preset") {
      const hasValue =
        next !== undefined &&
        (!next.startsWith("--") || !isBundledCodeReviewCliKey(next));
      if (hasValue) {
        presetName = next.trim().length === 0 ? undefined : next;
        index += 1;
      }
      continue;
    }

    const boolKey = FLAG_TO_KEY[optName];
    if (boolKey !== undefined) {
      flags.add(optName);
      explicitKeys.add(boolKey);
      continue;
    }

    flags.add(optName);
    const orphanValueConsumable =
      next !== undefined &&
      (!next.startsWith("--") || !isBundledCodeReviewCliKey(next));
    if (orphanValueConsumable) {
      stringOptions[optName] = next;
      index += 1;
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
