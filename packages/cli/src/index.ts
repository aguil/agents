import { resolve } from "node:path";
import {
  CODE_REVIEW_HARNESS_PACKAGE_ADAPTER_DEFAULT,
  type CodeReviewAdapterName,
  createCodeReviewAdapter,
  runCodeReview,
} from "@aguil/agents-code-review";
import { runCodeReviewFromConfig } from "@aguil/agents-code-review/config-runner";
import {
  buildPendingReviewSummaryBody,
  candidateToComment,
  checkReviewPullRequestDivergence,
  discoverLatestResultPath,
  findingsToPendingReviewComments,
  getCurrentPullRequestNumber,
  getRepoNameWithOwner,
  loadPullRequestDiffContext,
  loadStoredReviewResult,
  type PullRequestDiffContext,
  parsePrNumber,
  parseReviewSummaryStyle,
  replacePendingPullRequestReview,
  resolvedResultPathIsUnderCodeReviewDryRunRoot,
  runCommand,
  type StoredReviewResult,
  updateRunResultMetadata,
  warnPrAnchorIssues,
} from "@aguil/agents-code-review-post";
import type { AgentEvent, Finding } from "@aguil/agents-core";
import {
  agentsCodeReviewDryRunRoot,
  agentsCodeReviewRunsRoot,
} from "@aguil/agents-core";
import { severityEmoji } from "@aguil/agents-reporting";
import type { CliOptions } from "./code-review-cli-models";
import { stabilizeMergedWorkspace } from "./code-review-config";
import {
  codeReviewHelpStderrExtras,
  renderCodeReviewHelp,
  resolveCodeReviewHelp,
} from "./code-review-help";
import { createDetachedPullRequestWorktree } from "./isolate-git-review-worktree";
import {
  parseCodeReviewArgv,
  peelCodeReviewSubcommand,
  resolveEffectivePostOnly,
} from "./parse-code-review-argv";
import { readAgentsMonorepoVersion } from "./skills-pack";
import {
  renderTriageHelp,
  resolveTriageHelp,
  triageHelpStderrExtras,
} from "./triage-help";

export type {
  PendingReviewComment,
  PendingReviewPostResult,
  ReviewPostProvenance,
  ReviewSummaryStyle,
} from "@aguil/agents-code-review-post";
export {
  buildPendingReviewSummaryBody,
  discoverLatestResultPath,
  findingHasNonPostablePrLineAnchor,
  findingsToPendingReviewComments,
  findingUsesFileNotInPrChangedFiles,
  firstAnchorableDiffReviewPosition,
  firstNonCollidingAnchorableDiffReviewPosition,
  formatReviewCoverageSectionLines,
  formatReviewProvenanceSectionLines,
  loadStoredReviewResult,
  type PullRequestDiffContext,
  parsePrNumber,
  parseReviewSummaryStyle,
  replacePendingPullRequestReview,
  resolveAdapterModelFromMetadata,
  resolvedResultPathIsUnderCodeReviewDryRunRoot,
} from "@aguil/agents-code-review-post";

