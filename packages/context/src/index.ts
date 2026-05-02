import { ensureDirectory, writeJsonFile, writeTextFile } from "@aguil/agents-core";
import type { ReviewTriageTier } from "@aguil/agents-core";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export interface ContextRequest {
  readonly workspacePath: string;
  readonly diffPath?: string;
  readonly scratchpadPath: string;
}

export interface ContextArtifact {
  readonly id: string;
  readonly title: string;
  readonly path?: string;
  readonly content: string;
}

export interface ContextProvider {
  readonly name: string;
  collect(request: ContextRequest): Promise<readonly ContextArtifact[]>;
}

export interface ContextBundle {
  readonly id: string;
  readonly artifacts: readonly ContextArtifact[];
}

export interface WrittenContextBundle {
  readonly bundle: ContextBundle;
  readonly jsonPath: string;
  readonly markdownPath: string;
}

export interface PullRequestMetadata {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly baseRefName?: string;
}

export interface RemoteScope {
  readonly remoteName: string;
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}

export interface ParsedGitRemoteUrl {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}

export interface PullRequestMetadataProviderOptions {
  readonly commandRunner?: CommandRunner;
}

export interface PullRequestReferencedDocsProviderOptions {
  readonly commandRunner?: CommandRunner;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

export class StaticContextProvider implements ContextProvider {
  readonly name = "static";

  constructor(private readonly artifacts: readonly ContextArtifact[]) {}

  async collect(): Promise<readonly ContextArtifact[]> {
    return this.artifacts;
  }
}

export class AgentsInstructionsProvider implements ContextProvider {
  readonly name = "agents-instructions";

  async collect(request: ContextRequest): Promise<readonly ContextArtifact[]> {
    const path = join(request.workspacePath, "AGENTS.md");
    try {
      return [
        {
          id: "agents-md",
          title: "Repository AGENTS.md",
          path,
          content: await readFile(path, "utf8"),
        },
      ];
    } catch {
      return [];
    }
  }
}

export class PullRequestMetadataProvider implements ContextProvider {
  readonly name = "pull-request-metadata";

  private readonly commandRunner: CommandRunner;

  constructor(options: PullRequestMetadataProviderOptions = {}) {
    this.commandRunner = options.commandRunner ?? runCommand;
  }

  async collect(request: ContextRequest): Promise<readonly ContextArtifact[]> {
    const pullRequest = await discoverPullRequest(request.workspacePath, this.commandRunner);
    if (pullRequest === undefined) {
      return [
        {
          id: "pr-metadata",
          title: "Pull Request Metadata",
          content:
            "No related pull request discovered for the current branch. Continuing with repository context only.",
        },
      ];
    }

    return [
      {
        id: "pr-metadata",
        title: "Pull Request Metadata",
        path: pullRequest.url,
        content: renderPullRequestMetadata(pullRequest),
      },
    ];
  }
}

export class PullRequestReferencedDocsProvider implements ContextProvider {
  readonly name = "pull-request-referenced-docs";

  private readonly commandRunner: CommandRunner;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;

  constructor(options: PullRequestReferencedDocsProviderOptions = {}) {
    this.commandRunner = options.commandRunner ?? runCommand;
    this.maxBytes = options.maxBytes ?? 50_000;
    this.timeoutMs = options.timeoutMs ?? 8_000;
  }

