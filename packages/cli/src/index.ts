import { createCodeReviewAdapter, runCodeReview } from "@aguil/agents-code-review";
import type { CodeReviewAdapterName } from "@aguil/agents-code-review";
import { resolveGitAwarePath } from "@aguil/agents-core";
import type { AgentEvent, Finding } from "@aguil/agents-core";
import { findingFingerprint, severityEmoji } from "@aguil/agents-reporting";
import { access, readFile, rm, writeFile, readdir, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export async function main(argv: readonly string[] = Bun.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.length === 0) {
    console.log(`Usage: agents <command> [options]

Commands:
  run code-review        Run the code-review harness

Options:
  --workspace <path>     Workspace to review (default: cwd)
  --scratchpad <path>    Scratchpad root (default: <workspace>/.review-agent/runs)
  --dry-run              Write artifacts under <workspace>/.review-agent/dry-run
  --context-bundle <path> Reuse an existing context bundle JSON for replay
  --consensus <n>        Run n passes and keep recurring findings (default: 1 with --pending-review)
  --adapter <name>       Execution adapter: fake, opencode, claude, or cursor (default: fake)
  --model <id>           Model passed to opencode/claude/cursor
  --variant <id>         OpenCode variant (provider-specific effort profile)
  --agent <name>         OpenCode agent name
  --opencode <path>      OpenCode executable (default: opencode)
  --claude <path>        Claude Code executable (default: claude)
  --claude-args <value>  Comma-separated arg template for Claude (supports {prompt})
  --cursor <path>        Cursor CLI executable (default: agent)
  --cursor-args <value>  Comma-separated arg template for Cursor (supports {prompt}; keep --trust)
  --cursor-mode <mode>   Cursor mode: agent, plan, or ask
  --verbose, -v          Print compact progress and finding summaries
  --show-commands        Print adapter commands before and after execution
  --no-deterministic     Disable deterministic adapter defaults
  --strict               Fail run on any role error or timeout
  --pending-review       Create an unsubmitted GitHub PR review
  --post-only            Post findings from an existing run result
  --result <path>        Result JSON path (auto-discovers latest by default)
  --no-confirm           Skip interactive confirmation prompts
  --replace-pending-review Replace an existing pending PR review (requires opt-in)
  --review-pr <number>   PR number used for review context and diff collection
  --pr <number>          PR number for pending review (auto-discover if omitted)
  --review-summary <id>  Review summary style: triage, impact, evidence (default: impact)
  --pure                 Run opencode without external plugins
  --print-logs           Ask opencode to print logs to stderr`);
    return 0;
  }

  if (argv[0] === "run" && argv[1] === "code-review") {
    const options = parseOptions(argv.slice(2));
    if (options.postOnly) {
      return runPostOnly(options);
    }
    const adapterName = parseAdapterName(options.adapter);
    if (adapterName === undefined) {
      console.error(`Unsupported adapter: ${options.adapter}`);
      return 1;
    }
    const cursorMode = parseCursorMode(options.cursorMode);
    if (options.cursorMode !== undefined && cursorMode === undefined) {
      console.error(`Invalid --cursor-mode value: ${options.cursorMode}`);
      console.error("Expected one of: agent, plan, ask.");
      return 1;
    }
    const deterministicEnabled = !options.noDeterministic;
    const effectiveAdapter = resolveEffectiveAdapterOptions(options, adapterName, deterministicEnabled);
    const adapter = createCodeReviewAdapter(adapterName, {
      opencode: {
        executable: options.opencode,
        model: effectiveAdapter.opencode.model,
        variant: effectiveAdapter.opencode.variant,
        agent: effectiveAdapter.opencode.agent,
        pure: effectiveAdapter.opencode.pure,
        printLogs: options.printLogs,
      },
      claude: {
        executable: options.claude,
        model: effectiveAdapter.claude.model,
        argsTemplate: effectiveAdapter.claude.argsTemplate,
      },
      cursor: {
        executable: options.cursor,
        model: effectiveAdapter.cursor.model,
        argsTemplate: effectiveAdapter.cursor.argsTemplate,
        mode: cursorMode ?? effectiveAdapter.cursor.mode,
        force: effectiveAdapter.cursor.force,
      },
    });

    const requestedConsensusRuns = parseConsensusRuns(options.consensus);
    if (options.consensus !== undefined && requestedConsensusRuns === undefined) {
      console.error(`Invalid --consensus value: ${options.consensus}`);
      console.error("Expected a positive integer greater than 0.");
      return 1;
    }
    const pendingReviewEnabled = options.pendingReview && !options.dryRun;
    const consensusRuns = requestedConsensusRuns ?? (pendingReviewEnabled ? 1 : undefined);
    const reviewPrNumber = parsePrNumber(options.reviewPr);
    if (options.reviewPr !== undefined && reviewPrNumber === undefined) {
      console.error(`Invalid --review-pr value: ${options.reviewPr}`);
      return 1;
    }

    if (options.verbose) {
      console.log(`Starting code review with adapter '${adapterName}'.`);
      if (requestedConsensusRuns === undefined && pendingReviewEnabled) {
        console.log("Using default consensus=1 for --pending-review (override with --consensus <n>).");
      }
    }

    const result = await runCodeReview({
      workspacePath: options.workspace,
      scratchpadRoot: resolveScratchpadRoot(options),
      contextBundlePath: options.contextBundle,
      reviewPrNumber,
      consensusRuns,
      strict: options.strict,
      metadata: await buildDeterminismMetadata(adapterName, effectiveAdapter, options, deterministicEnabled),
      adapter,
      onEvent: createRunEventLogger(options),
    });
    if (options.verbose) {
      printVerboseFindingSummary(result.findings);
      const summaryStyle = parseReviewSummaryStyle(options.reviewSummary) ?? "impact";
      const rawCommentCandidates = findingsToPendingReviewComments(result.findings);
      let prDiffContext: PullRequestDiffContext | undefined;
      let postedInlineCount = rawCommentCandidates.length;
      let skippedUnanchorable = 0;
      if (reviewPrNumber !== undefined) {
        try {
          const workspacePath = resolve(options.workspace ?? process.cwd());
          const repo = await getRepoNameWithOwner(workspacePath);
          const loadedDiff = await loadPullRequestDiffContext(repo, reviewPrNumber, workspacePath);
          prDiffContext = loadedDiff;
          warnPrAnchorIssues(result.findings, loadedDiff);
          postedInlineCount = rawCommentCandidates.filter(
            (candidate) => candidateToComment(candidate, loadedDiff) !== undefined,
          ).length;
          skippedUnanchorable = rawCommentCandidates.length - postedInlineCount;
        } catch {
          prDiffContext = undefined;
          postedInlineCount = rawCommentCandidates.length;
          skippedUnanchorable = 0;
        }
      } else {
        skippedUnanchorable = result.findings.length - rawCommentCandidates.length;
      }
      console.log("");
      console.log(buildPendingReviewSummaryBody({
        style: summaryStyle,
        findings: result.findings,
        postedCommentCount: postedInlineCount,
        skippedUnanchorable,
        prDiffContext,
      }));
      console.log("");
      console.log(`Code review ${result.status}.`);
      console.log(`Report: ${result.reportPath}`);
    } else if (options.dryRun) {
      console.log(`Dry-run ${result.status}. Report: ${result.reportPath}`);
    } else {
      console.log(`Code review ${result.status}. Report: ${result.reportPath}`);
    }

    try {
      const staleCheck = await checkReviewPullRequestDivergence(result.metadata, options.workspace);
      if (staleCheck.status === "diverged") {
        console.warn(
          `Warning: reviewed PR #${staleCheck.prNumber} is stale (${staleCheck.reviewedHeadSha.slice(0, 12)} -> ${staleCheck.currentHeadSha.slice(0, 12)}).`,
        );
      }
    } catch {
      // Non-fatal: staleness checks should not block review runs.
    }

    if (pendingReviewEnabled) {
      const prNumber = parsePrNumber(options.pr);
      if (options.pr !== undefined && prNumber === undefined) {
        console.error(`Invalid --pr value: ${options.pr}`);
        return 1;
      }
      const reviewSummaryStyle = parseReviewSummaryStyle(options.reviewSummary);
      if (options.reviewSummary !== undefined && reviewSummaryStyle === undefined) {
        console.error(`Invalid --review-summary value: ${options.reviewSummary}`);
        console.error("Expected one of: triage, impact, evidence.");
        return 1;
      }

      const posted = await replacePendingPullRequestReview({
        findings: result.findings,
        prNumber,
        reviewSummaryStyle: reviewSummaryStyle ?? "impact",
        reviewedHeadSha: result.metadata?.pr_reviewed_head_sha,
        noConfirm: options.noConfirm,
        replacePendingReview: options.replacePendingReview,
        workspacePath: options.workspace,
      });
      if (posted.cancelled === true) {
        await updateRunResultMetadata(result.artifacts, {
          pr_posting_head_sha: posted.currentHeadSha ?? "",
          pr_head_diverged: posted.headDiverged ? "true" : "false",
        });
        return 0;
      }
      console.log(
        `Created pending review #${posted.reviewId} on PR #${posted.prNumber} with ${posted.commentCount} inline comments.`,
      );
      console.log(`Review URL: ${posted.url}`);
      await updateRunResultMetadata(result.artifacts, {
        pr_posting_head_sha: posted.currentHeadSha ?? "",
        pr_head_diverged: posted.headDiverged ? "true" : "false",
      });
    }

    return result.status === "error" ? 1 : 0;
  }

  console.error(`Unknown command: ${argv[0]}`);
  return 1;
}

