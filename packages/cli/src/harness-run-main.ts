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
import type { AgentAdapter } from "@aguil/agents-execution";
import {
  ClaudeCodeAdapter,
  CursorAdapter,
  FakeAgentAdapter,
  OpenCodeAdapter,
} from "@aguil/agents-execution";
import type { LoadedHarness } from "@aguil/agents-harness-config";
import {
  applyFindingPipelines,
  filterEnabledRoles,
  loadHarness,
  validateOutcomesAgainstSchemas,
} from "@aguil/agents-harness-config";
import {
  generateCursorHooksConfig,
  renderCursorHooksConfig,
} from "@aguil/agents-hooks";
import { NativeBunOrchestrator } from "@aguil/agents-orchestration";
import { POLICY_NONE_TOKEN } from "@aguil/agents-policy";

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
}

const USAGE = `Usage: agents harness run <id> --agents-dir <dir> --workspace <path>
                        [--adapter cursor|claude|opencode|fake]
                        [--agents-cli <cmd>] [--strict]
                        [--allow-unenforced-policy]`;

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
  };
}

function constructAdapter(name: AdapterName): AgentAdapter {
  switch (name) {
    case "cursor":
      return new CursorAdapter({ force: true });
    case "claude":
      return new ClaudeCodeAdapter({});
    case "opencode":
      return new OpenCodeAdapter({});
    case "fake":
      return new FakeAgentAdapter({});
  }
}

type EnforcementArgs = Pick<
  HarnessRunArgs,
  "adapter" | "agentsDir" | "workspace" | "agentsCli" | "allowUnenforcedPolicy"
>;

/**
 * Write the role-invariant `.cursor/hooks.json`. Policy identity is NOT in
 * this file — it travels via per-spawn env (ADR 0008) — so the bytes are
 * identical for every role and run of this harness. The write is atomic
 * (temp + rename) so a hook process or concurrent run reading mid-write
 * never observes partial JSON, which could silently drop enforcement.
 */
