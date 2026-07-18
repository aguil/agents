import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRunId, writeJsonFile } from "@aguil/agents-core";
import type { AgentAdapter } from "@aguil/agents-execution";
import {
  ClaudeCodeAdapter,
  CursorAdapter,
  FakeAgentAdapter,
  OpenCodeAdapter,
} from "@aguil/agents-execution";
import type { LoadedHarness } from "@aguil/agents-harness-config";
import { loadHarness } from "@aguil/agents-harness-config";
import {
  generateCursorHooksConfig,
  renderCursorHooksConfig,
} from "@aguil/agents-hooks";
import { NativeBunOrchestrator } from "@aguil/agents-orchestration";

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

/**
 * Write `.cursor/hooks.json` for a single role's effective policy. Because
 * Cursor reads one workspace-level hook config, per-role enforcement is
 * achieved by regenerating this file immediately before each role runs (via
 * the orchestrator's onRoleStart). Cursor adapter only in v1.
 */
async function writeRoleHooks(
  loaded: LoadedHarness,
  args: HarnessRunArgs,
  policyId: string | undefined,
): Promise<void> {
  const { config } = generateCursorHooksConfig({
    hooks: loaded.hooks,
    policyId,
    agentsDir: resolve(args.agentsDir),
    agentsCli: args.agentsCli,
  });
  const cursorDir = join(resolve(args.workspace), ".cursor");
  await mkdir(cursorDir, { recursive: true });
  await writeFile(
    join(cursorDir, "hooks.json"),
    renderCursorHooksConfig(config),
  );
}

/**
 * Decide how hook config is materialized for this run.
 *
 * Per-role regeneration rewrites the single workspace `.cursor/hooks.json`
 * before each role, which is only race-free when roles run sequentially
 * (chain mode). For parallel and validation-loop modes we generate once
 * from the harness-level policy and warn about any role whose stricter
 * own-policy is therefore not enforced. Returns the onRoleStart callback
 * (chain) or undefined after doing one-shot generation (other modes).
 */
async function setUpHookEnforcement(
  loaded: LoadedHarness,
  args: HarnessRunArgs,
): Promise<
  | { readonly onRoleStart?: (roleId: string) => Promise<void> }
  | { readonly error: string }
> {
  const hasHooks = Object.keys(loaded.hooks).length > 0;
  const hasAnyPolicy =
    loaded.policy !== undefined || Object.keys(loaded.rolePolicies).length > 0;
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

  const mode = loaded.definition.execution?.mode ?? "parallel";
  if (mode === "chain") {
    return {
      // Regenerate unconditionally at every role start. Skipping the rewrite
      // when the policy id is unchanged would let a role tamper with
      // .cursor/hooks.json and have the next same-policy role reuse it; a
      // governance surface must re-establish canonical enforcement per role.
      // The idempotent JSON write is negligible next to that bypass window.
      onRoleStart: async (roleId: string) => {
        const policyId = roleEffectivePolicyId(loaded, roleId);
        await writeRoleHooks(loaded, args, policyId);
        console.warn(
          `harness run: role "${roleId}" enforced under policy "${policyId ?? "(none)"}"`,
        );
      },
    };
  }

  // Non-sequential: one-shot generation from the harness-level policy;
  // per-role regeneration would race on the shared hooks file.
  await writeRoleHooks(loaded, args, loaded.policy?.id);
  const coarsened = Object.keys(loaded.rolePolicies).filter(
    (roleId) => loaded.rolePolicies[roleId]?.id !== loaded.policy?.id,
  );
  if (coarsened.length > 0) {
    console.warn(
      `harness run: ${mode} mode enforces the harness-level policy "${loaded.policy?.id ?? "(none)"}" for all roles; per-role policies for [${coarsened.join(", ")}] require chain mode`,
    );
  }
  return {};
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

  const workspacePath = resolve(parsed.workspace);
  const runId = createRunId(`harness-${parsed.harnessId}`);
  const scratchpadPath = join(workspacePath, ".agents-harness", "runs", runId);
  const contextBundlePath = join(scratchpadPath, "context.json");
  await mkdir(scratchpadPath, { recursive: true });
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

  const passGate = makePassGate(loaded, workspacePath);

  const orchestrator = new NativeBunOrchestrator({
    definition: loaded.definition,
    adapter: constructAdapter(parsed.adapter),
    contextBundlePath,
    ...(onRoleStart === undefined ? {} : { onRoleStart }),
    ...(passGate === undefined ? {} : { passGate }),
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
  for (const outcome of result.outcomes ?? []) {
    console.log(
      `- [${outcome.kind}] ${outcome.sourceRole}: ${outcome.title} (${outcome.id})`,
    );
  }
  console.log(`artifacts: ${scratchpadPath}`);
  return result.status === "passed" ? 0 : 1;
}
