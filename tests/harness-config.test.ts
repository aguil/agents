import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  filterEnabledRoles,
  loadHarness,
  loadManifest,
} from "@aguil/agents-harness-config";
import type { HarnessDefinition } from "@aguil/agents-orchestration";

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
    ).rejects.toThrow('hooks event "mystery_event" is not supported');

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
    ).rejects.toThrow("role a has unsupported fields: timout_ms");
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
    ).rejects.toThrow("context has unsupported fields: typo");

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
        message: "output.schemas.evidence has unsupported fields: optional",
      },
      {
        lines: ["filtering:", "  outcomes: [builtin:actionable]"],
        message: "filtering has unsupported fields: outcomes",
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
    ).rejects.toThrow("reporting has unsupported fields: format");

    await writeReporting(["reporting: []"]);
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "reported" }),
    ).rejects.toThrow("reporting must be a mapping");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
