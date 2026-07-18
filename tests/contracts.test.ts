import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODE_REVIEW_HARNESS_PACKAGE_ADAPTER_DEFAULT,
  CODE_REVIEW_ROLE_IDS,
  createFakeCodeReviewAdapter,
  definitionForTriage,
  expectedRolesForTriageTier,
  roleReviewSectionLabel,
  runCodeReview,
} from "@aguil/agents-code-review";
import {
  changedFilesFromDiff,
  classifyDiff,
  collectReviewDiff,
  discoverPullRequest,
  extractReferencedDocumentation,
  filterReviewDiff,
  PullRequestReferencedDocsProvider,
  parseGitRemoteUrl,
  parsePullRequestRepoScope,
  parseRemoteHeadBranch,
  RepositoryDiffProvider,
  resolvePreferredBaseBranch,
  selectPreferredRemoteName,
  shouldFetchReferencedUrl,
} from "@aguil/agents-context";
import type { AgentEvent, Finding } from "@aguil/agents-core";
import {
  AGENTS_CODE_REVIEW_DIR,
  resolveGitAwarePath,
} from "@aguil/agents-core";
import {
  buildClaudeCodeCommand,
  buildCursorCommand,
  buildCursorPrompt,
  buildOpenCodeCommand,
  buildOpenCodePrompt,
  collectAgentRun,
  normalizeAgentOutputLine,
  SubprocessAgentAdapter,
  validateFinding,
} from "@aguil/agents-execution";
import {
  actionableFindings,
  dedupeFindings,
  findingFingerprint,
  renderMarkdownReport,
  severityEmoji,
  statusForFindings,
} from "@aguil/agents-reporting";
import { serializeEvent } from "@aguil/agents-telemetry";
import { isToonEncodeAvailable } from "@aguil/agents-triage";
import {
  extractConfigDocument,
  mergeFlatConfigLayers,
  mergePresetMaps,
  normalizeAdapterArgsTemplateField,
  resolveCodeReviewCliOptions,
  sanitizeRepoAdapterExecutablePartial,
} from "../packages/cli/src/code-review-config";
import {
  codeReviewHelpStderrExtras,
  renderCodeReviewHelp,
  resolveCodeReviewHelp,
} from "../packages/cli/src/code-review-help";
import {
  buildPendingReviewSummaryBody,
  discoverLatestResultPath,
  findingHasNonPostablePrLineAnchor,
  findingsToPendingReviewComments,
  findingUsesFileNotInPrChangedFiles,
  firstAnchorableDiffReviewPosition,
  firstNonCollidingAnchorableDiffReviewPosition,
  formatReviewCoverageSectionLines,
  formatReviewProvenanceSectionLines,
  loadStoredReviewResult,
  parsePrNumber,
  parseReviewSummaryStyle,
  resolveAdapterModelFromMetadata,
} from "../packages/cli/src/index";
import {
  parseCodeReviewArgv,
  peelCodeReviewSubcommand,
  resolveEffectivePostOnly,
} from "../packages/cli/src/parse-code-review-argv";
import { parseTriageArgv } from "../packages/cli/src/parse-triage-argv";
import { runTriageCli } from "../packages/cli/src/triage-main";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("peelCodeReviewSubcommand leaves argv when absent or starts with -", () => {
  expect(peelCodeReviewSubcommand([])).toEqual({
    ok: true,
    kind: "run",
    optionArgv: [],
  });
  expect(peelCodeReviewSubcommand(["--dry-run"])).toEqual({
    ok: true,
    kind: "run",
    optionArgv: ["--dry-run"],
  });
});

test("peelCodeReviewSubcommand accepts post prefix", () => {
  expect(peelCodeReviewSubcommand(["post"])).toEqual({
    ok: true,
    kind: "post",
    optionArgv: [],
  });
  expect(peelCodeReviewSubcommand(["post", "--result", "./r.json"])).toEqual({
    ok: true,
    kind: "post",
    optionArgv: ["--result", "./r.json"],
  });
});

test("peelCodeReviewSubcommand injects context-bundle for replay positional path", () => {
  expect(peelCodeReviewSubcommand(["replay", "./bundle.json"])).toEqual({
    ok: true,
    kind: "replay",
    optionArgv: ["--context-bundle", "./bundle.json"],
  });
  expect(peelCodeReviewSubcommand(["replay", "--adapter", "fake"])).toEqual({
    ok: true,
    kind: "replay",
    optionArgv: ["--adapter", "fake"],
  });
  expect(peelCodeReviewSubcommand(["replay", "./b.json", "--dry-run"])).toEqual(
    {
      ok: true,
      kind: "replay",
      optionArgv: ["--context-bundle", "./b.json", "--dry-run"],
    },
  );
});

test("peelCodeReviewSubcommand accepts inbox prefix", () => {
  expect(peelCodeReviewSubcommand(["inbox", "list"])).toEqual({
    ok: true,
    kind: "inbox",
    optionArgv: ["list"],
  });
});

test("peelCodeReviewSubcommand rejects unknown leading token", () => {
  const result = peelCodeReviewSubcommand(["publish"]);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("publish");
    expect(result.error).toContain("replay");
    expect(result.error).toContain("post");
    expect(result.error).toContain("inbox");
    expect(result.error).toContain("code-review");
  }
});

test("parseCodeReviewArgv parses repos-root", () => {
  const parsed = parseCodeReviewArgv(["--repos-root", "/tmp/repos-root"]);
  expect(parsed.options.reposRoot).toBe("/tmp/repos-root");
  expect(parsed.explicitKeys.has("reposRoot")).toBe(true);
});

test("parseCodeReviewArgv never enables postOnly from CLI flags", () => {
  expect(parseCodeReviewArgv([]).options.postOnly).toBe(false);
  expect(parseCodeReviewArgv(["--dry-run"]).options.postOnly).toBe(false);
});

test("parseCodeReviewArgv marks boolean flags explicit even when followed by non-bundled tokens", () => {
  const parsed = parseCodeReviewArgv(["--dry-run", "--unknown-flag=1"]);
  expect(parsed.options.dryRun).toBe(true);
  expect(parsed.explicitKeys.has("dryRun")).toBe(true);
});

test("parseCodeReviewArgv binds string options when values look like flag tokens", () => {
  const cursorArgsComma = parseCodeReviewArgv([
    "--cursor-args",
    "--print,--output-format=stream-json",
  ]);
  expect(cursorArgsComma.options.cursorArgs).toBe(
    "--print,--output-format=stream-json",
  );
  expect(cursorArgsComma.explicitKeys.has("cursorArgs")).toBe(true);

  const claudeArgsComma = parseCodeReviewArgv(["--claude-args", "--foo,--bar"]);
  expect(claudeArgsComma.options.claudeArgs).toBe("--foo,--bar");

  const presetFollowing = parseCodeReviewArgv([
    "--adapter",
    "opencode",
    "--preset",
    "ci",
  ]);
  expect(presetFollowing.presetName).toBe("ci");
  expect(presetFollowing.options.adapter).toBe("opencode");

  const presetEquals = parseCodeReviewArgv([
    "--preset=qa",
    "--adapter",
    "fake",
  ]);
  expect(presetEquals.presetName).toBe("qa");

  const adapterAfterPreset = parseCodeReviewArgv([
    "--preset",
    "ci",
    "--adapter",
    "fake",
  ]);
  expect(adapterAfterPreset.presetName).toBe("ci");
  expect(adapterAfterPreset.options.adapter).toBe("fake");

  const equalsAdapter = parseCodeReviewArgv(["--adapter=opencode"]);
  expect(equalsAdapter.options.adapter).toBe("opencode");

  const cursorArgsEscaped = parseCodeReviewArgv([
    "--cursor-args=--strict,--trust,--print",
  ]);
  expect(cursorArgsEscaped.options.cursorArgs).toBe("--strict,--trust,--print");
  expect(cursorArgsEscaped.explicitKeys.has("cursorArgs")).toBe(true);

  const claudeArgsEscaped = parseCodeReviewArgv([
    "--claude-args=--dangerously-skip-permissions",
  ]);
  expect(claudeArgsEscaped.options.claudeArgs).toBe(
    "--dangerously-skip-permissions",
  );
});

test("parseCodeReviewArgv does not swallow equals-form bundled opts as spaced string-option values", () => {
  const spaced = parseCodeReviewArgv(["--cursor-args", "--adapter=opencode"]);
  expect(spaced.options.cursorArgs).toBeUndefined();
  expect(spaced.options.adapter).toBe("opencode");
});

test("resolveEffectivePostOnly ignores merged postOnly for replay subcommand", () => {
  expect(resolveEffectivePostOnly("replay", true)).toBe(false);
  expect(resolveEffectivePostOnly("replay", false)).toBe(false);
  expect(resolveEffectivePostOnly("run", true)).toBe(true);
  expect(resolveEffectivePostOnly("run", false)).toBe(false);
  expect(resolveEffectivePostOnly("post", false)).toBe(true);
  expect(resolveEffectivePostOnly("post", true)).toBe(true);
  expect(resolveEffectivePostOnly("inbox", true)).toBe(false);
  expect(resolveEffectivePostOnly("inbox", false)).toBe(false);
});

