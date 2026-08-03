import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  collectContextBundle,
  resolveContextProvider,
  writeContextBundle,
} from "@aguil/agents-context";
import type { HarnessOutcome } from "@aguil/agents-core";
import {
  createRunId,
  isReviewTriageTier,
  writeJsonFile,
} from "@aguil/agents-core";
import type {
  AgentAdapter,
  ClaudeCodeAdapterOptions,
  CursorAdapterOptions,
} from "@aguil/agents-execution";
import {
  ClaudeCodeAdapter,
  CursorAdapter,
  FakeAgentAdapter,
  OpenCodeAdapter,
  resolveCursorApprovalFlags,
} from "@aguil/agents-execution";
import type { LoadedHarness } from "@aguil/agents-harness-config";
import {
  applyFindingPipelines,
  filterEnabledRoles,
  harnessDeclaresPolicy,
  loadHarness,
  makePassGate,
  validateOutcomesAgainstSchemas,
} from "@aguil/agents-harness-config";
import {
  adapterCanDeny,
  adapterHookCapabilities,
  generateClaudeHooksConfig,
  generateCursorHooksConfig,
  renderClaudeSettingsConfig,
  renderCursorHooksConfig,
  undispatchableLifecycleHookWarnings,
} from "@aguil/agents-hooks";
import {
  harnessStatusIsFindingsBlind,
  NativeBunOrchestrator,
} from "@aguil/agents-orchestration";
import { POLICY_NONE_TOKEN } from "@aguil/agents-policy";
import {
  resolveReportRenderer,
  statusAfterFindingPipelines,
} from "@aguil/agents-reporting";

export { POLICY_NONE_TOKEN } from "@aguil/agents-policy";

const SUPPORTED_ADAPTERS = ["cursor", "claude", "opencode", "fake"] as const;
type AdapterName = (typeof SUPPORTED_ADAPTERS)[number];

interface HarnessRunArgs {
  readonly harnessId: string;
  readonly agentsDir: string;
  readonly workspace: string;
  readonly adapter: AdapterName;
  readonly agentsCli?: string;
  readonly strict: boolean;
  readonly allowUnenforcedPolicy: boolean;
  /** Opt into Cursor `--force` (issue #159 / ADR 0020). Default off. */
  readonly forceToolCalls: boolean;
}

const USAGE = `Usage: agents harness run <id> --agents-dir <dir> --workspace <path>
                        [--adapter cursor|claude|opencode|fake]
                        [--agents-cli <cmd>] [--strict]
                        [--allow-unenforced-policy]
                        [--force-tool-calls]

Run a harness declared under <agents-dir>/harnesses/<id>.

Required:
  <id>                     Harness id
  --agents-dir <dir>       Directory containing harnesses/ (and policies/)
  --workspace <path>       Workspace the harness operates on

Optional:
  --adapter <name>         cursor (default) | claude | opencode | fake
  --agents-cli <cmd>       agents CLI used by generated hooks (default: agents)
  --strict                 Fail the run on schema / enablement violations
  --allow-unenforced-policy
                           Permit adapters that cannot enforce a declared policy
  --force-tool-calls       Pass Cursor --force (auto-allow unless denied).
                           Defeats hook ask / exec.unknown escalation; prefer
                           the default (sandbox enabled, force off).

See also: agents harness --help  (install packaged harnesses)`;

function parseHarnessRunArgv(argv: readonly string[]): HarnessRunArgs | string {
  const [harnessId, ...rest] = argv;
  if (harnessId === undefined || harnessId.startsWith("--")) {
    return `harness run: missing harness id\n${USAGE}`;
  }
  let agentsDir: string | undefined;
  let workspace: string | undefined;
  let adapter: AdapterName = "cursor";
  let agentsCli: string | undefined;
  let strict = false;
  let allowUnenforcedPolicy = false;
  let forceToolCalls = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--agents-dir") {
      agentsDir = rest[++index];
    } else if (arg === "--workspace") {
      workspace = rest[++index];
    } else if (arg === "--adapter") {
      const candidate = rest[++index];
      if (!SUPPORTED_ADAPTERS.includes(candidate as AdapterName)) {
        return `harness run: unsupported adapter "${candidate}" (${SUPPORTED_ADAPTERS.join(", ")})`;
      }
      adapter = candidate as AdapterName;
    } else if (arg === "--agents-cli") {
      agentsCli = rest[++index];
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--allow-unenforced-policy") {
      allowUnenforcedPolicy = true;
    } else if (arg === "--force-tool-calls") {
      forceToolCalls = true;
    } else {
      return `harness run: unknown argument "${arg}"\n${USAGE}`;
    }
  }
  if (agentsDir === undefined || workspace === undefined) {
    return `harness run: --agents-dir and --workspace are required\n${USAGE}`;
  }
  return {
    harnessId,
    agentsDir,
    workspace,
    adapter,
    agentsCli,
    strict,
    allowUnenforcedPolicy,
    forceToolCalls,
  };
}