export async function main(
  argv: readonly string[] = Bun.argv.slice(2),
): Promise<number> {
  if (
    argv.length === 1 &&
    (argv[0] === "--version" || argv[0] === "-V" || argv[0] === "-v")
  ) {
    console.log(readAgentsMonorepoVersion());
    return 0;
  }

  if (argv[0] === "doctor") {
    const {
      resolveDoctorHelp,
      renderDoctorHelp,
      doctorHelpStderrExtras,
      runAgentsDoctor,
    } = await import("./doctor-main");
    const doctorHelpReq = resolveDoctorHelp(argv);
    if (doctorHelpReq !== null) {
      console.log(renderDoctorHelp(doctorHelpReq));
      for (const line of doctorHelpStderrExtras(doctorHelpReq)) {
        console.error(line);
      }
      return 0;
    }
    if (argv.length > 1) {
      console.error(
        "agents doctor does not accept arguments (try: agents doctor --help).",
      );
      return 1;
    }
    return await runAgentsDoctor();
  }

  if (argv[0] === "skills") {
    const {
      resolveSkillsHelp,
      renderSkillsHelp,
      runSkillsCli,
      skillsHelpStderrExtras,
    } = await import("./skills-main");
    const skillsHelpReq = resolveSkillsHelp(argv);
    if (skillsHelpReq !== null) {
      console.log(renderSkillsHelp(skillsHelpReq));
      for (const line of skillsHelpStderrExtras(skillsHelpReq)) {
        console.error(line);
      }
      return 0;
    }
    return await runSkillsCli(argv.slice(1));
  }

  const triageHelpReq = resolveTriageHelp(argv);
  if (triageHelpReq !== null) {
    console.log(renderTriageHelp(triageHelpReq));
    for (const line of triageHelpStderrExtras(triageHelpReq)) {
      console.error(line);
    }
    return 0;
  }

  const helpReq = resolveCodeReviewHelp(argv);
  if (helpReq !== null) {
    console.log(renderCodeReviewHelp(helpReq));
    for (const line of codeReviewHelpStderrExtras(helpReq)) {
      console.error(line);
    }
    return 0;
  }

  if (argv[0] === "triage") {
    const { runTriageCli } = await import("./triage-main");
    return await runTriageCli(argv);
  }

  if (argv[0] === "policy-eval") {
    const { runPolicyEvalCli } = await import("./policy-eval-main");
    return await runPolicyEvalCli(argv.slice(1));
  }

  if (argv[0] === "harness") {
    if (argv[1] === "run") {
      const { runHarnessRunCli } = await import("./harness-run-main");
      return await runHarnessRunCli(argv.slice(2));
    }
    const { runHarnessCli } = await import("./harness-main");
    return await runHarnessCli(argv.slice(1));
  }

  if (argv[0] === "hooks") {
    if (argv[1] !== "test") {
      console.error(
        "Usage: agents hooks test --policy <id> --agents-dir <dir> --event <name> [--tool <name>] [--input <json>] [--file <path>] [--format text|json]",
      );
      return 1;
    }
    const { runHooksTestCli } = await import("./hooks-test-main");
    return await runHooksTestCli(argv.slice(2));
  }

  if (argv[0] === "pr-feedback") {
    const { runPrFeedbackCli } = await import("./pr-feedback-main");
    return await runPrFeedbackCli(argv.slice(1));
  }

  if (argv[0] === "code-review") {
    const peeled = peelCodeReviewSubcommand(argv.slice(1));
    if (!peeled.ok) {
      console.error(peeled.error);
      return 1;
    }
    if (peeled.kind === "inbox") {
      const { runCodeReviewInboxCli } = await import(
        "./code-review-inbox-main"
      );
      return runCodeReviewInboxCli(peeled.optionArgv);
    }
    const parsed = parseCodeReviewArgv(peeled.optionArgv);
    const stabilized = await stabilizeMergedWorkspace(parsed);
    if (!stabilized.ok) {
      console.error(stabilized.error);
      return 1;
    }
    const options: CliOptions = {
      ...stabilized.options,
      postOnly: resolveEffectivePostOnly(
        peeled.kind,
        stabilized.options.postOnly,
      ),
    };

    const logLevelResolved = parseCliLogLevel(options.log ?? "none");
    if (logLevelResolved === undefined) {
      console.error(`Invalid --log value: ${options.log}`);
      console.error("Expected one of: none, summary, commands, all.");
      return 1;
    }
    const logLevel: CliLogLevel = logLevelResolved;

    if (options.postOnly) {
      return runPostOnly(options);
    }
    if (peeled.kind === "replay") {
      const bundle = options.contextBundle?.trim();
      if (bundle === undefined || bundle.length === 0) {
        console.error(
          "replay requires a context bundle (--context-bundle <path> or positional path after `replay`).",
        );
        return 1;
      }
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
    const effectiveAdapter = resolveEffectiveAdapterOptions(
      options,
      adapterName,
      deterministicEnabled,
    );
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

    const impl = options.impl ?? "package";
    if (impl !== "package" && impl !== "config") {
      console.error(`Invalid --impl value: ${options.impl}`);
      console.error("Expected one of: package, config.");
      return 1;
    }

    const requestedConsensusRuns = parseConsensusRuns(options.consensus);
    if (
      options.consensus !== undefined &&
      requestedConsensusRuns === undefined
    ) {
      console.error(`Invalid --consensus value: ${options.consensus}`);
      console.error("Expected a positive integer greater than 0.");
      return 1;
    }
    if (impl === "config" && (requestedConsensusRuns ?? 1) > 1) {
      // ADR 0012: consensus is descoped from the config-declared harness.
      console.error(
        "--impl config does not support --consensus > 1 (consensus is descoped from the config harness; see ADR 0012). Use the package implementation for consensus runs.",
      );
      return 1;
    }
    const pendingReviewEnabled = options.pendingReview && !options.dryRun;
    const consensusRuns =
      requestedConsensusRuns ?? (pendingReviewEnabled ? 1 : undefined);
    const reviewPrNumber = parsePrNumber(options.pr);
    if (options.pr !== undefined && reviewPrNumber === undefined) {
      console.error(`Invalid --pr value: ${options.pr}`);
      return 1;
    }

    const artifactAnchorWorkspacePath = resolve(
      options.workspace ?? process.cwd(),
    );
    let reviewWorkspacePath = artifactAnchorWorkspacePath;
    let isolateCleanup: (() => Promise<void>) | undefined;
    if (reviewPrNumber !== undefined) {
      try {
        const isolated = await createDetachedPullRequestWorktree({
          artifactAnchorWorkspacePath,
          pullNumber: reviewPrNumber,
        });
        reviewWorkspacePath = isolated.worktreePath;
        isolateCleanup = isolated.cleanup;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        return 1;
      }
    }

    try {
      if (logShowsSummary(logLevel)) {
        console.log(
          impl === "config"
            ? `Starting code review with adapter '${adapterName}' (config-declared harness).`
            : `Starting code review with adapter '${adapterName}'.`,
        );
        if (requestedConsensusRuns === undefined && pendingReviewEnabled) {
          console.log(
            "Using default consensus=1 for --pending-review (override with --consensus <n>).",
          );
        }
        if (isolateCleanup !== undefined) {
          console.log(
            `Reviewing PR #${reviewPrNumber} in a detached git worktree (primary checkout unchanged): ${reviewWorkspacePath}`,
          );
        }
      }

      // Shared inputs for both implementations; the config path takes the
      // declarative harness from the review workspace's .agents tree and
      // structurally has no consensus option (ADR 0012, guarded above).
      const sharedRunInputs = {
        workspacePath: reviewWorkspacePath,
        scratchpadRoot: resolveScratchpadRootForRun(
          options,
          reviewWorkspacePath,
          artifactAnchorWorkspacePath,
        ),
        contextBundlePath: options.contextBundle,
        reviewPrNumber,
        strict: options.strict,
        metadata: await buildDeterminismMetadata(
          adapterName,
          effectiveAdapter,
          options,
          deterministicEnabled,
        ),
        agentsDir: options.agentsDir,
        adapter,
        onEvent: createRunEventLogger(logLevel),
      };
      const result =
        impl === "config"
          ? await runCodeReviewFromConfig(sharedRunInputs)
          : await runCodeReview({ ...sharedRunInputs, consensusRuns });
      let verbosePrDiffContext: PullRequestDiffContext | undefined;
      if (logShowsSummary(logLevel)) {
        if (impl === "config") {
          const source = result.metadata?.config_harness_source;
          const dir = result.metadata?.config_harness_agents_dir;
          if (source !== undefined && dir !== undefined) {
            console.log(`Config harness source: ${source} (${dir})`);
          }
          if (result.metadata?.config_harness_version_drift === "true") {
            console.warn(
              `Config harness install version ${result.metadata.config_harness_installed_version ?? "unknown"} differs from package version ${result.metadata.config_harness_package_version ?? "unknown"}. Run agents harness install code-review to refresh it.`,
            );
          }
        }
        printVerboseFindingSummary(result.findings);
        const summaryStyle =
          parseReviewSummaryStyle(options.reviewSummary) ?? "impact";
        const rawCommentCandidates = findingsToPendingReviewComments(
          result.findings,
        );
        let prDiffContext: PullRequestDiffContext | undefined;
        let postedInlineCount = rawCommentCandidates.length;
        let skippedUnanchorable = 0;
        if (reviewPrNumber !== undefined) {
          try {
            const workspacePath = artifactAnchorWorkspacePath;
            const repo = await getRepoNameWithOwner(workspacePath);
            const loadedDiff = await loadPullRequestDiffContext(
              repo,
              reviewPrNumber,
              workspacePath,
            );
            prDiffContext = loadedDiff;
            verbosePrDiffContext = loadedDiff;
            warnPrAnchorIssues(result.findings, loadedDiff);
            postedInlineCount = rawCommentCandidates.filter(
              (candidate) =>
                candidateToComment(candidate, loadedDiff) !== undefined,
            ).length;
            skippedUnanchorable =
              rawCommentCandidates.length - postedInlineCount;
          } catch {
            prDiffContext = undefined;
            postedInlineCount = rawCommentCandidates.length;
            skippedUnanchorable = 0;
          }
        } else {
          skippedUnanchorable =
            result.findings.length - rawCommentCandidates.length;
        }
        console.log("");
        console.log(
          buildPendingReviewSummaryBody({
            style: summaryStyle,
            findings: result.findings,
            postedCommentCount: postedInlineCount,
            skippedUnanchorable,
            prDiffContext,
            runMetadata: result.metadata,
            provenance: {
              runId: result.runId,
              runMetadata: result.metadata,
            },
          }),
        );
        console.log("");
        console.log(`Code review ${result.status}.`);
        console.log(`Report: ${result.reportPath}`);
      } else if (options.dryRun) {
        console.log(`Dry-run ${result.status}. Report: ${result.reportPath}`);
      } else {
        console.log(
          `Code review ${result.status}. Report: ${result.reportPath}`,
        );
      }

      try {
        const staleCheck = await checkReviewPullRequestDivergence(
          result.metadata,
          options.workspace,
        );
        if (staleCheck.status === "diverged") {
          console.warn(
            `Warning: reviewed PR #${staleCheck.prNumber} is stale (${staleCheck.reviewedHeadSha.slice(0, 12)} -> ${staleCheck.currentHeadSha.slice(0, 12)}).`,
          );
        }
      } catch {
        // Non-fatal: staleness checks should not block review runs.
      }

      if (pendingReviewEnabled) {
        if (
          options.postPr !== undefined &&
          parsePrNumber(options.postPr) === undefined
        ) {
          console.error(`Invalid --post-pr value: ${options.postPr}`);
          return 1;
        }
        const postingPrNumber =
          parsePrNumber(options.postPr) ?? parsePrNumber(options.pr);
        const reviewSummaryStyle = parseReviewSummaryStyle(
          options.reviewSummary,
        );
        if (
          options.reviewSummary !== undefined &&
          reviewSummaryStyle === undefined
        ) {
          console.error(
            `Invalid --review-summary value: ${options.reviewSummary}`,
          );
          console.error("Expected one of: triage, impact, evidence.");
          return 1;
        }

        const posted = await replacePendingPullRequestReview({
          findings: result.findings,
          prNumber: postingPrNumber,
          reviewSummaryStyle: reviewSummaryStyle ?? "impact",
          reviewedHeadSha: result.metadata?.pr_reviewed_head_sha,
          noConfirm: options.noConfirm,
          replacePendingReview: options.replacePendingReview,
          workspacePath: options.workspace,
          preloadedPrDiffContext:
            logShowsSummary(logLevel) &&
            reviewPrNumber !== undefined &&
            postingPrNumber !== undefined &&
            postingPrNumber === reviewPrNumber
              ? verbosePrDiffContext
              : undefined,
          runMetadata: result.metadata,
          runId: result.runId,
        });
        if (posted.cancelled === true) {
          await updateRunResultMetadata(result.artifacts, {
            pr_posting_head_sha: posted.currentHeadSha ?? "",
            pr_head_diverged: posted.headDiverged ? "true" : "false",
          });
          return 0;
        }
        console.log(
          `Created pending review #${posted.reviewId} on PR #${posted.prNumber} with ${posted.commentCount} review thread(s).`,
        );
        console.log(`Review URL: ${posted.url}`);
        await updateRunResultMetadata(result.artifacts, {
          pr_posting_head_sha: posted.currentHeadSha ?? "",
          pr_head_diverged: posted.headDiverged ? "true" : "false",
        });
      }

      return result.status === "error" ? 1 : 0;
    } finally {
      await isolateCleanup?.();
    }
  }

  if (argv[0] === "run" && argv[1] === "code-review") {
    console.error('Use `agents code-review` (the "run" command was removed).');
    return 1;
  }
  console.error(`Unknown command: ${argv[0]}`);
  return 1;
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

function resolveScratchpadRootForRun(
  options: CliOptions,
  reviewWorkspacePath: string,
  artifactAnchorWorkspacePath: string,
): string | undefined {
  if (options.scratchpad !== undefined) {
    return options.scratchpad;
  }
  if (options.dryRun) {
    return agentsCodeReviewDryRunRoot(artifactAnchorWorkspacePath);
  }
  if (resolve(reviewWorkspacePath) !== resolve(artifactAnchorWorkspacePath)) {
    return agentsCodeReviewRunsRoot(artifactAnchorWorkspacePath);
  }
  return undefined;
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
    const location =
      finding.file === undefined
        ? "(no file)"
        : finding.line === undefined
          ? finding.file
          : `${finding.file}:${finding.line}`;
    console.log(
      `- ${severityEmoji(finding.severity)} ${location} - ${summarizeFindingMessage(finding.title)}`,
    );
  }
  if (findings.length > shown.length) {
    console.log(`- ... ${findings.length - shown.length} more`);
  }
}

function summarizeFindingMessage(message: string): string {
  const firstSentence = message.split(/[.!?]\s/, 1)[0]?.trim();
  return firstSentence && firstSentence.length > 0
    ? firstSentence
    : message.trim();
}

function createRunEventLogger(
  logLevel: CliLogLevel,
): ((event: AgentEvent) => void) | undefined {
  if (!logShowsSummary(logLevel) && !logShowsCommands(logLevel)) {
    return undefined;
  }

  return (event) => {
    if (logShowsCommands(logLevel) && event.type === "tool") {
      const commandData = parseCommandEventData(event.data);
      if (commandData?.phase === "before") {
        console.log(
          `[${event.roleId}] command (before): ${formatCommand(commandData.cmd)}`,
        );
      }
    }

    if (
      logShowsCommands(logLevel) &&
      (event.type === "completed" || event.type === "error")
    ) {
      const completionData = parseCommandCompletionData(event.data);
      if (completionData !== undefined) {
        const durationLabel =
          completionData.elapsedMs === undefined
            ? "duration=unknown"
            : `duration=${Math.round(completionData.elapsedMs)}ms`;
        const exitLabel =
          completionData.exitCode === undefined
            ? "exit=unknown"
            : `exit=${completionData.exitCode}`;
        console.log(
          `[${event.roleId}] command (after): ${formatCommand(completionData.command)} (${exitLabel}, ${durationLabel})`,
        );
      }
    }

    if (!logShowsSummary(logLevel)) {
      return;
    }
    if (event.type === "started") {
      console.log(`[${event.roleId}] started`);
    }
    if (event.type === "completed") {
      console.log(`[${event.roleId}] completed`);
    }
    if (event.type === "error") {
      console.log(
        `[${event.roleId}] error: ${event.message ?? "unknown error"}`,
      );
    }
  };
}

function parseCommandEventData(
  data: unknown,
): { readonly phase: string; readonly cmd: readonly string[] } | undefined {
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const phase = (data as { readonly phase?: unknown }).phase;
  const cmd = (data as { readonly cmd?: unknown }).cmd;
  if (
    typeof phase !== "string" ||
    !Array.isArray(cmd) ||
    !cmd.every((part) => typeof part === "string")
  ) {
    return undefined;
  }
  return { phase, cmd };
}

function parseCommandCompletionData(data: unknown):
  | {
      readonly command: readonly string[];
      readonly exitCode?: number;
      readonly elapsedMs?: number;
    }
  | undefined {
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const command = (data as { readonly command?: unknown }).command;
  if (
    !Array.isArray(command) ||
    !command.every((part) => typeof part === "string")
  ) {
    return undefined;
  }
  const exitCodeValue = (data as { readonly exitCode?: unknown }).exitCode;
  const elapsedMsValue = (data as { readonly elapsedMs?: unknown }).elapsedMs;
  const exitCode =
    typeof exitCodeValue === "number" ? exitCodeValue : undefined;
  const elapsedMs =
    typeof elapsedMsValue === "number" ? elapsedMsValue : undefined;
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

function parseAdapterName(
  value: string | undefined,
): CodeReviewAdapterName | undefined {
  if (
    value === undefined ||
    value === "fake" ||
    value === "opencode" ||
    value === "claude" ||
    value === "cursor"
  ) {
    return value ?? CODE_REVIEW_HARNESS_PACKAGE_ADAPTER_DEFAULT;
  }
  return undefined;
}

function parseCursorMode(
  value: string | undefined,
): "agent" | "plan" | "ask" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "agent" || value === "plan" || value === "ask") {
    return value;
  }
  return undefined;
}