test("parsePrNumber rejects non-canonical Pull Request number strings", () => {
  expect(parsePrNumber("123")).toBe(123);
  expect(parsePrNumber(" 456 ")).toBe(456);
  expect(parsePrNumber(undefined)).toBe(undefined);
  expect(parsePrNumber("")).toBe(undefined);
  expect(parsePrNumber("   ")).toBe(undefined);
  expect(parsePrNumber("123abc")).toBe(undefined);
  expect(parsePrNumber("12 3")).toBe(undefined);
  expect(parsePrNumber("0")).toBe(undefined);
  expect(parsePrNumber("012")).toBe(undefined);
});

test("resolveCodeReviewHelp skips normal runs lacking help tokens", () => {
  expect(resolveCodeReviewHelp(["code-review"])).toBeNull();
  expect(
    resolveCodeReviewHelp(["code-review", "--adapter", "fake"]),
  ).toBeNull();
});

test("resolveCodeReviewHelp maps contextual help scopes", () => {
  expect(resolveCodeReviewHelp([])).toEqual({ kind: "overview" });
  expect(resolveCodeReviewHelp(["--help"])).toEqual({ kind: "overview" });
  expect(resolveCodeReviewHelp(["-h"])).toEqual({ kind: "overview" });
  expect(resolveCodeReviewHelp(["--help", "code-review"])).toEqual({
    kind: "run_replay",
  });
  expect(resolveCodeReviewHelp(["code-review", "--help"])).toEqual({
    kind: "run_replay",
  });
  expect(resolveCodeReviewHelp(["code-review", "-h"])).toEqual({
    kind: "run_replay",
  });
  expect(
    resolveCodeReviewHelp(["code-review", "--adapter", "fake", "-h"]),
  ).toEqual({
    kind: "run_replay",
  });
  expect(resolveCodeReviewHelp(["code-review", "post", "--help"])).toEqual({
    kind: "post",
  });
  expect(resolveCodeReviewHelp(["code-review", "--help", "post"])).toEqual({
    kind: "post",
  });
  expect(resolveCodeReviewHelp(["code-review", "replay", "--help"])).toEqual({
    kind: "replay",
  });
  expect(resolveCodeReviewHelp(["code-review", "inbox", "--help"])).toEqual({
    kind: "inbox",
  });
  expect(resolveCodeReviewHelp(["unknown", "--help"])).toEqual({
    kind: "overview",
    unknownFirstToken: "unknown",
  });
  expect(resolveCodeReviewHelp(["code-review", "waffles", "--help"])).toEqual({
    kind: "overview",
    codeReviewBadSubcommand: "waffles",
  });
  expect(resolveCodeReviewHelp(["run", "code-review", "--help"])).toEqual({
    kind: "run_replay",
    legacyRunSpelling: true,
  });
});

test("codeReviewHelpStderrExtras surfaces unknown command hints", () => {
  const top = resolveCodeReviewHelp(["nope", "-h"]);
  if (top === null) {
    throw new Error("expected code review help context");
  }
  expect(codeReviewHelpStderrExtras(top)).toHaveLength(2);

  const badCr = resolveCodeReviewHelp(["code-review", "nope-sub", "--help"]);
  if (badCr === null) {
    throw new Error("expected code-review subcommand help context");
  }
  expect(badCr).toMatchObject({
    kind: "overview",
    codeReviewBadSubcommand: "nope-sub",
  });
  expect(codeReviewHelpStderrExtras(badCr)).toHaveLength(2);
});

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

  expect(actionableFindings([verified, unverified, weaklyValidated])).toEqual([
    verified,
  ]);
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
  expect(
    parsePullRequestRepoScope("https://github.com/aguil/agents/pull/42"),
  ).toEqual({
    host: "github.com",
    owner: "aguil",
    repo: "agents",
  });
  expect(
    parsePullRequestRepoScope("https://github.com/aguil/agents/issues/42"),
  ).toBeUndefined();
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
  expect(parseRemoteHeadBranch("refs/remotes/origin/release/2026.05\n")).toBe(
    "release/2026.05",
  );
  expect(parseRemoteHeadBranch(undefined)).toBeUndefined();
});

test("resolves preferred base branch from remote HEAD first", async () => {
  const commands: string[] = [];
  const commandRunner = async (
    cmd: readonly string[],
  ): Promise<string | undefined> => {
    commands.push(cmd.join(" "));
    if (cmd[0] === "git" && cmd[1] === "symbolic-ref") {
      return "refs/remotes/origin/main\n";
    }
    return undefined;
  };

  expect(
    await resolvePreferredBaseBranch("/repo", commandRunner, "origin"),
  ).toBe("main");
  expect(commands.at(0)).toContain("refs/remotes/origin/HEAD");
});

test("discovers pull request by explicit number", async () => {
  const commands: string[] = [];
  const commandRunner = async (
    cmd: readonly string[],
  ): Promise<string | undefined> => {
    commands.push(cmd.join(" "));
    if (cmd[0] === "git" && cmd[1] === "rev-parse" && cmd[2] === "HEAD") {
      return "beefbeefbeefbeefbeefbeefbeefbeefbeefbeef\n";
    }
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
  expect(commands.some((c) => c.startsWith("gh pr view"))).toBe(true);
});

test("discovers pull request coalesces concurrent gh pr view calls per workspace and number", async () => {
  let invocationCount = 0;
  const commandRunner = async (
    cmd: readonly string[],
  ): Promise<string | undefined> => {
    if (cmd[0] === "git" && cmd[1] === "rev-parse" && cmd[2] === "HEAD") {
      return "coalesce-workspace-head-pin\n";
    }
    if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "view") {
      invocationCount += 1;
    }
    return JSON.stringify({
      number: 7,
      title: "T",
      body: "B",
      url: "https://github.com/aguil/agents/pull/7",
      baseRefName: "main",
      headRefOid: "aaa",
    });
  };

  await Promise.all([
    discoverPullRequest("/agents/pr-scope-a", commandRunner, 7),
    discoverPullRequest("/agents/pr-scope-b", commandRunner, 7),
  ]);
  expect(invocationCount).toBe(2);

  invocationCount = 0;
  await Promise.all([
    discoverPullRequest("/agents/pr-coalesce-pin", commandRunner, 7),
    discoverPullRequest("/agents/pr-coalesce-pin", commandRunner, 7),
    discoverPullRequest("/agents/pr-coalesce-pin", commandRunner, 7),
  ]);
  expect(invocationCount).toBe(1);

  invocationCount = 0;
  await discoverPullRequest("/agents/pr-coalesce-pin", commandRunner, 7);
  expect(invocationCount).toBe(0);
});

test("discoverPullRequest refetches GH metadata when workspace HEAD changes", async () => {
  const path = "/agents/pr-cache-head-shift";
  let head = "1111111111111111111111111111111111111111";
  let ghCalls = 0;
  const commandRunner = async (
    cmd: readonly string[],
  ): Promise<string | undefined> => {
    if (cmd[0] === "git" && cmd[1] === "rev-parse" && cmd[2] === "HEAD") {
      return `${head}\n`;
    }
    if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "view") {
      ghCalls += 1;
      const title = ghCalls === 1 ? "First" : "Second";
      return JSON.stringify({
        number: 9,
        title,
        body: "Body",
        url: "https://github.com/aguil/agents/pull/9",
        baseRefName: "main",
      });
    }
    return undefined;
  };

  expect((await discoverPullRequest(path, commandRunner, 9))?.title).toBe(
    "First",
  );
  expect(ghCalls).toBe(1);
  expect((await discoverPullRequest(path, commandRunner, 9))?.title).toBe(
    "First",
  );
  expect(ghCalls).toBe(1);

  head = "2222222222222222222222222222222222222222";
  expect((await discoverPullRequest(path, commandRunner, 9))?.title).toBe(
    "Second",
  );
  expect(ghCalls).toBe(2);
});

test("discoverPullRequest refetches implicit branch PR when symbolic HEAD ref changes", async () => {
  const path = "/agents/pr-implicit-branch-pin";
  const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  let symbolicHead = "refs/heads/feature-a";
  let ghCalls = 0;
  const commandRunner = async (
    cmd: readonly string[],
  ): Promise<string | undefined> => {
    if (cmd[0] === "git" && cmd[1] === "rev-parse" && cmd[2] === "HEAD") {
      return `${head}\n`;
    }
    if (
      cmd[0] === "git" &&
      cmd[1] === "symbolic-ref" &&
      cmd[2] === "-q" &&
      cmd[3] === "HEAD"
    ) {
      return `${symbolicHead}\n`;
    }
    if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "view") {
      ghCalls += 1;
      const n = ghCalls;
      return JSON.stringify({
        number: n,
        title: `PR ${n}`,
        body: "Body",
        url: `https://github.com/aguil/agents/pull/${n}`,
        baseRefName: "main",
      });
    }
    return undefined;
  };

  expect((await discoverPullRequest(path, commandRunner))?.number).toBe(1);
  expect(ghCalls).toBe(1);
  expect((await discoverPullRequest(path, commandRunner))?.number).toBe(1);
  expect(ghCalls).toBe(1);

  symbolicHead = "refs/heads/feature-b";
  expect((await discoverPullRequest(path, commandRunner))?.number).toBe(2);
  expect(ghCalls).toBe(2);
});

