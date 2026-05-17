/**
 * Contextual --help/-h for `agents code-review` (+ overview when no argv).
 */

/** Return `null` to continue normal CLI execution. */
export type CodeReviewHelpRequest =
  | {
      readonly kind: "overview";
      readonly unknownFirstToken?: string;
      /** User wrote agents code-review <wrong> (--help|-h). */
      readonly codeReviewBadSubcommand?: string;
      /** Stripped spelling was agents run code-review … */
      readonly legacyRunSpelling?: boolean;
    }
  | {
      readonly kind: "run_replay";
      readonly legacyRunSpelling?: boolean;
    }
  | {
      readonly kind: "post";
      readonly legacyRunSpelling?: boolean;
    }
  | {
      readonly kind: "replay";
      readonly legacyRunSpelling?: boolean;
    };

function stripHelpTokens(argv: readonly string[]): readonly string[] {
  return argv.filter((t) => t !== "--help" && t !== "-h");
}

/**
 * Decide whether argv is only requesting help text (possibly with subcommand scope).
 */
export function resolveCodeReviewHelp(
  argv: readonly string[],
): CodeReviewHelpRequest | null {
  if (argv.length === 0) {
    return { kind: "overview" };
  }
  const wantsHelp = argv.some((t) => t === "--help" || t === "-h");
  if (!wantsHelp) {
    return null;
  }
  let rest = [...stripHelpTokens(argv)];
  if (rest.length === 0) {
    return { kind: "overview" };
  }

  let legacyRunSpelling = false;
  if (rest[0] === "run" && rest[1] === "code-review") {
    legacyRunSpelling = true;
    rest = rest.slice(2);
  } else if (rest[0] === "code-review") {
    rest = rest.slice(1);
  } else {
    return { kind: "overview", unknownFirstToken: rest[0] };
  }

  if (rest.length === 0 || rest[0].startsWith("-")) {
    return legacyRunSpelling === true
      ? { kind: "run_replay", legacyRunSpelling: true }
      : { kind: "run_replay" };
  }
  if (rest[0] === "post") {
    return legacyRunSpelling === true
      ? { kind: "post", legacyRunSpelling: true }
      : { kind: "post" };
  }
  if (rest[0] === "replay") {
    return legacyRunSpelling === true
      ? { kind: "replay", legacyRunSpelling: true }
      : { kind: "replay" };
  }

  const bad = rest[0];
  if (legacyRunSpelling === true) {
    return {
      kind: "overview",
      codeReviewBadSubcommand: bad,
      legacyRunSpelling: true,
    };
  }
  return {
    kind: "overview",
    codeReviewBadSubcommand: bad,
  };
}

export function sharedConfigurationHelpBlock(): string {
  return `Configuration (later values override earlier ones: harness packaged defaults < user JSON <
repo JSON < preset < env < CLI):
  Packaged harness default adapter is merged first (currently "fake", see @aguil/agents-code-review).

  Merge order then loads JSON defaults from:
    $XDG_CONFIG_HOME/agents/code-review/config.json (or ~/.config/... when unset),
    then <workspace>/.review-agent/config.json (workspace = cwd or --workspace before merge).
    Each file may declare a top-level "presets" object.

  Environment: AGENTS_CODE_REVIEW_* (see harness README); booleans accept true/false/1/0/yes/no.

  JSON may use string arrays for claudeArgs/cursorArgs (one element per argv token; comma-
  separated CLI/env values still split on commas only). Unknown keys warn (set
  AGENTS_CODE_REVIEW_CONFIG_STRICT=yes to fail the run instead).

  --preset <name>        Apply presets.<name> from merged JSON before env then CLI overrides`;
}

export function renderCodeReviewHelp(req: CodeReviewHelpRequest): string {
  switch (req.kind) {
    case "overview":
      return buildOverviewHelp(req);
    case "run_replay":
      return buildRunReplayHelp(req.legacyRunSpelling ?? false);
    case "post":
      return buildPostHelp(req.legacyRunSpelling ?? false);
    case "replay":
      return buildReplayHelp(req.legacyRunSpelling ?? false);
  }
}

/** stderr lines after stdout help (exit 0). */
export function codeReviewHelpStderrExtras(
  req: CodeReviewHelpRequest,
): readonly string[] {
  if (req.kind === "overview" && req.unknownFirstToken !== undefined) {
    return [
      `Unknown command: '${req.unknownFirstToken}'.`,
      "See 'Getting help' in the overview above.",
    ];
  }
  if (
    req.kind === "overview" &&
    req.codeReviewBadSubcommand !== undefined &&
    req.codeReviewBadSubcommand !== ""
  ) {
    const lines = [
      `Unknown 'code-review' subcommand '${req.codeReviewBadSubcommand}'.`,
      `Expected 'post', 'replay', or options beginning with '-'.`,
    ];
    return lines;
  }
  return [];
}

function overviewLegacyNote(req: {
  readonly legacyRunSpelling?: boolean;
}): string {
  return req.legacyRunSpelling === true
    ? "Note: 'agents run code-review …' is removed; start with 'agents code-review …'.\n\n"
    : "";
}

