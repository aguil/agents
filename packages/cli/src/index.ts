import { createCodeReviewAdapter, runCodeReview } from "@aguil/agents-code-review";
import type { CodeReviewAdapterName } from "@aguil/agents-code-review";
import type { Finding } from "@aguil/agents-core";
import { rm } from "node:fs/promises";
import { join } from "node:path";

export async function main(argv: readonly string[] = Bun.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.length === 0) {
    console.log(`Usage: agents <command> [options]

Commands:
  run code-review        Run the code-review harness

Options:
  --workspace <path>     Workspace to review (default: cwd)
  --scratchpad <path>    Scratchpad root (default: <workspace>/.review-agent/runs)
  --adapter <name>       Execution adapter: fake, opencode, or claude (default: fake)
  --model <id>           Model passed to opencode/claude
  --agent <name>         OpenCode agent name
  --opencode <path>      OpenCode executable (default: opencode)
  --claude <path>        Claude Code executable (default: claude)
  --claude-args <value>  Comma-separated arg template for Claude (supports {prompt})
  --strict               Fail run on any role error or timeout
  --pending-review       Create an unsubmitted GitHub PR review
  --pr <number>          PR number for pending review (auto-discover if omitted)
  --review-summary <id>  Review summary style: triage, impact, evidence (default: impact)
  --pure                 Run opencode without external plugins
  --print-logs           Ask opencode to print logs to stderr`);
    return 0;
  }

  if (argv[0] === "run" && argv[1] === "code-review") {
    const options = parseOptions(argv.slice(2));
    const adapterName = parseAdapterName(options.adapter);
    if (adapterName === undefined) {
      console.error(`Unsupported adapter: ${options.adapter}`);
      return 1;
    }
    const adapter = createCodeReviewAdapter(adapterName, {
      opencode: {
        executable: options.opencode,
        model: options.model,
        agent: options.agent,
        pure: options.pure,
        printLogs: options.printLogs,
      },
      claude: {
        executable: options.claude,
        model: options.model,
        argsTemplate: parseCommaSeparated(options.claudeArgs),
      },
    });

    const result = await runCodeReview({
      workspacePath: options.workspace,
      scratchpadRoot: options.scratchpad,
      strict: options.strict,
      adapter,
    });
    console.log(`Code review ${result.status}. Report: ${result.reportPath}`);

    if (options.pendingReview) {
      const prNumber = parsePrNumber(options.pr);
      if (options.pr !== undefined && prNumber === undefined) {
        console.error(`Invalid --pr value: ${options.pr}`);
        return 1;
      }
      const reviewSummaryStyle = parseReviewSummaryStyle(options.reviewSummary);
      if (options.reviewSummary !== undefined && reviewSummaryStyle === undefined) {
        console.error(`Invalid --review-summary value: ${options.reviewSummary}`);
        console.error("Expected one of: triage, impact, evidence.");
        return 1;
      }

      const posted = await replacePendingPullRequestReview({
        findings: result.findings,
        prNumber,
        reviewSummaryStyle: reviewSummaryStyle ?? "impact",
      });
      console.log(
        `Created pending review #${posted.reviewId} on PR #${posted.prNumber} with ${posted.commentCount} inline comments.`,
      );
      console.log(`Review URL: ${posted.url}`);
    }

    return result.status === "error" ? 1 : 0;
  }

  console.error(`Unknown command: ${argv[0]}`);
  return 1;
}

if (import.meta.main) {
  process.exitCode = await main();
}

interface CliOptions {
  readonly workspace?: string;
  readonly scratchpad?: string;
  readonly adapter?: string;
  readonly model?: string;
  readonly agent?: string;
  readonly opencode?: string;
  readonly claude?: string;
  readonly claudeArgs?: string;
  readonly pr?: string;
  readonly reviewSummary?: string;
  readonly strict: boolean;
  readonly pendingReview: boolean;
  readonly pure: boolean;
  readonly printLogs: boolean;
}

export type ReviewSummaryStyle = "triage" | "impact" | "evidence";

export interface PendingReviewComment {
  readonly path: string;
  readonly line: number;
  readonly side: "RIGHT";
  readonly body: string;
}

interface GitHubPendingReviewCommentInput {
  readonly path: string;
  readonly position: number;
  readonly body: string;
}

interface PendingReviewPosted {
  readonly reviewId: number;
  readonly prNumber: number;
  readonly commentCount: number;
  readonly url: string;
}