/**
 * Cursor options for `harness run`. Default is force off + sandbox enabled
 * (via adapter defaults). `--force-tool-calls` is the explicit weaker posture
 * (issue #159 / ADR 0020).
 */
export function cursorOptionsForHarnessRun(
  forceToolCalls: boolean,
): CursorAdapterOptions {
  return forceToolCalls ? { force: true } : {};
}

function constructAdapter(
  name: AdapterName,
  options: {
    readonly forceToolCalls: boolean;
    readonly claude?: ClaudeCodeAdapterOptions;
  },
): AgentAdapter {
  switch (name) {
    case "cursor":
      return new CursorAdapter(
        cursorOptionsForHarnessRun(options.forceToolCalls),
      );
    case "claude":
      return new ClaudeCodeAdapter(options.claude ?? {});
    case "opencode":
      return new OpenCodeAdapter({});
    case "fake":
      return new FakeAgentAdapter({});
  }
}

type EnforcementArgs = Pick<
  HarnessRunArgs,
  "adapter" | "agentsDir" | "workspace" | "agentsCli" | "allowUnenforcedPolicy"
> & {
  /** Run scratchpad — Claude settings land here (ADR 0023 / JC-3). */
  readonly scratchpadPath: string;
};

/**
 * Write the role-invariant `.cursor/hooks.json`. Policy identity is NOT in
 * this file — it travels via per-spawn env (ADR 0008) — so the bytes are
 * identical for every role and run of this harness. The write is atomic
 * (temp + rename) so a hook process or concurrent run reading mid-write
 * never observes partial JSON, which could silently drop enforcement.
 */
async function writeCanonicalCursorHooks(
  loaded: LoadedHarness,
  args: EnforcementArgs,
): Promise<void> {
  const { config } = generateCursorHooksConfig({
    hooks: loaded.hooks,
    policyBridge: harnessDeclaresPolicy(loaded),
    agentsCli: args.agentsCli,
  });
  const cursorDir = join(resolve(args.workspace), ".cursor");
  await mkdir(cursorDir, { recursive: true });
  const finalPath = join(cursorDir, "hooks.json");
  // pid+timestamp is not unique under same-process concurrency (interleaved
  // onRoleStart callbacks share both), so a random component is required for
  // the rename source to survive until its own rename.
  const tempPath = `${finalPath}.${crypto.randomUUID()}.tmp`;
  await writeFile(tempPath, renderCursorHooksConfig(config));
  await rename(tempPath, finalPath);
}

/**
 * Write run-scoped Claude Code settings into the scratchpad (ADR 0023
 * decision 3). Nothing in the user's workspace tree is touched.
 */
async function writeCanonicalClaudeSettings(
  loaded: LoadedHarness,
  args: EnforcementArgs,
): Promise<string> {
  const generated = generateClaudeHooksConfig({
    hooks: loaded.hooks,
    policyBridge: harnessDeclaresPolicy(loaded),
    agentsCli: args.agentsCli,
  });
  const finalPath = join(args.scratchpadPath, "claude-settings.json");
  const tempPath = `${finalPath}.${crypto.randomUUID()}.tmp`;
  await writeFile(tempPath, renderClaudeSettingsConfig(generated.config));
  await rename(tempPath, finalPath);
  return finalPath;
}

export interface HookEnforcementSetup {
  readonly onRoleStart?: (roleId: string) => Promise<void>;
  readonly roleEnv?: (roleId: string) => Readonly<Record<string, string>>;
  /** Present when the Claude adapter should load run-scoped settings. */
  readonly claudeSettingsPath?: string;
}

