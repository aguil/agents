import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodeReviewFromConfig } from "@aguil/agents-code-review/config-runner";
import type { ContextBundle } from "@aguil/agents-context";
import { FakeAgentAdapter } from "@aguil/agents-execution";
import { type LoadedHarness, loadHarness } from "@aguil/agents-harness-config";
import type { HarnessDefinition } from "@aguil/agents-orchestration";

/**
 * Third-layer coverage for issue #156: every key the loader stores must have
 * an explicit disposition on each harness entry path, so a new field cannot
 * default to "parsed, stored, never read".
 *
 * Path (a) is `harness run` (`packages/cli/src/harness-run-main.ts`).
 * Path (b) is `runCodeReviewFromConfig` (`harnesses/code-review/src/config-runner.ts`).
 */

type PathDisposition = "consumed" | "rejected" | { readonly "n/a": string };

interface KeyDisposition {
  readonly harnessRun: PathDisposition;
  readonly codeReview: PathDisposition;
}

/**
 * Level 1: keys on `LoadedHarness`. Comments on `consumed` rows name where
 * the path reads the field (or the behavior test that pins it).
 */
const LOADED_HARNESS_DISPOSITIONS = {
  // Both paths pass `loaded.definition` (after enablement filtering) into
  // `NativeBunOrchestrator`. Nested fields are covered in
  // `HARNESS_DEFINITION_DISPOSITIONS`.
  definition: { harnessRun: "consumed", codeReview: "consumed" },
  // `setUpHookEnforcement` / `roleEffectivePolicyId` in harness-run-main.ts;
  // pinned by "a policy-declaring harness fails closed on a non-cursor adapter"
  // and "enforcement provides per-role env in every mode..." in
  // harness-run-cli.test.ts.
  policy: { harnessRun: "consumed", codeReview: "rejected" },
  // Same enforcement path as `policy` via `harnessDeclaresPolicy` and
  // `roleEffectivePolicyId` (harness-run-main.ts).
  rolePolicies: { harnessRun: "consumed", codeReview: "rejected" },
  // `writeCanonicalHooks` / `setUpHookEnforcement` in harness-run-main.ts;
  // pinned by the ADR 0008 enforcement test in harness-run-cli.test.ts.
  hooks: { harnessRun: "consumed", codeReview: "rejected" },
  // `runHarnessRunCli` resolves and collects providers; pinned by
  // "declared context providers collect the bundle for the run" in
  // harness-run-cli.test.ts. `runCodeReviewFromConfig` maps
  // `loaded.contextProviders` into `collectContextBundle`, after refusing
  // workspace-sourced `shell-command` providers (see
  // "a workspace-sourced shell-command provider is refused rather than
  // executed").
  contextProviders: { harnessRun: "consumed", codeReview: "consumed" },
  // Both paths wire `validateOutcomesAgainstSchemas` into the orchestrator's
  // `validateRoleOutcomes` (harness-run-main.ts / config-runner.ts).
  outputSchemas: { harnessRun: "consumed", codeReview: "consumed" },
  // Both paths pass filters into `applyFindingPipelines` before reporting
  // (harness-run-main.ts / config-runner.ts); config path pinned by
  // "config-driven code review marks unevidenced findings and dedupes by
  // fingerprint" in config-runner-parity.test.ts.
  findingFilters: { harnessRun: "consumed", codeReview: "consumed" },
  // Same `applyFindingPipelines` call site as `findingFilters`.
  findingDedupers: { harnessRun: "consumed", codeReview: "consumed" },
  // `runHarnessRunCli` renders via `resolveReportRenderer` when present
  // (pinned by "declared reporting template renders report.md into the
  // scratchpad" in harness-run-cli.test.ts). `runCodeReviewFromConfig`
  // requires it and writes report.md.
  reportingTemplate: { harnessRun: "consumed", codeReview: "consumed" },
  // Load-time only: `loadHarness` resolves prompt paths and substitutes
  // `$HARNESS_DIR` in hook commands, then stores the directory. Neither
  // entry point reads `loaded.harnessDir` afterward.
  harnessDir: {
    harnessRun: { "n/a": "baked into prompts and hooks at load time" },
    codeReview: { "n/a": "baked into prompts and hooks at load time" },
  },
} as const satisfies Record<keyof LoadedHarness, KeyDisposition>;

/**
 * Level 2: keys on `HarnessDefinition` (nested under `LoadedHarness.definition`).
 * This is where half of issue #156 lived (`execution.pass_check`,
 * `default_allowed_commands`).
 */
