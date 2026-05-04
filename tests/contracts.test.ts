import { expect, test } from "bun:test";
import type { AgentEvent, Finding } from "@aguil/agents-core";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  collectReviewDiff,
  discoverPullRequest,
  filterReviewDiff,
  extractReferencedDocumentation,
  PullRequestReferencedDocsProvider,
  RepositoryDiffProvider,
  parseRemoteHeadBranch,
  parseGitRemoteUrl,
  parsePullRequestRepoScope,
  resolvePreferredBaseBranch,
  selectPreferredRemoteName,
  shouldFetchReferencedUrl,
} from "@aguil/agents-context";
import {
  SubprocessAgentAdapter,
  buildClaudeCodeCommand,
  buildOpenCodeCommand,
  buildOpenCodePrompt,
  collectAgentRun,
  normalizeAgentOutputLine,
  validateFinding,
} from "@aguil/agents-execution";
import {
  actionableFindings,
  dedupeFindings,
  findingFingerprint,
  renderMarkdownReport,
  statusForFindings,
} from "@aguil/agents-reporting";
import { serializeEvent } from "@aguil/agents-telemetry";
import {
  buildPendingReviewSummaryBody,
  discoverLatestResultPath,
  findingsToPendingReviewComments,
  loadStoredReviewResult,
  parseReviewSummaryStyle,
} from "../packages/cli/src/index";

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
  const weaklyValidated: Finding = {
    ...verified,
    id: "finding-3",
    validation: { status: "verified", details: "looks fine" },
  };

  expect(actionableFindings([verified, unverified, weaklyValidated])).toEqual([verified]);
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

test("parses owner and repo from pull request URLs", () => {
  expect(parsePullRequestRepoScope("https://github.com/aguil/agents/pull/42")).toEqual({
    host: "github.com",
    owner: "aguil",
    repo: "agents",
  });
  expect(parsePullRequestRepoScope("https://github.com/aguil/agents/issues/42")).toBeUndefined();
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

test("parses remote HEAD branch names", () => {
  expect(parseRemoteHeadBranch("refs/remotes/origin/main\n")).toBe("main");
  expect(parseRemoteHeadBranch("refs/remotes/origin/release/2026.05\n")).toBe("release/2026.05");
  expect(parseRemoteHeadBranch(undefined)).toBeUndefined();
});

test("resolves preferred base branch from remote HEAD first", async () => {
  const commands: string[] = [];
  const commandRunner = async (cmd: readonly string[]): Promise<string | undefined> => {
    commands.push(cmd.join(" "));
    if (cmd[0] === "git" && cmd[1] === "symbolic-ref") {
      return "refs/remotes/origin/main\n";
    }
    return undefined;
  };

  expect(await resolvePreferredBaseBranch("/repo", commandRunner, "origin")).toBe("main");
  expect(commands.at(0)).toContain("refs/remotes/origin/HEAD");
});

test("discovers pull request by explicit number", async () => {
  const commands: string[] = [];
  const commandRunner = async (cmd: readonly string[]): Promise<string | undefined> => {
    commands.push(cmd.join(" "));
    return JSON.stringify({
      number: 42,
      title: "Merged PR",
      body: "Body",
      url: "https://github.com/aguil/agents/pull/42",
      baseRefName: "main",
    });
  };

  const discovered = await discoverPullRequest("/repo", commandRunner, 42);
  expect(discovered?.number).toBe(42);
  expect(commands.at(0)).toBe("gh pr view 42 --json number,title,body,url,baseRefName");
});

test("prefers explicit PR patch diff when review PR is provided", async () => {
  const commands: string[] = [];
  const commandRunner = async (cmd: readonly string[]): Promise<string | undefined> => {
    commands.push(cmd.join(" "));
    if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "view") {
      return JSON.stringify({
        number: 42,
        title: "Merged PR",
        body: "Body",
        url: "https://github.com/aguil/agents/pull/42",
        baseRefName: "main",
      });
    }
    if (cmd[0] === "gh" && cmd[1] === "api") {
      if (cmd.includes("--jq")) {
        return "deadbeefcafebabe\n";
      }
      return `diff --git a/.review-agent/runs/foo/result.json b/.review-agent/runs/foo/result.json
+ignored
diff --git a/src/main.ts b/src/main.ts
+added`;
    }
    return undefined;
  };

  const result = await collectReviewDiff("/repo", commandRunner, 42);
  expect(result.strategy).toBe("explicit_pr_patch");
  expect(result.reviewPr?.number).toBe(42);
  expect(result.reviewPr?.headSha).toBe("deadbeefcafebabe");
  expect(result.reviewPr?.reviewedAt).toBeTruthy();
  expect(result.diff).toContain("diff --git a/src/main.ts b/src/main.ts");
  expect(result.diff).not.toContain(".review-agent/runs/foo/result.json");
  expect(commands).toContain(
    "gh api --hostname github.com repos/aguil/agents/pulls/42 --jq .head.sha",
  );
  expect(commands).toContain(
    "gh api --hostname github.com -H Accept: application/vnd.github.v3.diff repos/aguil/agents/pulls/42",
  );
});

test("falls back to base diff when explicit PR patch is unavailable", async () => {
  const commands: string[] = [];
  const commandRunner = async (cmd: readonly string[]): Promise<string | undefined> => {
    commands.push(cmd.join(" "));
    if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "view") {
      return JSON.stringify({
        number: 42,
        title: "Merged PR",
        body: "Body",
        url: "https://github.com/aguil/agents/pull/42",
        baseRefName: "main",
      });
    }
    if (cmd[0] === "git" && cmd[1] === "diff" && cmd[3] === "main...HEAD") {
      return "diff --git a/src/a.ts b/src/a.ts\n+new";
    }
    if (cmd[0] === "gh" && cmd[1] === "api") {
      return undefined;
    }
    return undefined;
  };

  const result = await collectReviewDiff("/repo", commandRunner, 42);
  expect(result.strategy).toBe("pr_base_git");
  expect(result.baseRef).toBe("main");
  expect(commands).toContain(
    "gh api --hostname github.com -H Accept: application/vnd.github.v3.diff repos/aguil/agents/pulls/42",
  );
});