async function writeCanonicalHooks(
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

function harnessDeclaresPolicy(loaded: LoadedHarness): boolean {
  return (
    loaded.policy !== undefined || Object.keys(loaded.rolePolicies).length > 0
  );
}

/**
 * Set up policy enforcement for this run (ADR 0008).
 *
 * The hook config file only registers the env-reading policy bridge; the
 * per-role policy id travels in each role's subprocess environment via
 * roleEnv, so enforcement works identically in chain, parallel, and
 * validation-loop modes and cannot cross-contaminate concurrent runs.
 * onRoleStart still regenerates the (constant) file before every role as
 * tamper repair — safe to interleave because all writers produce the same
 * bytes and the write is atomic.
 */
export async function setUpHookEnforcement(
  loaded: LoadedHarness,
  args: EnforcementArgs,
): Promise<
  | {
      readonly onRoleStart?: (roleId: string) => Promise<void>;
      readonly roleEnv?: (roleId: string) => Readonly<Record<string, string>>;
    }
  | { readonly error: string }
> {
  const hasHooks = Object.keys(loaded.hooks).length > 0;
  const hasAnyPolicy = harnessDeclaresPolicy(loaded);
  if (!hasHooks && !hasAnyPolicy) {
    return {};
  }
  if (args.adapter !== "cursor") {
    // Hook config generation is cursor-only in v1, so a declared policy
    // cannot be enforced on other adapters. Fail closed unless the operator
    // explicitly accepts an unenforced run.
    if (hasAnyPolicy && !args.allowUnenforcedPolicy) {
      return {
        error:
          `harness run: harness declares a policy but adapter "${args.adapter}" cannot enforce it ` +
          "(hook config generation is cursor-only in v1). Re-run with --adapter cursor, " +
          "or pass --allow-unenforced-policy to run WITHOUT policy enforcement.",
      };
    }
    console.warn(
      `harness run: adapter "${args.adapter}" runs WITHOUT generated hook enforcement (--allow-unenforced-policy)`,
    );
    return {};
  }

  await writeCanonicalHooks(loaded, args);
  const agentsDir = resolve(args.agentsDir);
  return {
    onRoleStart: async (roleId: string) => {
      await writeCanonicalHooks(loaded, args);
      console.warn(
        `harness run: role "${roleId}" enforced under policy "${roleEffectivePolicyId(loaded, roleId) ?? "(none)"}"`,
      );
    },
    ...(hasAnyPolicy
      ? {
          roleEnv: (roleId: string) => ({
            AGENTS_POLICY_ID:
              roleEffectivePolicyId(loaded, roleId) ?? POLICY_NONE_TOKEN,
            AGENTS_AGENTS_DIR: agentsDir,
          }),
        }
      : {}),
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

/**
 * Build the orchestrator pass gate from `execution.pass_check`: run the
 * command in the workspace after roles complete; exit 0 => passed. Runtime-
 * evaluated so agent output cannot decide status. Undefined when the harness
 * declares no pass_check.
 */
function makePassGate(
  loaded: LoadedHarness,
  workspacePath: string,
): (() => Promise<boolean>) | undefined {
  const execution = loaded.definition.execution;
  if (
    execution === undefined ||
    execution.mode !== "chain" ||
    execution.passCheck === undefined
  ) {
    return undefined;
  }
  const command = execution.passCheck;
  return async () => {
    const proc = Bun.spawn({
      cmd: [...command],
      cwd: workspacePath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.warn(
        `harness run: pass_check "${command.join(" ")}" exited ${exitCode}; run FAILED`,
      );
    }
    return exitCode === 0;
  };
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

  const enforcement = await setUpHookEnforcement(loaded, parsed);
  if ("error" in enforcement) {
    console.error(enforcement.error);
    return 1;
  }
  const onRoleStart = enforcement.onRoleStart;
  const roleEnv = enforcement.roleEnv;

  const workspacePath = resolve(parsed.workspace);
  const runId = createRunId(`harness-${parsed.harnessId}`);
  const scratchpadPath = join(workspacePath, ".agents-harness", "runs", runId);
  await mkdir(scratchpadPath, { recursive: true });
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

  const passGate = makePassGate(loaded, workspacePath);
  const outputSchemas = loaded.outputSchemas;
  const validateRoleOutcomes =
    outputSchemas === undefined
      ? undefined
      : (input: { readonly outcomes: readonly HarnessOutcome[] }) =>
          validateOutcomesAgainstSchemas(input.outcomes, outputSchemas);

  const orchestrator = new NativeBunOrchestrator({
    definition,
    adapter: constructAdapter(parsed.adapter),
    contextBundlePath,
    ...(onRoleStart === undefined ? {} : { onRoleStart }),
    ...(roleEnv === undefined ? {} : { roleEnv }),
    ...(passGate === undefined ? {} : { passGate }),
    ...(validateRoleOutcomes === undefined ? {} : { validateRoleOutcomes }),
  });

  const result = await orchestrator.run({
    runId,
    harnessId: parsed.harnessId,
    workspacePath,
    scratchpadPath,
    strictMode: parsed.strict,
  });

  console.log(`run: ${result.runId}`);
  console.log(`status: ${result.status}`);
  console.log(`execution: ${result.metadata?.execution_mode ?? "parallel"}`);
  console.log(
    `roles completed: ${result.metadata?.completed_roles ?? "(none)"}`,
  );
  if ((result.metadata?.failed_roles ?? "") !== "") {
    console.log(`roles failed: ${result.metadata?.failed_roles}`);
  }
  // Declared pipelines shape the reported findings the same way the
  // code-review package does imperatively; the raw count is kept visible
  // so filtering is observable, never silent.
  if (
    loaded.findingFilters !== undefined ||
    loaded.findingDedupers !== undefined
  ) {
    const pipelined = applyFindingPipelines(result.findings, {
      ...(loaded.findingFilters === undefined
        ? {}
        : { filters: loaded.findingFilters }),
      ...(loaded.findingDedupers === undefined
        ? {}
        : { dedupers: loaded.findingDedupers }),
    });
    console.log(
      `findings: ${pipelined.length} after pipelines (${result.findings.length} raw)`,
    );
  }
  for (const outcome of result.outcomes ?? []) {
    console.log(
      `- [${outcome.kind}] ${outcome.sourceRole}: ${outcome.title} (${outcome.id})`,
    );
  }
  console.log(`artifacts: ${scratchpadPath}`);
  return result.status === "passed" ? 0 : 1;
}
