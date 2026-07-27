import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  filterEnabledRoles,
  findAllSchemaViolations,
  HARNESS_SCHEMA,
  loadHarness,
  loadManifest,
  MANIFEST_SCHEMA,
  POLICY_CONFIRMATION_CATEGORIES,
  POLICY_SCHEMA,
  SUPPORTED_SPEC_VERSIONS,
} from "@aguil/agents-harness-config";
import type { HarnessDefinition } from "@aguil/agents-orchestration";
import { REPORT_TEMPLATE_NAMES } from "@aguil/agents-reporting";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "agents-dir",
);

test("loadHarness maps harness.yaml to orchestration types", async () => {
  const loaded = await loadHarness({
    agentsDir: fixturesDir,
    harnessId: "triage-demo",
  });

  expect(loaded.definition.id).toBe("triage-demo");
  expect(loaded.definition.roles.map((r) => r.id)).toEqual([
    "scout",
    "diagnose",
  ]);

  const scout = loaded.definition.roles[0];
  expect(scout.prompt).toContain("Investigate the alert log");
  expect(scout.timeoutMs).toBe(300_000);
  expect(scout.requiredCapabilities).toEqual([]);

  const diagnose = loaded.definition.roles[1];
  expect(diagnose.prompt).toBeUndefined();
  expect(diagnose.promptPath).toBe(
    join(fixturesDir, "harnesses", "triage-demo", "prompts", "diagnose.md"),
  );
  expect(diagnose.allowedCommands).toEqual(["bun test"]);

  expect(loaded.definition.execution).toEqual({
    mode: "chain",
    order: ["scout", "diagnose"],
  });

  // pass_check is optional and absent in this fixture.
  expect(
    (loaded.definition.execution as { passCheck?: unknown }).passCheck,
  ).toBeUndefined();

  const preToolCall = loaded.hooks.pre_tool_call ?? [];
  expect(preToolCall).toHaveLength(1);
  expect(preToolCall[0].matcher).toBe("Execute");
  expect(preToolCall[0].timeoutS).toBe(10);
  expect(preToolCall[0].command).toBe(
    join(fixturesDir, "harnesses", "triage-demo", "hooks", "validate-shell.sh"),
  );
  expect(loaded.hooks.run_end?.[0].command).toBe("echo done");
});

test("loadHarness rejects unsupported hook events and handler types", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    const dir = join(scratch, "harnesses", "hooked");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.1"',
        "kind: harness",
        "harness: { id: hooked }",
        "roles: { a: { description: A } }",
        "hooks:",
        "  mystery_event:",
        '    - command: "x"',
      ].join("\n"),
    );
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "hooked" }),
    ).rejects.toThrow('hooks has unknown key "mystery_event"');

    await writeFile(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.1"',
        "kind: harness",
        "harness: { id: hooked }",
        "roles: { a: { description: A } }",
        "hooks:",
        "  pre_tool_call:",
        '    - prompt: "judge this"',
      ].join("\n"),
    );
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "hooked" }),
    ).rejects.toThrow("command handlers only");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("applies_to narrows tool-call handlers and is rejected elsewhere (spec v0.2)", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    const dir = join(scratch, "harnesses", "scoped");
    await mkdir(dir, { recursive: true });
    const spec = (hooksLines: readonly string[]) =>
      writeFile(
        join(dir, "harness.yaml"),
        [
          'spec_version: "0.2"',
          "kind: harness",
          "harness: { id: scoped }",
          "roles: { a: { description: A } }",
          "hooks:",
          ...hooksLines,
        ].join("\n"),
      );

    await spec([
      "  pre_tool_call:",
      '    - command: "x"',
      '      applies_to: ["shell"]',
    ]);
    const loaded = await loadHarness({
      agentsDir: scratch,
      harnessId: "scoped",
    });
    expect(loaded.hooks.pre_tool_call?.[0].appliesTo).toEqual(["shell"]);

    // applies_to only exists on tool-call events.
    await spec([
      "  role_stop:",
      '    - command: "x"',
      '      applies_to: ["shell"]',
    ]);
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "scoped" }),
    ).rejects.toThrow("only valid on tool-call events");

    // Unknown classes and empty lists fail loudly.
    await spec([
      "  pre_tool_call:",
      '    - command: "x"',
      '      applies_to: ["carrier-pigeon"]',
    ]);
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "scoped" }),
    ).rejects.toThrow("must be one of: shell, mcp, edit");

    await spec([
      "  pre_tool_call:",
      '    - command: "x"',
      "      applies_to: []",
    ]);
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "scoped" }),
    ).rejects.toThrow("non-empty list");

    // v0.1 documents stay loadable; unknown versions still fail.
    await writeFile(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.1"',
        "kind: harness",
        "harness: { id: scoped }",
        "roles: { a: { description: A } }",
      ].join("\n"),
    );
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "scoped" }),
    ).resolves.toBeDefined();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("loadHarness resolves the referenced policy", async () => {
  const loaded = await loadHarness({
    agentsDir: fixturesDir,
    harnessId: "triage-demo",
  });
  expect(loaded.policy?.id).toBe("triage-readonly");
  expect(loaded.policy?.capabilities?.exec?.deny).toEqual(["rm", "git push"]);
  expect(loaded.policy?.capabilities?.network?.deny).toEqual(["*"]);
  expect(loaded.policy?.limits?.costUsd).toBe(2.5);
  expect(loaded.policy?.limits?.timeoutMs).toBe(600_000);
  expect(loaded.policy?.confirmations?.requiredFor).toEqual(["exec.unknown"]);
});

