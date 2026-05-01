import { expect, test } from "bun:test";
import type { AgentEvent, Finding } from "@aguil/agents-core";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakeCodeReviewAdapter,
  definitionForTriage,
  runCodeReview,
} from "@aguil/agents-code-review";
import {
  changedFilesFromDiff,
  classifyDiff,
  extractReferencedDocumentation,
  parseGitRemoteUrl,
  selectPreferredRemoteName,
  shouldFetchReferencedUrl,
} from "@aguil/agents-context";
import {
  SubprocessAgentAdapter,
  buildClaudeCodeCommand,
  buildOpenCodeCommand,
  collectAgentRun,
  normalizeAgentOutputLine,
  validateFinding,
} from "@aguil/agents-execution";
import { actionableFindings, dedupeFindings, statusForFindings } from "@aguil/agents-reporting";
import { serializeEvent } from "@aguil/agents-telemetry";

test("serializes agent events as JSONL", () => {
  const event: AgentEvent = {
    timestamp: "2026-04-30T00:00:00.000Z",
    runId: "run-1",
    roleId: "security",
    type: "started",
    message: "started security review",
  };

  expect(serializeEvent(event)).toBe(`${JSON.stringify(event)}\n`);
});

test("keeps only verified findings for actionable reports", () => {
  const verified: Finding = {
    id: "finding-1",
    severity: "warning",
    title: "Verified issue",
    description: "A validated review finding.",
    evidence: "The reproduction passed.",
    sourceRole: "quality",
    validation: { status: "verified", details: "Reproduced locally." },
  };
  const unverified: Finding = {
    ...verified,
    id: "finding-2",
    validation: { status: "not_run", details: "No validation was attempted." },
  };

  expect(actionableFindings([verified, unverified])).toEqual([verified]);
});