/**
 * Set up policy enforcement for this run (ADR 0008 / ADR 0023).
 *
 * The hook config only registers the env-reading policy bridge; the per-role
 * policy id travels in each role's subprocess environment via roleEnv.
 * onRoleStart regenerates the (constant) file before every role as tamper
 * repair. Enforcement is per-adapter via `adapterCanDeny`, not a hard-coded
 * cursor comparison.
 */
export async function setUpHookEnforcement(
  loaded: LoadedHarness,
  args: EnforcementArgs,
): Promise<HookEnforcementSetup | { readonly error: string }> {
  const hasHooks = Object.keys(loaded.hooks).length > 0;
  const hasAnyPolicy = harnessDeclaresPolicy(loaded);
  // ADR 0024: tell the author when a declared lifecycle handler cannot fire
  // under the active adapter's generator.
  for (const warning of undispatchableLifecycleHookWarnings(
    loaded.hooks,
    args.adapter,
  )) {
    console.warn(`harness run: ${warning}`);
  }
  if (!hasHooks && !hasAnyPolicy) {
    return {};
  }

  const caps = adapterHookCapabilities(args.adapter);
  const canDeny = adapterCanDeny(args.adapter);
  if (!canDeny) {
    if (hasAnyPolicy && !args.allowUnenforcedPolicy) {
      const reason =
        caps?.cannotDenyReason ??
        `adapter "${args.adapter}" has no blocking hook mechanism`;
      return {
        error:
          `harness run: harness declares a policy but adapter "${args.adapter}" cannot enforce it ` +
          `(${reason}). Re-run with --adapter cursor or --adapter claude, ` +
          "or pass --allow-unenforced-policy to run WITHOUT policy enforcement.",
      };
    }
    console.warn(
      `harness run: adapter "${args.adapter}" runs WITHOUT generated hook enforcement` +
        (args.allowUnenforcedPolicy ? " (--allow-unenforced-policy)" : ""),
    );
    return {};
  }

  const agentsDir = resolve(args.agentsDir);
  const roleEnv = hasAnyPolicy
    ? (roleId: string) => ({
        AGENTS_POLICY_ID:
          roleEffectivePolicyId(loaded, roleId) ?? POLICY_NONE_TOKEN,
        AGENTS_AGENTS_DIR: agentsDir,
      })
    : undefined;

  if (args.adapter === "cursor") {
    await writeCanonicalCursorHooks(loaded, args);
    return {
      onRoleStart: async (roleId: string) => {
        await writeCanonicalCursorHooks(loaded, args);
        console.warn(
          `harness run: role "${roleId}" enforced under policy "${roleEffectivePolicyId(loaded, roleId) ?? "(none)"}"`,
        );
      },
      ...(roleEnv === undefined ? {} : { roleEnv }),
    };
  }

  if (args.adapter === "claude") {
    const claudeSettingsPath = await writeCanonicalClaudeSettings(loaded, args);
    return {
      claudeSettingsPath,
      onRoleStart: async (roleId: string) => {
        await writeCanonicalClaudeSettings(loaded, args);
        console.warn(
          `harness run: role "${roleId}" enforced under policy "${roleEffectivePolicyId(loaded, roleId) ?? "(none)"}"`,
        );
      },
      ...(roleEnv === undefined ? {} : { roleEnv }),
    };
  }

  return {
    error: `harness run: adapter "${args.adapter}" is marked canDeny but has no generator (internal matrix error)`,
  };
}

/**
 * Bind `tier` for enablement expressions from a collected `triage`
 * artifact (the git-diff builtin emits one; any provider producing an
 * artifact with id "triage" and a bare tier as content works, which is
 * also the deterministic-test seam). No artifact or an unrecognized value
 * → no binding, so expressions referencing tier fail loud downstream.
 */
function triageTierFromArtifacts(
  artifacts: ReadonlyArray<{ readonly id: string; readonly content: string }>,
): string | undefined {
  const content = artifacts
    .find((artifact) => artifact.id === "triage")
    ?.content.trim();
  return content !== undefined && isReviewTriageTier(content)
    ? content
    : undefined;
}

/** Effective policy id for a role: role override, else harness default. */
export function roleEffectivePolicyId(
  loaded: LoadedHarness,
  roleId: string,
): string | undefined {
  return loaded.rolePolicies[roleId]?.id ?? loaded.policy?.id;
}