  async collect(request: ContextRequest): Promise<readonly ContextArtifact[]> {
    const pullRequest = await discoverPullRequest(request.workspacePath, this.commandRunner);
    if (pullRequest === undefined) {
      return [
        {
          id: "pr-referenced-docs",
          title: "PR Referenced Documentation",
          content: "PR discovery unavailable, so no PR-referenced documents were fetched.",
        },
      ];
    }

    const remoteScope = await resolvePreferredRemoteScope(request.workspacePath, this.commandRunner);
    const references = extractReferencedDocumentation(pullRequest.body);
    if (references.length === 0) {
      return [
        {
          id: "pr-referenced-docs",
          title: "PR Referenced Documentation",
          content: "No documentation links or paths were found in the PR description.",
        },
      ];
    }

    const summaryLines = [
      `PR: #${pullRequest.number} ${pullRequest.url}`,
      remoteScope === undefined
        ? "Scope: unknown (no configured remote scope found)"
        : `Scope: ${remoteScope.remoteName} (${remoteScope.host}/${remoteScope.owner})`,
      "",
      "References:",
    ];
    const artifacts: ContextArtifact[] = [];

    for (let index = 0; index < references.length; index += 1) {
      const reference = references[index];
      if (reference.kind === "local-path") {
        const localArtifact = await collectLocalReferencedDoc(request.workspacePath, reference.value, index);
        if (localArtifact === undefined) {
          summaryLines.push(`- [skipped] ${reference.value} (not found or outside workspace)`);
          continue;
        }
        artifacts.push(localArtifact);
        summaryLines.push(`- [fetched] ${reference.value}`);
        continue;
      }

      const decision = shouldFetchReferencedUrl(reference.value, remoteScope);
      if (!decision.allowed) {
        summaryLines.push(`- [skipped] ${reference.value} (${decision.reason})`);
        continue;
      }

      const fetched = await fetchReferencedUrl(reference.value, {
        timeoutMs: this.timeoutMs,
        maxBytes: this.maxBytes,
      });
      if (fetched === undefined) {
        summaryLines.push(`- [skipped] ${reference.value} (fetch failed or unsupported content)`);
        continue;
      }

      artifacts.push({
        id: `pr-doc-url-${index + 1}`,
        title: `PR Referenced URL: ${reference.value}`,
        path: reference.value,
        content: fetched,
      });
      summaryLines.push(`- [fetched] ${reference.value}`);
    }

    return [
      {
        id: "pr-referenced-docs",
        title: "PR Referenced Documentation",
        content: summaryLines.join("\n"),
      },
      ...artifacts,
    ];
  }
}

export class RepositoryDiffProvider implements ContextProvider {
  readonly name = "repository-diff";

  constructor(private readonly commandRunner: CommandRunner = runCommand) {}

  async collect(request: ContextRequest): Promise<readonly ContextArtifact[]> {
    const { diff, baseRef, strategy } = request.diffPath
      ? {
          diff: await readFile(request.diffPath, "utf8"),
          baseRef: undefined,
          strategy: "explicit_diff_path",
        }
      : await collectReviewDiff(request.workspacePath, this.commandRunner);

    return [
      {
        id: "diff-strategy",
        title: "Diff Strategy",
        content: [
          `Strategy: ${strategy}`,
          `Base Ref: ${baseRef ?? "(none)"}`,
        ].join("\n"),
      },
      {
        id: "workspace-diff",
        title: "Workspace Diff",
        content: diff.trim().length > 0 ? diff : "No workspace diff detected.",
      },
      {
        id: "changed-files",
        title: "Changed Files",
        content: changedFilesFromDiff(diff).join("\n") || "No changed files detected.",
      },
      {
        id: "triage",
        title: "Risk Triage",
        content: classifyDiff(diff),
      },
    ];
  }
}

export async function collectContextBundle(
  id: string,
  request: ContextRequest,
  providers: readonly ContextProvider[],
): Promise<ContextBundle> {
  const artifacts = (
    await Promise.all(providers.map((provider) => provider.collect(request)))
  ).flat();
  return { id, artifacts };
}

export async function writeContextBundle(
  bundle: ContextBundle,
  scratchpadPath: string,
): Promise<WrittenContextBundle> {
  const contextPath = join(scratchpadPath, "context");
  await ensureDirectory(contextPath);
  const jsonPath = await writeJsonFile(join(contextPath, "bundle.json"), bundle);
  const markdownPath = await writeTextFile(
    join(contextPath, "bundle.md"),
    renderContextBundle(bundle),
  );
  return { bundle, jsonPath, markdownPath };
}

export function renderContextBundle(bundle: ContextBundle): string {
  const sections = bundle.artifacts.map((artifact) => {
    const source = artifact.path ? `\nSource: ${artifact.path}` : "";
    return `## ${artifact.title}${source}\n\n${artifact.content.trim()}\n`;
  });
  return `# Context Bundle: ${bundle.id}\n\n${sections.join("\n")}`;
}

export function classifyDiff(diff: string): ReviewTriageTier {
  const changedLines = diff
    .split(/\r?\n/)
    .filter((line) => /^[+-]/.test(line) && !line.startsWith("+++") && !line.startsWith("---"))
    .length;
  const changedFiles = changedFilesFromDiff(diff).length;

  if (changedLines <= 10 && changedFiles <= 2) {
    return "trivial";
  }
  if (changedLines <= 250 && changedFiles <= 12) {
    return "lite";
  }
  return "full";
}

export function changedFilesFromDiff(diff: string): readonly string[] {
  const files = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match) {
      files.add(match[2]);
    }
  }
  return [...files].sort();
}