test("loadManifest reads enabled harnesses and tolerates a missing file", async () => {
  const manifest = await loadManifest(fixturesDir);
  expect(manifest.specVersion).toBe("0.1");
  expect(manifest.enabledHarnesses).toEqual(["triage-demo"]);

  const empty = await loadManifest(join(fixturesDir, "no-such-dir"));
  expect(empty.enabledHarnesses).toEqual([]);
});

test("loadHarness rejects missing files, bad versions, and bad role refs", async () => {
  await expect(
    loadHarness({ agentsDir: fixturesDir, harnessId: "nope" }),
  ).rejects.toThrow('harness "nope" not readable');

  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    const dir = join(scratch, "harnesses", "bad");
    await mkdir(dir, { recursive: true });

    await writeFile(
      join(dir, "harness.yaml"),
      [
        'spec_version: "9.9"',
        "kind: harness",
        "harness: { id: bad }",
        "roles: { a: { description: A } }",
      ].join("\n"),
    );
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "bad" }),
    ).rejects.toThrow('unsupported spec_version "9.9"');

    await writeFile(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.1"',
        "kind: harness",
        "harness: { id: bad }",
        "roles: { a: { description: A } }",
        "execution: { mode: chain, order: [a, ghost] }",
      ].join("\n"),
    );
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "bad" }),
    ).rejects.toThrow('references unknown role "ghost"');

    await writeFile(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.1"',
        "kind: harness",
        "harness: { id: mismatched }",
        "roles: { a: { description: A } }",
      ].join("\n"),
    );
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "bad" }),
    ).rejects.toThrow('does not match directory "bad"');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("per-role policy references resolve with harness default fallback", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    await mkdir(join(scratch, "policies"), { recursive: true });
    await writeFile(
      join(scratch, "policies", "base.yaml"),
      "id: base\ncapabilities:\n  network: { deny: ['*'] }\n",
    );
    await writeFile(
      join(scratch, "policies", "writer.yaml"),
      "id: writer\ncapabilities:\n  exec: { deny: ['rm'] }\n",
    );
    const dir = join(scratch, "harnesses", "mixed");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.1"',
        "kind: harness",
        "harness: { id: mixed }",
        "policy: base",
        "roles:",
        "  reader: { description: R }",
        "  writer-role: { description: W, policy: writer }",
      ].join("\n"),
    );
    const loaded = await loadHarness({
      agentsDir: scratch,
      harnessId: "mixed",
    });
    expect(loaded.rolePolicies.reader?.id).toBe("base");
    expect(loaded.rolePolicies["writer-role"]?.id).toBe("writer");
    expect(loaded.policy?.id).toBe("base");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("roles reject unknown fields", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    const dir = join(scratch, "harnesses", "typo");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.1"',
        "kind: harness",
        "harness: { id: typo }",
        "roles:",
        "  a: { description: A, timout_ms: 5 }",
      ].join("\n"),
    );
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "typo" }),
    ).rejects.toThrow('roles.a has unknown key "timout_ms"');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("role enabled expressions are parsed and compile-checked", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    const dir = join(scratch, "harnesses", "conditional");
    await mkdir(dir, { recursive: true });
    const writeRole = (role: string) =>
      writeFile(
        join(dir, "harness.yaml"),
        [
          'spec_version: "0.2"',
          "kind: harness",
          "harness: { id: conditional }",
          "roles:",
          `  gated: ${role}`,
        ].join("\n"),
      );

    await writeRole("{ description: Gated, enabled: 'tier == \"full\"' }");
    const loaded = await loadHarness({
      agentsDir: scratch,
      harnessId: "conditional",
    });
    expect(loaded.definition.roles[0].enabledWhen).toBe('tier == "full"');

    await writeRole('{ description: Gated, enabled: "tier ===" }');
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "conditional" }),
    ).rejects.toThrow(/role gated enabled expression is invalid/);

    await writeRole("{ description: Gated, enabled: true }");
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "conditional" }),
    ).rejects.toThrow("role gated enabled must be a non-empty string");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

const conditionalDefinition: HarnessDefinition = {
  id: "code-review",
  roles: [
    {
      id: "quality",
      description: "Quality",
      requiredCapabilities: [],
      timeoutMs: 1,
    },
    {
      id: "security",
      description: "Security",
      enabledWhen: 'tier != "trivial"',
      requiredCapabilities: [],
      timeoutMs: 1,
    },
    {
      id: "performance",
      description: "Performance",
      enabledWhen: 'tier == "full"',
      requiredCapabilities: [],
      timeoutMs: 1,
    },
    {
      id: "compliance",
      description: "Compliance",
      enabledWhen: 'tier != "trivial"',
      requiredCapabilities: [],
      timeoutMs: 1,
    },
  ],
  execution: {
    mode: "chain",
    order: ["security", "performance", "quality", "compliance"],
  },
};