function buildOverviewHelp(
  req: Extract<CodeReviewHelpRequest, { kind: "overview" }>,
): string {
  const legacy = overviewLegacyNote(req);
  return `${legacy}Usage: agents <command> [options]

Getting help (context-specific option lists):

  agents
  agents --help                           Overview only

  agents code-review --help                Full run/replay flags
  agents code-review replay --help         Replay synopsis and shortcuts
  agents code-review post --help           Publish from stored result.json

  agents triage --help                     Normalize triage queues from producer output

  agents skills --help                     List, doctor, or install Agent Skills playbooks (docs/skills/)

Deprecated spelling (shows help anyway):

  agents run code-review [--help]

Commands:

  code-review [options]                 Run reviewers and write artifacts
  code-review replay [path] [options]   Replay with optional bundle path (-> --context-bundle)
  code-review post [options]            Publish pending PR review from result.json
  triage [options]                       Build triage-queue files (--from producer; code-review today)
  skills <command>                       List, doctor, or install playbooks from docs/skills/`;
}

function legacyRunReminderLine(include: boolean): string {
  if (!include) {
    return "";
  }
  return "Note: deprecated 'agents run code-review …' removed; prefer 'agents code-review …'.\n\n";
}

function buildRunReplayHelp(legacyRunSpelling: boolean): string {
  return `${legacyRunReminderLine(legacyRunSpelling)}Usage: agents code-review [options]
       agents code-review replay [bundle.json] [options]

replay injects --context-bundle when the first positional after 'replay' is present; otherwise use the flag.
replay fails if neither positional nor flag supplies a bundle.

See also: agents code-review post --help  (stored result publishing, no rerun)

Run and replay (shared):

  --workspace <path>     Workspace to review (default: cwd)
  --scratchpad <path>    Scratchpad root (default: <workspace>/.review-agent/runs)
  --dry-run              Write artifacts under <workspace>/.review-agent/dry-run
  --context-bundle <path> Reuse captured context bundle JSON
  --consensus <n>        Run n passes and keep recurring findings (default 1 when --pending-review)

GitHub / posting (during a full run):

  --pending-review       Create an unsubmitted GitHub PR review after the harness finishes
  --pr <number>          PR context + default posting target when combined with --pending-review
  --post-pr <number>     Alternate posting PR when it must differ from --pr (rare)
  --result <path>        Latest harness artifact path hints (replay rarely needs this flag)

Posting interaction flags (with --pending-review):

  --no-confirm           Skip confirmation prompts around stale/heads or replacements
  --replace-pending-review Replace an existing pending review (explicit opt-in)
  --review-summary <id>  Summary body modes: triage | impact | evidence (default impact)

Backend / adapters:

  --adapter <name>       fake | opencode | claude | cursor (defaults from harness package + config layers)
  --model <id>           Model selector for adapters that accept it
  --variant <id>         OpenCode variant / effort profile
  --agent <name>         OpenCode agent name override
  --opencode <path>      Executable (default: opencode)
  --claude <path>        Executable (default: claude)
  --claude-args <value>  Comma-separated template for Claude ({prompt})
  --cursor <path>        Executable (default: agent)
  --cursor-args <value>  Cursor template ({prompt}; retain --trust for CI)
  --cursor-mode <mode>   Cursor mode: agent | plan | ask
  --pure                 Run OpenCode without external plugins
  --print-logs           Ask OpenCode to stream logs on stderr
  --no-deterministic     Disable deterministic adapter defaults
  --strict               Fail fast on reviewer errors/timeouts

Diagnostics:

  --log <level>          none | summary | commands | all (default none)

${sharedConfigurationHelpBlock()}`;
}

function buildPostHelp(legacyRunSpelling: boolean): string {
  const legacyLine = legacyRunReminderLine(legacyRunSpelling);
  return `${legacyLine}Usage: agents code-review post [options]

Post-only publishes from result.json — adapter/model/consensus/context collection flags no longer execute reviewers.

Posting flags:

  --result <path>        Stored result JSON (omit to auto-discover latest under <workspace>/.review-agent/runs/ only; dry-run artifacts are never posted)
  --pr <number>          Explicit posting/metadata PR when inferred values are insufficient
  --post-pr <number>     Alternate posting PR when differing from inferred/--pr pairing (rare)
  --pending-review       Accepted but ignored (post implies pending review semantics)
  --review-summary <id>  Summary body formatting: triage | impact | evidence (default impact)
  --no-confirm           Skip interactive stale/consent prompts (recommended for CI)
  --replace-pending-review Explicitly opt in when replacing pending reviews

Supporting flags:

  --workspace <path>     Resolve repos/paths relative to workspace (discovery + GH access)
  --scratchpad <path>    Alternate scratchpad root if discoveries need scoping
  --dry-run              Rarely relevant for publishing but keeps parity with harness wiring
  --log <level>          none | summary | commands | all

Stored results must include pr_number and pr_reviewed_head_sha metadata (generate via PR-backed reviews).

${sharedConfigurationHelpBlock()}`;
}

function buildReplayHelp(legacyRunSpelling: boolean): string {
  const legacyLine = legacyRunReminderLine(legacyRunSpelling);
  return `${legacyLine}Usage: agents code-review replay [bundle.json] [options]

Place bundle.json immediately after 'replay' to auto-map to --context-bundle, or specify --context-bundle manually.
replay aborts early if parsing leaves no bundle reference.

Replay reuses harness execution with saved context bundle:

  --context-bundle <path> Captured artifact from earlier runs/generators

Adapter + workspace knobs match full runs (see agents code-review --help for exhaustive list):

  --adapter/--model/--variant/--agent/--opencode/--claude/--claude-args/--cursor/--cursor-args/--cursor-mode
  --pure, --print-logs, --no-deterministic, --strict

Shared run flags remain available:

  --workspace, --scratchpad, --dry-run

Diagnostics:

  --log <level>          none | summary | commands | all

Need every flag line-by-line? See agents code-review --help for the authoritative run/replay list.

${sharedConfigurationHelpBlock()}`;
}