function parseOptions(argv: readonly string[]): CliOptions {
  const options: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      flags.add(key);
      continue;
    }
    options[key] = value;
    index += 1;
  }
  return {
    workspace: options.workspace,
    scratchpad: options.scratchpad,
    adapter: options.adapter,
    model: options.model,
    agent: options.agent,
    opencode: options.opencode,
    claude: options.claude,
    claudeArgs: options["claude-args"],
    pr: options.pr,
    reviewSummary: options["review-summary"],
    strict: flags.has("strict"),
    pendingReview: flags.has("pending-review"),
    pure: flags.has("pure"),
    printLogs: flags.has("print-logs"),
  };
}

function parseAdapterName(value: string | undefined): CodeReviewAdapterName | undefined {
  if (value === undefined || value === "fake" || value === "opencode" || value === "claude") {
    return value ?? "fake";
  }
  return undefined;
}

function parseCommaSeparated(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

function parsePrNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseReviewSummaryStyle(value: string | undefined): ReviewSummaryStyle | undefined {
  if (value === undefined) {
    return "impact";
  }
  if (value === "triage" || value === "impact" || value === "evidence") {
    return value;
  }
  return undefined;
}

export function findingsToPendingReviewComments(findings: readonly Finding[]): readonly PendingReviewComment[] {
  return findings
    .filter((finding) => finding.file !== undefined && finding.line !== undefined)
    .map((finding) => ({
      path: finding.file as string,
      line: finding.line as number,
      side: "RIGHT" as const,
      body: formatPendingReviewBody(finding),
    }));
}

function formatPendingReviewBody(finding: Finding): string {
  return [
    `### ${finding.severity.toUpperCase()}: ${finding.title}`,
    "",
    finding.description,
    "",
    `Evidence: ${finding.evidence}`,
    `Validation: ${finding.validation.status} - ${finding.validation.details}`,
  ].join("\n");
}

async function replacePendingPullRequestReview(input: {
  readonly findings: readonly Finding[];
  readonly prNumber?: number;
  readonly reviewSummaryStyle: ReviewSummaryStyle;
}): Promise<PendingReviewPosted> {
  const repo = await getRepoNameWithOwner();
  const login = await getViewerLogin();
  const prNumber = input.prNumber ?? await getCurrentPullRequestNumber(repo);
  const rawComments = findingsToPendingReviewComments(input.findings);
  const diffContext = await loadPullRequestDiffContext(repo, prNumber);
  const comments = rawComments
    .map((candidate) => candidateToComment(candidate, diffContext))
    .filter((comment): comment is GitHubPendingReviewCommentInput => comment !== undefined);
  const skippedUnanchorable = rawComments.length - comments.length;

  const reviews = await ghApi<readonly GitHubPullRequestReview[]>(
    `repos/${repo}/pulls/${prNumber}/reviews`,
  );
  const pendingMine = reviews.filter((review) => review.state === "PENDING" && review.user.login === login);
  for (const review of pendingMine) {
    await ghApi<void>(
      `repos/${repo}/pulls/${prNumber}/reviews/${review.id}`,
      "DELETE",
    );
  }

  const body = buildPendingReviewSummaryBody({
    style: input.reviewSummaryStyle,
    findings: input.findings,
    postedCommentCount: comments.length,
    skippedUnanchorable,
  });
  const created = await ghApi<{ readonly id: number; readonly html_url: string }>(
    `repos/${repo}/pulls/${prNumber}/reviews`,
    "POST",
    {
      body,
      comments,
    },
  );

  return {
    reviewId: created.id,
    prNumber,
    commentCount: comments.length,
    url: created.html_url,
  };
}

export function buildPendingReviewSummaryBody(input: {
  readonly style: ReviewSummaryStyle;
  readonly findings: readonly Finding[];
  readonly postedCommentCount: number;
  readonly skippedUnanchorable: number;
}): string {
  switch (input.style) {
    case "triage":
      return renderTriageSummary(input.findings, input.postedCommentCount, input.skippedUnanchorable);
    case "impact":
      return renderImpactSummary(input.findings, input.postedCommentCount, input.skippedUnanchorable);
    case "evidence":
      return renderEvidenceSummary(input.findings, input.postedCommentCount, input.skippedUnanchorable);
  }
}

function renderTriageSummary(
  findings: readonly Finding[],
  postedCommentCount: number,
  skippedUnanchorable: number,
): string {
  const critical = findings.filter((finding) => finding.severity === "critical");
  const warnings = findings.filter((finding) => finding.severity === "warning");
  const fixNow = [...critical, ...warnings].slice(0, 2);
  const followUp = [...critical, ...warnings].slice(2, 6);

  return [
    "Code Review Harness (unsubmitted)",
    "",
    "## At a Glance",
    `- Findings: ${findings.length} (${critical.length} critical, ${warnings.length} warning)`,
    `- Inline comments posted: ${postedCommentCount}`,
    `- Skipped outside PR diff: ${skippedUnanchorable}`,
    "",
    "## Fix Now",
    ...formatFindingBullets(fixNow, "No immediate findings."),
    "",
    "## Follow-up",
    ...formatFindingBullets(followUp, "No follow-up findings."),
  ].join("\n");
}

function renderImpactSummary(
  findings: readonly Finding[],
  postedCommentCount: number,
  skippedUnanchorable: number,
): string {
  const groups: Record<Finding["sourceRole"], Finding[]> = {
    security: [],
    performance: [],
    quality: [],
    compliance: [],
  };

  for (const finding of findings) {
    groups[finding.sourceRole].push(finding);
  }

  return [
    "Code Review Harness (unsubmitted)",
    "",
    "## Impact Summary",
    `- Total findings: ${findings.length}`,
    `- Inline comments posted: ${postedCommentCount}`,
    `- Skipped outside PR diff: ${skippedUnanchorable}`,
    "",
    "### Security",
    ...formatFindingBullets(groups.security, "No security findings."),
    "",
    "### Runtime / Performance",
    ...formatFindingBullets(groups.performance, "No performance findings."),
    "",
    "### Correctness / Quality",
    ...formatFindingBullets(groups.quality, "No quality findings."),
    "",
    "### Documentation / Compliance",
    ...formatFindingBullets(groups.compliance, "No compliance findings."),
  ].join("\n");
}

function renderEvidenceSummary(
  findings: readonly Finding[],
  postedCommentCount: number,
  skippedUnanchorable: number,
): string {
  const lines = [
    "Code Review Harness (unsubmitted)",
    "",
    "## Why / Evidence / Fix",
    `- Total findings: ${findings.length}`,
    `- Inline comments posted: ${postedCommentCount}`,
    `- Skipped outside PR diff: ${skippedUnanchorable}`,
  ];

  if (findings.length === 0) {
    lines.push("", "No findings were generated.");
    return lines.join("\n");
  }

  for (const [index, finding] of findings.slice(0, 6).entries()) {
    lines.push(
      "",
      `### Finding ${index + 1}: ${finding.title}`,
      `- Why: ${finding.description}`,
      `- Evidence: ${finding.evidence}`,
      `- Suggested fix: ${suggestFixFromRole(finding.sourceRole)}`,
    );
  }

  return lines.join("\n");
}

function formatFindingBullets(findings: readonly Finding[], emptyLine: string): readonly string[] {
  if (findings.length === 0) {
    return [`- ${emptyLine}`];
  }
  return findings.map((finding) => {
    const location = finding.file !== undefined && finding.line !== undefined
      ? ` (${finding.file}:${finding.line})`
      : "";
    return `- ${finding.title}${location}`;
  });
}

function suggestFixFromRole(role: Finding["sourceRole"]): string {
  if (role === "security") {
    return "Apply least-privilege and input/output hardening for the affected path.";
  }
  if (role === "performance") {
    return "Reduce per-operation overhead and prefer batching or cheaper hot-path operations.";
  }
  if (role === "quality") {
    return "Align behavior with expected edge cases and add targeted regression coverage.";
  }
  return "Align docs and conventions with implemented behavior.";
}

async function getCurrentPullRequestNumber(repo: string): Promise<number> {
  const view = await runGh<{ readonly number: number }>([
    "pr",
    "view",
    "--repo",
    repo,
    "--json",
    "number",
  ]);
  if (!Number.isInteger(view.number)) {
    throw new Error("Could not resolve current PR number from gh pr view.");
  }
  return view.number;
}

async function getRepoNameWithOwner(): Promise<string> {
  try {
    const repo = await runGh<{ readonly nameWithOwner: string }>([
      "repo",
      "view",
      "--json",
      "nameWithOwner",
    ]);
    if (repo.nameWithOwner.trim().length > 0) {
      return repo.nameWithOwner;
    }
  } catch {
    // Fall back to remote URL parsing for jj workspaces.
  }
  const fromRemote = await resolveRepoNameWithOwnerFromRemote();
  if (fromRemote === undefined) {
    throw new Error("Could not resolve repository nameWithOwner from gh or remotes.");
  }
  return fromRemote;
}

async function getViewerLogin(): Promise<string> {
  const user = await runGh<{ readonly login: string }>(["api", "user"]);
  if (user.login.trim().length === 0) {
    throw new Error("Could not resolve GitHub login from gh api user.");
  }
  return user.login;
}

async function ghApi<T>(path: string, method = "GET", payload?: unknown): Promise<T> {
  const args = ["api", path, "--method", method] as string[];
  let inputPath: string | undefined;
  if (payload !== undefined) {
    inputPath = join("/tmp/opencode", `gh-api-${crypto.randomUUID()}.json`);
    await Bun.write(inputPath, `${JSON.stringify(payload)}\n`);
    args.push("--input", inputPath);
  }
  try {
    return await runGh<T>(args);
  } finally {
    if (inputPath !== undefined) {
      await rm(inputPath, { force: true });
    }
  }
}

async function runGh<T>(args: readonly string[]): Promise<T> {
  const proc = Bun.spawn({
    cmd: ["gh", ...args],
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    readProcessText(proc.stdout),
    readProcessText(proc.stderr),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${stderr.trim() || `exit code ${exitCode}`}`);
  }
  if (stdout.trim().length === 0) {
    return undefined as T;
  }
  return JSON.parse(stdout) as T;
}

async function resolveRepoNameWithOwnerFromRemote(): Promise<string | undefined> {
  const remoteUrl = (
    await runCommand(["jj", "git", "remote", "list"]) ??
    await runCommand(["git", "remote", "get-url", "origin"])
  )?.trim();
  if (remoteUrl === undefined || remoteUrl.length === 0) {
    return undefined;
  }

  const line = remoteUrl.split(/\r?\n/).find((entry) => entry.startsWith("origin "));
  const rawUrl = line?.replace(/^origin\s+/, "") ?? remoteUrl;
  return parseNameWithOwnerFromRemoteUrl(rawUrl);
}

function parseNameWithOwnerFromRemoteUrl(url: string): string | undefined {
  const sshLike = /^(?:[^@]+@)?[^:]+:([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (sshLike) {
    return `${sshLike[1]}/${sshLike[2]}`;
  }

  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\//, "").replace(/\.git$/, "");
    const parts = path.split("/");
    if (parts.length < 2) {
      return undefined;
    }
    return `${parts[0]}/${parts[1]}`;
  } catch {
    return undefined;
  }
}

async function runCommand(cmd: readonly string[]): Promise<string | undefined> {
  try {
    const proc = Bun.spawn({
      cmd: [...cmd],
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([
      readProcessText(proc.stdout),
      proc.exited,
    ]);
    return exitCode === 0 ? stdout : undefined;
  } catch {
    return undefined;
  }
}

async function readProcessText(
  stream: ReadableStream<Uint8Array> | number | undefined,
): Promise<string> {
  if (!(stream instanceof ReadableStream)) {
    return "";
  }
  return new Response(stream).text();
}

interface GitHubPullRequestReview {
  readonly id: number;
  readonly state: string;
  readonly user: {
    readonly login: string;
  };
}

interface GitHubPullRequestFile {
  readonly filename: string;
  readonly patch?: string;
}

type PullRequestDiffContext = ReadonlyMap<string, ReadonlyMap<number, number>>;

async function loadPullRequestDiffContext(
  repo: string,
  prNumber: number,
): Promise<PullRequestDiffContext> {
  const files = await ghApi<readonly GitHubPullRequestFile[]>(
    `repos/${repo}/pulls/${prNumber}/files?per_page=100`,
  );
  const map = new Map<string, ReadonlyMap<number, number>>();
  for (const file of files) {
    map.set(file.filename, extractRightSideHunkPositions(file.patch));
  }
  return map;
}

function candidateToComment(
  candidate: PendingReviewComment,
  context: PullRequestDiffContext,
): GitHubPendingReviewCommentInput | undefined {
  const positions = context.get(candidate.path);
  const position = positions?.get(candidate.line);
  if (position === undefined) {
    return undefined;
  }
  return {
    path: candidate.path,
    position,
    body: candidate.body,
  };
}

function extractRightSideHunkPositions(patch: string | undefined): ReadonlyMap<number, number> {
  if (patch === undefined) {
    return new Map<number, number>();
  }
  const positions = new Map<number, number>();
  let rightLine = 0;
  let position = 0;
  let inHunk = false;
  for (const line of patch.split(/\r?\n/)) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      rightLine = Number.parseInt(header[1] ?? "0", 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      position += 1;
      positions.set(rightLine, position);
      rightLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      position += 1;
      positions.set(rightLine, position);
      rightLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      position += 1;
      continue;
    }
    if (line.startsWith("\\")) {
      continue;
    }
  }
  return positions;
}