function parseCommaSeparated(
  value: string | undefined,
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

/** Config may store JSON string arrays verbatim; CLI and env supply comma-split strings. */
function coerceAdapterArgsTemplate(
  value: string | readonly string[] | undefined,
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const trimmed = value
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return parseCommaSeparated(value as string);
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
      pure:
        options.pure || (deterministicEnabled && adapterName === "opencode"),
    },
    claude: {
      model: options.model,
      argsTemplate: coerceAdapterArgsTemplate(options.claudeArgs),
    },
    cursor: {
      model: options.model,
      argsTemplate: coerceAdapterArgsTemplate(options.cursorArgs),
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
    metadata.opencode_version = await detectExecutableVersion(
      options.opencode ?? "opencode",
    );
  }

  if (adapterName === "claude") {
    metadata.claude_model = effective.claude.model ?? "";
    metadata.claude_args_template =
      effective.claude.argsTemplate === undefined ||
      effective.claude.argsTemplate.length === 0
        ? ""
        : JSON.stringify([...effective.claude.argsTemplate]);
    metadata.claude_version = await detectExecutableVersion(
      options.claude ?? "claude",
    );
  }

  if (adapterName === "cursor") {
    metadata.cursor_model = effective.cursor.model ?? "";
    metadata.cursor_args_template =
      effective.cursor.argsTemplate === undefined ||
      effective.cursor.argsTemplate.length === 0
        ? ""
        : JSON.stringify([...effective.cursor.argsTemplate]);
    metadata.cursor_mode = effective.cursor.mode ?? "";
    metadata.cursor_force = effective.cursor.force ? "true" : "false";
    metadata.cursor_version = await detectExecutableVersion(
      options.cursor ?? "agent",
    );
  }

  return metadata;
}