interface CliOptions {
  readonly workspace?: string;
  readonly scratchpad?: string;
  readonly dryRun: boolean;
  readonly contextBundle?: string;
  readonly result?: string;
  readonly consensus?: string;
  readonly adapter?: string;
  readonly model?: string;
  readonly variant?: string;
  readonly agent?: string;
  readonly opencode?: string;
  readonly claude?: string;
  readonly claudeArgs?: string;
  readonly cursor?: string;
  readonly cursorArgs?: string;
  readonly cursorMode?: string;
  readonly verbose: boolean;
  readonly showCommands: boolean;
  readonly reviewPr?: string;
  readonly pr?: string;
  readonly reviewSummary?: string;
  readonly postOnly: boolean;
  readonly noConfirm: boolean;
  readonly replacePendingReview: boolean;
  readonly noDeterministic: boolean;
  readonly strict: boolean;
  readonly pendingReview: boolean;
  readonly pure: boolean;
  readonly printLogs: boolean;
}

export type ReviewSummaryStyle = "triage" | "impact" | "evidence";

export interface PendingReviewComment {
  readonly path: string;
  readonly line: number;
  readonly side: "RIGHT";
  readonly body: string;
}

interface GitHubPendingReviewCommentInput {
  readonly path: string;
  readonly position: number;
  readonly body: string;
}

interface PendingReviewPosted {
  readonly cancelled?: false;
  readonly reviewId: number;
  readonly prNumber: number;
  readonly commentCount: number;
  readonly url: string;
  readonly currentHeadSha?: string;
  readonly headDiverged: boolean;
}

interface PendingReviewCancelled {
  readonly cancelled: true;
  readonly currentHeadSha?: string;
  readonly headDiverged: boolean;
}

interface PendingReviewFindingCache {
  readonly version: 1;
  readonly repo: string;
  readonly prNumber: number;
  readonly updatedAt: string;
  readonly findings: ReadonlyArray<{
    readonly fingerprint: string;
    readonly threadId: string;
  }>;
}

interface EffectiveAdapterOptions {
  readonly opencode: {
    readonly model?: string;
    readonly variant?: string;
    readonly agent?: string;
    readonly pure: boolean;
  };
  readonly claude: {
    readonly model?: string;
    readonly argsTemplate?: readonly string[];
  };
  readonly cursor: {
    readonly model?: string;
    readonly argsTemplate?: readonly string[];
    readonly mode?: "agent" | "plan" | "ask";
    readonly force: boolean;
  };
}

function parseOptions(argv: readonly string[]): CliOptions {
  const options: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-v") {
      flags.add("verbose");
      continue;
    }
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      flags.add(key);
      continue;
    }
    options[key] = value;
    index += 1;
  }
  return {
    workspace: options.workspace,
    scratchpad: options.scratchpad,
    dryRun: flags.has("dry-run"),
    contextBundle: options["context-bundle"],
    result: options.result,
    consensus: options.consensus,
    adapter: options.adapter,
    model: options.model,
    variant: options.variant,
    agent: options.agent,
    opencode: options.opencode,
    claude: options.claude,
    claudeArgs: options["claude-args"],
    cursor: options.cursor,
    cursorArgs: options["cursor-args"],
    cursorMode: options["cursor-mode"],
    verbose: flags.has("verbose"),
    showCommands: flags.has("show-commands"),
    reviewPr: options["review-pr"],
    pr: options.pr,
    reviewSummary: options["review-summary"],
    postOnly: flags.has("post-only"),
    noConfirm: flags.has("no-confirm"),
    replacePendingReview: flags.has("replace-pending-review"),
    noDeterministic: flags.has("no-deterministic"),
    strict: flags.has("strict"),
    pendingReview: flags.has("pending-review"),
    pure: flags.has("pure"),
    printLogs: flags.has("print-logs"),
  };
}

function resolveScratchpadRoot(options: CliOptions): string | undefined {
  if (options.scratchpad !== undefined) {
    return options.scratchpad;
  }
  if (!options.dryRun) {
    return undefined;
  }
  const workspacePath = resolve(options.workspace ?? process.cwd());
  return join(workspacePath, ".review-agent", "dry-run");
}

function printVerboseFindingSummary(findings: readonly Finding[]): void {
  if (findings.length === 0) {
    console.log("Findings: none.");
    return;
  }

  console.log(`Findings (${findings.length}):`);
  const limit = 10;
  const shown = findings.slice(0, limit);
  for (const finding of shown) {
    const location = finding.file === undefined
      ? "(no file)"
      : finding.line === undefined
      ? finding.file
      : `${finding.file}:${finding.line}`;
    console.log(`- ${severityEmoji(finding.severity)} ${location} - ${summarizeFindingMessage(finding.title)}`);
  }
  if (findings.length > shown.length) {
    console.log(`- ... ${findings.length - shown.length} more`);
  }
}

function summarizeFindingMessage(message: string): string {
  const firstSentence = message.split(/[.!?]\s/, 1)[0]?.trim();
  return firstSentence && firstSentence.length > 0 ? firstSentence : message.trim();
}

function createRunEventLogger(options: CliOptions): ((event: AgentEvent) => void) | undefined {
  if (!options.verbose && !options.showCommands) {
    return undefined;
  }

  return (event) => {
    if (options.showCommands && event.type === "tool") {
      const commandData = parseCommandEventData(event.data);
      if (commandData?.phase === "before") {
        console.log(`[${event.roleId}] command (before): ${formatCommand(commandData.cmd)}`);
      }
    }

    if (options.showCommands && (event.type === "completed" || event.type === "error")) {
      const completionData = parseCommandCompletionData(event.data);
      if (completionData !== undefined) {
        const durationLabel = completionData.elapsedMs === undefined
          ? "duration=unknown"
          : `duration=${Math.round(completionData.elapsedMs)}ms`;
        const exitLabel = completionData.exitCode === undefined
          ? "exit=unknown"
          : `exit=${completionData.exitCode}`;
        console.log(`[${event.roleId}] command (after): ${formatCommand(completionData.command)} (${exitLabel}, ${durationLabel})`);
      }
    }

    if (!options.verbose) {
      return;
    }
    if (event.type === "started") {
      console.log(`[${event.roleId}] started`);
    }
    if (event.type === "completed") {
      console.log(`[${event.roleId}] completed`);
    }
    if (event.type === "error") {
      console.log(`[${event.roleId}] error: ${event.message ?? "unknown error"}`);
    }
  };
}