export async function runHarnessRunCli(
  argv: readonly string[],
): Promise<number> {
  if (argv.some((t) => t === "--help" || t === "-h")) {
    console.log(USAGE);
    return 0;
  }
  const parsed = parseHarnessRunArgv(argv);
  if (typeof parsed === "string") {
    console.error(parsed);
    return 1;
  }

  let loaded: LoadedHarness;
  try {
    loaded = await loadHarness({
      agentsDir: parsed.agentsDir,
      harnessId: parsed.harnessId,
    });
  } catch (error) {
    console.error(
      `harness run: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  if (parsed.forceToolCalls) {
    // Same audibility bar as --allow-unenforced-policy: weakening the Cursor
    // approval posture must be stated on stderr, not inherited quietly.
    if (harnessDeclaresPolicy(loaded)) {
      console.warn(
        "harness run: --force-tool-calls collapses hook ask into allow and " +
          "defeats confirmations.requiredFor escalation (exec.unknown / " +
          "filesystem.write) despite a declared policy (issue #159)",
      );
    } else {
      console.warn(
        "harness run: --force-tool-calls passes Cursor --force (auto-allow unless denied)",
      );
    }
  }

  const workspacePath = resolve(parsed.workspace);
  const runId = createRunId(`harness-${parsed.harnessId}`);
  const scratchpadPath = join(workspacePath, ".agents-harness", "runs", runId);
  await mkdir(scratchpadPath, { recursive: true });

  // Enforcement needs the scratchpad so Claude settings are run-scoped
  // (ADR 0023 / JC-3) rather than written into the workspace.
  const enforcement = await setUpHookEnforcement(loaded, {
    ...parsed,
    scratchpadPath,
  });
  if ("error" in enforcement) {
    console.error(enforcement.error);
    return 1;
  }
  const onRoleStart = enforcement.onRoleStart;
  const roleEnv = enforcement.roleEnv;

  let contextBundlePath: string;
  const enablementEnv: Record<string, string | number | boolean> = {};
  if (loaded.contextProviders !== undefined) {
    // Declared providers resolve against the builtin registry; resolution
    // errors (unknown name, bad params) abort before any role runs.
    // Resolution AND collection failures use the same controlled error
    // surface: a required-but-missing file or a failing provider must not
    // escape as a bare stack trace.
    try {
      const providers = loaded.contextProviders.map((spec) =>
        resolveContextProvider(spec.use, spec.params),
      );
      const bundle = await collectContextBundle(
        `${runId}-context`,
        { workspacePath, scratchpadPath },
        providers,
      );
      const written = await writeContextBundle(bundle, scratchpadPath);
      contextBundlePath = written.jsonPath;
      const tier = triageTierFromArtifacts(bundle.artifacts);
      if (tier !== undefined) {
        enablementEnv.tier = tier;
      }
    } catch (error) {
      console.error(
        `harness run: context collection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  } else {
    contextBundlePath = join(scratchpadPath, "context.json");
    await writeJsonFile(contextBundlePath, {
      id: runId,
      artifacts: [
        {
          id: "workspace",
          title: "Workspace under triage",
          content: `Workspace path: ${workspacePath}`,
        },
      ],
    });
  }

  // Role enablement is decided from collected context, fail closed: a
  // broken expression (or one referencing a binding no provider produced,
  // e.g. tier without a triage artifact) aborts the run rather than
  // guessing which way the author meant to gate the role.
  let definition = loaded.definition;
  try {
    const enablement = filterEnabledRoles(loaded.definition, enablementEnv);
    definition = enablement.definition;
    if (enablement.disabledRoleIds.length > 0) {
      console.warn(
        `harness run: roles disabled by enablement expressions: ${enablement.disabledRoleIds.join(", ")}`,
      );
    }
  } catch (error) {
    console.error(
      `harness run: role enablement failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  const passGate = makePassGate(loaded.definition.execution, workspacePath);
  const outputSchemas = loaded.outputSchemas;
  const validateRoleOutcomes =
    outputSchemas === undefined
      ? undefined
      : (input: { readonly outcomes: readonly HarnessOutcome[] }) =>
          validateOutcomesAgainstSchemas(input.outcomes, outputSchemas);

  const orchestrator = new NativeBunOrchestrator({
    definition,
    adapter: constructAdapter(parsed.adapter, {
      forceToolCalls: parsed.forceToolCalls,
      ...(enforcement.claudeSettingsPath === undefined
        ? {}
        : {
            claude: {
              settingsPath: enforcement.claudeSettingsPath,
              requireHookEnforcement: harnessDeclaresPolicy(loaded),
            },
          }),
    }),
    contextBundlePath,
    ...(onRoleStart === undefined ? {} : { onRoleStart }),
    ...(roleEnv === undefined ? {} : { roleEnv }),
    ...(passGate === undefined ? {} : { passGate }),
    ...(validateRoleOutcomes === undefined ? {} : { validateRoleOutcomes }),
  });

  const cursorApproval =
    parsed.adapter === "cursor"
      ? resolveCursorApprovalFlags(
          cursorOptionsForHarnessRun(parsed.forceToolCalls),
        )
      : undefined;

  const result = await orchestrator.run({
    runId,
    harnessId: parsed.harnessId,
    workspacePath,
    scratchpadPath,
    strictMode: parsed.strict,
    ...(cursorApproval === undefined
      ? {}
      : {
          metadata: {
            cursor_force: cursorApproval.force ? "true" : "false",
            cursor_sandbox: cursorApproval.sandbox ?? "",
          },
        }),
  });

  // Declared pipelines shape the reported findings the same way the
  // code-review package does imperatively (it renders report.md AFTER
  // dedup/filter); the raw count stays visible so filtering is
  // observable, never silent. The rendered report consumes the same
  // pipelined view — reporting raw findings would break parity.
  const hasPipelines =
    loaded.findingFilters !== undefined || loaded.findingDedupers !== undefined;
  const reportedFindings = hasPipelines
    ? applyFindingPipelines(result.findings, {
        ...(loaded.findingFilters === undefined
          ? {}
          : { filters: loaded.findingFilters }),
        ...(loaded.findingDedupers === undefined
          ? {}
          : { dedupers: loaded.findingDedupers }),
      })
    : result.findings;

  // Only recompute when a classifier actually ran. Without pipelines the
  // findings carry no marker this code put there, and re-deriving status from
  // them would start honoring one an agent supplied.
  const status = hasPipelines
    ? statusAfterFindingPipelines({
        rawStatus: result.status,
        findings: reportedFindings,
        findingsBlind: harnessStatusIsFindingsBlind(
          loaded.definition.execution,
          {
            ...(passGate === undefined ? {} : { passGate }),
          },
        ),
        timedOut: (result.metadata?.timed_out_roles ?? "") !== "",
      })
    : result.status;

  console.log(`run: ${result.runId}`);
  console.log(`status: ${status}`);
  console.log(`execution: ${result.metadata?.execution_mode ?? "parallel"}`);
  console.log(
    `roles completed: ${result.metadata?.completed_roles ?? "(none)"}`,
  );
  if ((result.metadata?.failed_roles ?? "") !== "") {
    console.log(`roles failed: ${result.metadata?.failed_roles}`);
  }
  if (hasPipelines) {
    console.log(
      `findings: ${reportedFindings.length} after pipelines (${result.findings.length} raw)`,
    );
    // Reported but not counted toward status (ADR 0019 §4). Said out loud
    // because the whole point of the classifier is that nothing it sets aside
    // disappears quietly.
    const unsubstantiated = reportedFindings.filter(
      (finding) => finding.unsubstantiated === true,
    ).length;
    if (unsubstantiated > 0) {
      console.log(
        `findings reported but not counted: ${unsubstantiated} (unverified or citing no evidence)`,
      );
    }
  }
  for (const outcome of result.outcomes ?? []) {
    console.log(
      `- [${outcome.kind}] ${outcome.sourceRole}: ${outcome.title} (${outcome.id})`,
    );
  }
  if (loaded.reportingTemplate !== undefined) {
    const reportPath = join(scratchpadPath, "report.md");
    await writeFile(
      reportPath,
      resolveReportRenderer(loaded.reportingTemplate)({
        ...result,
        status,
        findings: reportedFindings,
      }),
    );
    console.log(`report: ${reportPath}`);
  }
  console.log(`artifacts: ${scratchpadPath}`);
  return status === "passed" ? 0 : 1;
}
