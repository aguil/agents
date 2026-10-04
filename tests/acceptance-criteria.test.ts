import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  conformanceOutcomeViolations,
  conformanceReportedMetadata,
  conformanceRunMetadata,
} from "@aguil/agents-code-review";
import { runCodeReviewFromConfig } from "@aguil/agents-code-review/config-runner";
import {
  buildPendingReviewSummaryBody,
  formatReviewCoverageSectionLines,
} from "@aguil/agents-code-review-post";
import {
  AcceptanceCriteriaProvider,
  acceptanceCriteriaFromArtifacts,
  acceptanceCriteriaRowCount,
  type ContextBundle,
  fetchReferencedUrl,
  MAX_ACCEPTANCE_CRITERIA_REFERENCES,
  readBoundedResponseText,
  resolveContextProvider,
} from "@aguil/agents-context";
import {
  ACCEPTANCE_CRITERIA_ARTIFACT_ID,
  type AcceptanceCriteriaArtifactContent,
  createAgentEvent,
  type Finding,
  findingToHarnessOutcome,
  type HarnessOutcome,
  parseAcceptanceCriteria,
  readAcceptanceCriteriaArtifact,
  readConformanceVerdict,
} from "@aguil/agents-core";
import type { AgentAdapter, AgentRunRequest } from "@aguil/agents-execution";
import { renderMarkdownReport } from "@aguil/agents-reporting";

const AGENTS_DIR = join(import.meta.dir, "..", ".agents");

const CRITERIA = {
  version: 1,
  source: "plan.md#slice-3",
  criteria: [
    {
      id: "AC-1",
      statement: "The canonical hash is stable under map insertion order.",
      check: "diff",
      required_tests: ["hash is stable when keys are inserted in reverse"],
    },
    {
      id: "AC-2",
      statement: "The fallback uses stored values when they are non-empty.",
    },
  ],
};

async function withWorkspace(
  run: (workspace: string) => Promise<void>,
): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "agents-criteria-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function collectCriteria(
  provider: AcceptanceCriteriaProvider,
  workspace: string,
  params?: Readonly<Record<string, unknown>>,
): Promise<AcceptanceCriteriaArtifactContent> {
  const artifacts = await provider.collect({
    workspacePath: workspace,
    scratchpadPath: workspace,
    ...(params === undefined ? {} : { params }),
  });
  expect(artifacts).toHaveLength(1);
  expect(artifacts[0]?.id).toBe(ACCEPTANCE_CRITERIA_ARTIFACT_ID);
  const content = readAcceptanceCriteriaArtifact(artifacts[0]?.content ?? "");
  if (content === undefined) {
    throw new Error("artifact content did not parse");
  }
  return content;
}

function prRunner(body: string | undefined) {
  return async (cmd: readonly string[]) => {
    if (body !== undefined && cmd[0] === "gh" && cmd[1] === "pr") {
      return JSON.stringify({
        number: 42,
        title: "Slice 3",
        body,
        url: "https://github.com/aguil/agents/pull/42",
      });
    }
    return undefined;
  };
}

test("parses criteria rows with defaults", () => {
  const parsed = parseAcceptanceCriteria(JSON.stringify(CRITERIA));
  expect(parsed).toEqual({
    ok: true,
    document: {
      source: "plan.md#slice-3",
      criteria: [
        {
          id: "AC-1",
          statement: "The canonical hash is stable under map insertion order.",
          check: "diff",
          requiredTests: ["hash is stable when keys are inserted in reverse"],
        },
        {
          id: "AC-2",
          statement: "The fallback uses stored values when they are non-empty.",
          check: "diff",
          requiredTests: [],
        },
      ],
    },
  });
});