test("includes explicit PR metadata in diff strategy artifact", async () => {
  const provider = new RepositoryDiffProvider(async (cmd) => {
    if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "view") {
      return JSON.stringify({
        number: 42,
        title: "Merged PR",
        body: "Body",
        url: "https://github.com/aguil/agents/pull/42",
        baseRefName: "main",
      });
    }
    if (cmd[0] === "gh" && cmd[1] === "api" && cmd.includes("--jq")) {
      return "0123456789abcdef";
    }
    if (cmd[0] === "gh" && cmd[1] === "api") {
      return "diff --git a/src/a.ts b/src/a.ts\n+new";
    }
    return undefined;
  });

  const artifacts = await provider.collect({
    workspacePath: "/repo",
    scratchpadPath: "/repo/.review-agent/runs/1",
    pullRequestNumber: 42,
  });
  const strategy = artifacts.find((artifact) => artifact.id === "diff-strategy")?.content ?? "";
  expect(strategy).toContain("Strategy: explicit_pr_patch");
  expect(strategy).toContain("PR Number: 42");
  expect(strategy).toContain("PR Head SHA: 0123456789abcdef");
  expect(strategy).toContain("Reviewed At:");
});

test("filters harness artifacts out of review diff", () => {
  const diff = `diff --git a/.review-agent/runs/foo/result.json b/.review-agent/runs/foo/result.json
index a..b 100644
--- a/.review-agent/runs/foo/result.json
+++ b/.review-agent/runs/foo/result.json
@@ -1 +1 @@
-old
+new
diff --git a/src/app.ts b/src/app.ts
index c..d 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-a
+b`;

  const filtered = filterReviewDiff(diff);
  expect(filtered).toContain("diff --git a/src/app.ts b/src/app.ts");
  expect(filtered).not.toContain(".review-agent/runs/foo/result.json");
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

test("rejects PR-referenced local docs that escape workspace via symlink", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agents-doc-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "agents-doc-outside-"));
  try {
    await writeFile(join(outside, "secret.txt"), "do-not-read", "utf8");
    await symlink(join(outside, "secret.txt"), join(workspace, "docs-link.md"));

    const provider = new PullRequestReferencedDocsProvider({
      commandRunner: async (cmd) => {
        if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "view") {
          return JSON.stringify({
            number: 1,
            title: "Test PR",
            body: "See docs-link.md",
            url: "https://github.com/aguil/agents/pull/1",
          });
        }
        return undefined;
      },
    });

    const artifacts = await provider.collect({
      workspacePath: workspace,
      scratchpadPath: workspace,
    });

    expect(artifacts.some((artifact) => artifact.title.startsWith("PR Referenced Local Doc:"))).toBe(false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
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

test("keeps rephrased findings distinct when semantic fingerprint differs", () => {
  const base: Finding = {
    id: "finding-1",
    severity: "warning",
    title: "Event sink does directory checks on every emitted event",
    description: "Event sink runs ensureDirectory on every write and orchestration awaits each call.",
    evidence: "JsonlFileEventSink.write calls ensureDirectory(dirname(path)) before appendFile.",
    sourceRole: "performance",
    file: "packages/telemetry/src/index.ts",
    line: 18,
    validation: { status: "verified", details: "Code-path review." },
  };
  const rephrased: Finding = {
    ...base,
    id: "finding-2",
    title: "Per-event ensureDirectory adds avoidable filesystem overhead",
    description: "Each telemetry event performs a directory check and the orchestrator waits on it.",
    evidence: "The event sink performs ensureDirectory before appending JSONL for each event.",
  };

  expect(findingFingerprint(base).split("|")[0]).toBe("performance");
  expect(dedupeFindings([base, rephrased])).toHaveLength(2);
});

test("does not merge distinct findings that share one location", () => {
  const left: Finding = {
    id: "finding-1",
    severity: "warning",
    title: "Missing authorization check on write path",
    description: "Mutation endpoint updates state without verifying caller permissions.",
    evidence: "writeConfig() is called before any authorize() guard in the handler.",
    sourceRole: "security",
    file: "src/handler.ts",
    line: 42,
    validation: { status: "verified", details: "Inspected call path around handler implementation." },
  };
  const right: Finding = {
    ...left,
    id: "finding-2",
    title: "Expensive JSON parse in hot request path",
    description: "Handler reparses unchanged payload and doubles CPU work for each request.",
    evidence: "JSON.parse runs twice in the same handler branch without transformation.",
    sourceRole: "security",
  };

  expect(findingFingerprint(left)).not.toBe(findingFingerprint(right));
  expect(dedupeFindings([left, right])).toHaveLength(2);
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

test("creates pending PR review comments only for anchorable findings", () => {
  const anchorable: Finding = {
    id: "finding-1",
    severity: "warning",
    title: "Anchored issue",
    description: "A validated review finding.",
    evidence: "The reproduction passed.",
    sourceRole: "quality",
    file: "src/app.ts",
    line: 12,
    validation: { status: "verified", details: "Reproduced locally." },
  };
  const summaryOnly: Finding = {
    ...anchorable,
    id: "finding-2",
    file: undefined,
  };

  const comments = findingsToPendingReviewComments([anchorable, summaryOnly]);
  expect(comments).toHaveLength(1);
  expect(comments[0]).toEqual({
    path: "src/app.ts",
    line: 12,
    side: "RIGHT",
    body: expect.stringContaining("Anchored issue"),
  });
});

test("defaults review summary style to impact", () => {
  expect(parseReviewSummaryStyle(undefined)).toBe("impact");
});

test("rejects invalid review summary style", () => {
  expect(parseReviewSummaryStyle("unknown")).toBeUndefined();
});

test("loads stored review result findings and metadata", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agents-post-only-load-"));
  try {
    const path = join(workspace, "result.json");
    await writeFile(
      path,
      JSON.stringify({
        findings: [
          {
            id: "finding-1",
            severity: "warning",
            title: "Stored issue",
            description: "A validated review finding.",
            evidence: "The reproduction passed.",
            sourceRole: "quality",
            validation: { status: "verified", details: "Reproduced locally." },
          },
        ],
        metadata: {
          pr_number: "1",
          pr_reviewed_head_sha: "deadbeef",
        },
      }),
      "utf8",
    );

    const loaded = await loadStoredReviewResult(path);
    expect(loaded.findings).toHaveLength(1);
    expect(loaded.metadata?.pr_number).toBe("1");
    expect(loaded.metadata?.pr_reviewed_head_sha).toBe("deadbeef");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("discovers latest run result path", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agents-post-only-discover-"));
  try {
    const runsRoot = join(workspace, ".review-agent", "runs");
    await mkdir(join(runsRoot, "code-review-20260501120000-aaaa"), { recursive: true });
    await mkdir(join(runsRoot, "code-review-20260502120000-bbbb"), { recursive: true });
    await writeFile(
      join(runsRoot, "code-review-20260501120000-aaaa", "result.json"),
      "{}\n",
      "utf8",
    );
    await writeFile(
      join(runsRoot, "code-review-20260502120000-bbbb", "result.json"),
      "{}\n",
      "utf8",
    );

    const discovered = await discoverLatestResultPath(workspace);
    expect(discovered).toBe(join(runsRoot, "code-review-20260502120000-bbbb", "result.json"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("builds triage review summary body", () => {
  const finding: Finding = {
    id: "finding-1",
    severity: "warning",
    title: "Anchored issue",
    description: "A validated review finding.",
    evidence: "The reproduction passed.",
    sourceRole: "quality",
    file: "src/app.ts",
    line: 12,
    validation: { status: "verified", details: "Reproduced locally." },
  };

  const body = buildPendingReviewSummaryBody({
    style: "triage",
    findings: [finding],
    postedCommentCount: 1,
    skippedUnanchorable: 0,
  });

  expect(body).toContain("## At a Glance");
  expect(body).toContain("## Fix Now");
});

test("builds impact review summary body", () => {
  const finding: Finding = {
    id: "finding-1",
    severity: "warning",
    title: "Perf issue",
    description: "A validated review finding.",
    evidence: "The reproduction passed.",
    sourceRole: "performance",
    file: "src/app.ts",
    line: 12,
    validation: { status: "verified", details: "Reproduced locally." },
  };

  const body = buildPendingReviewSummaryBody({
    style: "impact",
    findings: [finding],
    postedCommentCount: 1,
    skippedUnanchorable: 0,
  });

  expect(body).toContain("## Impact Summary");
  expect(body).toContain("### Runtime / Performance");
});

test("builds evidence review summary body", () => {
  const finding: Finding = {
    id: "finding-1",
    severity: "warning",
    title: "Doc mismatch",
    description: "A validated review finding.",
    evidence: "The reproduction passed.",
    sourceRole: "compliance",
    file: "README.md",
    line: 12,
    validation: { status: "verified", details: "Reproduced locally." },
  };

  const body = buildPendingReviewSummaryBody({
    style: "evidence",
    findings: [finding],
    postedCommentCount: 1,
    skippedUnanchorable: 0,
  });

  expect(body).toContain("## Why / Evidence / Fix");
  expect(body).toContain("### Finding 1: Doc mismatch");
});

test("renders severity emojis in markdown report", () => {
  const critical: Finding = {
    id: "finding-critical",
    severity: "critical",
    title: "Critical security issue",
    description: "A critical problem.",
    evidence: "Evidence here.",
    sourceRole: "security",
    validation: { status: "verified", details: "Validated." },
  };
  const warning: Finding = {
    id: "finding-warning",
    severity: "warning",
    title: "Warning performance issue",
    description: "A warning problem.",
    evidence: "Evidence here.",
    sourceRole: "performance",
    validation: { status: "verified", details: "Validated." },
  };

  const report = renderMarkdownReport({
    runId: "run-1",
    status: "failed",
    findings: [critical, warning],
    artifacts: [],
  });

  expect(report).toContain("## 1. 🔴 Critical security issue");
  expect(report).toContain("## 2. ⚠️ Warning performance issue");
  expect(report).not.toContain("CRITICAL:");
  expect(report).not.toContain("WARNING:");
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
    {
      executable: "opencode-test",
      model: "provider/model",
      variant: "minimal",
      agent: "reviewer",
      pure: true,
    },
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
  expect(command).toContain("minimal");
  expect(command).toContain("reviewer");
  expect(command).toContain("--pure");
  expect(command.at(-1)).toContain("security code-review specialist");
});

test("adds jj guidance to opencode prompt when workspace is jj", () => {
  const prompt = buildOpenCodePrompt({
    runId: "run-1",
    roleId: "quality",
    prompt: "Review this change.",
    workspacePath: "/repo",
    contextBundlePath: "/scratch/context.json",
    scratchpadPath: "/scratch/roles/quality",
    timeoutMs: 1_000,
    allowedCommands: ["jj diff"],
    metadata: { vcs_mode: "jj" },
  });

  expect(prompt).toContain("workspace uses jujutsu");
  expect(prompt).toContain("Prefer the provided context bundle");
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

test("captures subprocess stdout/stderr artifacts for debugging", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "agents-streaming-"));
  try {
    const adapter = new SubprocessAgentAdapter({
      name: "streaming-test-agent",
      capabilities: {
        streaming: true,
        structuredOutput: true,
        readOnlyMode: true,
        mcp: false,
        cancellation: true,
      },
      buildCommand: () => ({
        cmd: [
          process.execPath,
          "--eval",
          "console.log('stream-stdout'); console.error('stream-stderr');",
        ],
        cwd: tempDir,
      }),
      heartbeatIntervalMs: 5,
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

    expect(run.events.some((event) => event.type === "stdout" && event.message === "stream-stdout")).toBe(
      true,
    );
    expect(run.events.some((event) => event.type === "stderr" && event.message === "stream-stderr")).toBe(
      true,
    );
    expect(await readFile(join(tempDir, "stdout.log"), "utf8")).toContain("stream-stdout");
    expect(await readFile(join(tempDir, "stderr.log"), "utf8")).toContain("stream-stderr");
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

test("treats timed out roles as warnings with partial coverage metadata", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "agents-code-review-timeout-"));
  try {
    const result = await runCodeReview({
      workspacePath: tempDir,
      scratchpadRoot: join(tempDir, "scratchpad"),
      runId: "test-timeout-run",
      adapter: {
        name: "timeout-test-agent",
        capabilities: () => ({
          streaming: true,
          structuredOutput: true,
          readOnlyMode: true,
          mcp: false,
          cancellation: true,
        }),
        async *run(request) {
          yield {
            timestamp: "2026-05-02T00:00:00.000Z",
            runId: request.runId,
            roleId: request.roleId,
            type: "error" as const,
            message: "timed out",
            data: { reason: "timed_out", timeoutMs: 180_000 },
          };
        },
      },
    });

    expect(result.status).toBe("warnings");
    expect(result.metadata?.strict_mode).toBe("false");
    expect(result.metadata?.timed_out_roles).toBe("quality");
    expect(result.metadata?.failed_roles).toBe("");
    expect(await readFile(result.reportPath, "utf8")).toContain("Execution Notes");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("replays a run from a provided context bundle", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "agents-code-review-replay-"));
  try {
    const contextPath = join(tempDir, "context.json");
    await writeFile(
      contextPath,
      JSON.stringify({
        id: "replay-context",
        artifacts: [
          { id: "triage", title: "Risk Triage", content: "trivial" },
          { id: "workspace-diff", title: "Workspace Diff", content: "diff --git a/a b/a" },
        ],
      }),
    );

    const result = await runCodeReview({
      workspacePath: tempDir,
      scratchpadRoot: join(tempDir, "scratchpad"),
      runId: "test-replay-run",
      contextBundlePath: contextPath,
      adapter: createFakeCodeReviewAdapter(),
    });

    expect(result.metadata?.context_source).toBe("replay");
    expect(result.metadata?.context_fingerprint?.length).toBe(12);
    expect(result.metadata?.completed_roles).toBe("quality");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("keeps only recurring findings when consensus mode is enabled", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "agents-code-review-consensus-"));
  try {
    const shared: Finding = {
      id: "shared-finding",
      severity: "warning",
      title: "Shared issue",
      description: "Present in all passes.",
      evidence: "Detected consistently.",
      sourceRole: "quality",
      file: "src/app.ts",
      line: 42,
      validation: { status: "verified", details: "Verified by code-path inspection." },
    };

    const result = await runCodeReview({
      workspacePath: tempDir,
      scratchpadRoot: join(tempDir, "scratchpad"),
      runId: "test-consensus-run",
      consensusRuns: 2,
      adapter: {
        name: "consensus-test-agent",
        capabilities: () => ({
          streaming: true,
          structuredOutput: true,
          readOnlyMode: true,
          mcp: false,
          cancellation: true,
        }),
        async *run(request) {
          if (request.roleId !== "quality") {
            return;
          }
          const passSpecific: Finding = {
            ...shared,
            id: request.runId.endsWith("pass1") ? "pass1-only" : "pass2-only",
            title: request.runId.endsWith("pass1") ? "Only pass 1" : "Only pass 2",
            line: request.runId.endsWith("pass1") ? 100 : 101,
          };
          yield {
            timestamp: "2026-05-02T00:00:00.000Z",
            runId: request.runId,
            roleId: request.roleId,
            type: "finding" as const,
            message: shared.title,
            data: shared,
          };
          yield {
            timestamp: "2026-05-02T00:00:00.000Z",
            runId: request.runId,
            roleId: request.roleId,
            type: "finding" as const,
            message: passSpecific.title,
            data: passSpecific,
          };
        },
      },
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.id).toBe("shared-finding");
    expect(result.metadata?.consensus_mode).toBe("intersection");
    expect(result.metadata?.consensus_runs).toBe("2");
    expect(result.metadata?.consensus_dropped_findings).toBe("2");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("consensus run with no recurring findings reports passed and drops findings", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "agents-code-review-consensus-none-"));
  try {
    const result = await runCodeReview({
      workspacePath: tempDir,
      scratchpadRoot: join(tempDir, "scratchpad"),
      runId: "test-consensus-none",
      consensusRuns: 2,
      adapter: {
        name: "consensus-none-agent",
        capabilities: () => ({
          streaming: true,
          structuredOutput: true,
          readOnlyMode: true,
          mcp: false,
          cancellation: true,
        }),
        async *run(request) {
          if (request.roleId !== "quality") {
            return;
          }
          const finding: Finding = {
            id: request.runId.endsWith("pass1") ? "p1" : "p2",
            severity: "warning",
            title: request.runId.endsWith("pass1") ? "Only pass 1" : "Only pass 2",
            description: "Pass-specific finding",
            evidence: "Only appears in one pass",
            sourceRole: "quality",
            file: "src/app.ts",
            line: request.runId.endsWith("pass1") ? 10 : 11,
            validation: { status: "verified", details: "Verified by code inspection path trace." },
          };
          yield {
            timestamp: "2026-05-02T00:00:00.000Z",
            runId: request.runId,
            roleId: request.roleId,
            type: "finding" as const,
            message: finding.title,
            data: finding,
          };
        },
      },
    });

    expect(result.status).toBe("passed");
    expect(result.findings).toHaveLength(0);
    expect(result.metadata?.consensus_dropped_findings).toBe("2");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("rejects non-positive consensusRuns from API options", async () => {
  await expect(async () => {
    await runCodeReview({
      workspacePath: "/tmp",
      consensusRuns: 0,
      adapter: createFakeCodeReviewAdapter(),
    });
  }).toThrow("Invalid consensusRuns value");
});

test("strict mode fails run on timed out roles", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "agents-code-review-timeout-strict-"));
  try {
    const result = await runCodeReview({
      workspacePath: tempDir,
      scratchpadRoot: join(tempDir, "scratchpad"),
      runId: "test-timeout-run-strict",
      strict: true,
      adapter: {
        name: "timeout-test-agent",
        capabilities: () => ({
          streaming: true,
          structuredOutput: true,
          readOnlyMode: true,
          mcp: false,
          cancellation: true,
        }),
        async *run(request) {
          yield {
            timestamp: "2026-05-02T00:00:00.000Z",
            runId: request.runId,
            roleId: request.roleId,
            type: "error" as const,
            message: "timed out",
            data: { reason: "timed_out", timeoutMs: 420_000 },
          };
        },
      },
    });

    expect(result.status).toBe("error");
    expect(result.metadata?.strict_mode).toBe("true");
    expect(result.metadata?.timed_out_roles).toBe("quality");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