async function detectExecutableVersion(executable: string): Promise<string> {
  const output = await runCommand([executable, "--version"]);
  const line = output
    ?.trim()
    .split(/\r?\n/)
    .find((entry) => entry.trim().length > 0);
  return line ?? "";
}

/** CLI diagnostics for code-review (`--log`); default resolved to `none` in main after validation. */
type CliLogLevel = "none" | "summary" | "commands" | "all";

function parseCliLogLevel(value: string | undefined): CliLogLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    value === "none" ||
    value === "summary" ||
    value === "commands" ||
    value === "all"
  ) {
    return value;
  }
  return undefined;
}

function logShowsSummary(level: CliLogLevel): boolean {
  return level === "summary" || level === "all";
}

function logShowsCommands(level: CliLogLevel): boolean {
  return level === "commands" || level === "all";
}

async function runPostOnly(options: CliOptions): Promise<number> {
  if (options.pendingReview) {
    console.warn(
      "Ignoring --pending-review because code-review post already publishes a pending review.",
    );
  }
  if (
    options.postPr !== undefined &&
    parsePrNumber(options.postPr) === undefined
  ) {
    console.error(`Invalid --post-pr value: ${options.postPr}`);
    return 1;
  }
  if (options.pr !== undefined && parsePrNumber(options.pr) === undefined) {
    console.error(`Invalid --pr value: ${options.pr}`);
    return 1;
  }
  const explicitPrNumber =
    parsePrNumber(options.postPr) ?? parsePrNumber(options.pr);

  const reviewSummaryStyle = parseReviewSummaryStyle(options.reviewSummary);
  if (options.reviewSummary !== undefined && reviewSummaryStyle === undefined) {
    console.error(`Invalid --review-summary value: ${options.reviewSummary}`);
    console.error("Expected one of: triage, impact, evidence.");
    return 1;
  }

  const workspacePath = resolve(options.workspace ?? process.cwd());
  const resultPath =
    options.result === undefined
      ? await discoverLatestResultPath(workspacePath)
      : resolve(options.result);
  if (resultPath === undefined) {
    console.error(
      "Could not auto-discover a prior run result. Pass --result <path>.",
    );
    return 1;
  }
  if (
    options.result !== undefined &&
    (await resolvedResultPathIsUnderCodeReviewDryRunRoot(
      workspacePath,
      resultPath,
    ))
  ) {
    console.error(
      "Refusing to post a dry-run result.json. Use .agents-code-review/runs/… (or legacy .review-agent/runs/…) or omit --result for auto-discovery.",
    );
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
  const reviewedHeadShaFromMetadata =
    metadata.pr_reviewed_head_sha?.trim() ?? "";

  let prNumber = explicitPrNumber ?? metadataPrNumber;
  if (prNumber === undefined) {
    try {
      const repo = await getRepoNameWithOwner(workspacePath);
      prNumber = await getCurrentPullRequestNumber(repo, workspacePath);
    } catch {
      console.error(
        "Could not resolve which pull request to post to from stored metadata or the workspace.",
      );
      console.error(
        "Pass --post-pr <number> (or --pr <number>), or re-run code-review with PR-linked context so result.json includes pr_number.",
      );
      return 1;
    }
  }

  if (
    explicitPrNumber !== undefined &&
    metadataPrNumber !== undefined &&
    explicitPrNumber !== metadataPrNumber
  ) {
    console.warn(
      `Warning: posting run from PR #${metadataPrNumber} to PR #${explicitPrNumber}.`,
    );
  }

  let reviewedHeadSha: string | undefined =
    reviewedHeadShaFromMetadata.length > 0
      ? reviewedHeadShaFromMetadata
      : undefined;
  if (reviewedHeadSha === undefined) {
    const localHead = (
      await runCommand(["git", "rev-parse", "HEAD"], workspacePath, {
        gitAware: true,
      })
    )?.trim();
    if (localHead !== undefined && localHead.length > 0) {
      reviewedHeadSha = localHead;
      console.warn(
        "Stored result lacks pr_reviewed_head_sha; using workspace HEAD for staleness comparison.",
      );
    } else {
      console.warn(
        "Stored result lacks pr_reviewed_head_sha; stale-head confirmation will be skipped.",
      );
    }
  }

  const posted = await replacePendingPullRequestReview({
    findings: loaded.findings,
    prNumber,
    reviewSummaryStyle: reviewSummaryStyle ?? "impact",
    reviewedHeadSha,
    noConfirm: options.noConfirm,
    replacePendingReview: options.replacePendingReview,
    workspacePath,
    runMetadata: metadata,
    runId: loaded.runId,
  });
  if (posted.cancelled === true) {
    return 0;
  }
  console.log(
    `Created pending review #${posted.reviewId} on PR #${posted.prNumber} with ${posted.commentCount} review thread(s).`,
  );
  console.log(`Review URL: ${posted.url}`);
  if (posted.headDiverged) {
    console.warn("Posted against updated PR head after confirmation.");
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