test("rejects criteria files that would silently lose a row", () => {
  const cases: readonly [unknown, string][] = [
    [{ ...CRITERIA, version: 2 }, `"version" must be 1`],
    [{ ...CRITERIA, source: "   " }, `"source" must be a non-empty string`],
    [{ version: 1, criteria: [] }, `"criteria" must be a non-empty list`],
    [
      { version: 1, criteria: [CRITERIA.criteria[0], CRITERIA.criteria[0]] },
      `duplicate criterion id "AC-1"`,
    ],
    [
      { version: 1, criteria: [{ id: "a,b", statement: "x" }] },
      "criteria[0].id must match",
    ],
    [
      { version: 1, criteria: [{ id: "AC-1", statement: " " }] },
      "criteria[0].statement must be a non-empty string",
    ],
    [
      { version: 1, criteria: [{ id: "AC-1", statement: "x", check: "eyes" }] },
      `criteria[0].check must be "diff" or "runtime"`,
    ],
    [
      {
        version: 1,
        criteria: [{ id: "AC-1", statement: "x", requiredTests: ["t"] }],
      },
      `criteria[0] has unknown key "requiredTests"`,
    ],
    [
      { version: 1, criteria: [{ id: "AC-1", statement: "x" }], extra: 1 },
      `top level has unknown key "extra"`,
    ],
  ];
  for (const [input, error] of cases) {
    const parsed = parseAcceptanceCriteria(JSON.stringify(input));
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.error).toContain(error);
  }
  expect(parseAcceptanceCriteria("{").ok).toBe(false);
});

test("the operator's criteria path wins and an unusable one is fatal", async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, "criteria.json");
    await writeFile(path, JSON.stringify(CRITERIA), "utf8");
    const provider = new AcceptanceCriteriaProvider({
      path: "ignored.json",
      commandRunner: prRunner("Acceptance-Criteria: also-ignored.json"),
    });

    const loaded = await collectCriteria(provider, workspace, {
      acceptanceCriteriaPath: path,
    });
    expect(loaded.status).toBe("loaded");
    expect(loaded.sources).toEqual([path]);
    expect(loaded.criteria.map((row) => row.id)).toEqual(["AC-1", "AC-2"]);

    await writeFile(path, "{}", "utf8");
    await expect(
      provider.collect({
        workspacePath: workspace,
        scratchpadPath: workspace,
        params: { acceptanceCriteriaPath: path },
      }),
    ).rejects.toThrow(`acceptance criteria ${path}`);
  });
});

test("a harness path with no file is absent, a bad one is invalid", async () => {
  await withWorkspace(async (workspace) => {
    const provider = resolveContextProvider("acceptance-criteria", {
      path: "criteria.json",
    }) as AcceptanceCriteriaProvider;

    const absent = await collectCriteria(provider, workspace);
    expect(absent.status).toBe("absent");
    expect(absent.reason).toContain("criteria.json");

    await writeFile(join(workspace, "criteria.json"), "not json", "utf8");
    const invalid = await collectCriteria(provider, workspace);
    expect(invalid.status).toBe("invalid");
    expect(invalid.reason).toContain("not valid JSON");
  });
});

test("reads Acceptance-Criteria lines from the PR description", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(
      join(workspace, "a.json"),
      JSON.stringify({ version: 1, criteria: [CRITERIA.criteria[0]] }),
      "utf8",
    );
    await writeFile(
      join(workspace, "a-again.json"),
      JSON.stringify({ version: 1, criteria: [CRITERIA.criteria[0]] }),
      "utf8",
    );
    await writeFile(
      join(workspace, "b.json"),
      JSON.stringify({ version: 1, criteria: [CRITERIA.criteria[1]] }),
      "utf8",
    );

    const loaded = await collectCriteria(
      new AcceptanceCriteriaProvider({
        commandRunner: prRunner(
          "Slice 3.\n\nAcceptance-Criteria: a.json\nAcceptance-Criteria: b.json\n",
        ),
      }),
      workspace,
    );
    expect(loaded.status).toBe("loaded");
    expect(loaded.criteria.map((row) => row.id)).toEqual(["AC-1", "AC-2"]);

    const none = await collectCriteria(
      new AcceptanceCriteriaProvider({ commandRunner: prRunner("No plan.") }),
      workspace,
    );
    expect(none.status).toBe("absent");
    expect(none.reason).toContain("PR #42 has no `Acceptance-Criteria:` line");

    const noPr = await collectCriteria(
      new AcceptanceCriteriaProvider({ commandRunner: prRunner(undefined) }),
      workspace,
    );
    expect(noPr.status).toBe("absent");

    const repeated = await collectCriteria(
      new AcceptanceCriteriaProvider({
        commandRunner: prRunner("Acceptance-Criteria: b.json\n".repeat(50)),
      }),
      workspace,
    );
    expect(repeated.status).toBe("loaded");
    expect(repeated.sources).toEqual(["b.json"]);

    const tooMany = await collectCriteria(
      new AcceptanceCriteriaProvider({
        commandRunner: prRunner(
          Array.from(
            { length: MAX_ACCEPTANCE_CRITERIA_REFERENCES + 1 },
            (_, index) => `Acceptance-Criteria: c${index}.json`,
          ).join("\n"),
        ),
      }),
      workspace,
    );
    expect(tooMany.status).toBe("invalid");
    expect(tooMany.reason).toContain(
      `at most ${MAX_ACCEPTANCE_CRITERIA_REFERENCES} are read`,
    );

    const duplicate = await collectCriteria(
      new AcceptanceCriteriaProvider({
        commandRunner: prRunner(
          "Acceptance-Criteria: a.json\nAcceptance-Criteria: a-again.json",
        ),
      }),
      workspace,
    );
    expect(duplicate.status).toBe("invalid");
    expect(duplicate.reason).toContain(`duplicate criterion id "AC-1"`);
  });
});

