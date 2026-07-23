import { createHash } from "node:crypto";
import { existsSync, constants as FsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

export type ConfigHarnessSourceKind =
  | "explicit"
  | "workspace"
  | "user-global"
  | "package";

export interface ResolvedConfigHarnessSource {
  readonly agentsDir: string;
  readonly source: ConfigHarnessSourceKind;
  readonly packageVersion: string;
  readonly installedVersion?: string;
  readonly versionDrift: boolean;
}

const CONFIG_HARNESS_ID = "code-review";
const INSTALL_VERSION_FILE = ".agents-package-version";
const CONFIG_RUNNER_DIR = dirname(fileURLToPath(import.meta.url));

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, FsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function findAgentsPackRoot(): string {
  let dir = CONFIG_RUNNER_DIR;
  for (let index = 0; index < 10; index += 1) {
    if (
      existsSync(
        join(dir, ".agents", "harnesses", CONFIG_HARNESS_ID, "harness.yaml"),
      )
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(
    "Could not locate packaged code-review harness (.agents/harnesses/code-review/harness.yaml).",
  );
}

async function readPackageVersion(packRoot: string): Promise<string> {
  try {
    const parsed = JSON.parse(
      await readFile(join(packRoot, "package.json"), "utf8"),
    ) as { readonly version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0
      ? parsed.version
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function readInstalledVersion(
  agentsDir: string,
): Promise<string | undefined> {
  try {
    const version = await readFile(
      join(agentsDir, "harnesses", CONFIG_HARNESS_ID, INSTALL_VERSION_FILE),
      "utf8",
    );
    const trimmed = version.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

async function hasCodeReviewHarness(agentsDir: string): Promise<boolean> {
  return await pathExists(
    join(resolve(agentsDir), "harnesses", CONFIG_HARNESS_ID, "harness.yaml"),
  );
}

function userGlobalAgentsDir(): string {
  const homeFromEnv = process.env.HOME?.trim();
  const home =
    homeFromEnv === undefined || homeFromEnv === "" ? homedir() : homeFromEnv;
  return join(home, ".agents");
}

export async function resolveConfigHarnessSource(
  workspacePath: string,
  agentsDirOverride?: string,
): Promise<ResolvedConfigHarnessSource> {
  const packRoot = findAgentsPackRoot();
  const packageVersion = await readPackageVersion(packRoot);
  if (agentsDirOverride !== undefined) {
    const agentsDir = resolve(agentsDirOverride);
    const installedVersion = await readInstalledVersion(agentsDir);
    return {
      agentsDir,
      source: "explicit",
      packageVersion,
      ...(installedVersion === undefined ? {} : { installedVersion }),
      versionDrift:
        installedVersion !== undefined && installedVersion !== packageVersion,
    };
  }

  const candidates: readonly {
    readonly source: ConfigHarnessSourceKind;
    readonly agentsDir: string;
  }[] = [
    { source: "workspace", agentsDir: join(workspacePath, ".agents") },
    { source: "user-global", agentsDir: userGlobalAgentsDir() },
    { source: "package", agentsDir: join(packRoot, ".agents") },
  ];

  for (const candidate of candidates) {
    if (!(await hasCodeReviewHarness(candidate.agentsDir))) {
      continue;
    }
    const agentsDir = resolve(candidate.agentsDir);
    const installedVersion =
      candidate.source === "user-global"
        ? await readInstalledVersion(agentsDir)
        : undefined;
    return {
      agentsDir,
      source: candidate.source,
      packageVersion,
      ...(installedVersion === undefined ? {} : { installedVersion }),
      versionDrift:
        installedVersion !== undefined && installedVersion !== packageVersion,
    };
  }

  throw new Error(
    `code-review config harness not found in ${candidates
      .map((candidate) => `${candidate.source}:${resolve(candidate.agentsDir)}`)
      .join(", ")}`,
  );
}

export interface ConfigCodeReviewRunOptions {
  /** Explicit `.agents/` directory; bypasses workspace/global/package resolution. */
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
 * registered builtins. This driver only composes loaded config with runtime
 * inputs (workspace, adapter, context bundle). Shared helpers (status
 * composition, VCS defaults, discovery pointer) live in `./index.ts`.
 * Branching here (beyond those runtime inputs) is a harness-contract bug.
 */
export async function runCodeReviewFromConfig(
  options: ConfigCodeReviewRunOptions = {},
): Promise<CodeReviewRunResult> {
  const workspacePath = resolve(options.workspacePath ?? process.cwd());
  const harnessSource = await resolveConfigHarnessSource(
    workspacePath,
    options.agentsDir,
  );
  const loaded: LoadedHarness = await loadHarness({
    agentsDir: harnessSource.agentsDir,
    harnessId: CONFIG_HARNESS_ID,
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
    config_harness_source: harnessSource.source,
    config_harness_agents_dir: harnessSource.agentsDir,
    config_harness_package_version: harnessSource.packageVersion,
    config_harness_version_drift: harnessSource.versionDrift ? "true" : "false",
    ...(harnessSource.installedVersion === undefined
      ? {}
      : { config_harness_installed_version: harnessSource.installedVersion }),
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