export async function collectRepositoryDiff(workspacePath: string): Promise<string> {
  return (
    (await runCommand(["jj", "diff", "--git"], workspacePath)) ??
    (await runCommand(["git", "diff", "--no-ext-diff", "--"], workspacePath)) ??
    ""
  );
}

export async function collectReviewDiff(
  workspacePath: string,
  commandRunner: CommandRunner = runCommand,
): Promise<{
  readonly diff: string;
  readonly baseRef?: string;
  readonly strategy: string;
}> {
  const pullRequest = await discoverPullRequest(workspacePath, commandRunner);
  const remoteScope = await resolvePreferredRemoteScope(workspacePath, commandRunner);
  const baseCandidates = pullRequest?.baseRefName !== undefined
    ? [pullRequest.baseRefName]
    : await resolvePreferredBaseBranchCandidates(workspacePath, commandRunner, remoteScope?.remoteName);

  for (const baseRef of dedupeStrings(baseCandidates)) {
    const gitDiff = await commandRunner(
      ["git", "diff", "--no-ext-diff", `${baseRef}...HEAD`],
      workspacePath,
    );
    if (gitDiff !== undefined) {
      return {
        diff: filterReviewDiff(gitDiff),
        baseRef,
        strategy: pullRequest?.baseRefName !== undefined ? "pr_base_git" : "fallback_base_git",
      };
    }

    for (const jjBase of toJjBaseCandidates(baseRef, remoteScope?.remoteName)) {
      const jjDiff = await commandRunner(["jj", "diff", "--git", "--from", jjBase, "--to", "@"], workspacePath);
      if (jjDiff !== undefined) {
        return {
          diff: filterReviewDiff(jjDiff),
          baseRef: jjBase,
          strategy: pullRequest?.baseRefName !== undefined ? "pr_base_jj" : "fallback_base_jj",
        };
      }
    }
  }

  const workingDiff = await collectRepositoryDiff(workspacePath);
  return {
    diff: filterReviewDiff(workingDiff),
    baseRef: undefined,
    strategy: "working_copy_fallback",
  };
}

export function filterReviewDiff(diff: string): string {
  const lines = diff.split(/\r?\n/);
  const kept: string[] = [];
  let current: string[] = [];
  let currentPath: string | undefined;

  const flush = (): void => {
    if (current.length === 0) {
      return;
    }
    if (currentPath === undefined || !isHarnessArtifactPath(currentPath)) {
      kept.push(...current);
    }
    current = [];
    currentPath = undefined;
  };

  for (const line of lines) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match) {
      flush();
      currentPath = match[2];
      current.push(line);
      continue;
    }
    current.push(line);
  }
  flush();

  return kept.join("\n").trimEnd();
}