test("PR-declared criteria may not leave the workspace", async () => {
  await withWorkspace(async (workspace) => {
    const outside = await mkdtemp(join(tmpdir(), "agents-criteria-out-"));
    try {
      await writeFile(
        join(outside, "c.json"),
        JSON.stringify(CRITERIA),
        "utf8",
      );
      const refused = await collectCriteria(
        new AcceptanceCriteriaProvider({
          commandRunner: prRunner(
            `Acceptance-Criteria: ${join(outside, "c.json")}`,
          ),
        }),
        workspace,
      );
      expect(refused.status).toBe("invalid");
      expect(refused.reason).toContain("outside the workspace");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("row count binds only loaded criteria", () => {
  const artifact = (content: AcceptanceCriteriaArtifactContent) => ({
    id: ACCEPTANCE_CRITERIA_ARTIFACT_ID,
    title: "Acceptance Criteria",
    content: JSON.stringify(content),
  });
  const parsed = parseAcceptanceCriteria(JSON.stringify(CRITERIA));
  const criteria = parsed.ok ? parsed.document.criteria : [];
  expect(acceptanceCriteriaRowCount([])).toBe(0);
  expect(
    acceptanceCriteriaRowCount([
      artifact({ status: "loaded", reason: "r", sources: ["x"], criteria }),
    ]),
  ).toBe(2);
  expect(
    acceptanceCriteriaRowCount([
      artifact({ status: "invalid", reason: "r", sources: ["x"], criteria }),
    ]),
  ).toBe(0);
});

test("a malformed replayed artifact counts no rows instead of crashing", () => {
  const artifact = (criteria: unknown) => ({
    id: ACCEPTANCE_CRITERIA_ARTIFACT_ID,
    title: "Acceptance Criteria",
    content: JSON.stringify({
      status: "loaded",
      reason: "x",
      sources: [],
      criteria,
    }),
  });
  for (const criteria of [
    [null],
    [{ id: "AC-1", statement: "x" }],
    [{ id: "a,b", statement: "x", check: "diff", requiredTests: [] }],
    [
      { id: "AC-1", statement: "x", check: "diff", requiredTests: [] },
      { id: "AC-1", statement: "y", check: "diff", requiredTests: [] },
    ],
    [{ id: "AC-1", statement: " ", check: "diff", requiredTests: [] }],
    [{ id: "AC-1", statement: "x", check: "diff", requiredTests: [""] }],
  ]) {
    expect(acceptanceCriteriaRowCount([artifact(criteria)])).toBe(0);
    expect(
      conformanceRunMetadata({
        declaredRoleIds: ["conformance"],
        enabledRoleIds: [],
        criteria: acceptanceCriteriaFromArtifacts([artifact(criteria)]),
      }),
    ).toMatchObject({ conformance: "not_run" });
  }
});

test("conformance metadata says whether the role ran and why", () => {
  expect(
    conformanceRunMetadata({
      declaredRoleIds: ["quality"],
      enabledRoleIds: ["quality"],
      criteria: undefined,
    }),
  ).toEqual({});
  expect(
    conformanceRunMetadata({
      declaredRoleIds: ["quality", "conformance"],
      enabledRoleIds: ["quality"],
      criteria: undefined,
    }),
  ).toMatchObject({
    conformance: "not_run",
    conformance_reason: expect.stringContaining(
      "no well-formed acceptance-criteria",
    ),
  });
  expect(
    conformanceRunMetadata({
      declaredRoleIds: ["conformance"],
      enabledRoleIds: [],
      criteria: { status: "invalid", reason: "bad", sources: [], criteria: [] },
    }),
  ).toMatchObject({
    conformance: "not_run",
    conformance_reason: "acceptance criteria could not be used: bad",
  });
});

function conformanceOutcome(
  criterion: string,
  status: string,
  detail: string,
): HarnessOutcome {
  return {
    id: `conformance-${criterion}`,
    kind: "conformance",
    sourceRole: "conformance",
    title: `${criterion}: ${status}`,
    data: { criterion, status, detail },
  };
}

function conformanceFinding(id: string, title: string): Finding {
  return {
    id,
    severity: "critical",
    title,
    description: "The fallback returns early instead of using stored values.",
    evidence: "src/fallback.ts:12 returns before reading the store.",
    sourceRole: "conformance",
    validation: {
      status: "verified",
      details: "Read the fallback against row AC-2.",
      evidence: [
        { kind: "artifact", path: "acceptance-criteria" },
        { kind: "source", file: "src/fallback.ts", line: 12 },
      ],
    },
    file: "src/fallback.ts",
    line: 12,
  };
}

function scriptedConformanceAdapter(
  options: { readonly emitFinding?: boolean } = {},
): AgentAdapter {
  return {
    name: "scripted",
    capabilities: () => ({
      streaming: false,
      structuredOutput: true,
      readOnlyMode: true,
      mcp: false,
      cancellation: false,
    }),
    async *run(request: AgentRunRequest) {
      if (request.roleId !== "conformance") {
        return;
      }
      // AC-1 satisfied, AC-2 violated, AC-3 never reported.
      for (const outcome of [
        conformanceOutcome("AC-1", "satisfied", "src/hash.ts:4 sorts keys."),
        conformanceOutcome("AC-2", "unsatisfied", "Returns early."),
      ]) {
        yield createAgentEvent({
          runId: request.runId,
          roleId: request.roleId,
          type: "outcome",
          data: outcome,
        });
      }
      if (options.emitFinding === false) {
        return;
      }
      yield createAgentEvent({
        runId: request.runId,
        roleId: request.roleId,
        type: "finding",
        data: conformanceFinding(
          "conformance-ac-2-early-return",
          "[AC-2] Fallback returns early instead of using stored values",
        ),
      });
    },
  };
}

async function writeBundle(
  workspace: string,
  criteria: AcceptanceCriteriaArtifactContent | undefined,
): Promise<string> {
  const bundle: ContextBundle = {
    id: "recorded",
    artifacts: [
      { id: "triage", title: "Recorded triage", content: "trivial" },
      ...(criteria === undefined
        ? []
        : [
            {
              id: ACCEPTANCE_CRITERIA_ARTIFACT_ID,
              title: "Acceptance Criteria",
              content: JSON.stringify(criteria),
            },
          ]),
    ],
  };
  const path = join(workspace, "bundle.json");
  await writeFile(path, JSON.stringify(bundle), "utf8");
  return path;
}

test("a change that violates a stated row gets an unsatisfied finding and a per-row report", async () => {
  await withWorkspace(async (workspace) => {
    const parsed = parseAcceptanceCriteria(
      JSON.stringify({
        version: 1,
        criteria: [
          ...CRITERIA.criteria,
          { id: "AC-3", statement: "Runs offline.", check: "runtime" },
        ],
      }),
    );
    const result = await runCodeReviewFromConfig({
      agentsDir: AGENTS_DIR,
      workspacePath: workspace,
      runId: "code-review-conformance",
      contextBundlePath: await writeBundle(workspace, {
        status: "loaded",
        reason: "3 criteria from plan.json",
        sources: ["plan.json"],
        criteria: parsed.ok ? parsed.document.criteria : [],
      }),
      adapter: scriptedConformanceAdapter(),
      scratchpadRoot: join(workspace, "runs"),
    });

    // Trivial tier: only quality would run, but conformance is tier-blind.
    expect(result.metadata?.completed_roles).toBe("quality,conformance");
    expect(result.metadata?.conformance).toBe("scheduled");
    expect(result.metadata?.conformance_criteria).toBe("AC-1,AC-2,AC-3");
    expect(result.metadata?.conformance_reported).toBe("AC-1,AC-2");
    expect(result.status).toBe("failed");
    expect(result.findings.map((finding) => finding.title)).toEqual([
      "[AC-2] Fallback returns early instead of using stored values",
    ]);
    expect(
      (result.outcomes ?? [])
        .filter((outcome) => outcome.kind === "conformance")
        .map((outcome) => outcome.id),
    ).toEqual(["conformance-AC-1", "conformance-AC-2"]);

    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("## Plan Conformance");
    expect(report).toContain(
      "3 criteria: 1 satisfied, 1 unsatisfied, 0 unverifiable, 1 without a result.",
    );
    expect(report).toContain(
      "- ✅ **AC-1**: satisfied. src/hash.ts:4 sorts keys.",
    );
    expect(report).toContain("- ❌ **AC-2**: unsatisfied. Returns early.");
    expect(report).toContain("- ❔ **AC-3**: no result.");
  });
});

test("without criteria the report says the conformance role did not run and why", async () => {
  await withWorkspace(async (workspace) => {
    const result = await runCodeReviewFromConfig({
      agentsDir: AGENTS_DIR,
      workspacePath: workspace,
      runId: "code-review-no-criteria",
      contextBundlePath: await writeBundle(workspace, {
        status: "absent",
        reason: "no acceptance criteria supplied: PR #42 has no line",
        sources: [],
        criteria: [],
      }),
      adapter: scriptedConformanceAdapter(),
      scratchpadRoot: join(workspace, "runs"),
    });

    expect(result.metadata?.completed_roles).toBe("quality");
    expect(result.metadata?.conformance).toBe("not_run");
    expect(result.status).toBe("passed");
    // No generic outcome was emitted, so the legacy result shape holds.
    expect(result.outcomes).toBeUndefined();
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain(
      "## Plan Conformance\n\nNot run: no acceptance criteria supplied: PR #42 has no line.",
    );
  });
});

test("an explicit criteria file is refused on replay rather than ignored", async () => {
  await withWorkspace(async (workspace) => {
    await expect(
      runCodeReviewFromConfig({
        agentsDir: AGENTS_DIR,
        workspacePath: workspace,
        contextBundlePath: await writeBundle(workspace, undefined),
        acceptanceCriteriaPath: join(workspace, "criteria.json"),
        adapter: scriptedConformanceAdapter(),
        scratchpadRoot: join(workspace, "runs"),
      }),
    ).rejects.toThrow("--criteria cannot be combined with a replayed");
  });
});

test("an explicit criteria file is refused when the harness would ignore it", async () => {
  await withWorkspace(async (workspace) => {
    const packaged = await readFile(
      join(AGENTS_DIR, "harnesses", "code-review", "harness.yaml"),
      "utf8",
    );
    const absolutePrompts = packaged.replaceAll(
      "../../../harnesses/",
      `${join(import.meta.dir, "..", "harnesses")}/`,
    );
    const variants: readonly [string, string][] = [
      [
        absolutePrompts.replace("    - use: acceptance-criteria\n", ""),
        "`acceptance-criteria` context provider",
      ],
      [
        absolutePrompts.replace(/ {2}conformance:\n( {4}.*\n)+/, ""),
        "`conformance` role",
      ],
    ];
    for (const [yaml, missing] of variants) {
      const agentsDir = join(workspace, `agents-${missing.length}`);
      await mkdir(join(agentsDir, "harnesses", "code-review"), {
        recursive: true,
      });
      await writeFile(
        join(agentsDir, "harnesses", "code-review", "harness.yaml"),
        yaml,
        "utf8",
      );
      await expect(
        runCodeReviewFromConfig({
          agentsDir,
          workspacePath: workspace,
          acceptanceCriteriaPath: join(workspace, "criteria.json"),
          adapter: scriptedConformanceAdapter(),
          scratchpadRoot: join(workspace, "runs"),
        }),
      ).rejects.toThrow(missing);
    }
  });
});

test("reports render no conformance section when the harness has no such role", () => {
  const report = renderMarkdownReport({
    runId: "r",
    status: "passed",
    findings: [],
    artifacts: [],
    metadata: {},
  });
  expect(report).not.toContain("Plan Conformance");
});

test("posted review coverage states the conformance role's outcome", () => {
  const line = (metadata: Readonly<Record<string, string>>) =>
    formatReviewCoverageSectionLines({
      triage: "lite",
      completed_roles: "security,quality,compliance",
      ...metadata,
    }).find((entry) => entry.includes("**Plan Conformance:**"));

  expect(line({})).toBeUndefined();
  expect(
    line({ conformance: "not_run", conformance_reason: "no criteria" }),
  ).toBe("- **Plan Conformance:** not performed — no criteria.");
  expect(
    line({
      conformance: "scheduled",
      conformance_criteria: "AC-1,AC-2",
      conformance_reported: "AC-1,AC-2",
      completed_roles: "security,quality,compliance,conformance",
    }),
  ).toBe(
    "- **Plan Conformance:** checked against 2 acceptance criteria (AC-1, AC-2).",
  );
  expect(
    line({
      conformance: "scheduled",
      conformance_criteria: "AC-1,AC-2,AC-3",
      conformance_reported: "AC-1,AC-2",
      completed_roles: "security,quality,compliance,conformance",
    }),
  ).toBe(
    "- **Plan Conformance:** checked 2 of 3 acceptance criteria; **no result** for AC-3 (treat as unchecked).",
  );
  expect(
    line({
      conformance: "scheduled",
      conformance_criteria: "AC-1",
      completed_roles: "security,quality,compliance,conformance",
    }),
  ).toContain("per-row results not recorded");
  expect(
    line({
      conformance: "scheduled",
      conformance_criteria: "AC-1",
      timed_out_roles: "conformance",
    }),
  ).toContain("timed out");
});

test("URL criteria bodies are read only up to the byte cap", async () => {
  let pulls = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
    },
  });
  const text = await readBoundedResponseText(new Response(endless), 4_000);
  expect(Buffer.byteLength(text, "utf8")).toBe(4_000);
  // A few chunks of read-ahead at most, not the whole (infinite) body.
  expect(pulls).toBeLessThan(10);
});

test("an unsatisfied verdict without its finding fails the conformance role", async () => {
  expect(
    conformanceOutcomeViolations({
      roleId: "conformance",
      outcomes: [
        conformanceOutcome("AC-1", "satisfied", "ok"),
        conformanceOutcome("AC-2", "unsatisfied", "differs"),
        conformanceOutcome("AC-3", "unverifiable", "runtime only"),
        findingToHarnessOutcome({
          ...conformanceFinding("f3", "[AC-3] Cannot be shown from the diff"),
          severity: "warning",
        }),
        conformanceOutcome("AC-4", "unsatisfied", "differs"),
        // Matching title, but a warning for an unsatisfied row.
        findingToHarnessOutcome({
          ...conformanceFinding("f4", "[AC-4] Differs"),
          severity: "warning",
        }),
        conformanceOutcome("AC-5", "unsatisfied", "differs"),
        // Matching title and severity, but no evidence: would not count.
        findingToHarnessOutcome({
          ...conformanceFinding("f5", "[AC-5] Differs"),
          validation: { status: "verified", details: "Looked." },
        }),
        conformanceOutcome("AC-6", "unsatisfied", "differs"),
        findingToHarnessOutcome(conformanceFinding("f6", "[AC-6] Differs")),
        conformanceOutcome("AC-7", "unverifiable", "runtime only"),
        // A critical for an unverifiable row would claim a failure.
        findingToHarnessOutcome(conformanceFinding("f7", "[AC-7] Unclear")),
      ],
    }).map((violation) => violation.outcomeId),
  ).toEqual([
    "conformance-AC-2",
    "conformance-AC-4",
    "conformance-AC-5",
    "conformance-AC-7",
  ]);
  expect(
    conformanceOutcomeViolations({
      roleId: "quality",
      outcomes: [conformanceOutcome("AC-2", "unsatisfied", "differs")],
    }),
  ).toEqual([]);

  await withWorkspace(async (workspace) => {
    const parsed = parseAcceptanceCriteria(JSON.stringify(CRITERIA));
    const result = await runCodeReviewFromConfig({
      agentsDir: AGENTS_DIR,
      workspacePath: workspace,
      runId: "code-review-verdict-without-finding",
      contextBundlePath: await writeBundle(workspace, {
        status: "loaded",
        reason: "2 criteria from plan.json",
        sources: ["plan.json"],
        criteria: parsed.ok ? parsed.document.criteria : [],
      }),
      adapter: scriptedConformanceAdapter({ emitFinding: false }),
      scratchpadRoot: join(workspace, "runs"),
    });
    expect(result.metadata?.failed_roles).toBe("conformance");
    expect(result.status).not.toBe("passed");
    expect(await readFile(result.reportPath, "utf8")).toContain(
      "The conformance role failed",
    );
  });
});

test("a verdict without detail is not counted and fails the role", () => {
  expect(
    readConformanceVerdict(conformanceOutcome("AC-1", "satisfied", "  ")),
  ).toBeUndefined();
  expect(
    conformanceOutcomeViolations({
      roleId: "conformance",
      outcomes: [conformanceOutcome("AC-1", "satisfied", "")],
    }).map((violation) => violation.outcomeId),
  ).toEqual(["conformance-AC-1"]);
  expect(
    conformanceReportedMetadata({
      metadata: { conformance: "scheduled", conformance_criteria: "AC-1" },
      outcomes: [conformanceOutcome("AC-1", "satisfied", "")],
    }),
  ).toEqual({ conformance_reported: "" });
});

test("posted coverage does not call a review complete when conformance failed", () => {
  const problems: readonly Readonly<Record<string, string>>[] = [
    { failed_roles: "conformance" },
    { timed_out_roles: "conformance" },
    {
      completed_roles: "security,quality,compliance,conformance",
      conformance_reported: "",
    },
  ];
  for (const problem of problems) {
    const lines = formatReviewCoverageSectionLines({
      triage: "lite",
      completed_roles: "security,quality,compliance",
      conformance: "scheduled",
      conformance_criteria: "AC-1",
      ...problem,
    });
    expect(lines.join("\n")).not.toContain("All scheduled reviewers");
    expect(
      lines.some(
        (line) =>
          line.startsWith("- **Plan Conformance:**") &&
          (line.includes("not performed") || line.includes("**no result**")),
      ),
    ).toBe(true);
  }
  expect(
    formatReviewCoverageSectionLines({
      triage: "full",
      completed_roles: "security,performance,quality,compliance,conformance",
      conformance: "scheduled",
      conformance_criteria: "AC-1",
      conformance_reported: "AC-1",
    }).join("\n"),
  ).toContain("All scheduled reviewers **completed**");
});

test("a finding sharing a verdict's id does not hide the verdict", async () => {
  const collidingAdapter: AgentAdapter = {
    name: "scripted",
    capabilities: () => ({
      streaming: false,
      structuredOutput: true,
      readOnlyMode: true,
      mcp: false,
      cancellation: false,
    }),
    async *run(request: AgentRunRequest) {
      if (request.roleId !== "conformance") {
        return;
      }
      // Unsubstantiated finding first, with the verdict's own id.
      yield createAgentEvent({
        runId: request.runId,
        roleId: request.roleId,
        type: "finding",
        data: {
          ...conformanceFinding("conformance-AC-2", "[AC-2] Differs"),
          validation: { status: "verified", details: "Looked." },
        },
      });
      yield createAgentEvent({
        runId: request.runId,
        roleId: request.roleId,
        type: "outcome",
        data: conformanceOutcome("AC-2", "unsatisfied", "Returns early."),
      });
    },
  };
  await withWorkspace(async (workspace) => {
    const parsed = parseAcceptanceCriteria(JSON.stringify(CRITERIA));
    const result = await runCodeReviewFromConfig({
      agentsDir: AGENTS_DIR,
      workspacePath: workspace,
      runId: "code-review-id-collision",
      contextBundlePath: await writeBundle(workspace, {
        status: "loaded",
        reason: "2 criteria from plan.json",
        sources: ["plan.json"],
        criteria: parsed.ok ? parsed.document.criteria : [],
      }),
      adapter: collidingAdapter,
      scratchpadRoot: join(workspace, "runs"),
    });
    // The verdict survives, its finding does not count, so the role fails.
    expect(result.metadata?.failed_roles).toBe("conformance");
    expect(result.status).not.toBe("passed");
  });
});

test("a clean review with unchecked criteria does not close green", () => {
  const body = (runMetadata: Readonly<Record<string, string>>) =>
    ["triage", "impact", "evidence"].map((style) =>
      buildPendingReviewSummaryBody({
        style: style as "triage" | "impact" | "evidence",
        findings: [],
        postedCommentCount: 0,
        skippedUnanchorable: 0,
        runMetadata: {
          triage: "full",
          completed_roles:
            "security,performance,quality,compliance,conformance",
          conformance: "scheduled",
          conformance_criteria: "AC-1,AC-2",
          ...runMetadata,
        },
      }),
    );
  for (const text of body({ conformance_reported: "AC-1" })) {
    expect(text).not.toContain("code looks good");
    expect(text).toContain("plan conformance is incomplete");
  }
  for (const text of body({ conformance_reported: "AC-1,AC-2" })) {
    expect(text).toContain("✅ No findings - code looks good!");
  }
});

test("only the conformance role's verdicts count", async () => {
  const strayAdapter: AgentAdapter = {
    name: "scripted",
    capabilities: () => ({
      streaming: false,
      structuredOutput: true,
      readOnlyMode: true,
      mcp: false,
      cancellation: false,
    }),
    async *run(request: AgentRunRequest) {
      if (request.roleId === "quality") {
        // Another reviewer posing as the conformance role.
        yield createAgentEvent({
          runId: request.runId,
          roleId: request.roleId,
          type: "outcome",
          data: conformanceOutcome("AC-2", "satisfied", "Looks fine."),
        });
      }
      if (request.roleId === "conformance") {
        yield createAgentEvent({
          runId: request.runId,
          roleId: request.roleId,
          type: "outcome",
          data: conformanceOutcome("AC-1", "satisfied", "src/hash.ts:4"),
        });
      }
    },
  };
  await withWorkspace(async (workspace) => {
    const parsed = parseAcceptanceCriteria(JSON.stringify(CRITERIA));
    const result = await runCodeReviewFromConfig({
      agentsDir: AGENTS_DIR,
      workspacePath: workspace,
      runId: "code-review-stray-verdict",
      contextBundlePath: await writeBundle(workspace, {
        status: "loaded",
        reason: "2 criteria from plan.json",
        sources: ["plan.json"],
        criteria: parsed.ok ? parsed.document.criteria : [],
      }),
      adapter: strayAdapter,
      scratchpadRoot: join(workspace, "runs"),
    });
    expect(
      (result.outcomes ?? []).find(
        (outcome) => outcome.id === "conformance-AC-2",
      )?.sourceRole,
    ).toBe("quality");
    expect(result.metadata?.conformance_reported).toBe("AC-1");
    expect(await readFile(result.reportPath, "utf8")).toContain(
      "- ❔ **AC-2**: no result.",
    );
  });
});

test("a referenced URL that redirects off-owner is not fetched", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/aguil/redirect.json") {
        return Response.redirect(
          new URL("/someone-else/x.json", request.url).href,
        );
      }
      if (path === "/aguil/same-owner.json") {
        return Response.redirect(new URL("/aguil/x.json", request.url).href);
      }
      return new Response('{"ok":true}', {
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    const host = `localhost:${server.port}`;
    const options = {
      timeoutMs: 2_000,
      maxBytes: 1_000,
      remoteScope: {
        remoteName: "origin",
        host,
        owner: "aguil",
        repo: "agents",
      },
    };
    expect(
      await fetchReferencedUrl(`http://${host}/aguil/redirect.json`, options),
    ).toBeUndefined();
    expect(
      await fetchReferencedUrl(`http://${host}/aguil/same-owner.json`, options),
    ).toBe('{"ok":true}');
  } finally {
    server.stop(true);
  }
});