const HARNESS_DEFINITION_DISPOSITIONS = {
  // `runCodeReviewFromConfig` passes `loaded.definition.id` as `harnessId`.
  // `runHarnessRunCli` hands the definition to the orchestrator, which uses
  // `definition.id` in execution-config error messages.
  id: { harnessRun: "consumed", codeReview: "consumed" },
  // Both paths run roles through `NativeBunOrchestrator` after
  // `filterEnabledRoles` (enablement pinned by harness-run-cli.test.ts and
  // config-runner-parity trivial-tier scheduling).
  roles: { harnessRun: "consumed", codeReview: "consumed" },
  // Orchestrator `runRole` grants `definition.defaultAllowedCommands`.
  // Config path unions with `defaultCommandsForVcsMode` first; pinned by
  // "declared and vcs-derived command grants are unioned, not replaced".
  defaultAllowedCommands: { harnessRun: "consumed", codeReview: "consumed" },
  // Both paths call `makePassGate(execution, workspacePath)` for
  // `pass_check`, pass the block to the orchestrator for mode/order, and use
  // `harnessStatusIsFindingsBlind` (gate-owned, not bare presence) for
  // findings-blind status (issue #157). The config path first refuses a
  // workspace-sourced `execution` block (trusted sources still consume it);
  // pinned by "a declared pass_check decides the run on the config path too",
  // "a workspace-sourced pass_check is refused rather than executed", and
  // "harness run executes the full chain via the CLI; pass_check fails an
  // unhealed run".
  execution: { harnessRun: "consumed", codeReview: "consumed" },
} as const satisfies Record<keyof HarnessDefinition, KeyDisposition>;

function isRejected(disposition: PathDisposition): boolean {
  return disposition === "rejected";
}

async function writeBundle(root: string): Promise<string> {
  const path = join(root, "context-full.json");
  const bundle: ContextBundle = {
    id: "coverage-context",
    artifacts: [
      {
        id: "triage",
        title: "Recorded triage",
        content: "full",
      },
      {
        id: "diff-strategy",
        title: "Recorded diff strategy",
        content: [
          "PR Number: 73",
          "PR Head SHA: abc123",
          "Reviewed At: 2026-07-18T20:00:00.000Z",
        ].join("\n"),
      },
    ],
  };
  await writeFile(path, JSON.stringify(bundle), "utf8");
  return path;
}

async function writeCodeReviewHarness(
  agentsDir: string,
  extra: readonly string[],
): Promise<void> {
  const harnessDir = join(agentsDir, "harnesses", "code-review");
  await mkdir(harnessDir, { recursive: true });
  await writeFile(
    join(harnessDir, "harness.yaml"),
    [
      'spec_version: "0.4"',
      "kind: harness",
      "harness: { id: code-review }",
      "roles:",
      "  quality:",
      "    description: Quality",
      "    prompt: Review the change.",
      "reporting: { template: builtin:code-review-markdown }",
      ...extra,
    ].join("\n"),
    "utf8",
  );
}

