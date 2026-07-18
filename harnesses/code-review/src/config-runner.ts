import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  type ContextBundle,
  collectContextBundle,
  resolveContextProvider,
  writeContextBundle,
} from "@aguil/agents-context";
import type { AgentEvent, Finding, HarnessRunResult } from "@aguil/agents-core";
import {
  agentsCodeReviewRunsRoot,
  createRunId,
  ensureDirectory,
  writeJsonFile,
  writeTextFile,
} from "@aguil/agents-core";
import type { AgentAdapter } from "@aguil/agents-execution";
import { FakeAgentAdapter } from "@aguil/agents-execution";
import {
  applyFindingPipelines,
  filterEnabledRoles,
  type LoadedHarness,
  loadHarness,
  validateOutcomesAgainstSchemas,
} from "@aguil/agents-harness-config";
import { NativeBunOrchestrator } from "@aguil/agents-orchestration";
import {
  resolveReportRenderer,
  statusForFindings,
} from "@aguil/agents-reporting";
import { JsonlFileEventSink } from "@aguil/agents-telemetry";
import {
  type CodeReviewRunResult,
  combineStatuses,
  defaultCommandsForVcsMode,
  detectWorkspaceVcsMode,
  loadContextBundleFromPath,
  parseReviewPrMetadataFromContext,
  parseTriageTier,
  writeLatestCodeReviewDiscoveryPointer,
} from "./index";

export interface ConfigCodeReviewRunOptions {
  /** `.agents/` directory containing harnesses/code-review/harness.yaml. */
  readonly agentsDir?: string;
  readonly workspacePath?: string;
  readonly scratchpadRoot?: string;
  readonly runId?: string;
  readonly strict?: boolean;
  /** Replay seam: skip provider collection and load this bundle instead. */
  readonly contextBundlePath?: string;
  readonly reviewPrNumber?: number;
  readonly adapter?: AgentAdapter;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly onEvent?: (event: AgentEvent) => void | Promise<void>;
}

/**
 * Config-driven code-review run (#73 Tier 1 pass condition): every
 * behavioral decision — providers, role gating, output schemas, finding
 * pipelines, report template — comes from the loaded harness.yaml and its
 * registered builtins. This driver only composes loaded config with the
 * same shared machinery `runCodeReview` uses; any code-review-specific
 * branching here (beyond runtime inputs like vcs commands) is a parity
 * bug by definition.
 */