test("filterEnabledRoles filters code-review tiers and chain order", () => {
  const trivial = filterEnabledRoles(conditionalDefinition, {
    tier: "trivial",
  });
  expect(trivial.definition.roles.map((role) => role.id)).toEqual(["quality"]);
  expect(trivial.definition.execution).toEqual({
    mode: "chain",
    order: ["quality"],
  });
  expect(trivial.disabledRoleIds).toEqual([
    "security",
    "performance",
    "compliance",
  ]);

  const lite = filterEnabledRoles(conditionalDefinition, { tier: "lite" });
  expect(lite.definition.roles.map((role) => role.id)).toEqual([
    "quality",
    "security",
    "compliance",
  ]);
  expect(lite.definition.execution).toEqual({
    mode: "chain",
    order: ["security", "quality", "compliance"],
  });

  const full = filterEnabledRoles(conditionalDefinition, { tier: "full" });
  expect(full.definition.roles.map((role) => role.id)).toEqual([
    "quality",
    "security",
    "performance",
    "compliance",
  ]);
  expect(full.definition.execution).toEqual(conditionalDefinition.execution);
  expect(full.disabledRoleIds).toEqual([]);
});

test("filterEnabledRoles fails closed on evaluation errors and non-booleans", () => {
  const definitionWith = (enabledWhen: string): HarnessDefinition => ({
    id: "broken",
    roles: [
      {
        id: "gated",
        description: "Gated",
        enabledWhen,
        requiredCapabilities: [],
        timeoutMs: 1,
      },
    ],
  });

  expect(() =>
    filterEnabledRoles(definitionWith('tier2 == "x"'), { tier: "full" }),
  ).toThrow(/role "gated" enablement evaluation failed/);
  expect(() =>
    filterEnabledRoles(definitionWith("tier"), { tier: "full" }),
  ).toThrow(/role "gated" enablement expression returned string/);
});

test("filterEnabledRoles rejects empty harnesses and disabled loop participants", () => {
  expect(() =>
    filterEnabledRoles(
      {
        id: "empty",
        roles: [
          {
            id: "off",
            description: "Off",
            enabledWhen: "false",
            requiredCapabilities: [],
            timeoutMs: 1,
          },
        ],
      },
      {},
    ),
  ).toThrow('harness "empty" has no enabled roles');

  expect(() =>
    filterEnabledRoles(
      {
        id: "loop",
        roles: [
          {
            id: "implementation",
            description: "Implementation",
            requiredCapabilities: [],
            timeoutMs: 1,
          },
          {
            id: "validation",
            description: "Validation",
            enabledWhen: "false",
            requiredCapabilities: [],
            timeoutMs: 1,
          },
        ],
        execution: {
          mode: "validation-loop",
          implementationRoles: ["implementation"],
          validationRoles: ["validation"],
          maxRounds: 1,
        },
      },
      {},
    ),
  ).toThrow(/validation-loop references disabled role: validation/);
});

test("harness ids with traversal or separators are rejected before path use", async () => {
  await expect(
    loadHarness({ agentsDir: fixturesDir, harnessId: "../escape" }),
  ).rejects.toThrow('harness id "../escape" is invalid');
  await expect(
    loadHarness({ agentsDir: fixturesDir, harnessId: "a/b" }),
  ).rejects.toThrow("is invalid");
});

test("policy ids with traversal or shell metacharacters are rejected", async () => {
  const { loadPolicy } = await import("@aguil/agents-harness-config");
  await expect(loadPolicy(fixturesDir, "../escape")).rejects.toThrow(
    "is invalid",
  );
  await expect(loadPolicy(fixturesDir, "x; id")).rejects.toThrow("is invalid");
  await expect(loadPolicy(fixturesDir, "a/../../b")).rejects.toThrow(
    "is invalid",
  );
  // Valid grammar but nonexistent file: fails on readability, not grammar.
  await expect(loadPolicy(fixturesDir, "no-such-policy")).rejects.toThrow(
    "not readable",
  );
});