export async function resolvePreferredBaseBranch(
  workspacePath: string,
  commandRunner: CommandRunner = runCommand,
  remoteName?: string,
): Promise<string | undefined> {
  if (remoteName !== undefined) {
    const headRef = await commandRunner(
      ["git", "symbolic-ref", `refs/remotes/${remoteName}/HEAD`],
      workspacePath,
    );
    const branch = parseRemoteHeadBranch(headRef);
    if (branch !== undefined) {
      return branch;
    }
  }

  const candidates = dedupeStrings([
    ...(remoteName !== undefined ? [`${remoteName}/main`, `${remoteName}/master`] : []),
    "main",
    "master",
  ]);
  for (const candidate of candidates) {
    const exists = await commandRunner(["git", "rev-parse", "--verify", candidate], workspacePath);
    if (exists !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

export async function resolvePreferredBaseBranchCandidates(
  workspacePath: string,
  commandRunner: CommandRunner = runCommand,
  remoteName?: string,
): Promise<readonly string[]> {
  const preferred = await resolvePreferredBaseBranch(workspacePath, commandRunner, remoteName);
  return dedupeStrings([
    ...(preferred !== undefined ? [preferred] : []),
    ...(remoteName !== undefined ? [`${remoteName}/main`, `${remoteName}/master`] : []),
    "main",
    "master",
  ]);
}

export function parseRemoteHeadBranch(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  const parts = trimmed.split("/");
  return parts.length >= 4 ? parts.at(-1) : undefined;
}

export async function discoverPullRequest(
  workspacePath: string,
  commandRunner: CommandRunner = runCommand,
): Promise<PullRequestMetadata | undefined> {
  const json = await commandRunner(
    ["gh", "pr", "view", "--json", "number,title,body,url,baseRefName"],
    workspacePath,
  );
  if (json === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(json) as Partial<PullRequestMetadata>;
    if (
      typeof parsed.number !== "number" ||
      typeof parsed.title !== "string" ||
      typeof parsed.body !== "string" ||
      typeof parsed.url !== "string"
    ) {
      return undefined;
    }

    return {
      number: parsed.number,
        title: parsed.title,
        body: parsed.body,
        url: parsed.url,
        baseRefName: typeof parsed.baseRefName === "string" ? parsed.baseRefName : undefined,
      };
  } catch {
    return undefined;
  }
}

export async function resolvePreferredRemoteScope(
  workspacePath: string,
  commandRunner: CommandRunner = runCommand,
): Promise<RemoteScope | undefined> {
  const trackingRemote = await resolveTrackingRemoteName(workspacePath, commandRunner);
  const names = await listRemoteNames(workspacePath, commandRunner);
  const selected = selectPreferredRemoteName({
    trackingRemote,
    remoteNames: names,
  });
  if (selected === undefined) {
    return undefined;
  }

  const remoteUrl = await commandRunner(["git", "remote", "get-url", selected], workspacePath);
  if (remoteUrl === undefined) {
    return undefined;
  }
  const parsed = parseGitRemoteUrl(remoteUrl.trim());
  if (parsed === undefined) {
    return undefined;
  }

  return {
    remoteName: selected,
    host: parsed.host,
    owner: parsed.owner,
    repo: parsed.repo,
  };
}

export async function resolveTrackingRemoteName(
  workspacePath: string,
  commandRunner: CommandRunner = runCommand,
): Promise<string | undefined> {
  const upstream = await commandRunner(
    ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    workspacePath,
  );
  if (upstream === undefined) {
    return undefined;
  }

  const trimmed = upstream.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    return undefined;
  }
  return trimmed.slice(0, slash);
}

export function selectPreferredRemoteName(input: {
  readonly trackingRemote?: string;
  readonly remoteNames: readonly string[];
}): string | undefined {
  if (
    input.trackingRemote !== undefined &&
    input.remoteNames.includes(input.trackingRemote)
  ) {
    return input.trackingRemote;
  }
  if (input.remoteNames.includes("origin")) {
    return "origin";
  }
  return input.remoteNames.at(0);
}

export function parseGitRemoteUrl(value: string): ParsedGitRemoteUrl | undefined {
  try {
    const url = new URL(value);
    const parts = url.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
    if (parts.length < 2) {
      return undefined;
    }
    return {
      host: url.host,
      owner: parts[0] ?? "",
      repo: parts[1] ?? "",
    };
  } catch {
    const sshLike = /^(?:[^@]+@)?([^:]+):([^/]+)\/(.+?)(?:\.git)?$/.exec(value);
    if (!sshLike) {
      return undefined;
    }
    return {
      host: sshLike[1] ?? "",
      owner: sshLike[2] ?? "",
      repo: sshLike[3] ?? "",
    };
  }
}

export interface ReferencedDoc {
  readonly kind: "url" | "local-path";
  readonly value: string;
}

export function extractReferencedDocumentation(prBody: string): readonly ReferencedDoc[] {
  const urls = new Set<string>();
  const localPaths = new Set<string>();

  const markdownLinkPattern = /\[[^\]]+\]\(([^)\s]+)\)/g;
  for (const match of prBody.matchAll(markdownLinkPattern)) {
    const value = normalizeReference(match[1]);
    if (value === undefined) {
      continue;
    }
    if (isUrl(value)) {
      urls.add(value);
    } else if (looksLikeDocumentationPath(value)) {
      localPaths.add(value);
    }
  }

  const bareUrlPattern = /https?:\/\/[^\s)\]]+/g;
  for (const match of prBody.matchAll(bareUrlPattern)) {
    const value = normalizeReference(match[0]);
    if (value !== undefined) {
      urls.add(value);
    }
  }

  const localDocPattern = /(?:^|[\s(])(docs\/[\w./-]+|README[\w./-]*)(?=$|[\s),])/gim;
  for (const match of prBody.matchAll(localDocPattern)) {
    const value = normalizeReference(match[1]);
    if (value !== undefined) {
      localPaths.add(value);
    }
  }

  return [
    ...[...localPaths].sort().map((value) => ({ kind: "local-path", value }) as const),
    ...[...urls].sort().map((value) => ({ kind: "url", value }) as const),
  ];
}