function parseCommandEventData(data: unknown): { readonly phase: string; readonly cmd: readonly string[] } | undefined {
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const phase = (data as { readonly phase?: unknown }).phase;
  const cmd = (data as { readonly cmd?: unknown }).cmd;
  if (typeof phase !== "string" || !Array.isArray(cmd) || !cmd.every((part) => typeof part === "string")) {
    return undefined;
  }
  return { phase, cmd };
}

function parseCommandCompletionData(data: unknown): {
  readonly command: readonly string[];
  readonly exitCode?: number;
  readonly elapsedMs?: number;
} | undefined {
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const command = (data as { readonly command?: unknown }).command;
  if (!Array.isArray(command) || !command.every((part) => typeof part === "string")) {
    return undefined;
  }
  const exitCodeValue = (data as { readonly exitCode?: unknown }).exitCode;
  const elapsedMsValue = (data as { readonly elapsedMs?: unknown }).elapsedMs;
  const exitCode = typeof exitCodeValue === "number" ? exitCodeValue : undefined;
  const elapsedMs = typeof elapsedMsValue === "number" ? elapsedMsValue : undefined;
  return { command, exitCode, elapsedMs };
}

function formatCommand(cmd: readonly string[]): string {
  return cmd.map(quoteCommandPart).join(" ");
}

function quoteCommandPart(part: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(part)) {
    return part;
  }
  return JSON.stringify(part);
}

function parseConsensusRuns(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || `${parsed}` !== value.trim()) {
    return undefined;
  }
  return parsed;
}

function parseAdapterName(value: string | undefined): CodeReviewAdapterName | undefined {
  if (value === undefined || value === "fake" || value === "opencode" || value === "claude" || value === "cursor") {
    return value ?? "fake";
  }
  return undefined;
}

function parseCursorMode(value: string | undefined): "agent" | "plan" | "ask" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "agent" || value === "plan" || value === "ask") {
    return value;
  }
  return undefined;
}