test("discoverPullRequest does not indefinitely memoize GH PR metadata misses", async () => {
  const isolationPath = `/agents/pr-transient-${Math.random().toString(36).slice(2)}`;
  let invocationCount = 0;
  const transientRunner = async (
    cmd: readonly string[],
  ): Promise<string | undefined> => {
    if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "view") {
      invocationCount += 1;
      const n = invocationCount;
      const payload =
        n === 1
          ? undefined
          : JSON.stringify({
              number: 8,
              title: "Merged PR",
              body: "Body",
              url: "https://github.com/aguil/agents/pull/8",
              baseRefName: "main",
            });
      return payload;
    }
    return undefined;
  };
  expect(invocationCount).toBe(0);
  expect(
    await discoverPullRequest(isolationPath, transientRunner, 8),
  ).toBeUndefined();
  expect(invocationCount).toBe(1);
  expect(
    (await discoverPullRequest(isolationPath, transientRunner, 8))?.number,
  ).toBe(8);
  expect(invocationCount).toBe(2);
});

test("prefers explicit PR patch diff when review PR is provided", async () => {
  const commands: string[] = [];
  const commandRunner = async (
    cmd: readonly string[],
  ): Promise<string | undefined> => {
    commands.push(cmd.join(" "));
    if (cmd[0] === "git" && cmd[1] === "rev-parse" && cmd[2] === "HEAD") {
      return "explicit-pr-patch-workspace-head\n";
    }
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
      return `diff --git a/${AGENTS_CODE_REVIEW_DIR}/runs/foo/result.json b/${AGENTS_CODE_REVIEW_DIR}/runs/foo/result.json
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
  expect(result.diff).not.toContain(
    `${AGENTS_CODE_REVIEW_DIR}/runs/foo/result.json`,
  );
  expect(commands).toContain(
    "gh api --hostname github.com repos/aguil/agents/pulls/42 --jq .head.sha",
  );
  expect(commands).toContain(
    "gh api --hostname github.com -H Accept: application/vnd.github.v3.diff repos/aguil/agents/pulls/42",
  );
  expect(commands.some((command) => command.startsWith("gh gh "))).toBe(false);
});

test("collectReviewDiff attaches reviewPr when PR is discovered implicitly", async () => {
  const isolationPath = `/agents/collect-implicit-review-pr-${Math.random().toString(36).slice(2)}`;
  const commandRunner = async (
    cmd: readonly string[],
  ): Promise<string | undefined> => {
    if (cmd[0] === "git" && cmd[1] === "rev-parse" && cmd[2] === "HEAD") {
      return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";
    }
    if (
      cmd[0] === "git" &&
      cmd[1] === "symbolic-ref" &&
      cmd[2] === "-q" &&
      cmd[3] === "HEAD"
    ) {
      return "refs/heads/feat/cli-code-review-inbox\n";
    }
    if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "view") {
      expect(cmd.includes("--json")).toBe(true);
      expect(cmd.some((t) => /^\d+$/.test(t))).toBe(false);
      return JSON.stringify({
        number: 27,
        title: "PR",
        body: "b",
        url: "https://github.com/aguil/agents/pull/27",
        baseRefName: "main",
        headRefOid: "deadbeef11111111111111111111111111111111",
      });
    }
    if (
      cmd[0] === "git" &&
      cmd[1] === "rev-parse" &&
      cmd[2] === "--abbrev-ref" &&
      cmd[3] === "--symbolic-full-name" &&
      cmd[4] === "@{u}"
    ) {
      return undefined;
    }
    if (cmd[0] === "git" && cmd[1] === "remote" && cmd.length === 2) {
      return "origin\n";
    }
    if (cmd[0] === "git" && cmd[1] === "remote" && cmd[2] === "get-url") {
      return "git@github.com:aguil/agents.git\n";
    }
    if (
      cmd[0] === "git" &&
      cmd[1] === "diff" &&
      cmd[2] === "--no-ext-diff" &&
      cmd[3] === "main...HEAD"
    ) {
      return "diff --git a/a.ts b/a.ts\n+ok\n";
    }
    if (cmd[0] === "jj") {
      return undefined;
    }
    throw new Error(`unexpected command: ${cmd.join(" ")}`);
  };

  const result = await collectReviewDiff(isolationPath, commandRunner);
  expect(result.strategy).toBe("pr_base_git");
  expect(result.baseRef).toBe("main");
  expect(result.reviewPr?.number).toBe(27);
  expect(result.reviewPr?.headSha).toBe(
    "deadbeef11111111111111111111111111111111",
  );
  expect(result.reviewPr?.reviewedAt).toBeTruthy();
});

test("falls back to base diff when explicit PR patch is unavailable", async () => {
  const commands: string[] = [];
  const commandRunner = async (
    cmd: readonly string[],
  ): Promise<string | undefined> => {
    commands.push(cmd.join(" "));
    if (cmd[0] === "git" && cmd[1] === "rev-parse" && cmd[2] === "HEAD") {
      return "fallback-pr-patch-head\n";
    }
    if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "view") {
      return JSON.stringify({
        number: 42,
        title: "Merged PR",
        body: "Body",
        url: "https://github.com/aguil/agents/pull/42",
        baseRefName: "main",
        headRefOid: "deadbeefcafebabe",
      });
    }
    if (cmd[0] === "git" && cmd[1] === "cat-file") {
      return "";
    }
    if (
      cmd[0] === "git" &&
      cmd[1] === "diff" &&
      cmd[3] === "main...deadbeefcafebabe"
    ) {
      return "diff --git a/src/a.ts b/src/a.ts\n+new";
    }
    if (cmd[0] === "gh" && cmd[1] === "api") {
      return undefined;
    }
    return undefined;
  };

  const result = await collectReviewDiff("/repo", commandRunner, 42);
  expect(result.strategy).toBe("pr_base_git_head");
  expect(result.baseRef).toBe("main");
  expect(commands).toContain(
    "gh api --hostname github.com -H Accept: application/vnd.github.v3.diff repos/aguil/agents/pulls/42",
  );
});

test("includes explicit PR metadata in diff strategy artifact", async () => {
  const provider = new RepositoryDiffProvider(async (cmd) => {
    if (cmd[0] === "git" && cmd[1] === "rev-parse" && cmd[2] === "HEAD") {
      return "strategy-artifact-head\n";
    }
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
    scratchpadPath: `/repo/${AGENTS_CODE_REVIEW_DIR}/runs/1`,
    pullRequestNumber: 42,
  });
  const strategy =
    artifacts.find((artifact) => artifact.id === "diff-strategy")?.content ??
    "";
  expect(strategy).toContain("Strategy: explicit_pr_patch");
  expect(strategy).toContain("PR Number: 42");
  expect(strategy).toContain("PR Head SHA: 0123456789abcdef");
  expect(strategy).toContain("Reviewed At:");
});

test("filters harness artifacts out of review diff", () => {
  const diff = `diff --git a/${AGENTS_CODE_REVIEW_DIR}/runs/foo/result.json b/${AGENTS_CODE_REVIEW_DIR}/runs/foo/result.json
index a..b 100644
--- a/${AGENTS_CODE_REVIEW_DIR}/runs/foo/result.json
+++ b/${AGENTS_CODE_REVIEW_DIR}/runs/foo/result.json
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
  expect(filtered).not.toContain(
    `${AGENTS_CODE_REVIEW_DIR}/runs/foo/result.json`,
  );
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
    {
      kind: "url",
      value: "https://github.com/aguil/another-repo/blob/main/docs/guide.md",
    },
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
    shouldFetchReferencedUrl(
      "https://github.com/aguil/other-repo/blob/main/README.md",
      remoteScope,
    ).allowed,
  ).toBe(true);
  expect(
    shouldFetchReferencedUrl(
      "https://github.com/other-org/repo/blob/main/README.md",
      remoteScope,
    ).allowed,
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

    expect(
      artifacts.some((artifact) =>
        artifact.title.startsWith("PR Referenced Local Doc:"),
      ),
    ).toBe(false);
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
    description:
      "Event sink runs ensureDirectory on every write and orchestration awaits each call.",
    evidence:
      "JsonlFileEventSink.write calls ensureDirectory(dirname(path)) before appendFile.",
    sourceRole: "performance",
    file: "packages/telemetry/src/index.ts",
    line: 18,
    validation: { status: "verified", details: "Code-path review." },
  };
  const rephrased: Finding = {
    ...base,
    id: "finding-2",
    title: "Per-event ensureDirectory adds avoidable filesystem overhead",
    description:
      "Each telemetry event performs a directory check and the orchestrator waits on it.",
    evidence:
      "The event sink performs ensureDirectory before appending JSONL for each event.",
  };

  expect(findingFingerprint(base).split("|")[0]).toBe("performance");
  expect(dedupeFindings([base, rephrased])).toHaveLength(2);
});