export function shouldFetchReferencedUrl(
  value: string,
  remoteScope: RemoteScope | undefined,
): { readonly allowed: boolean; readonly reason: string } {
  if (remoteScope === undefined) {
    return { allowed: false, reason: "remote scope unavailable" };
  }
  try {
    const url = new URL(value);
    if (url.host !== remoteScope.host) {
      return { allowed: false, reason: "different host" };
    }
    const owner = url.pathname.replace(/^\//, "").split("/")[0];
    if (owner === undefined || owner.length === 0) {
      return { allowed: false, reason: "missing owner path" };
    }
    if (owner !== remoteScope.owner) {
      return { allowed: false, reason: "different org/owner" };
    }
    return { allowed: true, reason: "same remote org" };
  } catch {
    return { allowed: false, reason: "invalid url" };
  }
}

function renderPullRequestMetadata(pr: PullRequestMetadata): string {
  return [
    `Number: #${pr.number}`,
    `URL: ${pr.url}`,
    `Title: ${pr.title}`,
    "",
    "Description:",
    pr.body.trim().length > 0 ? pr.body : "(empty)",
  ].join("\n");
}

async function listRemoteNames(
  workspacePath: string,
  commandRunner: CommandRunner,
): Promise<readonly string[]> {
  const output = await commandRunner(["git", "remote"], workspacePath);
  if (output === undefined) {
    return [];
  }
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function collectLocalReferencedDoc(
  workspacePath: string,
  localPath: string,
  index: number,
): Promise<ContextArtifact | undefined> {
  const candidate = isAbsolute(localPath)
    ? localPath
    : resolve(workspacePath, localPath.replace(/^\.\//, ""));
  if (!isPathInsideWorkspace(candidate, workspacePath)) {
    return undefined;
  }

  try {
    const content = await readFile(candidate, "utf8");
    return {
      id: `pr-doc-local-${index + 1}`,
      title: `PR Referenced Local Doc: ${localPath}`,
      path: candidate,
      content,
    };
  } catch {
    return undefined;
  }
}

async function fetchReferencedUrl(
  url: string,
  options: { readonly timeoutMs: number; readonly maxBytes: number },
): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "agents-code-review-harness",
      },
    });
    if (!response.ok) {
      return undefined;
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (
      contentType.length > 0 &&
      !contentType.includes("text") &&
      !contentType.includes("json") &&
      !contentType.includes("xml") &&
      !contentType.includes("markdown")
    ) {
      return undefined;
    }

    const content = await response.text();
    return content.slice(0, options.maxBytes);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function isPathInsideWorkspace(path: string, workspacePath: string): boolean {
  const normalizedWorkspace = workspacePath.endsWith("/") ? workspacePath : `${workspacePath}/`;
  return path === workspacePath || path.startsWith(normalizedWorkspace);
}

function toJjBaseCandidates(baseRef: string, remoteName: string | undefined): readonly string[] {
  const candidates = [baseRef];
  const slash = baseRef.indexOf("/");
  if (slash > 0) {
    const remote = baseRef.slice(0, slash);
    const branch = baseRef.slice(slash + 1);
    candidates.push(`${branch}@${remote}`);
  } else if (remoteName !== undefined) {
    candidates.push(`${baseRef}@${remoteName}`);
  }
  return dedupeStrings(candidates);
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function normalizeReference(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.trim().replace(/[.,;:]$/, "");
}

function isHarnessArtifactPath(path: string): boolean {
  return path.startsWith(".review-agent/");
}

function isUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function looksLikeDocumentationPath(value: string): boolean {
  return /^(?:\.\/)?(?:docs\/|README[\w./-]*)/i.test(value);
}

type CommandRunner = (
  cmd: readonly string[],
  cwd: string,
) => Promise<string | undefined>;

async function runCommand(cmd: readonly string[], cwd: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn({ cmd: [...cmd], cwd, stdout: "pipe", stderr: "pipe" });
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