function parseCommaSeparated(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

function resolveEffectiveAdapterOptions(
  options: CliOptions,
  adapterName: CodeReviewAdapterName,
  deterministicEnabled: boolean,
): EffectiveAdapterOptions {
  return {
    opencode: {
      model: options.model,
      variant: options.variant,
      agent: options.agent,
      pure: options.pure || (deterministicEnabled && adapterName === "opencode"),
    },
    claude: {
      model: options.model,
      argsTemplate: parseCommaSeparated(options.claudeArgs),
    },
    cursor: {
      model: options.model,
      argsTemplate: parseCommaSeparated(options.cursorArgs),
      mode: parseCursorMode(options.cursorMode),
      force: true,
    },
  };
}

async function buildDeterminismMetadata(
  adapterName: CodeReviewAdapterName,
  effective: EffectiveAdapterOptions,
  options: CliOptions,
  deterministicEnabled: boolean,
): Promise<Readonly<Record<string, string>>> {
  const metadata: Record<string, string> = {
    deterministic_mode: deterministicEnabled ? "true" : "false",
  };

  if (adapterName === "opencode") {
    metadata.opencode_model = effective.opencode.model ?? "";
    metadata.opencode_variant = effective.opencode.variant ?? "";
    metadata.opencode_agent = effective.opencode.agent ?? "";
    metadata.opencode_pure = effective.opencode.pure ? "true" : "false";
    metadata.opencode_version = await detectExecutableVersion(options.opencode ?? "opencode");
  }

  if (adapterName === "claude") {
    metadata.claude_model = effective.claude.model ?? "";
    metadata.claude_args_template = effective.claude.argsTemplate?.join(",") ?? "";
    metadata.claude_version = await detectExecutableVersion(options.claude ?? "claude");
  }

  if (adapterName === "cursor") {
    metadata.cursor_model = effective.cursor.model ?? "";
    metadata.cursor_args_template = effective.cursor.argsTemplate?.join(",") ?? "";
    metadata.cursor_mode = effective.cursor.mode ?? "";
    metadata.cursor_force = effective.cursor.force ? "true" : "false";
    metadata.cursor_version = await detectExecutableVersion(options.cursor ?? "agent");
  }

  return metadata;
}

async function detectExecutableVersion(executable: string): Promise<string> {
  const output = await runCommand([executable, "--version"]);
  const line = output?.trim().split(/\r?\n/).find((entry) => entry.trim().length > 0);
  return line ?? "";
}

function parsePrNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

interface StoredReviewResult {
  readonly findings: readonly Finding[];
  readonly metadata?: Readonly<Record<string, string>>;
}

async function runPostOnly(options: CliOptions): Promise<number> {
  if (options.pendingReview) {
    console.warn("Ignoring --pending-review because --post-only already publishes a pending review.");
  }
  const explicitPrNumber = parsePrNumber(options.pr);
  if (options.pr !== undefined && explicitPrNumber === undefined) {
    console.error(`Invalid --pr value: ${options.pr}`);
    return 1;
  }

  const reviewSummaryStyle = parseReviewSummaryStyle(options.reviewSummary);
  if (options.reviewSummary !== undefined && reviewSummaryStyle === undefined) {
    console.error(`Invalid --review-summary value: ${options.reviewSummary}`);
    console.error("Expected one of: triage, impact, evidence.");
    return 1;
  }

  const workspacePath = resolve(options.workspace ?? process.cwd());
  const resultPath = options.result === undefined
    ? await discoverLatestResultPath(workspacePath)
    : resolve(options.result);
  if (resultPath === undefined) {
    console.error("Could not auto-discover a prior run result. Pass --result <path>.");
    return 1;
  }
  console.log(`Using stored review result: ${resultPath}`);

  let loaded: StoredReviewResult;
  try {
    loaded = await loadStoredReviewResult(resultPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 1;
  }
  const metadata = loaded.metadata ?? {};
  const metadataPrNumber = parsePrNumber(metadata.pr_number);
  const reviewedHeadSha = metadata.pr_reviewed_head_sha?.trim();
  if (metadataPrNumber === undefined || reviewedHeadSha === undefined || reviewedHeadSha.length === 0) {
    console.error("Selected result is missing PR metadata required for stale checks.");
    console.error("Re-run with --review-pr to capture pr_number and pr_reviewed_head_sha.");
    return 1;
  }
  const prNumber = explicitPrNumber ?? metadataPrNumber;
  if (explicitPrNumber !== undefined && explicitPrNumber !== metadataPrNumber) {
    console.warn(
      `Warning: posting run from PR #${metadataPrNumber} to PR #${explicitPrNumber}.`,
    );
  }

  const posted = await replacePendingPullRequestReview({
    findings: loaded.findings,
    prNumber,
    reviewSummaryStyle: reviewSummaryStyle ?? "impact",
    reviewedHeadSha,
    noConfirm: options.noConfirm,
    replacePendingReview: options.replacePendingReview,
    workspacePath,
  });
  if (posted.cancelled === true) {
    return 0;
  }
  console.log(
    `Created pending review #${posted.reviewId} on PR #${posted.prNumber} with ${posted.commentCount} inline comments.`,
  );
  console.log(`Review URL: ${posted.url}`);
  if (posted.headDiverged) {
    console.warn("Posted against updated PR head after confirmation.");
  }
  return 0;
}

export async function discoverLatestResultPath(workspacePath: string): Promise<string | undefined> {
  const runsRoot = join(workspacePath, ".review-agent", "runs");
  let entries: readonly (string | Uint8Array)[];
  try {
    entries = await readdir(runsRoot);
  } catch {
    return undefined;
  }
  const runDirectories = entries
    .map((entry) => typeof entry === "string" ? entry : Buffer.from(entry).toString("utf8"))
    .filter((entry) => entry.startsWith("code-review-"))
    .sort()
    .reverse();
  for (const runDirectory of runDirectories) {
    const candidate = join(runsRoot, runDirectory, "result.json");
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function loadStoredReviewResult(resultPath: string): Promise<StoredReviewResult> {
  const raw = await readFile(resultPath, "utf8");
  const parsed = JSON.parse(raw) as {
    readonly findings?: unknown;
    readonly metadata?: unknown;
  };
  if (!Array.isArray(parsed.findings)) {
    throw new Error(`Invalid result JSON at ${resultPath}: missing findings array.`);
  }
  const findings = parsed.findings as Finding[];
  const metadata = typeof parsed.metadata === "object" && parsed.metadata !== null
    ? parsed.metadata as Record<string, string>
    : undefined;
  return {
    findings,
    metadata,
  };
}

export function parseReviewSummaryStyle(value: string | undefined): ReviewSummaryStyle | undefined {
  if (value === undefined) {
    return "impact";
  }
  if (value === "triage" || value === "impact" || value === "evidence") {
    return value;
  }
  return undefined;
}

export function findingsToPendingReviewComments(findings: readonly Finding[]): readonly PendingReviewComment[] {
  return findings
    .filter((finding) => finding.file !== undefined && finding.line !== undefined)
    .map((finding) => ({
      path: finding.file as string,
      line: finding.line as number,
      side: "RIGHT" as const,
      body: formatPendingReviewBody(finding),
    }));
}

/** Maps PR-changed file paths to right-side line -> pull request review `position`. */
export type PullRequestDiffContext = ReadonlyMap<string, ReadonlyMap<number, number>>;

export function resolveReviewDiffPosition(
  path: string,
  line: number,
  context: PullRequestDiffContext,
): number | undefined {
  return context.get(path)?.get(line);
}

/**
 * When PR diff context is known, explains why a finding will not get an inline review thread.
 * Returns undefined when the finding anchors to a postable PR diff line.
 */
export function findingInlinePostingCaption(
  finding: Finding,
  context: PullRequestDiffContext,
): string | undefined {
  if (finding.file === undefined || finding.file === "") {
    return finding.line === undefined
      ? "summary only (no file:line anchor)"
      : "summary only (no file path for line anchor)";
  }
  if (!context.has(finding.file)) {
    return "summary only (file is not in this PR's changed files)";
  }
  if (finding.line === undefined) {
    return "summary only (no line on PR diff; add a hunk line for an inline thread)";
  }
  const positions = context.get(finding.file);
  if (positions?.get(finding.line) === undefined) {
    return "summary only (line is not on a PR diff hunk)";
  }
  return undefined;
}

/** True when `file` is set but is not among this PR's changed paths (from the files API). */
export function findingUsesFileNotInPrChangedFiles(
  finding: Finding,
  context: PullRequestDiffContext,
): boolean {
  return finding.file !== undefined && finding.file !== "" && !context.has(finding.file);
}

/** True when the finding has file+line but that anchor cannot map to a PR review diff position. */
export function findingHasNonPostablePrLineAnchor(
  finding: Finding,
  context: PullRequestDiffContext,
): boolean {
  if (finding.file === undefined || finding.line === undefined) {
    return false;
  }
  return resolveReviewDiffPosition(finding.file, finding.line, context) === undefined;
}

function warnPrAnchorIssues(findings: readonly Finding[], context: PullRequestDiffContext): void {
  const wrongFile = findings.filter((finding) => findingUsesFileNotInPrChangedFiles(finding, context));
  if (wrongFile.length > 0) {
    const sample = wrongFile.slice(0, 3).map((f) => `"${f.title}" (file: ${f.file})`).join("; ");
    const more = wrongFile.length > 3 ? ` (+${wrongFile.length - 3} more)` : "";
    console.warn(
      `${wrongFile.length} finding(s) use \`file\` not in this PR's changed-files list. ${sample}${more}`,
    );
  }
  const wrongHunk = findings.filter((finding) => {
    if (
      finding.file === undefined || finding.line === undefined || finding.file === ""
      || !context.has(finding.file)
    ) {
      return false;
    }
    return resolveReviewDiffPosition(finding.file, finding.line, context) === undefined;
  });
  if (wrongHunk.length > 0) {
    const sample = wrongHunk.slice(0, 3).map((f) => `"${f.title}" (${f.file}:${f.line})`).join("; ");
    const more = wrongHunk.length > 3 ? ` (+${wrongHunk.length - 3} more)` : "";
    console.warn(
      `${wrongHunk.length} finding(s) cite file:line not on a PR diff hunk (no inline review thread). ${sample}${more}`,
    );
  }
}

function formatPendingReviewBody(finding: Finding): string {
  return [
    `### ${severityEmoji(finding.severity)} ${finding.title}`,
    "",
    finding.description,
    "",
    `Evidence: ${finding.evidence}`,
    `Validation: ${finding.validation.status} - ${finding.validation.details}`,
    "",
    `<!-- finding:${findingFingerprint(finding)} -->`,
  ].join("\n");
}

async function replacePendingPullRequestReview(input: {
  readonly findings: readonly Finding[];
  readonly prNumber?: number;
  readonly reviewSummaryStyle: ReviewSummaryStyle;
  readonly reviewedHeadSha?: string;
  readonly noConfirm: boolean;
  readonly replacePendingReview: boolean;
  readonly workspacePath?: string;
}): Promise<PendingReviewPosted | PendingReviewCancelled> {
  const workspacePath = resolveWorkspaceCwd(input.workspacePath);
  const repo = await getRepoNameWithOwner(workspacePath);
  const login = await getViewerLogin(workspacePath);
  const prNumber = input.prNumber ?? await getCurrentPullRequestNumber(repo, workspacePath);
  const reviewedHeadSha = input.reviewedHeadSha?.trim();
  const currentHeadSha = await fetchPullRequestHeadSha(repo, prNumber, workspacePath);
  const headDiverged = reviewedHeadSha !== undefined && reviewedHeadSha.length > 0
    && currentHeadSha !== undefined
    && reviewedHeadSha !== currentHeadSha;

  if (headDiverged) {
    console.warn(
      `Warning: PR #${prNumber} has updates after this review context (${reviewedHeadSha.slice(0, 12)} -> ${currentHeadSha.slice(0, 12)}).`,
    );
    const confirmed = await confirmProceedAfterStaleness(input.noConfirm);
    if (!confirmed) {
      console.log("Skipped pending review publish.");
      return {
        cancelled: true,
        currentHeadSha,
        headDiverged,
      };
    }
  }

  const localAhead = await checkLocalAheadOfPullRequest({
    currentHeadSha,
    prNumber,
    workspacePath,
  });
  if (localAhead.status === "ahead") {
    console.warn(
      `Warning: local checkout is ahead of PR #${prNumber} (${localAhead.prHeadSha.slice(0, 12)} -> ${localAhead.localHeadSha.slice(0, 12)}).`,
    );
    const confirmed = await confirmProceedAfterLocalAhead(input.noConfirm);
    if (!confirmed) {
      console.log("Skipped pending review publish.");
      return {
        cancelled: true,
        currentHeadSha,
        headDiverged,
      };
    }
  }

  const reviews = await ghApi<readonly GitHubPullRequestReview[]>(
    `repos/${repo}/pulls/${prNumber}/reviews`,
    "GET",
    undefined,
    workspacePath,
  );
  const pendingMine = reviews.filter((review) => review.state === "PENDING" && review.user.login === login);

  // Only pay the resolved-thread scan cost when we're actually replacing an
  // existing pending review. First-time pending review publishing should stay
  // lightweight.
  let findings = input.findings;
  if (pendingMine.length > 0) {
    if (!input.replacePendingReview) {
      const confirmed = await confirmReplacePendingReview({
        noConfirm: input.noConfirm,
        prNumber,
        pendingCount: pendingMine.length,
      });
      if (!confirmed) {
        console.log("Skipped pending review publish.");
        return {
          cancelled: true,
          currentHeadSha,
          headDiverged,
        };
      }
    }

    const candidateFingerprints = new Set(findings.map((finding) => findingFingerprint(finding)));
    if (candidateFingerprints.size > 0) {
      const allowedAuthors = new Set([login]);
      const suppressedFromCache = await suppressFingerprintsFromLocalCache({
        repo,
        prNumber,
        workspacePath,
        wanted: candidateFingerprints,
      });

      let suppressedFingerprints = suppressedFromCache;
      const remaining = new Set([...candidateFingerprints].filter((fp) => !suppressedFingerprints.has(fp)));
      if (remaining.size > 0) {
        const fromScan = await fetchResolvedFindingFingerprints({
          repo,
          prNumber,
          workspacePath,
          wanted: remaining,
          allowedAuthors,
        });
        suppressedFingerprints = new Set([...suppressedFingerprints, ...fromScan]);
      }

      if (suppressedFingerprints.size > 0) {
        findings = findings.filter((finding) => !suppressedFingerprints.has(findingFingerprint(finding)));
      }
    }
  }

  const rawComments = findingsToPendingReviewComments(findings);
  const diffContext = await loadPullRequestDiffContext(repo, prNumber, workspacePath);
  warnPrAnchorIssues(findings, diffContext);
  const comments = rawComments
    .map((candidate) => candidateToComment(candidate, diffContext))
    .filter((comment): comment is GitHubPendingReviewCommentInput => comment !== undefined);
  const skippedUnanchorable = rawComments.length - comments.length;

  if (pendingMine.length > 0) {
    for (const review of pendingMine) {
      await ghApi<void>(
        `repos/${repo}/pulls/${prNumber}/reviews/${review.id}`,
        "DELETE",
        undefined,
        workspacePath,
      );
    }
  }

  const body = buildPendingReviewSummaryBody({
    style: input.reviewSummaryStyle,
    findings,
    postedCommentCount: comments.length,
    skippedUnanchorable,
    prDiffContext: diffContext,
  });
  const created = await ghApi<{ readonly id: number; readonly html_url: string }>(
    `repos/${repo}/pulls/${prNumber}/reviews`,
    "POST",
    {
      body,
      comments,
    },
    workspacePath,
  );

  // Best-effort cache update: map fingerprints from posted comments to thread IDs.
  // This lets future replacement checks query a small set of known threads rather
  // than scanning all PR threads.
  try {
    await updateLocalFindingThreadCacheAfterPost({
      repo,
      prNumber,
      reviewId: created.id,
      workspacePath,
      allowedAuthors: new Set([login]),
    });
  } catch {
    // Best-effort only.
  }

  return {
    reviewId: created.id,
    prNumber,
    commentCount: comments.length,
    url: created.html_url,
    currentHeadSha,
    headDiverged,
  };
}

function sanitizeRepoForCache(repo: string): string {
  return repo.replaceAll("/", "__");
}

function findingCachePath(workspacePath: string, repo: string, prNumber: number): string {
  return join(workspacePath, ".review-agent", "pr-cache", sanitizeRepoForCache(repo), `pr-${prNumber}`, "finding-threads.json");
}

async function loadLocalFindingThreadCache(
  workspacePath: string,
  repo: string,
  prNumber: number,
): Promise<PendingReviewFindingCache | undefined> {
  const path = findingCachePath(workspacePath, repo, prNumber);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<PendingReviewFindingCache>;
    if (parsed.version !== 1 || parsed.repo !== repo || parsed.prNumber !== prNumber || !Array.isArray(parsed.findings)) {
      return undefined;
    }
    return parsed as PendingReviewFindingCache;
  } catch {
    return undefined;
  }
}

async function writeLocalFindingThreadCache(workspacePath: string, cache: PendingReviewFindingCache): Promise<void> {
  const path = findingCachePath(workspacePath, cache.repo, cache.prNumber);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

async function suppressFingerprintsFromLocalCache(input: {
  readonly repo: string;
  readonly prNumber: number;
  readonly workspacePath: string;
  readonly wanted: ReadonlySet<string>;
}): Promise<Set<string>> {
  const cache = await loadLocalFindingThreadCache(input.workspacePath, input.repo, input.prNumber);
  if (cache === undefined) {
    return new Set();
  }

  const wantedThreadIds = new Map<string, string>();
  for (const entry of cache.findings) {
    if (input.wanted.has(entry.fingerprint)) {
      wantedThreadIds.set(entry.fingerprint, entry.threadId);
    }
  }
  if (wantedThreadIds.size === 0) {
    return new Set();
  }

  const uniqueThreadIds = [...new Set(wantedThreadIds.values())];
  const response = await runGh<{
    readonly data?: {
      readonly nodes?: ReadonlyArray<
        | { readonly id: string; readonly isResolved?: boolean }
        | { readonly id: string; readonly isResolved?: boolean } // same shape for thread nodes
        | null
      >;
    };
  }>([
    "api",
    "graphql",
    "-f",
    `query=query($ids:[ID!]!){nodes(ids:$ids){... on PullRequestReviewThread{id isResolved}}}`,
    "-f",
    `ids=${JSON.stringify(uniqueThreadIds)}`,
  ], input.workspacePath);

  const resolvedThreads = new Set<string>();
  for (const node of response.data?.nodes ?? []) {
    if (node && node.isResolved === true) {
      resolvedThreads.add(node.id);
    }
  }

  const suppressed = new Set<string>();
  for (const [fingerprint, threadId] of wantedThreadIds.entries()) {
    if (resolvedThreads.has(threadId)) {
      suppressed.add(fingerprint);
    }
  }
  return suppressed;
}

async function updateLocalFindingThreadCacheAfterPost(input: {
  readonly repo: string;
  readonly prNumber: number;
  readonly reviewId: number;
  readonly workspacePath: string;
  readonly allowedAuthors: ReadonlySet<string>;
}): Promise<void> {
  const reviewComments = await ghApi<ReadonlyArray<{ readonly node_id: string; readonly body: string }>>(
    `repos/${input.repo}/pulls/${input.prNumber}/reviews/${input.reviewId}/comments`,
    "GET",
    undefined,
    input.workspacePath,
  );

  const commentIdsToFingerprint = new Map<string, string>();
  for (const comment of reviewComments) {
    const matches = comment.body.matchAll(/<!--\s*finding:([^>]+?)\s*-->/g);
    for (const match of matches) {
      const fp = match[1]?.trim();
      if (fp) {
        commentIdsToFingerprint.set(comment.node_id, fp);
      }
    }
  }
  if (commentIdsToFingerprint.size === 0) {
    return;
  }

  const query = [
    "query($o:String!,$r:String!,$n:Int!,$after:String){",
    "repository(owner:$o,name:$r){",
    "pullRequest(number:$n){",
    "reviewThreads(first:100,after:$after){",
    "pageInfo{hasNextPage endCursor}",
    "nodes{id comments(first:50){nodes{id author{login}}}}",
    "}",
    "}",
    "}",
    "}",
  ].join("");

  const [owner, name] = input.repo.split("/");
  if (!owner || !name) {
    return;
  }

  const found = new Map<string, string>(); // fingerprint -> threadId
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const resp = await runGh<{
      readonly data?: {
        readonly repository?: {
          readonly pullRequest?: {
            readonly reviewThreads?: {
              readonly pageInfo?: { readonly hasNextPage?: boolean; readonly endCursor?: string | null };
              readonly nodes?: ReadonlyArray<{
                readonly id: string;
                readonly comments?: { readonly nodes?: ReadonlyArray<{ readonly id: string; readonly author?: { readonly login?: string } }> };
              }>;
            };
          };
        };
      };
    }>([
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      `o=${owner}`,
      "-f",
      `r=${name}`,
      "-F",
      `n=${input.prNumber}`,
      ...(after !== undefined ? ["-f", `after=${after}`] : []),
    ], input.workspacePath);

    for (const thread of resp.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []) {
      for (const comment of thread.comments?.nodes ?? []) {
        const authorLogin = comment.author?.login;
        if (typeof authorLogin !== "string" || !input.allowedAuthors.has(authorLogin)) {
          continue;
        }
        const fingerprint = commentIdsToFingerprint.get(comment.id);
        if (fingerprint) {
          found.set(fingerprint, thread.id);
        }
      }
    }

    if (found.size >= commentIdsToFingerprint.size) {
      break;
    }
    const pageInfo = resp.data?.repository?.pullRequest?.reviewThreads?.pageInfo;
    if (pageInfo?.hasNextPage !== true) {
      break;
    }
    const endCursor = pageInfo.endCursor ?? undefined;
    if (!endCursor) {
      break;
    }
    after = endCursor;
  }

  if (found.size === 0) {
    return;
  }

  const existing = await loadLocalFindingThreadCache(input.workspacePath, input.repo, input.prNumber);
  const merged = new Map<string, string>();
  for (const entry of existing?.findings ?? []) {
    merged.set(entry.fingerprint, entry.threadId);
  }
  for (const [fp, threadId] of found.entries()) {
    merged.set(fp, threadId);
  }

  await writeLocalFindingThreadCache(input.workspacePath, {
    version: 1,
    repo: input.repo,
    prNumber: input.prNumber,
    updatedAt: new Date().toISOString(),
    findings: [...merged.entries()].map(([fingerprint, threadId]) => ({ fingerprint, threadId })),
  });
}

async function fetchResolvedFindingFingerprints(input: {
  readonly repo: string;
  readonly prNumber: number;
  readonly workspacePath?: string;
  readonly wanted: ReadonlySet<string>;
  readonly allowedAuthors: ReadonlySet<string>;
}): Promise<ReadonlySet<string>> {
  const [owner, name] = input.repo.split("/");
  if (!owner || !name) {
    return new Set();
  }

  const suppressed = new Set<string>();
  const marker = /<!--\s*finding:([^>]+?)\s*-->/g;

  const query = [
    "query($o:String!,$r:String!,$n:Int!,$after:String){",
    "repository(owner:$o,name:$r){",
    "pullRequest(number:$n){",
    "reviewThreads(first:100,after:$after){",
    "pageInfo{hasNextPage endCursor}",
    "nodes{isResolved comments(first:10){nodes{body author{login}}}}",
    "}",
    "}",
    "}",
    "}",
  ].join("");

  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const response = await runGh<{
      readonly data?: {
        readonly repository?: {
          readonly pullRequest?: {
            readonly reviewThreads?: {
              readonly pageInfo?: { readonly hasNextPage?: boolean; readonly endCursor?: string | null };
              readonly nodes?: ReadonlyArray<{
                readonly isResolved?: boolean;
                readonly comments?: { readonly nodes?: ReadonlyArray<{ readonly body?: string; readonly author?: { readonly login?: string } }> };
              }>;
            };
          };
        };
      };
    }>([
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      `o=${owner}`,
      "-f",
      `r=${name}`,
      "-F",
      `n=${input.prNumber}`,
      ...(after !== undefined ? ["-f", `after=${after}`] : []),
    ], input.workspacePath);

    const threads = response.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    for (const thread of threads) {
      if (thread.isResolved !== true) {
        continue;
      }
      for (const comment of thread.comments?.nodes ?? []) {
        const body = comment.body;
        if (typeof body !== "string") {
          continue;
        }
        const authorLogin = comment.author?.login;
        if (typeof authorLogin !== "string" || !input.allowedAuthors.has(authorLogin)) {
          continue;
        }
        for (const match of body.matchAll(marker)) {
          const fingerprint = match[1]?.trim();
          if (fingerprint && input.wanted.has(fingerprint)) {
            suppressed.add(fingerprint);
          }
        }
      }
    }

    if (suppressed.size >= input.wanted.size) {
      break;
    }
    const pageInfo = response.data?.repository?.pullRequest?.reviewThreads?.pageInfo;
    if (pageInfo?.hasNextPage !== true) {
      break;
    }
    const endCursor = pageInfo.endCursor ?? undefined;
    if (endCursor === undefined || endCursor.length === 0) {
      break;
    }
    after = endCursor;
  }

  if (suppressed.size < input.wanted.size && after !== undefined) {
    console.warn(
      "Warning: resolved-thread suppression scan hit its pagination limit; some resolved findings may be reposted.",
    );
  }

  return suppressed;
}

async function checkLocalAheadOfPullRequest(input: {
  readonly currentHeadSha: string | undefined;
  readonly prNumber: number;
  readonly workspacePath: string;
}): Promise<
  | { readonly status: "unavailable" }
  | { readonly status: "ok" }
  | { readonly status: "ahead"; readonly prHeadSha: string; readonly localHeadSha: string }
> {
  const prHeadSha = input.currentHeadSha?.trim();
  if (prHeadSha === undefined || prHeadSha.length === 0) {
    return { status: "unavailable" };
  }

  const localHeadSha = (await runCommand(["git", "rev-parse", "HEAD"], input.workspacePath, { gitAware: true }))?.trim();
  if (localHeadSha === undefined || localHeadSha.length === 0) {
    return { status: "unavailable" };
  }
  if (localHeadSha === prHeadSha) {
    return { status: "ok" };
  }

  // Local is "ahead" if the PR head is reachable from local HEAD.
  const ancestorCheck = await runCommand(
    ["git", "merge-base", "--is-ancestor", prHeadSha, localHeadSha],
    input.workspacePath,
    { gitAware: true },
  );
  if (ancestorCheck !== undefined) {
    return { status: "ahead", prHeadSha, localHeadSha };
  }

  return { status: "ok" };
}

async function checkReviewPullRequestDivergence(
  metadata: Readonly<Record<string, string>> | undefined,
  workspacePathInput?: string,
): Promise<
  | { readonly status: "unavailable" }
  | {
      readonly status: "ok" | "diverged";
      readonly prNumber: number;
      readonly reviewedHeadSha: string;
      readonly currentHeadSha: string;
    }
> {
  if (metadata === undefined) {
    return { status: "unavailable" };
  }
  const prNumber = parsePrNumber(metadata.pr_number);
  const reviewedHeadSha = metadata.pr_reviewed_head_sha?.trim();
  if (prNumber === undefined || reviewedHeadSha === undefined || reviewedHeadSha.length === 0) {
    return { status: "unavailable" };
  }

  const workspacePath = resolveWorkspaceCwd(workspacePathInput);
  const repo = await getRepoNameWithOwner(workspacePath);
  const currentHeadSha = await fetchPullRequestHeadSha(repo, prNumber, workspacePath);
  if (currentHeadSha === undefined || currentHeadSha.length === 0) {
    return { status: "unavailable" };
  }

  return {
    status: reviewedHeadSha === currentHeadSha ? "ok" : "diverged",
    prNumber,
    reviewedHeadSha,
    currentHeadSha,
  };
}

async function confirmProceedAfterStaleness(noConfirm: boolean): Promise<boolean> {
  if (noConfirm) {
    return true;
  }
  if (process.platform === "win32") {
    console.warn("Interactive prompt is unsupported on Windows. Re-run with --no-confirm.");
    return false;
  }
  if (process.stdin.isTTY !== true) {
    console.warn("Non-interactive stdin detected. Re-run with --no-confirm to post anyway.");
    return false;
  }
  process.stdout.write("Post pending review anyway? [y/N] ");
  const reader = Bun.stdin.stream().getReader();
  try {
    const { value } = await reader.read();
    const answer = value === undefined ? "" : new TextDecoder().decode(value).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }
}

async function confirmProceedAfterLocalAhead(noConfirm: boolean): Promise<boolean> {
  if (noConfirm) {
    return true;
  }
  if (process.platform === "win32") {
    console.warn("Interactive prompt is unsupported on Windows. Re-run with --no-confirm.");
    return false;
  }
  if (process.stdin.isTTY !== true) {
    console.warn("Non-interactive stdin detected. Re-run with --no-confirm to post anyway.");
    return false;
  }
  process.stdout.write("Post pending review anyway? [y/N] ");
  const reader = Bun.stdin.stream().getReader();
  try {
    const { value } = await reader.read();
    const answer = value === undefined ? "" : new TextDecoder().decode(value).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }
}

async function confirmReplacePendingReview(input: {
  readonly noConfirm: boolean;
  readonly prNumber: number;
  readonly pendingCount: number;
}): Promise<boolean> {
  if (input.noConfirm) {
    console.warn("Non-interactive pending review replacement requires --replace-pending-review.");
    return false;
  }
  if (process.platform === "win32") {
    console.warn("Interactive prompt is unsupported on Windows. Re-run with --no-confirm.");
    return false;
  }
  if (process.stdin.isTTY !== true) {
    console.warn("Non-interactive stdin detected. Re-run with --replace-pending-review.");
    return false;
  }
  const plural = input.pendingCount === 1 ? "" : "s";
  process.stdout.write(
    `Replace your existing pending review${plural} (${input.pendingCount}) on PR #${input.prNumber}? [y/N] `,
  );
  const reader = Bun.stdin.stream().getReader();
  try {
    const { value } = await reader.read();
    const answer = value === undefined ? "" : new TextDecoder().decode(value).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }
}

export function buildPendingReviewSummaryBody(input: {
  readonly style: ReviewSummaryStyle;
  readonly findings: readonly Finding[];
  readonly postedCommentCount: number;
  readonly skippedUnanchorable: number;
  readonly prDiffContext?: PullRequestDiffContext;
}): string {
  switch (input.style) {
    case "triage":
      return renderTriageSummary(
        input.findings,
        input.postedCommentCount,
        input.skippedUnanchorable,
        input.prDiffContext,
      );
    case "impact":
      return renderImpactSummary(
        input.findings,
        input.postedCommentCount,
        input.skippedUnanchorable,
        input.prDiffContext,
      );
    case "evidence":
      return renderEvidenceSummary(
        input.findings,
        input.postedCommentCount,
        input.skippedUnanchorable,
        input.prDiffContext,
      );
  }
}

function renderTriageSummary(
  findings: readonly Finding[],
  postedCommentCount: number,
  skippedUnanchorable: number,
  prDiffContext: PullRequestDiffContext | undefined,
): string {
  const critical = findings.filter((finding) => finding.severity === "critical");
  const warnings = findings.filter((finding) => finding.severity === "warning");
  const lines = [
    "## At a Glance",
    `- Findings: ${findings.length} (🔴 ${critical.length} critical, ⚠️ ${warnings.length} warning)`,
    `- Inline comments posted: ${postedCommentCount}`,
    `- Skipped outside PR diff: ${skippedUnanchorable}`,
  ];

  if (findings.length === 0) {
    lines.push("", "✅ No findings - code looks good!");
    return lines.join("\n");
  }

  const fixNow = [...critical, ...warnings].slice(0, 2);
  const followUp = [...critical, ...warnings].slice(2, 6);
  lines.push(
    "",
    "## Fix Now",
    ...formatFindingBullets(fixNow, "No immediate findings.", prDiffContext),
    "",
    "## Follow-up",
    ...formatFindingBullets(followUp, "No follow-up findings.", prDiffContext),
  );
  return lines.join("\n");
}

function renderImpactSummary(
  findings: readonly Finding[],
  postedCommentCount: number,
  skippedUnanchorable: number,
  prDiffContext: PullRequestDiffContext | undefined,
): string {
  const lines = [
    "## Impact Summary",
    `- Total findings: ${findings.length}`,
    `- Inline comments posted: ${postedCommentCount}`,
    `- Skipped outside PR diff: ${skippedUnanchorable}`,
  ];

  if (findings.length === 0) {
    lines.push("", "✅ No findings - code looks good!");
    return lines.join("\n");
  }

  const groups: Record<Finding["sourceRole"], Finding[]> = {
    security: [],
    performance: [],
    quality: [],
    compliance: [],
  };

  for (const finding of findings) {
    groups[finding.sourceRole].push(finding);
  }

  lines.push(
    "",
    "### Security",
    ...formatFindingBullets(groups.security, "No security findings.", prDiffContext),
    "",
    "### Runtime / Performance",
    ...formatFindingBullets(groups.performance, "No performance findings.", prDiffContext),
    "",
    "### Correctness / Quality",
    ...formatFindingBullets(groups.quality, "No quality findings.", prDiffContext),
    "",
    "### Documentation / Compliance",
    ...formatFindingBullets(groups.compliance, "No compliance findings.", prDiffContext),
  );
  return lines.join("\n");
}

function renderEvidenceSummary(
  findings: readonly Finding[],
  postedCommentCount: number,
  skippedUnanchorable: number,
  prDiffContext: PullRequestDiffContext | undefined,
): string {
  const lines = [
    "## Why / Evidence / Fix",
    `- Total findings: ${findings.length}`,
    `- Inline comments posted: ${postedCommentCount}`,
    `- Skipped outside PR diff: ${skippedUnanchorable}`,
  ];

  if (findings.length === 0) {
    lines.push("", "✅ No findings - code looks good!");
    return lines.join("\n");
  }

  for (const [index, finding] of findings.slice(0, 6).entries()) {
    const caption = prDiffContext === undefined
      ? undefined
      : findingInlinePostingCaption(finding, prDiffContext);
    lines.push(
      "",
      `### Finding ${index + 1}: ${severityEmoji(finding.severity)} ${finding.title}`,
      ...(caption === undefined ? [] : [`- _${caption}_`]),
      `- Why: ${finding.description}`,
      `- Evidence: ${finding.evidence}`,
      `- Suggested fix: ${suggestFixFromRole(finding.sourceRole)}`,
    );
  }

  return lines.join("\n");
}

function formatFindingBullets(
  findings: readonly Finding[],
  emptyLine: string,
  prDiffContext: PullRequestDiffContext | undefined,
): readonly string[] {
  if (findings.length === 0) {
    return [`- ✅ ${emptyLine}`];
  }
  return findings.map((finding) => {
    const location = finding.file !== undefined && finding.line !== undefined
      ? ` (${finding.file}:${finding.line})`
      : "";
    const caption = prDiffContext === undefined ? undefined : findingInlinePostingCaption(finding, prDiffContext);
    const suffix = caption === undefined ? "" : ` — _${caption}_`;
    return `- ${severityEmoji(finding.severity)} ${finding.title}${location}${suffix}`;
  });
}

function suggestFixFromRole(role: Finding["sourceRole"]): string {
  if (role === "security") {
    return "Apply least-privilege and input/output hardening for the affected path.";
  }
  if (role === "performance") {
    return "Reduce per-operation overhead and prefer batching or cheaper hot-path operations.";
  }
  if (role === "quality") {
    return "Align behavior with expected edge cases and add targeted regression coverage.";
  }
  return "Align docs and conventions with implemented behavior.";
}

async function getCurrentPullRequestNumber(repo: string, workspacePath?: string): Promise<number> {
  const view = await runGh<{ readonly number: number }>([
    "pr",
    "view",
    "--repo",
    repo,
    "--json",
    "number",
  ], workspacePath);
  if (!Number.isInteger(view.number)) {
    throw new Error("Could not resolve current PR number from gh pr view.");
  }
  return view.number;
}

async function fetchPullRequestHeadSha(repo: string, prNumber: number, workspacePath?: string): Promise<string | undefined> {
  const output = await runCommand([
    "gh",
    "api",
    `repos/${repo}/pulls/${prNumber}`,
    "--jq",
    ".head.sha",
  ], workspacePath, { gitAware: true });
  const value = output?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

async function updateRunResultMetadata(
  artifacts: readonly string[],
  entries: Readonly<Record<string, string>>,
): Promise<void> {
  const resultPath = artifacts.find((artifact) => artifact.endsWith("/result.json"));
  if (resultPath === undefined) {
    return;
  }
  const raw = await readFile(resultPath, "utf8");
  const parsed = JSON.parse(raw) as {
    readonly metadata?: Record<string, string>;
    [key: string]: unknown;
  };
  const metadata = {
    ...(parsed.metadata ?? {}),
    ...entries,
  };
  await writeFile(resultPath, `${JSON.stringify({ ...parsed, metadata }, null, 2)}\n`, "utf8");
}

async function getRepoNameWithOwner(workspacePath?: string): Promise<string> {
  try {
    const repo = await runGh<{ readonly nameWithOwner: string }>([
      "repo",
      "view",
      "--json",
      "nameWithOwner",
    ], workspacePath);
    if (repo.nameWithOwner.trim().length > 0) {
      return repo.nameWithOwner;
    }
  } catch {
    // Fall back to remote URL parsing for jj workspaces.
  }
  const fromRemote = await resolveRepoNameWithOwnerFromRemote(workspacePath);
  if (fromRemote === undefined) {
    throw new Error("Could not resolve repository nameWithOwner from gh or remotes.");
  }
  return fromRemote;
}

async function getViewerLogin(workspacePath?: string): Promise<string> {
  const user = await runGh<{ readonly login: string }>(["api", "user"], workspacePath);
  if (user.login.trim().length === 0) {
    throw new Error("Could not resolve GitHub login from gh api user.");
  }
  return user.login;
}

async function ghApi<T>(
  path: string,
  method = "GET",
  payload?: unknown,
  workspacePath?: string,
): Promise<T> {
  const args = ["api", path, "--method", method] as string[];
  let inputPath: string | undefined;
  if (payload !== undefined) {
    inputPath = join("/tmp/opencode", `gh-api-${crypto.randomUUID()}.json`);
    await Bun.write(inputPath, `${JSON.stringify(payload)}\n`);
    args.push("--input", inputPath);
  }
  try {
    return await runGh<T>(args, workspacePath);
  } finally {
    if (inputPath !== undefined) {
      await rm(inputPath, { force: true });
    }
  }
}

async function runGh<T>(args: readonly string[], workspacePath?: string): Promise<T> {
  const gitAware = await resolveGhCwd(workspacePath);
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const proc = Bun.spawn({
      cmd: ["gh", ...args],
      cwd: gitAware,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      readProcessText(proc.stdout),
      readProcessText(proc.stderr),
      proc.exited,
    ]);
    if (exitCode === 0) {
      if (stdout.trim().length === 0) {
        return undefined as T;
      }
      return JSON.parse(stdout) as T;
    }

    const message = stderr.trim() || `exit code ${exitCode}`;
    const isTransientNetwork =
      /error connecting to api\.github\.com/i.test(message) ||
      /\bTLS handshake timeout\b/i.test(message) ||
      /\btimeout\b/i.test(message) ||
      /\btemporarily unavailable\b/i.test(message) ||
      /\bconnection reset\b/i.test(message) ||
      /\bconnection refused\b/i.test(message) ||
      /\bEOF\b/i.test(message) ||
      /\bno such host\b/i.test(message) ||
      /\bnetwork is unreachable\b/i.test(message);
    if (!isTransientNetwork || attempt === maxAttempts) {
      throw new Error(`gh ${args.join(" ")} failed: ${message}`);
    }

    const backoffMs = 250 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
    await Bun.sleep(backoffMs);
  }

  throw new Error(`gh ${args.join(" ")} failed: exhausted retries`);
}

const ghCwdCache = new Map<string, Promise<string>>();

async function resolveGhCwd(workspacePath?: string): Promise<string> {
  const workspaceCwd = resolveWorkspaceCwd(workspacePath);
  const cached = ghCwdCache.get(workspaceCwd);
  if (cached !== undefined) {
    return cached;
  }

  const pending = (async () => {
    // `resolveGitAwareCwd()` already handles jj workspaces and colocated repos.
    // Keeping all `gh` commands scoped to the git-aware root avoids subtle
    // cwd bugs across different jj/git layouts.
    return resolveGitAwareCwd(workspacePath);
  })();

  ghCwdCache.set(workspaceCwd, pending);
  return pending;
}

async function resolveRepoNameWithOwnerFromRemote(workspacePath?: string): Promise<string | undefined> {
  const remoteUrl = (
    await runCommand(["jj", "git", "remote", "list"], workspacePath) ??
    await runCommand(["git", "remote", "get-url", "origin"], workspacePath, { gitAware: true })
  )?.trim();
  if (remoteUrl === undefined || remoteUrl.length === 0) {
    return undefined;
  }

  const line = remoteUrl.split(/\r?\n/).find((entry) => entry.startsWith("origin "));
  const rawUrl = line?.replace(/^origin\s+/, "") ?? remoteUrl;
  return parseNameWithOwnerFromRemoteUrl(rawUrl);
}

function parseNameWithOwnerFromRemoteUrl(url: string): string | undefined {
  const sshLike = /^(?:[^@]+@)?[^:]+:([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (sshLike) {
    return `${sshLike[1]}/${sshLike[2]}`;
  }

  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\//, "").replace(/\.git$/, "");
    const parts = path.split("/");
    if (parts.length < 2) {
      return undefined;
    }
    return `${parts[0]}/${parts[1]}`;
  } catch {
    return undefined;
  }
}

function resolveWorkspaceCwd(workspacePath?: string): string {
  return workspacePath === undefined ? process.cwd() : resolve(workspacePath);
}

const gitAwareWorkspaceCache = new Map<string, Promise<string>>();
const emittedGitAwareWarnings = new Set<string>();

async function resolveGitAwareCwd(workspacePath?: string): Promise<string> {
  const cwd = resolveWorkspaceCwd(workspacePath);
  const cached = gitAwareWorkspaceCache.get(cwd);
  if (cached !== undefined) {
    return cached;
  }

  const pending = (async () => {
    const resolved = await resolveGitAwarePath(cwd);
    if (resolved.warning !== undefined && !emittedGitAwareWarnings.has(resolved.warning)) {
      emittedGitAwareWarnings.add(resolved.warning);
      console.warn(resolved.warning);
    }
    return resolved.gitAwarePath;
  })();

  gitAwareWorkspaceCache.set(cwd, pending);
  return pending;
}

async function runCommand(
  cmd: readonly string[],
  workspacePath?: string,
  options: { readonly gitAware?: boolean } = {},
): Promise<string | undefined> {
  try {
    const cwd = options.gitAware === true
      ? await resolveGitAwareCwd(workspacePath)
      : resolveWorkspaceCwd(workspacePath);
    const proc = Bun.spawn({
      cmd: [...cmd],
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([
      readProcessText(proc.stdout),
      proc.exited,
    ]);
    return exitCode === 0 ? stdout : undefined;
  } catch {
    return undefined;
  }
}

async function readProcessText(
  stream: ReadableStream<Uint8Array> | number | undefined,
): Promise<string> {
  if (!(stream instanceof ReadableStream)) {
    return "";
  }
  return new Response(stream).text();
}

interface GitHubPullRequestReview {
  readonly id: number;
  readonly state: string;
  readonly user: {
    readonly login: string;
  };
}

interface GitHubPullRequestFile {
  readonly filename: string;
  readonly patch?: string;
}

if (import.meta.main) {
  process.exitCode = await main();
}

async function loadPullRequestDiffContext(
  repo: string,
  prNumber: number,
  workspacePath?: string,
): Promise<PullRequestDiffContext> {
  const files = await ghApi<readonly GitHubPullRequestFile[]>(
    `repos/${repo}/pulls/${prNumber}/files?per_page=100`,
    "GET",
    undefined,
    workspacePath,
  );
  const map = new Map<string, ReadonlyMap<number, number>>();
  for (const file of files) {
    map.set(file.filename, extractRightSideHunkPositions(file.patch));
  }
  return map;
}

function candidateToComment(
  candidate: PendingReviewComment,
  context: PullRequestDiffContext,
): GitHubPendingReviewCommentInput | undefined {
  const position = resolveReviewDiffPosition(candidate.path, candidate.line, context);
  if (position === undefined) {
    return undefined;
  }
  return {
    path: candidate.path,
    position,
    body: candidate.body,
  };
}

function extractRightSideHunkPositions(patch: string | undefined): ReadonlyMap<number, number> {
  if (patch === undefined) {
    return new Map<number, number>();
  }
  const positions = new Map<number, number>();
  let rightLine = 0;
  let position = 0;
  let inHunk = false;
  for (const line of patch.split(/\r?\n/)) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      rightLine = Number.parseInt(header[1] ?? "0", 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      position += 1;
      positions.set(rightLine, position);
      rightLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      position += 1;
      positions.set(rightLine, position);
      rightLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      position += 1;
      continue;
    }
    if (line.startsWith("\\")) {
      continue;
    }
  }
  return positions;
}