async function writeMaximallyPopulatedAgentsDir(
  agentsDir: string,
): Promise<void> {
  const harnessDir = join(agentsDir, "harnesses", "coverage-max");
  const policiesDir = join(agentsDir, "policies");
  await mkdir(harnessDir, { recursive: true });
  await mkdir(policiesDir, { recursive: true });
  await writeFile(
    join(policiesDir, "readonly.yaml"),
    ["id: readonly", "capabilities:", "  filesystem:", "    deny: ['**']"].join(
      "\n",
    ),
    "utf8",
  );
  await writeFile(
    join(policiesDir, "writer.yaml"),
    [
      "id: writer",
      "capabilities:",
      "  filesystem:",
      "    deny: ['**/.env']",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(harnessDir, "harness.yaml"),
    [
      'spec_version: "0.4"',
      "kind: harness",
      "harness: { id: coverage-max }",
      "policy: readonly",
      "default_allowed_commands: [shellcheck, rg]",
      "roles:",
      "  quality:",
      "    description: Quality",
      "    prompt: Review the change.",
      "    policy: writer",
      "execution:",
      "  mode: chain",
      "  order: [quality]",
      '  pass_check: ["true"]',
      "hooks:",
      "  pre_tool_call:",
      "    - command: 'true'",
      "context:",
      "  providers:",
      "    - use: static-file",
      "      id: note",
      "      path: note.txt",
      "      required: false",
      "output:",
      "  schemas:",
      "    finding: builtin:finding",
      "filtering:",
      "  findings: [builtin:actionable]",
      "deduplication:",
      "  findings: [builtin:fingerprint]",
      "reporting: { template: builtin:code-review-markdown }",
    ].join("\n"),
    "utf8",
  );
}

test("a field added to LoadedHarness has to declare a disposition", async () => {
  const agentsDir = await mkdtemp(join(tmpdir(), "key-coverage-loaded-"));
  try {
    await writeMaximallyPopulatedAgentsDir(agentsDir);
    const loaded = await loadHarness({
      agentsDir,
      harnessId: "coverage-max",
    });
    // Equality rather than containment is the point: an optional field
    // missing from the fixture would leave a dispositioned key unobserved at
    // runtime, which is how the gaps in issue #156 stayed invisible.
    expect(Object.keys(loaded).sort()).toEqual(
      Object.keys(LOADED_HARNESS_DISPOSITIONS).sort(),
    );
  } finally {
    await rm(agentsDir, { recursive: true, force: true });
  }
});

test("a field added to HarnessDefinition has to declare a disposition", async () => {
  const agentsDir = await mkdtemp(join(tmpdir(), "key-coverage-definition-"));
  try {
    await writeMaximallyPopulatedAgentsDir(agentsDir);
    const loaded = await loadHarness({
      agentsDir,
      harnessId: "coverage-max",
    });
    expect(Object.keys(loaded.definition).sort()).toEqual(
      Object.keys(HARNESS_DEFINITION_DISPOSITIONS).sort(),
    );
  } finally {
    await rm(agentsDir, { recursive: true, force: true });
  }
});

test("every key marked rejected on code-review is refused by the entry point", async () => {
  // Both levels, so a rejection recorded on a definition field has to be
  // proven too rather than being unreachable by this test. Key names do not
  // currently collide across the two tables.
  const rejectedKeys = [
    ...Object.entries(LOADED_HARNESS_DISPOSITIONS),
    ...Object.entries(HARNESS_DEFINITION_DISPOSITIONS),
  ]
    .filter(([, disposition]) => isRejected(disposition.codeReview))
    .map(([key]) => key);

  // Keep the fixture map aligned with the table: a new `rejected` row without
  // a constructor here fails before any entry point is called.
  const declare: Record<
    "hooks" | "policy" | "rolePolicies",
    {
      readonly extra?: readonly string[];
      readonly writeFull?: true;
      readonly setup?: (agentsDir: string) => Promise<void>;
    }
  > = {
    hooks: {
      extra: ["hooks:", "  pre_tool_call:", "    - command: 'true'"],
    },
    policy: {
      extra: ["policy: readonly"],
      setup: async (agentsDir) => {
        await mkdir(join(agentsDir, "policies"), { recursive: true });
        await writeFile(
          join(agentsDir, "policies", "readonly.yaml"),
          [
            "id: readonly",
            "capabilities:",
            "  filesystem:",
            "    deny: ['**']",
          ].join("\n"),
          "utf8",
        );
      },
    },
    rolePolicies: {
      // Role-level only so this case is not just `policy` under another name.
      // Built as a full document below: appending a second `roles:` block onto
      // `writeCodeReviewHarness` would replace the role mapping in YAML.
      writeFull: true,
      setup: async (agentsDir) => {
        await mkdir(join(agentsDir, "policies"), { recursive: true });
        await writeFile(
          join(agentsDir, "policies", "readonly.yaml"),
          [
            "id: readonly",
            "capabilities:",
            "  filesystem:",
            "    deny: ['**']",
          ].join("\n"),
          "utf8",
        );
      },
    },
  };

  expect([...rejectedKeys].sort()).toEqual(
    (Object.keys(declare) as (keyof typeof declare)[]).sort(),
  );

  const workspacePath = await mkdtemp(join(tmpdir(), "key-coverage-reject-"));
  try {
    const contextBundlePath = await writeBundle(workspacePath);
    for (const key of Object.keys(declare) as (keyof typeof declare)[]) {
      const fixture = declare[key];
      const agentsDir = join(workspacePath, `agents-${key}`);
      await mkdir(agentsDir, { recursive: true });
      await fixture.setup?.(agentsDir);
      if (fixture.writeFull === true) {
        const harnessDir = join(agentsDir, "harnesses", "code-review");
        await mkdir(harnessDir, { recursive: true });
        await writeFile(
          join(harnessDir, "harness.yaml"),
          [
            'spec_version: "0.4"',
            "kind: harness",
            "harness: { id: code-review }",
            "roles:",
            "  quality:",
            "    description: Quality",
            "    prompt: Review the change.",
            "    policy: readonly",
            "reporting: { template: builtin:code-review-markdown }",
          ].join("\n"),
          "utf8",
        );
      } else {
        await writeCodeReviewHarness(agentsDir, fixture.extra ?? []);
      }

      await expect(
        runCodeReviewFromConfig({
          agentsDir,
          workspacePath,
          runId: `coverage-reject-${key}`,
          contextBundlePath,
          adapter: new FakeAgentAdapter(),
          scratchpadRoot: join(workspacePath, `configured-${key}`),
        }),
      ).rejects.toThrow(
        key === "hooks" ? "harness declares hooks" : "harness declares policy",
      );
    }
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});