test("classifies small diffs as trivial", () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts
+hello
-hello`;

  expect(classifyDiff(diff)).toBe("trivial");
  expect(changedFilesFromDiff(diff)).toEqual(["src/a.ts"]);
});

test("parses git remote URLs for host/org scope", () => {
  expect(parseGitRemoteUrl("git@github.com:aguil/agents.git")).toEqual({
    host: "github.com",
    owner: "aguil",
    repo: "agents",
  });
  expect(parseGitRemoteUrl("https://github.com/aguil/agents.git")).toEqual({
    host: "github.com",
    owner: "aguil",
    repo: "agents",
  });
});

test("prefers tracking remote before origin", () => {
  expect(
    selectPreferredRemoteName({
      trackingRemote: "upstream",
      remoteNames: ["origin", "upstream"],
    }),
  ).toBe("upstream");
  expect(
    selectPreferredRemoteName({
      trackingRemote: undefined,
      remoteNames: ["origin", "upstream"],
    }),
  ).toBe("origin");
});

test("extracts referenced docs from PR descriptions", () => {
  const references = extractReferencedDocumentation(`
See [design](docs/architecture.md) and README.md.
Also referenced: https://github.com/aguil/another-repo/blob/main/docs/guide.md
And [external](https://example.com/docs)
`);

  expect(references).toEqual([
    { kind: "local-path", value: "README.md" },
    { kind: "local-path", value: "docs/architecture.md" },
    { kind: "url", value: "https://example.com/docs" },
    { kind: "url", value: "https://github.com/aguil/another-repo/blob/main/docs/guide.md" },
  ]);
});

test("fetch gating allows only same remote org links", () => {
  const remoteScope = {
    remoteName: "origin",
    host: "github.com",
    owner: "aguil",
    repo: "agents",
  };
  expect(
    shouldFetchReferencedUrl("https://github.com/aguil/other-repo/blob/main/README.md", remoteScope)
      .allowed,
  ).toBe(true);
  expect(
    shouldFetchReferencedUrl("https://github.com/other-org/repo/blob/main/README.md", remoteScope)
      .allowed,
  ).toBe(false);
});

test("dedupes findings and derives severity status", () => {
  const finding: Finding = {
    id: "finding-1",
    severity: "critical",
    title: "Duplicate issue",
    description: "A validated review finding.",
    evidence: "The reproduction passed.",
    sourceRole: "security",
    file: "src/a.ts",
    line: 10,
    validation: { status: "verified", details: "Reproduced locally." },
  };

  const deduped = dedupeFindings([{ ...finding, id: "finding-2" }, finding]);

  expect(deduped).toHaveLength(1);
  expect(statusForFindings(deduped)).toBe("failed");
});

test("validates finding shape before accepting agent output", () => {
  const invalid = validateFinding({
    id: "finding-1",
    severity: "info",
    title: "Not actionable",
  });

  expect(invalid.valid).toBe(false);
  expect(invalid.errors).toContain("severity must be critical or warning");
  expect(invalid.errors).toContain("description must be a non-empty string");
});

test("normalizes finding JSONL emitted by an agent", () => {
  const finding: Finding = {
    id: "finding-1",
    severity: "warning",
    title: "Verified issue",
    description: "A validated review finding.",
    evidence: "The reproduction passed.",
    sourceRole: "quality",
    validation: { status: "verified", details: "Reproduced locally." },
  };

  const events = normalizeAgentOutputLine(
    {
      runId: "run-1",
      roleId: "quality",
      prompt: "Review this change.",
      workspacePath: "/tmp/workspace",
      contextBundlePath: "/tmp/context.json",
      scratchpadPath: "/tmp/scratchpad",
      timeoutMs: 1_000,
      allowedCommands: [],
    },
    JSON.stringify({ finding }),
  );

  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe("finding");
  expect(events[0]?.data).toEqual(finding);
});

test("builds opencode command behind the adapter boundary", () => {
  const command = buildOpenCodeCommand(
    {
      runId: "run-1",
      roleId: "security",
      prompt: "Review this change.",
      workspacePath: "/repo",
      contextBundlePath: "/scratch/context.json",
      scratchpadPath: "/scratch/roles/security",
      timeoutMs: 1_000,
      allowedCommands: ["bun test"],
    },
    "/scratch/roles/security/security.request.json",
    { executable: "opencode-test", model: "provider/model", agent: "reviewer", pure: true },
  );

  expect(command.slice(0, 6)).toEqual([
    "opencode-test",
    "run",
    "--format",
    "json",
    "--dir",
    "/repo",
  ]);
  expect(command).toContain("provider/model");
  expect(command).toContain("reviewer");
  expect(command).toContain("--pure");
  expect(command.at(-1)).toContain("security code-review specialist");
});

test("builds claude command behind the adapter boundary", () => {
  const command = buildClaudeCodeCommand(
    {
      runId: "run-1",
      roleId: "quality",
      prompt: "Review this change.",
      workspacePath: "/repo",
      contextBundlePath: "/scratch/context.json",
      scratchpadPath: "/scratch/roles/quality",
      timeoutMs: 1_000,
      allowedCommands: ["bun test"],
    },
    "/scratch/roles/quality/quality.request.json",
    {
      executable: "claude-test",
      model: "claude-sonnet",
      argsTemplate: ["-p", "{prompt}", "--cwd", "{workspace}", "--context", "{context_bundle}"],
    },
  );

  expect(command[0]).toBe("claude-test");
  expect(command[1]).toBe("-p");
  expect(command[3]).toBe("--cwd");
  expect(command).toContain("/repo");
  expect(command).toContain("/scratch/context.json");
  expect(command).toContain("--model");
  expect(command).toContain("claude-sonnet");
  expect(command[2]).toContain("quality specialist");
});

test("uses fewer reviewer roles for lower-risk triage tiers", () => {
  expect(definitionForTriage("trivial").roles.map((role) => role.id)).toEqual(["quality"]);
  expect(definitionForTriage("lite").roles.map((role) => role.id)).toEqual([
    "security",
    "quality",
    "compliance",
  ]);
});

test("collects fake agent findings through the adapter contract", async () => {
  const finding: Finding = {
    id: "finding-1",
    severity: "warning",
    title: "Verified issue",
    description: "A validated review finding.",
    evidence: "The reproduction passed.",
    sourceRole: "quality",
    validation: { status: "verified", details: "Reproduced locally." },
  };
  const tempDir = await mkdtemp(join(tmpdir(), "agents-execution-"));
  try {
    const run = await collectAgentRun(createFakeCodeReviewAdapter({ quality: [finding] }), {
      runId: "run-1",
      roleId: "quality",
      prompt: "Review this change.",
      workspacePath: tempDir,
      contextBundlePath: join(tempDir, "context.json"),
      scratchpadPath: tempDir,
      timeoutMs: 1_000,
      allowedCommands: [],
    });

    expect(run.result.findings).toEqual([finding]);
    expect(run.events.map((event) => event.type)).toEqual(["started", "finding", "completed"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("marks subprocess agents as timed out", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "agents-timeout-"));
  try {
    const adapter = new SubprocessAgentAdapter({
      name: "slow-test-agent",
      capabilities: {
        streaming: true,
        structuredOutput: true,
        readOnlyMode: true,
        mcp: false,
        cancellation: true,
      },
      buildCommand: () => ({
        cmd: [process.execPath, "--eval", "await new Promise((resolve) => setTimeout(resolve, 500));"],
        cwd: tempDir,
      }),
    });

    const run = await collectAgentRun(adapter, {
      runId: "run-1",
      roleId: "quality",
      prompt: "Review this change.",
      workspacePath: tempDir,
      contextBundlePath: join(tempDir, "context.json"),
      scratchpadPath: tempDir,
      timeoutMs: 10,
      allowedCommands: [],
    });

    expect(run.result.status).toBe("timed_out");
    expect(run.events.at(-1)?.type).toBe("error");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("handles missing subprocess binaries as adapter failures", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "agents-missing-binary-"));
  try {
    const adapter = new SubprocessAgentAdapter({
      name: "missing-binary-agent",
      capabilities: {
        streaming: true,
        structuredOutput: true,
        readOnlyMode: true,
        mcp: false,
        cancellation: true,
      },
      buildCommand: () => ({
        cmd: ["command-that-does-not-exist-for-tests-xyz"],
        cwd: tempDir,
      }),
    });

    const run = await collectAgentRun(adapter, {
      runId: "run-1",
      roleId: "quality",
      prompt: "Review this change.",
      workspacePath: tempDir,
      contextBundlePath: join(tempDir, "context.json"),
      scratchpadPath: tempDir,
      timeoutMs: 1_000,
      allowedCommands: [],
    });

    expect(run.result.status).toBe("failed");
    expect(run.events.at(-1)?.type).toBe("error");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runs the code-review harness with a fake adapter", async () => {
  const finding: Finding = {
    id: "finding-1",
    severity: "warning",
    title: "Verified harness issue",
    description: "A validated review finding.",
    evidence: "The reproduction passed.",
    sourceRole: "quality",
    validation: { status: "verified", details: "Reproduced locally." },
  };
  const tempDir = await mkdtemp(join(tmpdir(), "agents-code-review-"));
  try {
    const result = await runCodeReview({
      workspacePath: tempDir,
      scratchpadRoot: join(tempDir, "scratchpad"),
      runId: "test-run",
      adapter: createFakeCodeReviewAdapter({ quality: [finding] }),
    });

    expect(result.status).toBe("warnings");
    expect(result.findings).toEqual([finding]);
    expect(await readFile(result.reportPath, "utf8")).toContain("Verified harness issue");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("preserves adapter errors in final harness status", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "agents-code-review-error-"));
  try {
    const result = await runCodeReview({
      workspacePath: tempDir,
      scratchpadRoot: join(tempDir, "scratchpad"),
      runId: "test-error-run",
      adapter: {
        name: "error-test-agent",
        capabilities: () => ({
          streaming: true,
          structuredOutput: true,
          readOnlyMode: true,
          mcp: false,
          cancellation: true,
        }),
        async *run(request) {
          yield {
            timestamp: "2026-05-01T00:00:00.000Z",
            runId: request.runId,
            roleId: request.roleId,
            type: "error" as const,
            message: "adapter failed",
          };
        },
      },
    });

    expect(result.status).toBe("error");
    expect(result.findings).toEqual([]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