test("does not merge distinct findings that share one location", () => {
  const left: Finding = {
    id: "finding-1",
    severity: "warning",
    title: "Missing authorization check on write path",
    description:
      "Mutation endpoint updates state without verifying caller permissions.",
    evidence:
      "writeConfig() is called before any authorize() guard in the handler.",
    sourceRole: "security",
    file: "src/handler.ts",
    line: 42,
    validation: {
      status: "verified",
      details: "Inspected call path around handler implementation.",
    },
  };
  const right: Finding = {
    ...left,
    id: "finding-2",
    title: "Expensive JSON parse in hot request path",
    description:
      "Handler reparses unchanged payload and doubles CPU work for each request.",
    evidence:
      "JSON.parse runs twice in the same handler branch without transformation.",
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

test("rejects echoed prompt templates only when the finding id contains a token", () => {
  const base = {
    severity: "warning" as const,
    title: "T",
    description: "D",
    evidence: "E",
    sourceRole: "quality",
    validation: { status: "verified" as const, details: "ok" },
  };

  const templateEcho = validateFinding({
    ...base,
    id: "${request.roleId}-duplicate-calls",
  });
  expect(templateEcho.valid).toBe(false);
  expect(templateEcho.errors).toContain(
    "id looks like an echoed prompt template",
  );

  const quotedCode = validateFinding({
    ...base,
    id: "quality-template-literal",
    description: "The code interpolates ${request.roleId} in this path.",
  });
  expect(quotedCode.valid).toBe(true);
});

test("coerces empty and null file or line before validating findings", () => {
  const base = {
    id: "finding-1",
    severity: "warning" as const,
    title: "T",
    description: "D",
    evidence: "E",
    sourceRole: "compliance",
    validation: { status: "verified" as const, details: "ok" },
  };

  const emptyFile = validateFinding({ ...base, file: "" });
  expect(emptyFile.valid).toBe(true);

  const nullFile = validateFinding({
    ...base,
    file: null as unknown as string,
  });
  expect(nullFile.valid).toBe(true);

  const nullLine = validateFinding({
    ...base,
    file: "a.ts",
    line: null as unknown as number,
  });
  expect(nullLine.valid).toBe(true);
  expect(nullLine.errors).toHaveLength(0);

  const stringLine = validateFinding({
    ...base,
    file: "a.ts",
    line: "42" as unknown as number,
  });
  expect(stringLine.valid).toBe(true);
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

test("strips empty file string from JSON finding envelope", () => {
  const events = normalizeAgentOutputLine(
    {
      runId: "run-1",
      roleId: "compliance",
      prompt: "Review.",
      workspacePath: "/tmp/workspace",
      contextBundlePath: "/tmp/context.json",
      scratchpadPath: "/tmp/scratchpad",
      timeoutMs: 1_000,
      allowedCommands: [],
    },
    JSON.stringify({
      finding: {
        id: "finding-1",
        severity: "warning",
        title: "Issue",
        description: "D",
        evidence: "E",
        sourceRole: "compliance",
        file: "",
        validation: { status: "verified", details: "ok" },
      },
    }),
  );

  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe("finding");
  const data = events[0]?.data as Finding;
  expect(data.file).toBeUndefined();
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
    const runsRoot = join(workspace, AGENTS_CODE_REVIEW_DIR, "runs");
    await mkdir(join(runsRoot, "code-review-20260501120000-aaaa"), {
      recursive: true,
    });
    await mkdir(join(runsRoot, "code-review-20260502120000-bbbb"), {
      recursive: true,
    });
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
    expect(discovered).toBe(
      join(runsRoot, "code-review-20260502120000-bbbb", "result.json"),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("discoverLatestResultPath ignores dry-run when selecting post artifact", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agents-post-disc-over-"));
  try {
    const runsRoot = join(workspace, AGENTS_CODE_REVIEW_DIR, "runs");
    const dryRoot = join(workspace, AGENTS_CODE_REVIEW_DIR, "dry-run");
    await mkdir(join(runsRoot, "code-review-20260501120000-aaaa"), {
      recursive: true,
    });
    await mkdir(join(dryRoot, "code-review-20260503120000-zzzz"), {
      recursive: true,
    });
    await writeFile(
      join(runsRoot, "code-review-20260501120000-aaaa", "result.json"),
      "{}\n",
      "utf8",
    );
    await writeFile(
      join(dryRoot, "code-review-20260503120000-zzzz", "result.json"),
      "{}\n",
      "utf8",
    );

    const discovered = await discoverLatestResultPath(workspace);
    expect(discovered).toBe(
      join(runsRoot, "code-review-20260501120000-aaaa", "result.json"),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("firstAnchorableDiffReviewPosition returns undefined for empty context", () => {
  expect(firstAnchorableDiffReviewPosition(new Map())).toBeUndefined();
});

test("firstAnchorableDiffReviewPosition skips empty file maps", () => {
  const ctx = new Map<string, ReadonlyMap<number, number>>([
    ["empty.ts", new Map()],
    ["x.ts", new Map([[1, 10]])],
  ]);
  expect(firstAnchorableDiffReviewPosition(ctx)).toEqual({
    path: "x.ts",
    position: 10,
  });
});

test("firstAnchorableDiffReviewPosition uses first non-empty file in map order and minimum position", () => {
  const ctx = new Map<string, ReadonlyMap<number, number>>([
    [
      "b.ts",
      new Map([
        [2, 100],
        [3, 2],
      ]),
    ],
    ["a.ts", new Map([[1, 1]])],
  ]);
  expect(firstAnchorableDiffReviewPosition(ctx)).toEqual({
    path: "b.ts",
    position: 2,
  });
});

test("firstNonCollidingAnchorableDiffReviewPosition skips positions already used", () => {
  const ctx = new Map<string, ReadonlyMap<number, number>>([
    [
      "b.ts",
      new Map([
        [2, 2],
        [3, 5],
      ]),
    ],
    ["a.ts", new Map([[1, 1]])],
  ]);
  expect(
    firstNonCollidingAnchorableDiffReviewPosition(
      ctx,
      new Set([`b.ts\u0000${2}`]),
    ),
  ).toEqual({ path: "b.ts", position: 5 });
});

test("firstNonCollidingAnchorableDiffReviewPosition advances to next file when first file is exhausted", () => {
  const ctx = new Map<string, ReadonlyMap<number, number>>([
    ["b.ts", new Map([[2, 2]])],
    ["a.ts", new Map([[1, 1]])],
  ]);
  expect(
    firstNonCollidingAnchorableDiffReviewPosition(
      ctx,
      new Set([`b.ts\u0000${2}`]),
    ),
  ).toEqual({ path: "a.ts", position: 1 });
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
  expect(body).toContain("🔴 0 critical, ⚠️ 1 warning");
  expect(body).toContain("- ⚠️ Anchored issue (src/app.ts:12)");
  expect(body).toContain("- ✅ No follow-up findings.");
});

test("impact summary review coverage notes lite triage omissions", () => {
  const body = buildPendingReviewSummaryBody({
    style: "impact",
    findings: [],
    postedCommentCount: 0,
    skippedUnanchorable: 0,
    runMetadata: {
      triage: "lite",
      completed_roles: "security,quality,compliance",
    },
  });

  expect(body).toContain("### Review coverage");
  expect(body).toContain("Triage tier **lite**");
  expect(body).toContain("Runtime / Performance");
  expect(body).toContain("not scheduled");
});

test("resolveAdapterModelFromMetadata picks adapter-specific model field", () => {
  expect(
    resolveAdapterModelFromMetadata({
      adapter: "cursor",
      cursor_model: "sonnet-4",
      claude_model: "claude-sonnet-4",
    }),
  ).toBe("sonnet-4");
  expect(
    resolveAdapterModelFromMetadata({
      adapter: "opencode",
      opencode_model: "opencode/gpt-5.3-codex",
    }),
  ).toBe("opencode/gpt-5.3-codex");
});

test("review provenance section lists reviewer and agent in summary", () => {
  const lines = formatReviewProvenanceSectionLines({
    reviewerLogin: "jasona",
    runId: "code-review-20260501120000-aaaa",
    runMetadata: {
      adapter: "cursor",
      cursor_model: "sonnet-4",
    },
  });
  expect(lines.join("\n")).toContain("### Review provenance");
  expect(lines.join("\n")).toContain("Reviewer: @jasona");
  expect(lines.join("\n")).toContain("Agent: cursor (sonnet-4)");
  expect(lines.join("\n")).toContain("code-review-20260501120000-aaaa");

  const body = buildPendingReviewSummaryBody({
    style: "impact",
    findings: [],
    postedCommentCount: 0,
    skippedUnanchorable: 0,
    runMetadata: {
      adapter: "cursor",
      cursor_model: "sonnet-4",
    },
    provenance: {
      reviewerLogin: "jasona",
      runId: "code-review-20260501120000-aaaa",
      runMetadata: {
        adapter: "cursor",
        cursor_model: "sonnet-4",
      },
    },
  });
  expect(body).toContain("### Review provenance");
  expect(body).toContain("Reviewer: @jasona");
  expect(body).toContain("Agent: cursor (sonnet-4)");
});

test("inline pending review comments include agent and role provenance footer", () => {
  const finding: Finding = {
    id: "f-prov",
    severity: "warning",
    title: "Anchored issue",
    description: "d",
    evidence: "e",
    sourceRole: "security",
    file: "src/app.ts",
    line: 12,
    validation: { status: "verified", details: "ok" },
  };
  const comments = findingsToPendingReviewComments([finding], {
    reviewerLogin: "jasona",
    runMetadata: { adapter: "claude", claude_model: "claude-sonnet-4" },
  });
  expect(comments[0]?.body).toContain("@jasona");
  expect(comments[0]?.body).toContain("Agent: claude (claude-sonnet-4)");
  expect(comments[0]?.body).toContain("Role: Security");
});

test("impact summary review coverage lists timed-out scheduled role", () => {
  const body = buildPendingReviewSummaryBody({
    style: "impact",
    findings: [],
    postedCommentCount: 0,
    skippedUnanchorable: 0,
    runMetadata: {
      triage: "full",
      completed_roles: "quality,compliance,performance",
      timed_out_roles: "security",
    },
  });

  expect(body).toContain("**Security:** not performed");
  expect(body).toContain("timed out");
});

test("impact summary buckets unknown or empty sourceRole without throwing", () => {
  const base = {
    id: "f-bad-role",
    severity: "warning" as const,
    title: "Role plumbing",
    description: "d",
    evidence: "e",
    validation: { status: "verified" as const, details: "ok" },
    file: "x.ts",
    line: 1,
  };
  const body = buildPendingReviewSummaryBody({
    style: "impact",
    findings: [
      { ...base, id: "f-empty", sourceRole: "" },
      { ...base, id: "f-weird", sourceRole: "  Performance  " },
    ],
    postedCommentCount: 0,
    skippedUnanchorable: 0,
  });

  expect(body).toContain("### Uncategorized findings");
  expect(body).toContain("Role plumbing");
});

test("detects file:line anchors outside the PR diff map", () => {
  const finding: Finding = {
    id: "f1",
    severity: "warning",
    title: "x",
    description: "d",
    evidence: "e",
    sourceRole: "quality",
    file: "a.ts",
    line: 5,
    validation: { status: "verified", details: "ok" },
  };
  const empty = new Map<string, ReadonlyMap<number, number>>();
  expect(findingHasNonPostablePrLineAnchor(finding, empty)).toBe(true);

  const wrongLine = new Map<string, ReadonlyMap<number, number>>([
    ["a.ts", new Map([[10, 1]])],
  ]);
  expect(findingHasNonPostablePrLineAnchor(finding, wrongLine)).toBe(true);

  const match = new Map<string, ReadonlyMap<number, number>>([
    ["a.ts", new Map([[5, 1]])],
  ]);
  expect(findingHasNonPostablePrLineAnchor(finding, match)).toBe(false);

  const noLine: Finding = { ...finding, line: undefined };
  expect(findingHasNonPostablePrLineAnchor(noLine, wrongLine)).toBe(false);
});

test("detects file path not in PR changed-files list", () => {
  const finding: Finding = {
    id: "f1",
    severity: "warning",
    title: "x",
    description: "d",
    evidence: "e",
    sourceRole: "quality",
    file: "other.ts",
    line: 1,
    validation: { status: "verified", details: "ok" },
  };
  const ctx = new Map<string, ReadonlyMap<number, number>>([
    ["src/app.ts", new Map([[1, 1]])],
  ]);
  expect(findingUsesFileNotInPrChangedFiles(finding, ctx)).toBe(true);
  expect(
    findingUsesFileNotInPrChangedFiles({ ...finding, file: "src/app.ts" }, ctx),
  ).toBe(false);
});

test("impact summary annotates findings that are not inline-postable when PR diff context is provided", () => {
  const onHunk: Finding = {
    id: "finding-hunk",
    severity: "warning",
    title: "On hunk",
    description: "Validated.",
    evidence: "Evidence.",
    sourceRole: "quality",
    file: "src/app.ts",
    line: 10,
    validation: { status: "verified", details: "Verified." },
  };
  const offHunk: Finding = {
    ...onHunk,
    id: "finding-off",
    title: "Off hunk",
    line: 99,
  };
  const wrongFile: Finding = {
    ...onHunk,
    id: "finding-other",
    title: "Other file",
    file: "src/other.ts",
    line: 10,
  };
  const prDiffContext = new Map<string, ReadonlyMap<number, number>>([
    ["src/app.ts", new Map([[10, 1]])],
  ]);

  const body = buildPendingReviewSummaryBody({
    style: "impact",
    findings: [onHunk, offHunk, wrongFile],
    postedCommentCount: 1,
    skippedUnanchorable: 2,
    prDiffContext,
  });

  expect(body).toContain("- ⚠️ On hunk (src/app.ts:10)");
  expect(body).not.toContain("On hunk (src/app.ts:10) —");
  expect(body).toContain("- Skipped outside PR diff: 2");
  expect(body).toContain("line is not on a PR diff hunk");
  expect(body).toContain("file is not in this PR's changed files");
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
  expect(body).toContain("- ⚠️ Perf issue (src/app.ts:12)");
  expect(body).toContain("- ✅ No security findings.");
  expect(body).toContain("- ✅ No quality findings.");
  expect(body).toContain("- ✅ No compliance findings.");
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
  expect(body).toContain("### Finding 1: ⚠️ Doc mismatch");
});

test("formats pending review comments with severity emojis", () => {
  const findings: Finding[] = [
    {
      id: "finding-critical",
      severity: "critical",
      title: "Critical issue",
      description: "A critical validated finding.",
      evidence: "Critical evidence.",
      sourceRole: "security",
      file: "src/security.ts",
      line: 7,
      validation: { status: "verified", details: "Reproduced locally." },
    },
    {
      id: "finding-warning",
      severity: "warning",
      title: "Warning issue",
      description: "A warning validated finding.",
      evidence: "Warning evidence.",
      sourceRole: "quality",
      file: "src/quality.ts",
      line: 9,
      validation: { status: "verified", details: "Reproduced locally." },
    },
  ];

  const comments = findingsToPendingReviewComments(findings);

  expect(comments[0]?.body).toContain("### 🔴 Critical issue");
  expect(comments[0]?.body).not.toContain("CRITICAL:");
  expect(comments[1]?.body).toContain("### ⚠️ Warning issue");
  expect(comments[1]?.body).not.toContain("WARNING:");
});

test("builds evidence review summary no-findings body with green check", () => {
  const body = buildPendingReviewSummaryBody({
    style: "evidence",
    findings: [],
    postedCommentCount: 0,
    skippedUnanchorable: 0,
  });

  expect(body).toContain("✅ No findings - code looks good!");
});

test("builds impact review summary no-findings body with green check", () => {
  const body = buildPendingReviewSummaryBody({
    style: "impact",
    findings: [],
    postedCommentCount: 0,
    skippedUnanchorable: 0,
  });

  expect(body).toContain("## Impact Summary");
  expect(body).toContain("✅ No findings - code looks good!");
  expect(body).not.toContain("### Security");
});

test("builds triage review summary no-findings body with green check", () => {
  const body = buildPendingReviewSummaryBody({
    style: "triage",
    findings: [],
    postedCommentCount: 0,
    skippedUnanchorable: 0,
  });

  expect(body).toContain("## At a Glance");
  expect(body).toContain("🔴 0 critical, ⚠️ 0 warning");
  expect(body).toContain("✅ No findings - code looks good!");
  expect(body).not.toContain("## Fix Now");
});

test("formats subsection empty states with green check emoji", () => {
  const securityFinding: Finding = {
    id: "finding-1",
    severity: "critical",
    title: "Security issue",
    description: "A security finding.",
    evidence: "Evidence here.",
    sourceRole: "security",
    file: "src/app.ts",
    line: 10,
    validation: { status: "verified", details: "Verified." },
  };

  const impactBody = buildPendingReviewSummaryBody({
    style: "impact",
    findings: [securityFinding],
    postedCommentCount: 1,
    skippedUnanchorable: 0,
  });

  expect(impactBody).toContain("- 🔴 Security issue (src/app.ts:10)");
  expect(impactBody).toContain("- ✅ No performance findings.");
  expect(impactBody).toContain("- ✅ No quality findings.");
  expect(impactBody).toContain("- ✅ No compliance findings.");

  const triageBody = buildPendingReviewSummaryBody({
    style: "triage",
    findings: [securityFinding],
    postedCommentCount: 1,
    skippedUnanchorable: 0,
  });

  expect(triageBody).toContain("- 🔴 Security issue (src/app.ts:10)");
  expect(triageBody).toContain("- ✅ No follow-up findings.");
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

test("uses unknown severity fallback emoji", () => {
  expect(severityEmoji("critical")).toBe("🔴");
  expect(severityEmoji("warning")).toBe("⚠️");
  expect(severityEmoji("info" as Finding["severity"])).toBe("❓");
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
      argsTemplate: [
        "-p",
        "{prompt}",
        "--cwd",
        "{workspace}",
        "--context",
        "{context_bundle}",
      ],
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

test("builds cursor command behind the adapter boundary", () => {
  const command = buildCursorCommand(
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
      executable: "agent-test",
      model: "cursor-model",
      mode: "agent",
      force: true,
      sandbox: "enabled",
    },
  );

  expect(command[0]).toBe("agent-test");
  expect(command).toContain("--print");
  expect(command).toContain("--output-format");
  expect(command).toContain("stream-json");
  expect(command).toContain("--workspace");
  expect(command).toContain("/repo");
  expect(command).toContain("--trust");
  expect(command).toContain("--force");
  expect(command).toContain("--model");
  expect(command).toContain("cursor-model");
  expect(command).toContain("--sandbox");
  expect(command).toContain("enabled");
  expect(command.at(-1)).toContain("quality specialist");
});

test("adds cursor --mode only for non-default modes", () => {
  const command = buildCursorCommand(
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
      executable: "agent-test",
      mode: "plan",
    },
  );

  expect(command).toContain("--mode");
  expect(command).toContain("plan");
});

test("builds cursor command from a custom args template", () => {
  const command = buildCursorCommand(
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
      executable: "agent-test",
      argsTemplate: ["--print", "--workspace", "{workspace}", "--mode", "ask"],
    },
  );

  expect(command).toEqual([
    "agent-test",
    "--print",
    "--workspace",
    "/repo",
    "--mode",
    "ask",
    expect.stringContaining("quality specialist"),
  ]);
});

test("reuses claude-style prompt guidance for cursor", () => {
  const prompt = buildCursorPrompt(
    {
      runId: "run-1",
      roleId: "quality",
      prompt: "Review this change.",
      workspacePath: "/repo",
      contextBundlePath: "/scratch/context.json",
      scratchpadPath: "/scratch/roles/quality",
      timeoutMs: 1_000,
      allowedCommands: ["jj diff"],
      metadata: { vcs_mode: "jj" },
    },
    "/scratch/roles/quality/quality.request.json",
  );

  expect(prompt).toContain("workspace uses jujutsu");
  expect(prompt).toContain("Emit each finding as a single JSON line");
});

test("CLI review coverage matches harness scheduled roles for each triage tier", () => {
  const tiers = ["trivial", "lite", "full"] as const;
  for (const tier of tiers) {
    expect(definitionForTriage(tier).roles.map((role) => role.id)).toEqual([
      ...expectedRolesForTriageTier(tier),
    ]);
    const scheduled = new Set(expectedRolesForTriageTier(tier));
    const lines = formatReviewCoverageSectionLines({
      triage: tier,
      completed_roles: [...scheduled].join(","),
    });
    for (const roleId of CODE_REVIEW_ROLE_IDS) {
      const label = roleReviewSectionLabel(roleId);
      const skipLine = lines.find(
        (line) =>
          line.includes(`**${label}:**`) && line.includes("not scheduled"),
      );
      if (scheduled.has(roleId)) {
        expect(skipLine).toBeUndefined();
      } else {
        expect(skipLine).toBeDefined();
      }
    }
  }
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
    const run = await collectAgentRun(
      createFakeCodeReviewAdapter({ quality: [finding] }),
      {
        runId: "run-1",
        roleId: "quality",
        prompt: "Review this change.",
        workspacePath: tempDir,
        contextBundlePath: join(tempDir, "context.json"),
        scratchpadPath: tempDir,
        timeoutMs: 1_000,
        allowedCommands: [],
      },
    );

    expect(run.result.findings).toEqual([finding]);
    expect(run.events.map((event) => event.type)).toEqual([
      "started",
      "finding",
      "completed",
    ]);
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
        cmd: [
          process.execPath,
          "--eval",
          "await new Promise((resolve) => setTimeout(resolve, 500));",
        ],
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

test("cancels subprocess agents when AbortSignal aborts", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "agents-abort-"));
  try {
    const controller = new AbortController();
    const adapter = new SubprocessAgentAdapter({
      name: "stall-test-agent",
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
          "await new Promise((resolve) => setTimeout(resolve, 30_000));",
        ],
        cwd: tempDir,
      }),
    });

    const runPromise = collectAgentRun(adapter, {
      runId: "run-abort-1",
      roleId: "implementation",
      prompt: "Implement the task.",
      workspacePath: tempDir,
      contextBundlePath: join(tempDir, "context.json"),
      scratchpadPath: tempDir,
      timeoutMs: 60_000,
      allowedCommands: [],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const run = await runPromise;

    expect(run.result.status).toBe("cancelled");
    expect(
      run.events.some(
        (event) =>
          event.type === "error" &&
          typeof event.data === "object" &&
          event.data !== null &&
          (event.data as { reason?: string }).reason === "aborted",
      ),
    ).toBe(true);
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

    expect(
      run.events.some(
        (event) => event.type === "stdout" && event.message === "stream-stdout",
      ),
    ).toBe(true);
    expect(
      run.events.some(
        (event) => event.type === "stderr" && event.message === "stream-stderr",
      ),
    ).toBe(true);
    expect(await readFile(join(tempDir, "stdout.log"), "utf8")).toContain(
      "stream-stdout",
    );
    expect(await readFile(join(tempDir, "stderr.log"), "utf8")).toContain(
      "stream-stderr",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("emits command events before and after subprocess execution", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "agents-command-events-"));
  try {
    const adapter = new SubprocessAgentAdapter({
      name: "command-event-agent",
      capabilities: {
        streaming: true,
        structuredOutput: true,
        readOnlyMode: true,
        mcp: false,
        cancellation: true,
      },
      buildCommand: () => ({
        cmd: [process.execPath, "--eval", "console.log('ok')"],
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

    const beforeEvent = run.events.find(
      (event) =>
        event.type === "tool" &&
        typeof event.data === "object" &&
        event.data !== null &&
        (event.data as { readonly kind?: string }).kind === "command" &&
        (event.data as { readonly phase?: string }).phase === "before",
    );
    const completionEvent = run.events.find(
      (event) =>
        event.type === "completed" &&
        typeof event.data === "object" &&
        event.data !== null &&
        Array.isArray((event.data as { readonly command?: unknown }).command),
    );

    expect(beforeEvent).toBeDefined();
    expect(completionEvent).toBeDefined();
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
    expect(await readFile(result.reportPath, "utf8")).toContain(
      "Verified harness issue",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("forwards adapter events through runCodeReview onEvent callback", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "agents-code-review-on-event-"));
  try {
    const eventTypes: string[] = [];
    const result = await runCodeReview({
      workspacePath: tempDir,
      scratchpadRoot: join(tempDir, "scratchpad"),
      runId: "test-on-event-run",
      adapter: createFakeCodeReviewAdapter(),
      onEvent(event) {
        eventTypes.push(event.type);
      },
    });

    expect(result.status).toBe("passed");
    expect(eventTypes).toContain("started");
    expect(eventTypes).toContain("completed");
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
    expect(await readFile(result.reportPath, "utf8")).toContain(
      "Execution Notes",
    );
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
          {
            id: "workspace-diff",
            title: "Workspace Diff",
            content: "diff --git a/a b/a",
          },
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
  const tempDir = await mkdtemp(
    join(tmpdir(), "agents-code-review-consensus-"),
  );
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
      validation: {
        status: "verified",
        details: "Verified by code-path inspection.",
      },
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
            title: request.runId.endsWith("pass1")
              ? "Only pass 1"
              : "Only pass 2",
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
  const tempDir = await mkdtemp(
    join(tmpdir(), "agents-code-review-consensus-none-"),
  );
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
            title: request.runId.endsWith("pass1")
              ? "Only pass 1"
              : "Only pass 2",
            description: "Pass-specific finding",
            evidence: "Only appears in one pass",
            sourceRole: "quality",
            file: "src/app.ts",
            line: request.runId.endsWith("pass1") ? 10 : 11,
            validation: {
              status: "verified",
              details: "Verified by code inspection path trace.",
            },
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
  const tempDir = await mkdtemp(
    join(tmpdir(), "agents-code-review-timeout-strict-"),
  );
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

test("resolveGitAwarePath keeps colocated repo paths", async () => {
  const tempDir = await mkdtemp(
    join(tmpdir(), "agents-core-git-aware-colocated-"),
  );
  try {
    await mkdir(join(tempDir, ".git"), { recursive: true });
    const result = await resolveGitAwarePath(tempDir);
    expect(result.gitAwarePath).toBe(tempDir);
    expect(result.isJjWorkspace).toBe(false);
    expect(result.resolvedFromPointer).toBe(false);
    expect(result.warning).toBeUndefined();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveGitAwarePath treats git worktree .git files as git-aware", async () => {
  const tempDir = await mkdtemp(
    join(tmpdir(), "agents-core-git-aware-worktree-"),
  );
  try {
    await writeFile(
      join(tempDir, ".git"),
      "gitdir: /tmp/worktree/.git\n",
      "utf8",
    );
    const result = await resolveGitAwarePath(tempDir);
    expect(result.gitAwarePath).toBe(tempDir);
    expect(result.isJjWorkspace).toBe(false);
    expect(result.resolvedFromPointer).toBe(false);
    expect(result.warning).toBeUndefined();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveGitAwarePath resolves canonical repo from jj pointer", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "agents-core-git-aware-jj-"));
  try {
    const canonicalRepo = join(tempDir, "repos", "github.com", "acme", "demo");
    const workspace = join(tempDir, "projects", "feat", "task", "demo");
    await mkdir(join(canonicalRepo, ".jj"), { recursive: true });
    await mkdir(join(canonicalRepo, ".git"), { recursive: true });
    await mkdir(join(workspace, ".jj"), { recursive: true });
    const pointer = "../../../../../repos/github.com/acme/demo/.jj/repo\n";
    await writeFile(join(workspace, ".jj", "repo"), pointer, "utf8");

    const result = await resolveGitAwarePath(workspace);
    expect(result.gitAwarePath).toBe(canonicalRepo);
    expect(result.isJjWorkspace).toBe(true);
    expect(result.resolvedFromPointer).toBe(true);
    expect(result.warning).toBeUndefined();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveGitAwarePath warns and falls back when jj pointer is empty", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "agents-core-git-aware-empty-"));
  try {
    await mkdir(join(tempDir, ".jj"), { recursive: true });
    await writeFile(join(tempDir, ".jj", "repo"), "\n", "utf8");

    const result = await resolveGitAwarePath(tempDir);
    expect(result.gitAwarePath).toBe(tempDir);
    expect(result.isJjWorkspace).toBe(true);
    expect(result.resolvedFromPointer).toBe(false);
    expect(result.warning).toContain("pointer");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveGitAwarePath warns and falls back when canonical .git is missing", async () => {
  const tempDir = await mkdtemp(
    join(tmpdir(), "agents-core-git-aware-missing-git-"),
  );
  try {
    const canonicalRepo = join(tempDir, "repos", "github.com", "acme", "demo");
    const workspace = join(tempDir, "projects", "feat", "task", "demo");
    await mkdir(join(canonicalRepo, ".jj"), { recursive: true });
    await mkdir(join(workspace, ".jj"), { recursive: true });
    const pointer = "../../../../../repos/github.com/acme/demo/.jj/repo\n";
    await writeFile(join(workspace, ".jj", "repo"), pointer, "utf8");

    const result = await resolveGitAwarePath(workspace);
    expect(result.gitAwarePath).toBe(workspace);
    expect(result.isJjWorkspace).toBe(true);
    expect(result.resolvedFromPointer).toBe(false);
    expect(result.warning).toContain("was not found");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("mergeFlatConfigLayers overlays strings and booleans onto base partials", () => {
  expect(
    mergeFlatConfigLayers(
      { model: "keep", adapter: "opencode" },
      { model: "overlay", strict: true },
    ),
  ).toEqual({
    model: "overlay",
    adapter: "opencode",
    strict: true,
  });
});

test("mergePresetMaps merges each named preset user then repo (repo wins on overlap)", () => {
  expect(
    mergePresetMaps(
      { ci: { dryRun: false, model: "m0" } },
      { ci: { dryRun: true, adapter: "fake" } },
    ),
  ).toEqual({
    ci: { dryRun: true, model: "m0", adapter: "fake" },
  });
});

test("extractConfigDocument rejects nested presets inside a preset body", () => {
  expect(
    extractConfigDocument({
      presets: {
        ci: { presets: {} },
      },
    }).ok,
  ).toBe(false);
});

test("extractConfigDocument parses top-level flat options and presets", () => {
  const doc = extractConfigDocument({
    adapter: "fake",
    log: "summary",
    dryRun: false,
    presets: { ci: { dryRun: true } },
  });
  expect(doc.ok).toBe(true);
  if (!doc.ok) {
    return;
  }
  expect(doc.flat.adapter).toBe("fake");
  expect(doc.flat.log).toBe("summary");
  expect(doc.presets.ci).toEqual({ dryRun: true });
  expect(doc.diagnostics.length).toBe(0);
});

test("normalizeAdapterArgsTemplateField preserves JSON array tokens (including embedded commas)", () => {
  expect(normalizeAdapterArgsTemplateField("cursorArgs", undefined)).toEqual({
    ok: true,
  });
  const normalized = normalizeAdapterArgsTemplateField("cursorArgs", [
    "--print",
    "a,b",
    "  spaced  ",
  ]);
  expect(normalized).toEqual({
    ok: true,
    normalized: ["--print", "a,b", "spaced"],
  });
});

test("normalizeAdapterArgsTemplateField rejects mixed-type arrays", () => {
  const badFixture: unknown[] = ["--ok", false];
  expect(normalizeAdapterArgsTemplateField("claudeArgs", badFixture).ok).toBe(
    false,
  );
});

test("extractConfigDocument accepts adapter arg templates as JSON string arrays", () => {
  const doc = extractConfigDocument({
    cursorArgs: ["--trust", "--print"],
    presets: {
      demo: {
        claudeArgs: ["-p", "--model", "x"],
      },
    },
  });
  expect(doc.ok).toBe(true);
  if (!doc.ok) {
    return;
  }
  expect(doc.flat.cursorArgs).toEqual(["--trust", "--print"]);
  expect(doc.presets.demo?.claudeArgs).toEqual(["-p", "--model", "x"]);
});

test("extractConfigDocument lists unknown JSON keys in diagnostics when not strict", () => {
  const doc = extractConfigDocument({
    adapter: "fake",
    customFieldNobodyKnows: 1,
  });
  expect(doc.ok).toBe(true);
  if (!doc.ok) {
    return;
  }
  expect(doc.diagnostics.some((m) => m.includes("unknown keys"))).toBe(true);
});

test("extractConfigDocument rejects unknown keys when AGENTS_CODE_REVIEW_CONFIG_STRICT is truthy", () => {
  const prev = process.env.AGENTS_CODE_REVIEW_CONFIG_STRICT;
  process.env.AGENTS_CODE_REVIEW_CONFIG_STRICT = "true";
  try {
    expect(
      extractConfigDocument({
        adapter: "fake",
        orphanKeyForTests: {},
      }).ok,
    ).toBe(false);
  } finally {
    if (prev === undefined) {
      delete process.env.AGENTS_CODE_REVIEW_CONFIG_STRICT;
    } else {
      process.env.AGENTS_CODE_REVIEW_CONFIG_STRICT = prev;
    }
  }
});

test("extractConfigDocument rejects invalid cursorArgs array shapes", () => {
  expect(
    extractConfigDocument({ cursorArgs: [1 as unknown as string] }).ok,
  ).toBe(false);
});

test("resolveCodeReviewCliOptions merges configs and applies preset and CLI precedence", async () => {
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const tempRoot = await mkdtemp(join(tmpdir(), "agents-cr-cfg-resolve-"));
  try {
    const xdg = join(tempRoot, "xdg");
    const ws = join(tempRoot, "ws");
    await mkdir(join(xdg, "agents", "code-review"), { recursive: true });
    await mkdir(join(ws, AGENTS_CODE_REVIEW_DIR), { recursive: true });
    await writeFile(
      join(xdg, "agents", "code-review", "config.json"),
      JSON.stringify({
        model: "from-user",
        presets: { ci: { consensus: "2" } },
      }),
    );
    await writeFile(
      join(ws, AGENTS_CODE_REVIEW_DIR, "config.json"),
      JSON.stringify({
        adapter: "opencode",
        presets: { ci: { dryRun: true, adapter: "cursor" } },
      }),
    );
    process.env.XDG_CONFIG_HOME = xdg;

    const parsedCi = parseCodeReviewArgv(["--preset", "ci"]);
    const r1 = await resolveCodeReviewCliOptions(ws, parsedCi);
    expect(r1.ok).toBe(true);
    if (!r1.ok) {
      return;
    }
    expect(r1.options.adapter).toBe(
      CODE_REVIEW_HARNESS_PACKAGE_ADAPTER_DEFAULT,
    );
    expect(r1.options.model).toBe("from-user");
    expect(r1.options.consensus).toBe("2");
    expect(r1.options.dryRun).toBe(true);

    const parsedCliWins = parseCodeReviewArgv([
      "--preset",
      "ci",
      "--adapter",
      "fake",
      "--dry-run",
    ]);
    const r2 = await resolveCodeReviewCliOptions(ws, parsedCliWins);
    expect(r2.ok).toBe(true);
    if (!r2.ok) {
      return;
    }
    expect(r2.options.adapter).toBe("fake");
    expect(r2.options.dryRun).toBe(true);

    const badPreset = parseCodeReviewArgv(["--preset", "missing"]);
    const r3 = await resolveCodeReviewCliOptions(ws, badPreset);
    expect(r3.ok).toBe(false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    if (prevXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = prevXdg;
    }
  }
});

test("resolveCodeReviewCliOptions preserves comma-containing tokens in JSON cursorArgs arrays", async () => {
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const tempRoot = await mkdtemp(join(tmpdir(), "agents-cr-args-comma-"));
  try {
    const xdg = join(tempRoot, "xdg");
    const ws = join(tempRoot, "ws");
    process.env.XDG_CONFIG_HOME = xdg;
    await mkdir(join(xdg, "agents", "code-review"), { recursive: true });
    await mkdir(join(ws, AGENTS_CODE_REVIEW_DIR), { recursive: true });
    await writeFile(
      join(xdg, "agents", "code-review", "config.json"),
      JSON.stringify({
        cursorArgs: ["--flag", "a,b=c", "--tail"],
      }),
    );

    const r = await resolveCodeReviewCliOptions(ws, parseCodeReviewArgv([]));
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.options.cursorArgs).toEqual(["--flag", "a,b=c", "--tail"]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    if (prevXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = prevXdg;
    }
  }
});

test("sanitizeRepoAdapterExecutablePartial strips repo-managed steering knobs", () => {
  const { sanitized, strippedKeys } = sanitizeRepoAdapterExecutablePartial({
    adapter: "cursor",
    workspace: "/evil/ws",
    cursor: "/evil/agent",
    claudeArgs: ["-p"],
    model: "m",
    opencode: "/evil/opencode",
    claude: "/evil/claude",
    scratchpad: "/evil/sp",
    cursorArgs: ["--trust"],
  });
  expect([...strippedKeys].sort()).toEqual([
    "adapter",
    "claude",
    "claudeArgs",
    "cursor",
    "cursorArgs",
    "opencode",
    "scratchpad",
    "workspace",
  ]);
  expect(sanitized.adapter).toBeUndefined();
  expect(sanitized.workspace).toBeUndefined();
  expect(sanitized.scratchpad).toBeUndefined();
  expect(sanitized.cursor).toBeUndefined();
  expect(sanitized.opencode).toBeUndefined();
  expect(sanitized.claude).toBeUndefined();
  expect(sanitized.claudeArgs).toBeUndefined();
  expect(sanitized.cursorArgs).toBeUndefined();
  expect(sanitized.model).toBe("m");
});

test("resolveCodeReviewCliOptions drops repo-supplied executable paths and keeps user ones", async () => {
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const tempRoot = await mkdtemp(join(tmpdir(), "agents-cr-repo-strip-"));
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
    Reflect.apply(origWarn, console, args);
  };
  try {
    const xdg = join(tempRoot, "xdg");
    const ws = join(tempRoot, "ws");
    process.env.XDG_CONFIG_HOME = xdg;
    await mkdir(join(xdg, "agents", "code-review"), { recursive: true });
    await mkdir(join(ws, AGENTS_CODE_REVIEW_DIR), { recursive: true });
    await writeFile(
      join(xdg, "agents", "code-review", "config.json"),
      JSON.stringify({
        cursor: "/user/agent",
      }),
    );
    await writeFile(
      join(ws, AGENTS_CODE_REVIEW_DIR, "config.json"),
      JSON.stringify({
        cursor: "/repo/agent",
        adapter: "cursor",
      }),
    );

    const r = await resolveCodeReviewCliOptions(ws, parseCodeReviewArgv([]));
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.options.cursor).toBe("/user/agent");
    expect(r.options.adapter).toBe(CODE_REVIEW_HARNESS_PACKAGE_ADAPTER_DEFAULT);
    expect(
      warns.some((line) => line.includes("repo-managed review overrides")),
    ).toBe(true);
  } finally {
    console.warn = origWarn;
    await rm(tempRoot, { recursive: true, force: true });
    if (prevXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = prevXdg;
    }
  }
});

test("resolveCodeReviewCliOptions uses harness packaged adapter below empty configs", async () => {
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const tempRoot = await mkdtemp(join(tmpdir(), "agents-cr-pack-layer-"));
  try {
    const xdg = join(tempRoot, "xdg");
    const ws = join(tempRoot, "ws");
    process.env.XDG_CONFIG_HOME = xdg;
    await mkdir(xdg, { recursive: true });
    await mkdir(ws, { recursive: true });

    const r = await resolveCodeReviewCliOptions(ws, parseCodeReviewArgv([]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.adapter).toBe(
        CODE_REVIEW_HARNESS_PACKAGE_ADAPTER_DEFAULT,
      );
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    if (prevXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = prevXdg;
    }
  }
});

test("parseTriageArgv defaults format to both and requires --from", () => {
  expect(parseTriageArgv([]).ok).toBe(false);
  const parsed = parseTriageArgv(["--from", "code-review"]);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.options.format).toBe("both");
    expect(parsed.options.formatExplicit).toBe(false);
    expect(parsed.options.stdout).toBeUndefined();
  }
});

test("parseTriageArgv sets formatExplicit when --format is passed", () => {
  const implicit = parseTriageArgv(["--from", "code-review"]);
  expect(implicit.ok).toBe(true);
  if (implicit.ok) {
    expect(implicit.options.formatExplicit).toBe(false);
  }
  const explicit = parseTriageArgv([
    "--from",
    "code-review",
    "--format",
    "json",
  ]);
  expect(explicit.ok).toBe(true);
  if (explicit.ok) {
    expect(explicit.options.formatExplicit).toBe(true);
    expect(explicit.options.format).toBe("json");
  }
});

test("parseTriageArgv rejects --stdout unless format is json or toon", () => {
  const bad = parseTriageArgv(["--from", "code-review", "--stdout"]);
  expect(bad.ok).toBe(false);
  const okJson = parseTriageArgv([
    "--from",
    "code-review",
    "--stdout",
    "--format",
    "json",
  ]);
  expect(okJson.ok).toBe(true);
  if (okJson.ok) {
    expect(okJson.options.formatExplicit).toBe(true);
  }
});

test("runTriageCli accepts legacy leading ingest token", async () => {
  const workspace = await mkdtemp(
    join(tmpdir(), "agents-triage-legacy-ingest-"),
  );
  try {
    const resultRel = "result.json";
    const resultAbs = resolve(workspace, resultRel);
    await writeFile(
      resultAbs,
      JSON.stringify({ runId: "legacy", findings: [] }),
      "utf8",
    );
    expect(
      await runTriageCli([
        "triage",
        "ingest",
        "--from",
        "code-review",
        "--workspace",
        workspace,
        "--result",
        resultRel,
        "--format",
        "json",
      ]),
    ).toBe(0);
    const triageRoot = join(workspace, ".agents-triage");
    const slugDirs = (await readdir(triageRoot)).filter((name) =>
      name.startsWith("code-review-"),
    );
    expect(slugDirs).toHaveLength(1);
    const slug = slugDirs[0];
    await readFile(join(triageRoot, slug, "triage-queue.json"), "utf8");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runTriageCli writes triage-queue.json and triage-queue.toon under slug dir", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agents-triage-ingest-"));
  try {
    const resultRel = join("custom", "result.json");
    const resultAbs = resolve(workspace, resultRel);
    await mkdir(dirname(resultAbs), { recursive: true });
    await writeFile(
      resultAbs,
      JSON.stringify({
        runId: "stored-run",
        findings: [
          {
            id: "finding-1",
            severity: "warning",
            title: "Example",
            description: "Detail line.",
            evidence: "Evidence line.",
            sourceRole: "quality",
            validation: { status: "verified", details: "ok" },
          },
        ],
      }),
      "utf8",
    );

    expect(
      await runTriageCli([
        "triage",
        "--from",
        "code-review",
        "--workspace",
        workspace,
        "--result",
        resultRel,
      ]),
    ).toBe(0);

    const triageRoot = join(workspace, ".agents-triage");
    const slugDirs = (await readdir(triageRoot)).filter((name) =>
      name.startsWith("code-review-"),
    );
    expect(slugDirs).toHaveLength(1);
    const slug = slugDirs[0];
    const outDir = join(triageRoot, slug);

    const jsonRaw = await readFile(join(outDir, "triage-queue.json"), "utf8");
    const envelope = JSON.parse(jsonRaw) as { outputSlug?: string };
    expect(envelope.outputSlug).toBe(slug);
    expect(jsonRaw.length).toBeGreaterThan(0);
    const toonInstalled = await isToonEncodeAvailable();
    if (toonInstalled) {
      expect(
        (await readFile(join(outDir, "triage-queue.toon"), "utf8")).length,
      ).toBeGreaterThan(0);
    } else {
      await expect(
        readFile(join(outDir, "triage-queue.toon"), "utf8"),
      ).rejects.toThrow();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runTriageCli respects --output without extra slug segment", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agents-triage-output-"));
  try {
    const resultRel = "result.json";
    const resultAbs = join(workspace, resultRel);
    await writeFile(
      resultAbs,
      JSON.stringify({
        runId: "r2",
        findings: [],
      }),
      "utf8",
    );
    const explicit = join(workspace, "my-queue");
    expect(
      await runTriageCli([
        "triage",
        "--from",
        "code-review",
        "--workspace",
        workspace,
        "--result",
        resultRel,
        "--output",
        "my-queue",
        "--format",
        "json",
      ]),
    ).toBe(0);
    await readFile(join(explicit, "triage-queue.json"), "utf8");
    await expect(
      readFile(join(explicit, "triage-queue.toon"), "utf8"),
    ).rejects.toThrow();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("agents triage --stdout --format json prints envelope", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agents-triage-stdout-"));
  try {
    const resultRel = "result.json";
    await writeFile(
      join(workspace, resultRel),
      JSON.stringify({
        runId: "r3",
        findings: [],
      }),
      "utf8",
    );
    const proc = Bun.spawnSync(
      [
        process.execPath,
        "run",
        "packages/cli/src/index.ts",
        "triage",
        "--from",
        "code-review",
        "--workspace",
        workspace,
        "--result",
        resultRel,
        "--stdout",
        "--format",
        "json",
      ],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    expect(proc.exitCode).toBe(0);
    const envelope = JSON.parse(proc.stdout.toString().trim()) as {
      schemaId?: string;
    };
    expect(envelope.schemaId).toBeDefined();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("code-review overview help mentions agents triage, doctor, and skills", () => {
  const overview = resolveCodeReviewHelp([]);
  expect(overview).not.toBeNull();
  if (overview !== null && overview.kind === "overview") {
    const rendered = renderCodeReviewHelp(overview);
    expect(rendered).toContain("agents triage --help");
    expect(rendered).toContain("triage [options]");
    expect(rendered).toContain("agents code-review inbox --help");
    expect(rendered).toContain("agents doctor --help");
    expect(rendered).toContain("agents skills --help");
    expect(rendered).toContain("skills <command>");
  }
});
