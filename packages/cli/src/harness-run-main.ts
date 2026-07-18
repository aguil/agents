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
}

const USAGE = `Usage: agents harness run <id> --agents-dir <dir> --workspace <path>
                        [--adapter cursor|claude|opencode|fake]
                        [--agents-cli <cmd>] [--strict]`;

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
    } else {
      return `harness run: unknown argument "${arg}"\n${USAGE}`;
    }
  }
  if (agentsDir === undefined || workspace === undefined) {
    return `harness run: --agents-dir and --workspace are required\n${USAGE}`;
  }
  return { harnessId, agentsDir, workspace, adapter, agentsCli, strict };
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
 * Generate the workspace .cursor/hooks.json so the policy-eval bridge and
 * harness hooks gate the run. Cursor adapter only in v1; other adapters get
 * a warning so the gap is visible rather than silent.
 */
async function materializeHooks(
  loaded: LoadedHarness,
  args: HarnessRunArgs,
): Promise<void> {
  const hasHooks = Object.keys(loaded.hooks).length > 0;
  if (loaded.policy === undefined && !hasHooks) {
    return;
  }
  if (args.adapter !== "cursor") {
    console.warn(
      `harness run: hook/policy config generation targets the cursor adapter; adapter "${args.adapter}" runs WITHOUT generated hook enforcement`,
    );
    return;
  }
  const { config, skippedEvents } = generateCursorHooksConfig({
    hooks: loaded.hooks,
    policyId: loaded.policy?.id,
    agentsDir: resolve(args.agentsDir),
    agentsCli: args.agentsCli,
  });
  const cursorDir = join(resolve(args.workspace), ".cursor");
  await mkdir(cursorDir, { recursive: true });
  await writeFile(
    join(cursorDir, "hooks.json"),
    renderCursorHooksConfig(config),
  );
  if (skippedEvents.length > 0) {
    console.warn(
      `harness run: events without cursor equivalents were skipped: ${skippedEvents.join(", ")}`,
    );
  }
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

  await materializeHooks(loaded, parsed);

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

  const orchestrator = new NativeBunOrchestrator({
    definition: loaded.definition,
    adapter: constructAdapter(parsed.adapter),
    contextBundlePath,
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