test("loadHarness rejects validation-loop configs with missing role lists", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    const dir = join(scratch, "harnesses", "loop");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.1"',
        "kind: harness",
        "harness: { id: loop }",
        "roles: { w: { description: W }, v: { description: V } }",
        "execution: { mode: validation-loop, implementation_roles: [w] }",
      ].join("\n"),
    );
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "loop" }),
    ).rejects.toThrow("execution.validation_roles must list at least one role");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("loadHarness passes context provider params through verbatim", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    const dir = join(scratch, "harnesses", "contextual");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.2"',
        "kind: harness",
        "harness: { id: contextual }",
        "roles: { a: { description: A } }",
        "context:",
        "  providers:",
        "    - use: static-file",
        "      id: incident-log",
        "      path: var/incident.log",
        "      required: true",
        "      max_bytes: 2048",
        "    - use: git-diff",
      ].join("\n"),
    );

    const loaded = await loadHarness({
      agentsDir: scratch,
      harnessId: "contextual",
    });
    expect(loaded.contextProviders).toEqual([
      {
        use: "static-file",
        params: {
          id: "incident-log",
          path: "var/incident.log",
          required: true,
          max_bytes: 2048,
        },
      },
      { use: "git-diff", params: {} },
    ]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("loadHarness rejects malformed context sections", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    const dir = join(scratch, "harnesses", "contextual");
    await mkdir(dir, { recursive: true });
    const writeContext = (lines: readonly string[]) =>
      writeFile(
        join(dir, "harness.yaml"),
        [
          'spec_version: "0.2"',
          "kind: harness",
          "harness: { id: contextual }",
          "roles: { a: { description: A } }",
          ...lines,
        ].join("\n"),
      );

    await writeContext(["context: []"]);
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "contextual" }),
    ).rejects.toThrow("context must be a mapping");

    await writeContext([
      "context:",
      "  providers: [{ use: git-diff }]",
      "  typo: true",
    ]);
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "contextual" }),
    ).rejects.toThrow('context has unknown key "typo" (supported: providers)');

    await writeContext(["context:", "  providers: []"]);
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "contextual" }),
    ).rejects.toThrow("context.providers must be a non-empty list");

    await writeContext(["context:", "  providers:", "    - max_bytes: 10"]);
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "contextual" }),
    ).rejects.toThrow("context.providers[0].use is required");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("loadHarness carries output schemas and finding pipelines", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    const dir = join(scratch, "harnesses", "outputs");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.2"',
        "kind: harness",
        "harness: { id: outputs }",
        "roles: { a: { description: A } }",
        "output:",
        "  schemas:",
        "    finding: builtin:finding",
        "    evidence:",
        "      required: [id, kind, title]",
        "      data_required: [alert]",
        "filtering:",
        "  findings: [builtin:actionable]",
        "deduplication:",
        "  findings: [builtin:fingerprint]",
      ].join("\n"),
    );

    const loaded = await loadHarness({
      agentsDir: scratch,
      harnessId: "outputs",
    });
    expect(loaded.outputSchemas).toEqual({
      finding: "builtin:finding",
      evidence: {
        required: ["id", "kind", "title"],
        dataRequired: ["alert"],
      },
    });
    expect(loaded.findingFilters).toEqual(["builtin:actionable"]);
    expect(loaded.findingDedupers).toEqual(["builtin:fingerprint"]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("loadHarness rejects malformed output schemas and finding pipelines", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    const dir = join(scratch, "harnesses", "outputs");
    await mkdir(dir, { recursive: true });
    const writeSections = (lines: readonly string[]) =>
      writeFile(
        join(dir, "harness.yaml"),
        [
          'spec_version: "0.2"',
          "kind: harness",
          "harness: { id: outputs }",
          "roles: { a: { description: A } }",
          ...lines,
        ].join("\n"),
      );

    const cases: readonly {
      readonly lines: readonly string[];
      readonly message: string;
    }[] = [
      {
        lines: ["filtering:", "  findings: [builtin:mystery]"],
        message:
          'filtering.findings has unknown strategy "builtin:mystery" (supported: builtin:actionable)',
      },
      {
        lines: ["deduplication:", "  findings: [builtin:mystery]"],
        message:
          'deduplication.findings has unknown strategy "builtin:mystery" (supported: builtin:fingerprint)',
      },
      {
        lines: ["output:", "  schemas:", "    evidence: builtin:finding"],
        message:
          'output.schemas.evidence may use builtin:finding only for kind "finding"',
      },
      {
        lines: ["filtering:", "  findings: []"],
        message:
          "filtering.findings must be a non-empty list of non-empty strings",
      },
      {
        lines: ["deduplication:", "  findings: []"],
        message:
          "deduplication.findings must be a non-empty list of non-empty strings",
      },
      {
        lines: ["output:", "  schemas:", "    evidence: { optional: [title] }"],
        message: 'output.schemas.evidence has unknown key "optional"',
      },
      {
        lines: ["filtering:", "  outcomes: [builtin:actionable]"],
        message: 'filtering has unknown key "outcomes"',
      },
      {
        lines: ["output:", "  schemas:", "    evidence: { required: title }"],
        message:
          "output.schemas.evidence.required must be a non-empty list of non-empty strings",
      },
      {
        lines: [
          "output:",
          "  schemas:",
          "    evidence: { data_required: [1] }",
        ],
        message:
          "output.schemas.evidence.data_required must be a non-empty list of non-empty strings",
      },
    ];

    for (const rejection of cases) {
      await writeSections(rejection.lines);
      await expect(
        loadHarness({ agentsDir: scratch, harnessId: "outputs" }),
      ).rejects.toThrow(rejection.message);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("loadHarness carries a supported reporting template", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    const dir = join(scratch, "harnesses", "reported");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.2"',
        "kind: harness",
        "harness: { id: reported }",
        "roles: { a: { description: A } }",
        "reporting:",
        "  template: builtin:outcomes-markdown",
      ].join("\n"),
    );

    const loaded = await loadHarness({
      agentsDir: scratch,
      harnessId: "reported",
    });
    expect(loaded.reportingTemplate).toBe("builtin:outcomes-markdown");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("loadHarness rejects malformed reporting sections", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    const dir = join(scratch, "harnesses", "reported");
    await mkdir(dir, { recursive: true });
    const writeReporting = (lines: readonly string[]) =>
      writeFile(
        join(dir, "harness.yaml"),
        [
          'spec_version: "0.2"',
          "kind: harness",
          "harness: { id: reported }",
          "roles: { a: { description: A } }",
          ...lines,
        ].join("\n"),
      );

    await writeReporting(["reporting:", "  template: builtin:unknown"]);
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "reported" }),
    ).rejects.toThrow(
      'reporting.template has unknown template "builtin:unknown" (supported: builtin:code-review-markdown, builtin:outcomes-markdown)',
    );

    await writeReporting([
      "reporting:",
      "  template: builtin:outcomes-markdown",
      "  format: markdown",
    ]);
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "reported" }),
    ).rejects.toThrow(
      'reporting has unknown key "format" (supported: template)',
    );

    await writeReporting(["reporting: []"]);
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "reported" }),
    ).rejects.toThrow("reporting must be a mapping");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a role defined only as a file is usable from a harness spec by ref", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    const roleDir = join(scratch, "agents", "auditor");
    await mkdir(roleDir, { recursive: true });
    await writeFile(
      join(roleDir, "agent.md"),
      [
        "---",
        "description: Audit the change for licensing problems.",
        "timeout_ms: 90000",
        "required_capabilities: [readOnlyMode]",
        "allowed_commands: [rg, cat]",
        "---",
        "",
        "Look for incompatible licenses.",
        "",
      ].join("\n"),
    );
    const harnessDir = join(scratch, "harnesses", "refs");
    await mkdir(harnessDir, { recursive: true });
    await writeFile(
      join(harnessDir, "harness.yaml"),
      [
        'spec_version: "0.2"',
        "kind: harness",
        "harness: { id: refs }",
        "roles:",
        "  auditor:",
        "    ref: auditor",
      ].join("\n"),
    );

    const loaded = await loadHarness({ agentsDir: scratch, harnessId: "refs" });
    const auditor = loaded.definition.roles[0];
    expect(auditor.id).toBe("auditor");
    expect(auditor.description).toBe(
      "Audit the change for licensing problems.",
    );
    expect(auditor.prompt).toBe("Look for incompatible licenses.");
    expect(auditor.promptPath).toBeUndefined();
    expect(auditor.timeoutMs).toBe(90_000);
    expect(auditor.requiredCapabilities).toEqual(["readOnlyMode"]);
    expect(auditor.allowedCommands).toEqual(["rg", "cat"]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("harness keys override the referenced role file, and ref may rename", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    const roleDir = join(scratch, "agents", "auditor");
    await mkdir(roleDir, { recursive: true });
    await writeFile(
      join(roleDir, "agent.md"),
      [
        "---",
        "description: From the file.",
        "timeout_ms: 90000",
        "---",
        "",
        "File prompt.",
        "",
      ].join("\n"),
    );
    const harnessDir = join(scratch, "harnesses", "refs");
    await mkdir(harnessDir, { recursive: true });
    await writeFile(
      join(harnessDir, "harness.yaml"),
      [
        'spec_version: "0.2"',
        "kind: harness",
        "harness: { id: refs }",
        "roles:",
        "  licensing:",
        "    ref: auditor",
        "    description: From the harness.",
        "    prompt: Harness prompt.",
      ].join("\n"),
    );

    const loaded = await loadHarness({ agentsDir: scratch, harnessId: "refs" });
    const role = loaded.definition.roles[0];
    // The local key names the role, so one file can back several roles.
    expect(role.id).toBe("licensing");
    // Harness keys win; unstated ones fall through to the file.
    expect(role.description).toBe("From the harness.");
    expect(role.prompt).toBe("Harness prompt.");
    expect(role.timeoutMs).toBe(90_000);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a role file never shadows a spec-defined role of the same id", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    const roleDir = join(scratch, "agents", "auditor");
    await mkdir(roleDir, { recursive: true });
    await writeFile(
      join(roleDir, "agent.md"),
      [
        "---",
        "description: From the file.",
        "---",
        "",
        "File prompt.",
        "",
      ].join("\n"),
    );
    const harnessDir = join(scratch, "harnesses", "refs");
    await mkdir(harnessDir, { recursive: true });
    await writeFile(
      join(harnessDir, "harness.yaml"),
      [
        'spec_version: "0.2"',
        "kind: harness",
        "harness: { id: refs }",
        "roles:",
        "  auditor:",
        "    description: Declared inline.",
        "    prompt: Inline prompt.",
      ].join("\n"),
    );

    const loaded = await loadHarness({ agentsDir: scratch, harnessId: "refs" });
    const role = loaded.definition.roles[0];
    // Role files are consulted only when referenced, so the identically
    // named file contributes nothing here.
    expect(role.description).toBe("Declared inline.");
    expect(role.prompt).toBe("Inline prompt.");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("loadHarness rejects malformed refs and role files", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    const harnessDir = join(scratch, "harnesses", "refs");
    await mkdir(harnessDir, { recursive: true });
    const spec = (roleLines: readonly string[]) =>
      writeFile(
        join(harnessDir, "harness.yaml"),
        [
          'spec_version: "0.2"',
          "kind: harness",
          "harness: { id: refs }",
          "roles:",
          ...roleLines,
        ].join("\n"),
      );

    await spec(["  auditor:", "    ref: nope"]);
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "refs" }),
    ).rejects.toThrow(
      'role file "nope" not found at agents/nope/agent.md (available: none)',
    );

    const roleDir = join(scratch, "agents", "auditor");
    await mkdir(roleDir, { recursive: true });

    await writeFile(join(roleDir, "agent.md"), "no frontmatter here\n");
    await spec(["  auditor:", "    ref: auditor"]);
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "refs" }),
    ).rejects.toThrow('must begin with a "---" frontmatter delimiter');

    await writeFile(
      join(roleDir, "agent.md"),
      [
        "---",
        "description: A.",
        "prompt_path: elsewhere.md",
        "---",
        "",
        "B",
        "",
      ].join("\n"),
    );
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "refs" }),
    ).rejects.toThrow("unsupported frontmatter fields: prompt_path");

    await writeFile(
      join(roleDir, "agent.md"),
      ["---", "description: A.", "---", "", "   ", ""].join("\n"),
    );
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "refs" }),
    ).rejects.toThrow("empty body; the body is the role prompt");

    // A near-miss delimiter is malformed, not a terminator.
    await writeFile(
      join(roleDir, "agent.md"),
      ["---", "description: A.", "---oops", "", "Body.", ""].join("\n"),
    );
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "refs" }),
    ).rejects.toThrow('not terminated by a closing "---"');

    // A role file supplying no description is still an incomplete role.
    await writeFile(
      join(roleDir, "agent.md"),
      ["---", "timeout_ms: 1000", "---", "", "Body.", ""].join("\n"),
    );
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "refs" }),
    ).rejects.toThrow("role auditor description is required");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a malformed unreferenced role file does not break harness loading", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    const brokenDir = join(scratch, "agents", "broken");
    await mkdir(brokenDir, { recursive: true });
    await writeFile(join(brokenDir, "agent.md"), "no frontmatter at all\n");

    const harnessDir = join(scratch, "harnesses", "refs");
    await mkdir(harnessDir, { recursive: true });
    await writeFile(
      join(harnessDir, "harness.yaml"),
      [
        'spec_version: "0.2"',
        "kind: harness",
        "harness: { id: refs }",
        "roles:",
        "  auditor:",
        "    description: Declared inline.",
        "    prompt: Inline prompt.",
      ].join("\n"),
    );

    // Resolution is by reference only, so an unreferenced file is never read.
    const loaded = await loadHarness({ agentsDir: scratch, harnessId: "refs" });
    expect(loaded.definition.roles[0].description).toBe("Declared inline.");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("the schema rejects unknown keys at levels the loader never guarded", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    const dir = join(scratch, "harnesses", "schema");
    await mkdir(dir, { recursive: true });
    const spec = (lines: readonly string[]) =>
      writeFile(
        join(dir, "harness.yaml"),
        [
          'spec_version: "0.3"',
          "kind: harness",
          "harness: { id: schema }",
          "roles: { a: { description: A } }",
          ...lines,
        ].join("\n"),
      );

    // Document root: previously ignored entirely.
    await spec(["polciy: something"]);
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "schema" }),
    ).rejects.toThrow('harness.yaml has unknown key "polciy"');

    // harness: previously only `id` was read and anything else ignored.
    await writeFile(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.3"',
        "kind: harness",
        "harness: { id: schema, descriptoin: typo }",
        "roles: { a: { description: A } }",
      ].join("\n"),
    );
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "schema" }),
    ).rejects.toThrow('harness has unknown key "descriptoin"');

    // execution: mode-irrelevant siblings were ignored.
    await spec(["execution:", "  mode: chain", "  oder: [a]"]);
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "schema" }),
    ).rejects.toThrow('execution has unknown key "oder"');

    // A valid key at the wrong nesting level reads as unknown where it landed.
    await spec([
      "context:",
      "  providers:",
      "    - use: agents-md",
      "  roles: {}",
    ]);
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "schema" }),
    ).rejects.toThrow('context has unknown key "roles" (supported: providers)');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("harness.description is accepted, and spec 0.3 loads alongside 0.1 and 0.2", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    const dir = join(scratch, "harnesses", "described");
    await mkdir(dir, { recursive: true });
    for (const version of ["0.1", "0.2", "0.3"]) {
      await writeFile(
        join(dir, "harness.yaml"),
        [
          `spec_version: "${version}"`,
          "kind: harness",
          "harness:",
          "  id: described",
          "  description: Documentation the loader does not read.",
          "roles: { a: { description: A } }",
        ].join("\n"),
      );
      const loaded = await loadHarness({
        agentsDir: scratch,
        harnessId: "described",
      });
      expect(loaded.definition.id).toBe("described");
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("the published schemas match the ones the loader enforces", async () => {
  const { readFile } = await import("node:fs/promises");
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  for (const name of [
    "harness.schema.json",
    "manifest.schema.json",
    "policy.schema.json",
  ]) {
    const published = await readFile(
      join(repoRoot, ".agents", "schemas", name),
      "utf8",
    );
    const enforced = await readFile(
      join(repoRoot, "packages", "harness-config", "src", name),
      "utf8",
    );
    // ADR 0015 designates the published file normative; it is worthless as a
    // description if it can drift from what actually runs.
    expect([name, published]).toEqual([name, enforced]);
  }
});

test("schema enums stay in step with the constants they describe", () => {
  const harness = HARNESS_SCHEMA as {
    properties: {
      spec_version: { enum: readonly string[] };
      reporting: { properties: { template: { enum: readonly string[] } } };
    };
  };
  expect(harness.properties.spec_version.enum).toEqual([
    ...SUPPORTED_SPEC_VERSIONS,
  ]);
  expect(harness.properties.reporting.properties.template.enum).toEqual([
    ...REPORT_TEMPLATE_NAMES,
  ]);

  const manifest = MANIFEST_SCHEMA as {
    properties: { specVersion: { enum: readonly string[] } };
  };
  expect(manifest.properties.specVersion.enum).toEqual([
    ...SUPPORTED_SPEC_VERSIONS,
  ]);

  const policy = POLICY_SCHEMA as {
    definitions: { confirmationCategories: { items: { enum: string[] } } };
  };
  expect(policy.definitions.confirmationCategories.items.enum).toEqual([
    ...POLICY_CONFIRMATION_CATEGORIES,
  ]);
});

test("every harness document in the repository satisfies the schema", async () => {
  const { readFile } = await import("node:fs/promises");
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const documents = [
    ".agents/harnesses/code-review/harness.yaml",
    "examples/incident-triage/.agents/harnesses/incident-triage/harness.yaml",
    "tests/fixtures/agents-dir/harnesses/triage-demo/harness.yaml",
  ];
  for (const relative of documents) {
    const parsed = Bun.YAML.parse(
      await readFile(join(repoRoot, relative), "utf8"),
    );
    // Every rule, not just the subset the loader reports: a third party
    // validating the published file applies all of them, so the schema has to
    // stay truthful about these documents under the strictest reading.
    expect([relative, findAllSchemaViolations(parsed)]).toEqual([relative, []]);
  }
});

test("every manifest and policy document in the repository satisfies its schema", async () => {
  const { readFile } = await import("node:fs/promises");
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const documents: readonly (readonly [string, typeof MANIFEST_SCHEMA])[] = [
    [".agents/manifest.yaml", MANIFEST_SCHEMA],
    ["examples/incident-triage/.agents/manifest.yaml", MANIFEST_SCHEMA],
    ["tests/fixtures/agents-dir/manifest.yaml", MANIFEST_SCHEMA],
    [".agents/policies/code-review-readonly.yaml", POLICY_SCHEMA],
    [
      "examples/incident-triage/.agents/policies/triage-fix.yaml",
      POLICY_SCHEMA,
    ],
    [
      "examples/incident-triage/.agents/policies/triage-readonly.yaml",
      POLICY_SCHEMA,
    ],
    ["tests/fixtures/agents-dir/policies/triage-readonly.yaml", POLICY_SCHEMA],
  ];
  for (const [relative, schema] of documents) {
    const parsed = Bun.YAML.parse(
      await readFile(join(repoRoot, relative), "utf8"),
    );
    expect([relative, findAllSchemaViolations(parsed, schema)]).toEqual([
      relative,
      [],
    ]);
  }
});

test("the manifest rejects unknown keys and unsupported spec versions", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    const manifest = (lines: readonly string[]) =>
      writeFile(join(scratch, "manifest.yaml"), lines.join("\n"));

    await manifest(['specVersion: "0.2"', "enabled:", "  harnesses: [a]"]);
    expect((await loadManifest(scratch)).enabledHarnesses).toEqual(["a"]);

    // The gap ADR 0015 §4 named: any string used to load.
    await manifest(['specVersion: "9.9"']);
    await expect(loadManifest(scratch)).rejects.toThrow(
      'unsupported manifest specVersion "9.9" (supported: 0.1, 0.2, 0.3)',
    );

    await manifest(["specVerison: '0.2'"]);
    await expect(loadManifest(scratch)).rejects.toThrow(
      'manifest.yaml has unknown key "specVerison" (supported: enabled, specVersion)',
    );

    // The one that mattered: a typo here enables nothing, silently.
    await manifest(["enabled:", "  harnesess: [a]"]);
    await expect(loadManifest(scratch)).rejects.toThrow(
      'enabled has unknown key "harnesess" (supported: harnesses)',
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a policy document rejects unknown keys at every level", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    await mkdir(join(scratch, "harnesses", "policied"), { recursive: true });
    await mkdir(join(scratch, "policies"), { recursive: true });
    await writeFile(
      join(scratch, "harnesses", "policied", "harness.yaml"),
      [
        'spec_version: "0.3"',
        "kind: harness",
        "harness: { id: policied }",
        "policy: guard",
        "roles: { a: { description: A } }",
      ].join("\n"),
    );
    const policy = (lines: readonly string[]) =>
      writeFile(
        join(scratch, "policies", "guard.yaml"),
        ["id: guard", ...lines].join("\n"),
      );
    const load = () =>
      loadHarness({ agentsDir: scratch, harnessId: "policied" });

    // A governance document that fails open is the whole point of #149: each
    // of these used to parse cleanly and constrain nothing.
    await policy(["capabilties:", "  exec: { deny: ['*'] }"]);
    await expect(load()).rejects.toThrow(
      'the policy document has unknown key "capabilties"',
    );

    await policy(["capabilities:", "  filesytem: { deny: ['.env'] }"]);
    await expect(load()).rejects.toThrow(
      'capabilities has unknown key "filesytem" (supported: exec, filesystem, network)',
    );

    await policy(["capabilities:", "  exec: { dney: ['rm'] }"]);
    await expect(load()).rejects.toThrow(
      'capabilities.exec has unknown key "dney" (supported: allow, deny)',
    );

    await policy(["limits:", "  timeout_msec: 1000"]);
    await expect(load()).rejects.toThrow(
      'limits has unknown key "timeout_msec" (supported: cost_usd, timeout_ms)',
    );

    await policy(["confirmations:", "  requiredfor: [exec.unknown]"]);
    await expect(load()).rejects.toThrow(
      'confirmations has unknown key "requiredfor"',
    );

    // Both spellings of the confirmations key stay accepted.
    await policy(["confirmations:", "  required_for: [exec.unknown]"]);
    const loaded = await load();
    expect(loaded.rolePolicies.a?.confirmations?.requiredFor).toEqual([
      "exec.unknown",
    ]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a policy constraint written as an empty key fails rather than granting everything", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    await mkdir(join(scratch, "harnesses", "nulled"), { recursive: true });
    await mkdir(join(scratch, "policies"), { recursive: true });
    await writeFile(
      join(scratch, "harnesses", "nulled", "harness.yaml"),
      [
        'spec_version: "0.3"',
        "kind: harness",
        "harness: { id: nulled }",
        "policy: guard",
        "roles: { a: { description: A } }",
      ].join("\n"),
    );
    // `deny:` with nothing after it parses as null, and the loader's list
    // helper reads null as an absent key — so this used to load as a policy
    // that denied nothing at all.
    await writeFile(
      join(scratch, "policies", "guard.yaml"),
      ["id: guard", "capabilities:", "  exec:", "    deny:"].join("\n"),
    );
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "nulled" }),
    ).rejects.toThrow("capabilities.exec.deny must be array");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a policy spend ceiling must be a positive finite number", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    await mkdir(join(scratch, "harnesses", "priced"), { recursive: true });
    await mkdir(join(scratch, "policies"), { recursive: true });
    await writeFile(
      join(scratch, "harnesses", "priced", "harness.yaml"),
      [
        'spec_version: "0.3"',
        "kind: harness",
        "harness: { id: priced }",
        "policy: budget",
        "roles: { a: { description: A } }",
      ].join("\n"),
    );
    const budget = (value: string) =>
      writeFile(
        join(scratch, "policies", "budget.yaml"),
        ["id: budget", "limits:", `  cost_usd: ${value}`].join("\n"),
      );
    const load = () => loadHarness({ agentsDir: scratch, harnessId: "priced" });

    await budget("2.5");
    expect((await load()).rolePolicies.a?.limits?.costUsd).toBe(2.5);

    // Each of these was accepted before and left the ceiling unset, so a
    // mistyped budget read as no budget at all. Which layer reports it splits
    // by kind: the schema owns wrong types, including the bare `cost_usd:`
    // that parses as null, and the loader owns values of the right type that
    // are out of range, where its message names the constraint.
    const rejected = [
      ["'2.5'", "limits.cost_usd must be number"],
      ["null", "limits.cost_usd must be number"],
      ["", "limits.cost_usd must be number"],
      [".nan", "policy budget limits.cost_usd must be a positive number"],
      [".inf", "policy budget limits.cost_usd must be a positive number"],
      ["0", "policy budget limits.cost_usd must be a positive number"],
      ["-1", "policy budget limits.cost_usd must be a positive number"],
    ] as const;
    for (const [value, message] of rejected) {
      await budget(value);
      await expect(load()).rejects.toThrow(message);
      // ADR 0018 has the loader enforcing a subset of the schema, never more,
      // so a value the loader rejects must not satisfy a third-party
      // validator. `.inf` is the one that needs saying: JSON cannot write it,
      // YAML can, and expressing finiteness takes an explicit maximum.
      const parsed = Bun.YAML.parse(`limits: { cost_usd: ${value} }`);
      expect([
        value,
        findAllSchemaViolations(parsed, POLICY_SCHEMA),
      ]).not.toEqual([value, []]);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("role identifiers cannot escape the scratchpad directory", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    const dir = join(scratch, "harnesses", "traversal");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.3"',
        "kind: harness",
        "harness: { id: traversal }",
        "roles:",
        '  "../../outside": { description: Escape }',
      ].join("\n"),
    );
    // A role id is joined into the run scratchpad path, so traversal in one
    // would place a role's directory outside it.
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "traversal" }),
    ).rejects.toThrow('roles has invalid key "../../outside"');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