export async function runCodeReviewFromConfig(
  options: ConfigCodeReviewRunOptions = {},
): Promise<CodeReviewRunResult> {
  const workspacePath = resolve(options.workspacePath ?? process.cwd());
  const loaded: LoadedHarness = await loadHarness({
    agentsDir: resolve(options.agentsDir ?? join(workspacePath, ".agents")),
    harnessId: "code-review",
  });
  const runId = options.runId ?? createRunId("code-review");
  const scratchpadRoot = resolve(
    options.scratchpadRoot ?? agentsCodeReviewRunsRoot(workspacePath),
  );
  const scratchpadPath = join(scratchpadRoot, runId);
  await ensureDirectory(scratchpadPath);

  const context: ContextBundle =
    options.contextBundlePath !== undefined
      ? await loadContextBundleFromPath(options.contextBundlePath)
      : await collectContextBundle(
          `${runId}-context`,
          {
            workspacePath,
            scratchpadPath,
            pullRequestNumber: options.reviewPrNumber,
          },
          (loaded.contextProviders ?? []).map((spec) =>
            resolveContextProvider(spec.use, spec.params),
          ),
        );
  const writtenContext = await writeContextBundle(context, scratchpadPath);
  const contextFingerprint = createHash("sha256")
    .update(JSON.stringify(context))
    .digest("hex")
    .slice(0, 12);

  const triage = parseTriageTier(
    context.artifacts.find((artifact) => artifact.id === "triage")?.content,
  );
  const reviewPrMetadata = parseReviewPrMetadataFromContext(
    context.artifacts.find((artifact) => artifact.id === "diff-strategy")
      ?.content,
  );
  const vcsMode = await detectWorkspaceVcsMode(workspacePath);
  await writeJsonFile(join(scratchpadPath, "triage.json"), { tier: triage });

  const enablement = filterEnabledRoles(loaded.definition, { tier: triage });
  const definition = {
    ...enablement.definition,
    defaultAllowedCommands: defaultCommandsForVcsMode(vcsMode),
  };

  const adapter = options.adapter ?? new FakeAgentAdapter();
  const outputSchemas = loaded.outputSchemas;
  const fileEventSink = new JsonlFileEventSink(
    join(scratchpadPath, "events.jsonl"),
  );
  const orchestrator = new NativeBunOrchestrator({
    definition,
    adapter,
    eventSink:
      options.onEvent === undefined
        ? fileEventSink
        : {
            async write(event) {
              await fileEventSink.write(event);
              await options.onEvent?.(event);
            },
          },
    contextBundlePath: writtenContext.jsonPath,
    ...(outputSchemas === undefined
      ? {}
      : {
          validateRoleOutcomes: (input: {
            readonly outcomes: readonly import("@aguil/agents-core").HarnessOutcome[];
          }) => validateOutcomesAgainstSchemas(input.outcomes, outputSchemas),
        }),
  });

  /**
   * Keep this object aligned with runCodeReview's baseMetadata: report output
   * and downstream discovery treat these deterministic fields as contract.
   */
  const baseMetadata = {
    run_id: runId,
    adapter: adapter.name,
    triage,
    strict_mode: options.strict === true ? "true" : "false",
    vcs_mode: vcsMode,
    context_source: options.contextBundlePath === undefined ? "live" : "replay",
    context_fingerprint: contextFingerprint,
    ...(reviewPrMetadata === undefined
      ? {}
      : {
          pr_number: String(reviewPrMetadata.number),
          pr_reviewed_head_sha: reviewPrMetadata.headSha ?? "",
          pr_reviewed_at: reviewPrMetadata.reviewedAt,
        }),
    ...options.metadata,
  };

  const rawResult = await orchestrator.run({
    runId,
    harnessId: loaded.definition.id,
    workspacePath,
    scratchpadPath,
    contextBundlePath: writtenContext.jsonPath,
    strictMode: options.strict === true,
    metadata: {
      ...baseMetadata,
      consensus_runs: "1",
      consensus_pass: "1",
    },
  });

  const findings: readonly Finding[] = applyFindingPipelines(
    rawResult.findings,
    {
      ...(loaded.findingFilters === undefined
        ? {}
        : { filters: loaded.findingFilters }),
      ...(loaded.findingDedupers === undefined
        ? {}
        : { dedupers: loaded.findingDedupers }),
    },
  );

  const rawMetadata = {
    ...baseMetadata,
    timed_out_roles: rawResult.metadata?.timed_out_roles ?? "",
    failed_roles: rawResult.metadata?.failed_roles ?? "",
    completed_roles: rawResult.metadata?.completed_roles ?? "",
    consensus_runs: "1",
    consensus_mode: "off",
    consensus_dropped_findings: "0",
  };
  // Parity subtlety: runCodeReview derives the pre-combine status through
  // combinePassResults, which is findings-BLIND (error/failed/timeout,
  // else passed) — the orchestrator's findings-aware status never
  // survives it. Raw findings that the declared pipelines drop must not
  // leak into status here either, or replay diverges (surfaced by the
  // Tier 2 differential on corpus entries with only non-actionable
  // findings).
  const timedOut = (rawResult.metadata?.timed_out_roles ?? "") !== "";
  const passStatus: HarnessRunResult["status"] =
    rawResult.status === "error"
      ? "error"
      : rawResult.status === "failed"
        ? "failed"
        : timedOut
          ? "warnings"
          : "passed";
  const result: HarnessRunResult = {
    ...rawResult,
    status: combineStatuses(passStatus, statusForFindings(findings)),
    findings,
    metadata: rawMetadata,
    artifacts: [
      ...rawResult.artifacts,
      writtenContext.jsonPath,
      writtenContext.markdownPath,
    ],
  };

  if (loaded.reportingTemplate === undefined) {
    throw new Error("code-review harness must declare a reporting template");
  }
  const renderer = resolveReportRenderer(loaded.reportingTemplate);
  const reportPath = await writeTextFile(
    join(scratchpadPath, "report.md"),
    renderer(result),
  );
  const resultPath = await writeJsonFile(join(scratchpadPath, "result.json"), {
    ...result,
    reportPath,
    contextBundlePath: writtenContext.jsonPath,
  });
  await writeLatestCodeReviewDiscoveryPointer({
    workspacePath,
    scratchpadRoot,
    resultPath,
  });

  return {
    ...result,
    reportPath,
    contextBundlePath: writtenContext.jsonPath,
    artifacts: [...result.artifacts, reportPath, resultPath],
  };
}
