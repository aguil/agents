import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  CODE_REVIEW_ROLE_IDS,
  type CodeReviewRoleId,
  expectedRolesForTriageTier,
  parseCodeReviewRunMetadata,
  roleReviewSectionLabel,
} from "@aguil/agents-code-review";
import type { Finding } from "@aguil/agents-core";
import {
  AGENTS_CODE_REVIEW_DIR,
  agentsCodeReviewDryRunRoot,
  LEGACY_AGENTS_CODE_REVIEW_DIR,
  legacyAgentsCodeReviewDryRunRoot,
  resolveGitAwarePath,
} from "@aguil/agents-core";
import { findingFingerprint, severityEmoji } from "@aguil/agents-reporting";

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

export interface PendingReviewPosted {
  readonly cancelled?: false;
  readonly reviewId: number;
  readonly prNumber: number;
  readonly commentCount: number;
  readonly url: string;
  readonly currentHeadSha?: string;
  readonly headDiverged: boolean;
}

export interface PendingReviewCancelled {
  readonly cancelled: true;
  readonly currentHeadSha?: string;
  readonly headDiverged: boolean;
}

export type PendingReviewPostResult =
  | PendingReviewPosted
  | PendingReviewCancelled;

interface PendingReviewFindingCache {
  readonly version: 1;
  readonly repo: string;
  readonly prNumber: number;
  readonly updatedAt: string;
  readonly findings: ReadonlyArray<{
    readonly fingerprint: string;
    readonly threadId: string;
  }>;
}
export function parsePrNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (!/^[1-9]\d*$/.test(trimmed)) {
    return undefined;
  }
  return Number.parseInt(trimmed, 10);
}
export interface StoredReviewResult {
  readonly findings: readonly Finding[];
  readonly metadata?: Readonly<Record<string, string>>;
  readonly runId?: string;
}
export async function resolvedResultPathIsUnderCodeReviewDryRunRoot(
  workspacePath: string,
  resultPath: string,
): Promise<boolean> {
  try {
    const wsReal = await realpath(workspacePath);
    const resReal = await realpath(resultPath);
    const dryRoots = [
      agentsCodeReviewDryRunRoot(wsReal),
      legacyAgentsCodeReviewDryRunRoot(wsReal),
    ];
    for (const dryRoot of dryRoots) {
      if (resReal === dryRoot || resReal.startsWith(`${dryRoot}${sep}`)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
export async function discoverLatestResultPath(
  workspacePath: string,
): Promise<string | undefined> {
  const { discoverLatestRunsCodeReviewResultPath } = await import(
    "@aguil/agents-triage"
  );
  return discoverLatestRunsCodeReviewResultPath(workspacePath);
}

export async function loadStoredReviewResult(
  resultPath: string,
): Promise<StoredReviewResult> {
  const raw = await readFile(resultPath, "utf8");
  const parsed = JSON.parse(raw) as {
    readonly findings?: unknown;
    readonly metadata?: unknown;
    readonly runId?: unknown;
  };
  if (!Array.isArray(parsed.findings)) {
    throw new Error(
      `Invalid result JSON at ${resultPath}: missing findings array.`,
    );
  }
  const findings = parsed.findings as Finding[];
  const metadata =
    typeof parsed.metadata === "object" && parsed.metadata !== null
      ? (parsed.metadata as Record<string, string>)
      : undefined;
  const runId =
    typeof parsed.runId === "string" && parsed.runId.trim().length > 0
      ? parsed.runId.trim()
      : undefined;
  return {
    findings,
    metadata,
    runId,
  };
}

export function parseReviewSummaryStyle(
  value: string | undefined,
): ReviewSummaryStyle | undefined {
  if (value === undefined) {
    return "impact";
  }
  if (value === "triage" || value === "impact" || value === "evidence") {
    return value;
  }
  return undefined;
}
export interface ReviewPostProvenance {
  readonly reviewerLogin?: string;
  readonly runId?: string;
  readonly runMetadata?: Readonly<Record<string, string>>;
}

export function findingsToPendingReviewComments(
  findings: readonly Finding[],
  provenance?: ReviewPostProvenance,
): readonly PendingReviewComment[] {
  return findings
    .filter(
      (finding) => finding.file !== undefined && finding.line !== undefined,
    )
    .map((finding) => ({
      path: finding.file as string,
      line: finding.line as number,
      side: "RIGHT" as const,
      body: formatPendingReviewBody(finding, provenance),
    }));
}

/** Maps PR-changed file paths to right-side line -> pull request review `position`. */
export type PullRequestDiffContext = ReadonlyMap<
  string,
  ReadonlyMap<number, number>
>;

export function resolveReviewDiffPosition(
  path: string,
  line: number,
  context: PullRequestDiffContext,
): number | undefined {
  return context.get(path)?.get(line);
}

/**
 * Earliest unified-diff `position` in the first PR changed file that has hunk
 * mappings. Used to anchor the pending-review summary as an inline comment so
 * GitHub's "Finish review" UI does not overwrite API-authored review `body`
 * text with an empty submission.
 */
export function firstAnchorableDiffReviewPosition(
  context: PullRequestDiffContext,
): { readonly path: string; readonly position: number } | undefined {
  for (const [path, lineMap] of context) {
    if (lineMap.size === 0) {
      continue;
    }
    let minPos = Infinity;
    for (const [, pos] of lineMap) {
      if (pos < minPos) {
        minPos = pos;
      }
    }
    if (minPos !== Infinity) {
      return { path, position: minPos };
    }
  }
  return undefined;
}

function anchorKey(path: string, position: number): string {
  return `${path}\0${position}`;
}

/**
 * Like {@link firstAnchorableDiffReviewPosition}, but skips diff positions already
 * used by inline finding comments. GitHub rejects `POST .../pulls/{n}/reviews` with
 * HTTP 422 when the same `path` + `position` appears twice in one payload.
 */
export function firstNonCollidingAnchorableDiffReviewPosition(
  context: PullRequestDiffContext,
  usedPositions: ReadonlySet<string>,
): { readonly path: string; readonly position: number } | undefined {
  for (const [path, lineMap] of context) {
    if (lineMap.size === 0) {
      continue;
    }
    let minPos = Infinity;
    for (const [, pos] of lineMap) {
      if (usedPositions.has(anchorKey(path, pos))) {
        continue;
      }
      if (pos < minPos) {
        minPos = pos;
      }
    }
    if (minPos !== Infinity) {
      return { path, position: minPos };
    }
  }
  return undefined;
}

/**
 * When PR diff context is known, explains why a finding will not get an inline review thread.
 * Returns undefined when the finding anchors to a postable PR diff line.
 */
export function findingInlinePostingCaption(
  finding: Finding,
  context: PullRequestDiffContext,
): string | undefined {
  if (finding.file === undefined || finding.file === "") {
    return finding.line === undefined
      ? "summary only (no file:line anchor)"
      : "summary only (no file path for line anchor)";
  }
  if (!context.has(finding.file)) {
    return "summary only (file is not in this PR's changed files)";
  }
  if (finding.line === undefined) {
    return "summary only (no line on PR diff; add a hunk line for an inline thread)";
  }
  const positions = context.get(finding.file);
  if (positions?.get(finding.line) === undefined) {
    return "summary only (line is not on a PR diff hunk)";
  }
  return undefined;
}

/** True when `file` is set but is not among this PR's changed paths (from the files API). */
export function findingUsesFileNotInPrChangedFiles(
  finding: Finding,
  context: PullRequestDiffContext,
): boolean {
  return (
    finding.file !== undefined &&
    finding.file !== "" &&
    !context.has(finding.file)
  );
}

/** True when the finding has file+line but that anchor cannot map to a PR review diff position. */
export function findingHasNonPostablePrLineAnchor(
  finding: Finding,
  context: PullRequestDiffContext,
): boolean {
  if (finding.file === undefined || finding.line === undefined) {
    return false;
  }
  return (
    resolveReviewDiffPosition(finding.file, finding.line, context) === undefined
  );
}

export function warnPrAnchorIssues(
  findings: readonly Finding[],
  context: PullRequestDiffContext,
): void {
  const wrongFile = findings.filter((finding) =>
    findingUsesFileNotInPrChangedFiles(finding, context),
  );
  if (wrongFile.length > 0) {
    const sample = wrongFile
      .slice(0, 3)
      .map((f) => `"${f.title}" (file: ${f.file})`)
      .join("; ");
    const more = wrongFile.length > 3 ? ` (+${wrongFile.length - 3} more)` : "";
    console.warn(
      `${wrongFile.length} finding(s) use \`file\` not in this PR's changed-files list. ${sample}${more}`,
    );
  }
  const wrongHunk = findings.filter((finding) => {
    if (
      finding.file === undefined ||
      finding.line === undefined ||
      finding.file === "" ||
      !context.has(finding.file)
    ) {
      return false;
    }
    return (
      resolveReviewDiffPosition(finding.file, finding.line, context) ===
      undefined
    );
  });
  if (wrongHunk.length > 0) {
    const sample = wrongHunk
      .slice(0, 3)
      .map((f) => `"${f.title}" (${f.file}:${f.line})`)
      .join("; ");
    const more = wrongHunk.length > 3 ? ` (+${wrongHunk.length - 3} more)` : "";
    console.warn(
      `${wrongHunk.length} finding(s) cite file:line not on a PR diff hunk (no inline review thread). ${sample}${more}`,
    );
  }
}

function formatPendingReviewBody(
  finding: Finding,
  provenance?: ReviewPostProvenance,
): string {
  const footer = formatInlineReviewProvenanceFooter(finding, provenance);
  return [
    `### ${severityEmoji(finding.severity)} ${finding.title}`,
    "",
    finding.description,
    "",
    `Evidence: ${finding.evidence}`,
    `Validation: ${finding.validation.status} - ${finding.validation.details}`,
    ...(footer === undefined ? [] : ["", footer]),
    "",
    `<!-- finding:${findingFingerprint(finding)} -->`,
  ].join("\n");
}

export interface ReplacePendingPullRequestReviewInput {
  readonly findings: readonly Finding[];
  readonly prNumber?: number;
  readonly reviewSummaryStyle: ReviewSummaryStyle;
  readonly reviewedHeadSha?: string;
  readonly noConfirm: boolean;
  /** When true, cancel instead of posting if PR head moved since review. */
  readonly abortOnStaleHead?: boolean;
  readonly replacePendingReview: boolean;
  readonly workspacePath?: string;
  readonly preloadedPrDiffContext?: PullRequestDiffContext;
  /** From harness result metadata (result.json) for review coverage in the summary body. */
  readonly runMetadata?: Readonly<Record<string, string>>;
  readonly runId?: string;
}

export async function replacePendingPullRequestReview(
  input: ReplacePendingPullRequestReviewInput,
): Promise<PendingReviewPostResult> {
  const workspacePath = resolveWorkspaceCwd(input.workspacePath);
  const repo = await getRepoNameWithOwner(workspacePath);
  const login = await getViewerLogin(workspacePath);
  const postProvenance: ReviewPostProvenance = {
    reviewerLogin: login,
    runId:
      input.runId?.trim() || input.runMetadata?.run_id?.trim() || undefined,
    runMetadata: input.runMetadata,
  };
  const prNumber =
    input.prNumber ?? (await getCurrentPullRequestNumber(repo, workspacePath));
  const reviewedHeadSha = input.reviewedHeadSha?.trim();
  const currentHeadSha = await fetchPullRequestHeadSha(
    repo,
    prNumber,
    workspacePath,
  );
  const headDiverged =
    reviewedHeadSha !== undefined &&
    reviewedHeadSha.length > 0 &&
    currentHeadSha !== undefined &&
    reviewedHeadSha !== currentHeadSha;

  if (headDiverged) {
    console.warn(
      `Warning: PR #${prNumber} has updates after this review context (${reviewedHeadSha.slice(0, 12)} -> ${currentHeadSha.slice(0, 12)}).`,
    );
    if (input.abortOnStaleHead === true) {
      console.log("Skipped pending review publish (stale PR head).");
      return {
        cancelled: true,
        currentHeadSha,
        headDiverged,
      };
    }
    const confirmed = await confirmProceedAfterStaleness(input.noConfirm);
    if (!confirmed) {
      console.log("Skipped pending review publish.");
      return {
        cancelled: true,
        currentHeadSha,
        headDiverged,
      };
    }
  }

  const localAhead = await checkLocalAheadOfPullRequest({
    currentHeadSha,
    prNumber,
    workspacePath,
  });
  if (localAhead.status === "ahead") {
    console.warn(
      `Warning: local checkout is ahead of PR #${prNumber} (${localAhead.prHeadSha.slice(0, 12)} -> ${localAhead.localHeadSha.slice(0, 12)}).`,
    );
    const confirmed = await confirmProceedAfterLocalAhead(input.noConfirm);
    if (!confirmed) {
      console.log("Skipped pending review publish.");
      return {
        cancelled: true,
        currentHeadSha,
        headDiverged,
      };
    }
  }

  const reviews = await ghApi<readonly GitHubPullRequestReview[]>(
    `repos/${repo}/pulls/${prNumber}/reviews`,
    "GET",
    undefined,
    workspacePath,
  );
  const pendingMine = reviews.filter(
    (review) => review.state === "PENDING" && review.user.login === login,
  );

  // Only pay the resolved-thread scan cost when we're actually replacing an
  // existing pending review. First-time pending review publishing should stay
  // lightweight.
  let findings = input.findings;
  if (pendingMine.length > 0) {
    if (!input.replacePendingReview) {
      const confirmed = await confirmReplacePendingReview({
        noConfirm: input.noConfirm,
        prNumber,
        pendingCount: pendingMine.length,
      });
      if (!confirmed) {
        console.log("Skipped pending review publish.");
        return {
          cancelled: true,
          currentHeadSha,
          headDiverged,
        };
      }
    }

    const candidateFingerprints = new Set(
      findings.map((finding) => findingFingerprint(finding)),
    );
    if (candidateFingerprints.size > 0) {
      const allowedAuthors = new Set([login]);
      const suppressedFromCache = await suppressFingerprintsFromLocalCache({
        repo,
        prNumber,
        workspacePath,
        wanted: candidateFingerprints,
      });

      let suppressedFingerprints = suppressedFromCache;
      const remaining = new Set(
        [...candidateFingerprints].filter(
          (fp) => !suppressedFingerprints.has(fp),
        ),
      );
      if (remaining.size > 0) {
        const fromScan = await fetchResolvedFindingFingerprints({
          repo,
          prNumber,
          workspacePath,
          wanted: remaining,
          allowedAuthors,
        });
        suppressedFingerprints = new Set([
          ...suppressedFingerprints,
          ...fromScan,
        ]);
      }

      if (suppressedFingerprints.size > 0) {
        findings = findings.filter(
          (finding) => !suppressedFingerprints.has(findingFingerprint(finding)),
        );
      }
    }
  }

  const rawComments = findingsToPendingReviewComments(findings, postProvenance);
  const diffContext =
    input.preloadedPrDiffContext ??
    (await loadPullRequestDiffContext(repo, prNumber, workspacePath));
  warnPrAnchorIssues(findings, diffContext);
  const comments = rawComments
    .map((candidate) => candidateToComment(candidate, diffContext))
    .filter(
      (comment): comment is GitHubPendingReviewCommentInput =>
        comment !== undefined,
    );
  const skippedUnanchorable = rawComments.length - comments.length;

  if (pendingMine.length > 0) {
    for (const review of pendingMine) {
      await ghApi<void>(
        `repos/${repo}/pulls/${prNumber}/reviews/${review.id}`,
        "DELETE",
        undefined,
        workspacePath,
      );
    }
  }

  const summaryBody = buildPendingReviewSummaryBody({
    style: input.reviewSummaryStyle,
    findings,
    postedCommentCount: comments.length,
    skippedUnanchorable,
    prDiffContext: diffContext,
    runMetadata: input.runMetadata,
    provenance: postProvenance,
  });

  const usedAnchorKeys = new Set(
    comments.map((c) => anchorKey(c.path, c.position)),
  );
  const summaryAnchor = firstNonCollidingAnchorableDiffReviewPosition(
    diffContext,
    usedAnchorKeys,
  );
  const commentsForApi: readonly GitHubPendingReviewCommentInput[] =
    summaryAnchor !== undefined
      ? [
          {
            path: summaryAnchor.path,
            position: summaryAnchor.position,
            body: summaryBody,
          },
          ...comments,
        ]
      : comments;
  const reviewBody = summaryAnchor !== undefined ? "" : summaryBody;

  const created = await ghApi<{
    readonly id: number;
    readonly html_url: string;
  }>(
    `repos/${repo}/pulls/${prNumber}/reviews`,
    "POST",
    {
      ...(currentHeadSha !== undefined ? { commit_id: currentHeadSha } : {}),
      body: reviewBody,
      comments: commentsForApi,
    },
    workspacePath,
  );

  // Best-effort cache update: map fingerprints from posted comments to thread IDs.
  // This lets future replacement checks query a small set of known threads rather
  // than scanning all PR threads.
  if (pendingMine.length > 0) {
    try {
      await updateLocalFindingThreadCacheAfterPost({
        repo,
        prNumber,
        reviewId: created.id,
        workspacePath,
        allowedAuthors: new Set([login]),
      });
    } catch {
      // Best-effort only.
    }
  }

  return {
    reviewId: created.id,
    prNumber,
    commentCount: commentsForApi.length,
    url: created.html_url,
    currentHeadSha,
    headDiverged,
  };
}

function sanitizeRepoForCache(repo: string): string {
  return repo.replaceAll("/", "__");
}

function findingCachePath(
  workspacePath: string,
  repo: string,
  prNumber: number,
): string {
  return join(
    workspacePath,
    AGENTS_CODE_REVIEW_DIR,
    "pr-cache",
    sanitizeRepoForCache(repo),
    `pr-${prNumber}`,
    "finding-threads.json",
  );
}

function legacyFindingCachePath(
  workspacePath: string,
  repo: string,
  prNumber: number,
): string {
  return join(
    workspacePath,
    LEGACY_AGENTS_CODE_REVIEW_DIR,
    "pr-cache",
    sanitizeRepoForCache(repo),
    `pr-${prNumber}`,
    "finding-threads.json",
  );
}

function parsePendingFindingCache(
  raw: string,
  repo: string,
  prNumber: number,
): PendingReviewFindingCache | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<PendingReviewFindingCache>;
    if (
      parsed.version !== 1 ||
      parsed.repo !== repo ||
      parsed.prNumber !== prNumber ||
      !Array.isArray(parsed.findings)
    ) {
      return undefined;
    }
    return parsed as PendingReviewFindingCache;
  } catch {
    return undefined;
  }
}

async function loadLocalFindingThreadCache(
  workspacePath: string,
  repo: string,
  prNumber: number,
): Promise<PendingReviewFindingCache | undefined> {
  const primaryPath = findingCachePath(workspacePath, repo, prNumber);
  let primaryRaw: string | undefined;
  try {
    primaryRaw = await readFile(primaryPath, "utf8");
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return undefined;
    }
    primaryRaw = undefined;
  }
  if (primaryRaw !== undefined) {
    return parsePendingFindingCache(primaryRaw, repo, prNumber);
  }
  try {
    const legacyRaw = await readFile(
      legacyFindingCachePath(workspacePath, repo, prNumber),
      "utf8",
    );
    return parsePendingFindingCache(legacyRaw, repo, prNumber);
  } catch {
    return undefined;
  }
}

async function writeLocalFindingThreadCache(
  workspacePath: string,
  cache: PendingReviewFindingCache,
): Promise<void> {
  const path = findingCachePath(workspacePath, cache.repo, cache.prNumber);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

async function suppressFingerprintsFromLocalCache(input: {
  readonly repo: string;
  readonly prNumber: number;
  readonly workspacePath: string;
  readonly wanted: ReadonlySet<string>;
}): Promise<Set<string>> {
  const cache = await loadLocalFindingThreadCache(
    input.workspacePath,
    input.repo,
    input.prNumber,
  );
  if (cache === undefined) {
    return new Set();
  }

  const wantedThreadIds = new Map<string, string>();
  for (const entry of cache.findings) {
    if (input.wanted.has(entry.fingerprint)) {
      wantedThreadIds.set(entry.fingerprint, entry.threadId);
    }
  }
  if (wantedThreadIds.size === 0) {
    return new Set();
  }

  const uniqueThreadIds = [...new Set(wantedThreadIds.values())];
  // `gh api graphql -f ids=[...]` treats the entire bracketed string as one ID; send variables
  // as JSON via --input instead (matches GitHub's expected { query, variables } shape).
  const response = await runGhGraphql<{
    readonly data?: {
      readonly nodes?: ReadonlyArray<
        | { readonly id: string; readonly isResolved?: boolean }
        | { readonly id: string; readonly isResolved?: boolean } // same shape for thread nodes
        | null
      >;
    };
  }>(
    {
      query:
        "query($ids:[ID!]!){nodes(ids:$ids){... on PullRequestReviewThread{id isResolved}}}",
      variables: { ids: uniqueThreadIds },
    },
    input.workspacePath,
  );

  const resolvedThreads = new Set<string>();
  for (const node of response.data?.nodes ?? []) {
    if (node && node.isResolved === true) {
      resolvedThreads.add(node.id);
    }
  }

  const suppressed = new Set<string>();
  for (const [fingerprint, threadId] of wantedThreadIds.entries()) {
    if (resolvedThreads.has(threadId)) {
      suppressed.add(fingerprint);
    }
  }
  return suppressed;
}

async function updateLocalFindingThreadCacheAfterPost(input: {
  readonly repo: string;
  readonly prNumber: number;
  readonly reviewId: number;
  readonly workspacePath: string;
  readonly allowedAuthors: ReadonlySet<string>;
}): Promise<void> {
  const reviewComments = await ghApi<
    ReadonlyArray<{ readonly node_id: string; readonly body: string }>
  >(
    `repos/${input.repo}/pulls/${input.prNumber}/reviews/${input.reviewId}/comments`,
    "GET",
    undefined,
    input.workspacePath,
  );

  const commentIdsToFingerprint = new Map<string, string>();
  for (const comment of reviewComments) {
    const matches = comment.body.matchAll(/<!--\s*finding:([^>]+?)\s*-->/g);
    for (const match of matches) {
      const fp = match[1]?.trim();
      if (fp) {
        commentIdsToFingerprint.set(comment.node_id, fp);
      }
    }
  }
  if (commentIdsToFingerprint.size === 0) {
    return;
  }

  // Prefer the most recent threads first: fresh pending-review comments almost always
  // land on recent threads, so `last` + `before` avoids scanning from the start of
  // long PR histories in the common case.
  const query = [
    "query($o:String!,$r:String!,$n:Int!,$before:String){",
    "repository(owner:$o,name:$r){",
    "pullRequest(number:$n){",
    "reviewThreads(last:100,before:$before){",
    "pageInfo{hasPreviousPage startCursor}",
    "nodes{id comments(first:50){nodes{id author{login}}}}",
    "}",
    "}",
    "}",
    "}",
  ].join("");

  const [owner, name] = input.repo.split("/");
  if (!owner || !name) {
    return;
  }

  const found = new Map<string, string>(); // fingerprint -> threadId
  let beforeCursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const resp = await runGh<{
      readonly data?: {
        readonly repository?: {
          readonly pullRequest?: {
            readonly reviewThreads?: {
              readonly pageInfo?: {
                readonly hasPreviousPage?: boolean;
                readonly startCursor?: string | null;
              };
              readonly nodes?: ReadonlyArray<{
                readonly id: string;
                readonly comments?: {
                  readonly nodes?: ReadonlyArray<{
                    readonly id: string;
                    readonly author?: { readonly login?: string };
                  }>;
                };
              }>;
            };
          };
        };
      };
    }>(
      [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-f",
        `o=${owner}`,
        "-f",
        `r=${name}`,
        "-F",
        `n=${input.prNumber}`,
        ...(beforeCursor !== undefined ? ["-f", `before=${beforeCursor}`] : []),
      ],
      input.workspacePath,
    );

    for (const thread of resp.data?.repository?.pullRequest?.reviewThreads
      ?.nodes ?? []) {
      for (const comment of thread.comments?.nodes ?? []) {
        const authorLogin = comment.author?.login;
        if (
          typeof authorLogin !== "string" ||
          !input.allowedAuthors.has(authorLogin)
        ) {
          continue;
        }
        const fingerprint = commentIdsToFingerprint.get(comment.id);
        if (fingerprint) {
          found.set(fingerprint, thread.id);
        }
      }
    }

    if (found.size >= commentIdsToFingerprint.size) {
      break;
    }
    const pageInfo =
      resp.data?.repository?.pullRequest?.reviewThreads?.pageInfo;
    if (pageInfo?.hasPreviousPage !== true) {
      break;
    }
    const startCursor = pageInfo.startCursor ?? undefined;
    if (startCursor === undefined || startCursor.length === 0) {
      break;
    }
    beforeCursor = startCursor;
  }

  if (found.size === 0) {
    return;
  }

  const existing = await loadLocalFindingThreadCache(
    input.workspacePath,
    input.repo,
    input.prNumber,
  );
  const merged = new Map<string, string>();
  for (const entry of existing?.findings ?? []) {
    merged.set(entry.fingerprint, entry.threadId);
  }
  for (const [fp, threadId] of found.entries()) {
    merged.set(fp, threadId);
  }

  await writeLocalFindingThreadCache(input.workspacePath, {
    version: 1,
    repo: input.repo,
    prNumber: input.prNumber,
    updatedAt: new Date().toISOString(),
    findings: [...merged.entries()].map(([fingerprint, threadId]) => ({
      fingerprint,
      threadId,
    })),
  });
}

async function fetchResolvedFindingFingerprints(input: {
  readonly repo: string;
  readonly prNumber: number;
  readonly workspacePath?: string;
  readonly wanted: ReadonlySet<string>;
  readonly allowedAuthors: ReadonlySet<string>;
}): Promise<ReadonlySet<string>> {
  const [owner, name] = input.repo.split("/");
  if (!owner || !name) {
    return new Set();
  }

  const suppressed = new Set<string>();
  const marker = /<!--\s*finding:([^>]+?)\s*-->/g;

  const query = [
    "query($o:String!,$r:String!,$n:Int!,$after:String){",
    "repository(owner:$o,name:$r){",
    "pullRequest(number:$n){",
    "reviewThreads(first:100,after:$after){",
    "pageInfo{hasNextPage endCursor}",
    "nodes{isResolved comments(first:10){nodes{body author{login}}}}",
    "}",
    "}",
    "}",
    "}",
  ].join("");

  let after: string | undefined;
  /** True when the last fetched page still had a next page but we stopped due to the page cap. */
  let cappedWithMorePages = false;
  for (let page = 0; page < 10; page++) {
    const response = await runGh<{
      readonly data?: {
        readonly repository?: {
          readonly pullRequest?: {
            readonly reviewThreads?: {
              readonly pageInfo?: {
                readonly hasNextPage?: boolean;
                readonly endCursor?: string | null;
              };
              readonly nodes?: ReadonlyArray<{
                readonly isResolved?: boolean;
                readonly comments?: {
                  readonly nodes?: ReadonlyArray<{
                    readonly body?: string;
                    readonly author?: { readonly login?: string };
                  }>;
                };
              }>;
            };
          };
        };
      };
    }>(
      [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-f",
        `o=${owner}`,
        "-f",
        `r=${name}`,
        "-F",
        `n=${input.prNumber}`,
        ...(after !== undefined ? ["-f", `after=${after}`] : []),
      ],
      input.workspacePath,
    );

    const threads =
      response.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    for (const thread of threads) {
      if (thread.isResolved !== true) {
        continue;
      }
      for (const comment of thread.comments?.nodes ?? []) {
        const body = comment.body;
        if (typeof body !== "string") {
          continue;
        }
        const authorLogin = comment.author?.login;
        if (
          typeof authorLogin !== "string" ||
          !input.allowedAuthors.has(authorLogin)
        ) {
          continue;
        }
        for (const match of body.matchAll(marker)) {
          const fingerprint = match[1]?.trim();
          if (fingerprint && input.wanted.has(fingerprint)) {
            suppressed.add(fingerprint);
          }
        }
      }
    }

    if (suppressed.size >= input.wanted.size) {
      break;
    }
    const pageInfo =
      response.data?.repository?.pullRequest?.reviewThreads?.pageInfo;
    if (pageInfo?.hasNextPage !== true) {
      break;
    }
    const endCursor = pageInfo.endCursor ?? undefined;
    if (endCursor === undefined || endCursor.length === 0) {
      break;
    }
    after = endCursor;
    if (page === 9) {
      cappedWithMorePages = true;
      break;
    }
  }

  if (suppressed.size < input.wanted.size && cappedWithMorePages) {
    console.warn(
      "Warning: resolved-thread suppression scan hit its pagination limit; some resolved findings may be reposted.",
    );
  }

  return suppressed;
}

async function checkLocalAheadOfPullRequest(input: {
  readonly currentHeadSha: string | undefined;
  readonly prNumber: number;
  readonly workspacePath: string;
}): Promise<
  | { readonly status: "unavailable" }
  | { readonly status: "ok" }
  | {
      readonly status: "ahead";
      readonly prHeadSha: string;
      readonly localHeadSha: string;
    }
> {
  const prHeadSha = input.currentHeadSha?.trim();
  if (prHeadSha === undefined || prHeadSha.length === 0) {
    return { status: "unavailable" };
  }

  const localHeadSha = (
    await runCommand(["git", "rev-parse", "HEAD"], input.workspacePath, {
      gitAware: true,
    })
  )?.trim();
  if (localHeadSha === undefined || localHeadSha.length === 0) {
    return { status: "unavailable" };
  }
  if (localHeadSha === prHeadSha) {
    return { status: "ok" };
  }

  // Local is "ahead" if the PR head is reachable from local HEAD.
  const ancestorCheck = await runCommand(
    ["git", "merge-base", "--is-ancestor", prHeadSha, localHeadSha],
    input.workspacePath,
    { gitAware: true },
  );
  if (ancestorCheck !== undefined) {
    return { status: "ahead", prHeadSha, localHeadSha };
  }

  return { status: "ok" };
}

export async function checkReviewPullRequestDivergence(
  metadata: Readonly<Record<string, string>> | undefined,
  workspacePathInput?: string,
): Promise<
  | { readonly status: "unavailable" }
  | {
      readonly status: "ok" | "diverged";
      readonly prNumber: number;
      readonly reviewedHeadSha: string;
      readonly currentHeadSha: string;
    }
> {
  if (metadata === undefined) {
    return { status: "unavailable" };
  }
  const prNumber = parsePrNumber(metadata.pr_number);
  const reviewedHeadSha = metadata.pr_reviewed_head_sha?.trim();
  if (
    prNumber === undefined ||
    reviewedHeadSha === undefined ||
    reviewedHeadSha.length === 0
  ) {
    return { status: "unavailable" };
  }

  const workspacePath = resolveWorkspaceCwd(workspacePathInput);
  const repo = await getRepoNameWithOwner(workspacePath);
  const currentHeadSha = await fetchPullRequestHeadSha(
    repo,
    prNumber,
    workspacePath,
  );
  if (currentHeadSha === undefined || currentHeadSha.length === 0) {
    return { status: "unavailable" };
  }

  return {
    status: reviewedHeadSha === currentHeadSha ? "ok" : "diverged",
    prNumber,
    reviewedHeadSha,
    currentHeadSha,
  };
}

async function confirmProceedAfterStaleness(
  noConfirm: boolean,
): Promise<boolean> {
  if (noConfirm) {
    return true;
  }
  if (process.platform === "win32") {
    console.warn(
      "Interactive prompt is unsupported on Windows. Re-run with --no-confirm.",
    );
    return false;
  }
  if (process.stdin.isTTY !== true) {
    console.warn(
      "Non-interactive stdin detected. Re-run with --no-confirm to post anyway.",
    );
    return false;
  }
  process.stdout.write("Post pending review anyway? [y/N] ");
  const reader = Bun.stdin.stream().getReader();
  try {
    const { value } = await reader.read();
    const answer =
      value === undefined
        ? ""
        : new TextDecoder().decode(value).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }
}

async function confirmProceedAfterLocalAhead(
  noConfirm: boolean,
): Promise<boolean> {
  if (noConfirm) {
    return true;
  }
  if (process.platform === "win32") {
    console.warn(
      "Interactive prompt is unsupported on Windows. Re-run with --no-confirm.",
    );
    return false;
  }
  if (process.stdin.isTTY !== true) {
    console.warn(
      "Non-interactive stdin detected. Re-run with --no-confirm to post anyway.",
    );
    return false;
  }
  process.stdout.write("Post pending review anyway? [y/N] ");
  const reader = Bun.stdin.stream().getReader();
  try {
    const { value } = await reader.read();
    const answer =
      value === undefined
        ? ""
        : new TextDecoder().decode(value).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }
}

async function confirmReplacePendingReview(input: {
  readonly noConfirm: boolean;
  readonly prNumber: number;
  readonly pendingCount: number;
}): Promise<boolean> {
  if (input.noConfirm) {
    console.warn(
      "Non-interactive pending review replacement requires --replace-pending-review.",
    );
    return false;
  }
  if (process.platform === "win32") {
    console.warn(
      "Interactive prompt is unsupported on Windows. Re-run with --replace-pending-review and --no-confirm.",
    );
    return false;
  }
  if (process.stdin.isTTY !== true) {
    console.warn(
      "Non-interactive stdin detected. Re-run with --replace-pending-review (and --no-confirm if other prompts apply).",
    );
    return false;
  }
  const plural = input.pendingCount === 1 ? "" : "s";
  process.stdout.write(
    `Replace your existing pending review${plural} (${input.pendingCount}) on PR #${input.prNumber}? [y/N] `,
  );
  const reader = Bun.stdin.stream().getReader();
  try {
    const { value } = await reader.read();
    const answer =
      value === undefined
        ? ""
        : new TextDecoder().decode(value).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }
}

export function buildPendingReviewSummaryBody(input: {
  readonly style: ReviewSummaryStyle;
  readonly findings: readonly Finding[];
  readonly postedCommentCount: number;
  readonly skippedUnanchorable: number;
  readonly prDiffContext?: PullRequestDiffContext;
  /** Harness run metadata (e.g. from result.json) for review coverage / triage. */
  readonly runMetadata?: Readonly<Record<string, string>>;
  /** Human reviewer + agent adapter attribution for the posted review. */
  readonly provenance?: ReviewPostProvenance;
}): string {
  const provenance: ReviewPostProvenance = input.provenance ?? {
    runMetadata: input.runMetadata,
  };
  switch (input.style) {
    case "triage":
      return renderTriageSummary(
        input.findings,
        input.postedCommentCount,
        input.skippedUnanchorable,
        input.prDiffContext,
        input.runMetadata,
        provenance,
      );
    case "impact":
      return renderImpactSummary(
        input.findings,
        input.postedCommentCount,
        input.skippedUnanchorable,
        input.prDiffContext,
        input.runMetadata,
        provenance,
      );
    case "evidence":
      return renderEvidenceSummary(
        input.findings,
        input.postedCommentCount,
        input.skippedUnanchorable,
        input.prDiffContext,
        input.runMetadata,
        provenance,
      );
  }
}

function triageTierRationale(tier: "trivial" | "lite" | "full"): string {
  if (tier === "trivial") {
    return "Triage tier **trivial**: only correctness/quality review is scheduled (small or low-risk change per context bundle).";
  }
  if (tier === "lite") {
    return "Triage tier **lite**: security, quality, and compliance run; runtime/performance is not scheduled for this scope.";
  }
  return "Triage tier **full**: all review dimensions are scheduled.";
}

function metadataString(
  record: Readonly<Record<string, string>> | undefined,
  key: string,
): string | undefined {
  const raw = record?.[key]?.trim() ?? "";
  return raw.length > 0 ? raw : undefined;
}

/** Model id recorded for the active adapter in harness run metadata. */
export function resolveAdapterModelFromMetadata(
  runMetadata: Readonly<Record<string, string>> | undefined,
): string | undefined {
  const adapter = metadataString(runMetadata, "adapter");
  if (adapter === "opencode") {
    return metadataString(runMetadata, "opencode_model");
  }
  if (adapter === "claude") {
    return metadataString(runMetadata, "claude_model");
  }
  if (adapter === "cursor") {
    return metadataString(runMetadata, "cursor_model");
  }
  return (
    metadataString(runMetadata, "cursor_model") ??
    metadataString(runMetadata, "claude_model") ??
    metadataString(runMetadata, "opencode_model")
  );
}

function formatAgentProviderLabel(
  runMetadata: Readonly<Record<string, string>> | undefined,
): string | undefined {
  const adapter = metadataString(runMetadata, "adapter");
  if (adapter === undefined) {
    return undefined;
  }
  const model = resolveAdapterModelFromMetadata(runMetadata);
  return model === undefined ? adapter : `${adapter} (${model})`;
}

/**
 * Markdown lines for human reviewer + harness agent attribution; empty when no signal.
 */
export function formatReviewProvenanceSectionLines(
  provenance: ReviewPostProvenance | undefined,
): readonly string[] {
  const runMetadata = provenance?.runMetadata;
  const reviewer = provenance?.reviewerLogin?.trim();
  const agent = formatAgentProviderLabel(runMetadata);
  const runId =
    provenance?.runId?.trim() || metadataString(runMetadata, "run_id");
  const consensusRuns = metadataString(runMetadata, "consensus_runs");
  const consensusMode = metadataString(runMetadata, "consensus_mode");
  const contextSource = metadataString(runMetadata, "context_source");

  const hasSignal =
    (reviewer !== undefined && reviewer.length > 0) ||
    agent !== undefined ||
    runId !== undefined ||
    (consensusRuns !== undefined && consensusRuns !== "1") ||
    contextSource === "replay";

  if (!hasSignal) {
    return [];
  }

  const lines: string[] = ["", "### Review provenance"];
  if (reviewer !== undefined && reviewer.length > 0) {
    lines.push(`- Reviewer: @${reviewer}`);
  }
  if (agent !== undefined) {
    lines.push(`- Agent: ${agent}`);
  }
  if (runId !== undefined) {
    lines.push(`- Run: \`${runId}\``);
  }
  if (consensusRuns !== undefined && consensusRuns !== "1") {
    const mode =
      consensusMode !== undefined && consensusMode.length > 0
        ? ` (${consensusMode})`
        : "";
    lines.push(`- Consensus: ${consensusRuns} pass(es)${mode}`);
  }
  if (contextSource === "replay") {
    lines.push("- Context: replayed from prior bundle");
  }
  return lines;
}

function formatInlineReviewProvenanceFooter(
  finding: Finding,
  provenance: ReviewPostProvenance | undefined,
): string | undefined {
  const reviewer = provenance?.reviewerLogin?.trim();
  const agent = formatAgentProviderLabel(provenance?.runMetadata);
  const roleRaw = finding.sourceRole?.trim() ?? "";
  const role = roleRaw.length > 0 ? roleReviewSectionLabel(roleRaw) : undefined;

  const parts: string[] = [];
  if (reviewer !== undefined && reviewer.length > 0) {
    parts.push(`@${reviewer}`);
  }
  if (agent !== undefined) {
    parts.push(`Agent: ${agent}`);
  }
  if (role !== undefined) {
    parts.push(`Role: ${role}`);
  }
  if (parts.length === 0) {
    return undefined;
  }
  return `_${parts.join(" · ")}_`;
}

/**
 * Markdown lines (each including leading `- ` or headings) for review coverage; empty if no usable metadata.
 */
export function formatReviewCoverageSectionLines(
  runMetadata: Readonly<Record<string, string>> | undefined,
): readonly string[] {
  const parsed = parseCodeReviewRunMetadata(runMetadata);
  const tier = parsed.triageTier;
  const triageRaw = parsed.triageRaw;
  const expected =
    tier === undefined ? undefined : new Set(expectedRolesForTriageTier(tier));
  const skippedByTriage = CODE_REVIEW_ROLE_IDS.filter(
    (id) => expected !== undefined && !expected.has(id),
  );

  const completed = parsed.completedRoles;
  const timedOutRolesRaw = parsed.timedOutRoles;
  const failedRolesRaw = parsed.failedRoles;

  const skipSet = new Set(skippedByTriage);
  const inScheduledTier = (roleId: string): boolean =>
    tier === undefined || expected?.has(roleId as CodeReviewRoleId) === true;

  const timedOut = timedOutRolesRaw.filter(
    (id) => !skipSet.has(id as CodeReviewRoleId) && inScheduledTier(id),
  );
  const failed = failedRolesRaw.filter(
    (id) => !skipSet.has(id as CodeReviewRoleId) && inScheduledTier(id),
  );

  const hasOutcomeDetail =
    completed.length > 0 || timedOut.length > 0 || failed.length > 0;
  const hasSignal =
    (triageRaw !== undefined && triageRaw.length > 0) ||
    skippedByTriage.length > 0 ||
    timedOutRolesRaw.length > 0 ||
    failedRolesRaw.length > 0 ||
    completed.length > 0;

  if (!hasSignal) {
    return [];
  }

  let missingOutcome: readonly string[] = [];
  if (tier !== undefined && expected !== undefined && hasOutcomeDetail) {
    missingOutcome = [...expected].filter(
      (id) =>
        !completed.includes(id) &&
        !timedOut.includes(id) &&
        !failed.includes(id),
    );
  }

  const hasProblem =
    skippedByTriage.length > 0 ||
    timedOut.length > 0 ||
    failed.length > 0 ||
    missingOutcome.length > 0;

  const lines: string[] = ["", "### Review coverage"];

  if (tier !== undefined) {
    lines.push(`- _${triageTierRationale(tier)}_`);
  } else if (triageRaw !== undefined && triageRaw.length > 0) {
    lines.push(
      `- _Triage label: \`${triageRaw}\` — scheduled reviewers inferred from run outcomes._`,
    );
  }

  for (const roleId of skippedByTriage) {
    lines.push(
      `- **${roleReviewSectionLabel(roleId)}:** not performed — omitted for this triage tier (not scheduled).`,
    );
  }

  for (const roleId of timedOut) {
    lines.push(
      `- **${roleReviewSectionLabel(roleId)}:** not performed — reviewer **timed out** before completion.`,
    );
  }

  for (const roleId of failed) {
    lines.push(
      `- **${roleReviewSectionLabel(roleId)}:** not performed — reviewer **failed** (adapter error or non-timeout failure).`,
    );
  }

  for (const roleId of missingOutcome) {
    lines.push(
      `- **${roleReviewSectionLabel(roleId)}:** not performed — no completion outcome recorded (unexpected).`,
    );
  }

  if (!hasProblem && tier !== undefined && hasOutcomeDetail) {
    lines.push(
      "- All scheduled reviewers **completed**; no triage omissions or incomplete roles.",
    );
  } else if (!hasProblem && tier === undefined && hasOutcomeDetail) {
    lines.push(
      "- All reported reviewer roles **completed**; no failures or timeouts in run metadata.",
    );
  }

  return lines;
}

function renderTriageSummary(
  findings: readonly Finding[],
  postedCommentCount: number,
  skippedUnanchorable: number,
  prDiffContext: PullRequestDiffContext | undefined,
  runMetadata: Readonly<Record<string, string>> | undefined,
  provenance: ReviewPostProvenance,
): string {
  const critical = findings.filter(
    (finding) => finding.severity === "critical",
  );
  const warnings = findings.filter((finding) => finding.severity === "warning");
  const lines = [
    "## At a Glance",
    `- Findings: ${findings.length} (🔴 ${critical.length} critical, ⚠️ ${warnings.length} warning)`,
    `- Inline comments posted: ${postedCommentCount}`,
  ];
  if (skippedUnanchorable > 0) {
    lines.push(`- Skipped outside PR diff: ${skippedUnanchorable}`);
  }
  lines.push(...formatReviewProvenanceSectionLines(provenance));
  lines.push(...formatReviewCoverageSectionLines(runMetadata));

  if (findings.length === 0) {
    lines.push("", "✅ No findings - code looks good!");
    return lines.join("\n");
  }

  const fixNow = [...critical, ...warnings].slice(0, 2);
  const followUp = [...critical, ...warnings].slice(2, 6);
  lines.push(
    "",
    "## Fix Now",
    ...formatFindingBullets(fixNow, "No immediate findings.", prDiffContext),
    "",
    "## Follow-up",
    ...formatFindingBullets(followUp, "No follow-up findings.", prDiffContext),
  );
  return lines.join("\n");
}

function renderImpactSummary(
  findings: readonly Finding[],
  postedCommentCount: number,
  skippedUnanchorable: number,
  prDiffContext: PullRequestDiffContext | undefined,
  runMetadata: Readonly<Record<string, string>> | undefined,
  provenance: ReviewPostProvenance,
): string {
  const lines = [
    "## Impact Summary",
    `- Total findings: ${findings.length}`,
    `- Inline comments posted: ${postedCommentCount}`,
  ];
  if (skippedUnanchorable > 0) {
    lines.push(`- Skipped outside PR diff: ${skippedUnanchorable}`);
  }
  lines.push(...formatReviewProvenanceSectionLines(provenance));
  lines.push(...formatReviewCoverageSectionLines(runMetadata));

  if (findings.length === 0) {
    lines.push("", "✅ No findings - code looks good!");
    return lines.join("\n");
  }

  const groups: Record<
    "security" | "performance" | "quality" | "compliance" | "other",
    Finding[]
  > = {
    security: [],
    performance: [],
    quality: [],
    compliance: [],
    other: [],
  };

  for (const finding of findings) {
    groups[impactBucketForSourceRole(finding.sourceRole)].push(finding);
  }

  lines.push(
    "",
    "### Security",
    ...formatFindingBullets(
      groups.security,
      "No security findings.",
      prDiffContext,
    ),
    "",
    "### Runtime / Performance",
    ...formatFindingBullets(
      groups.performance,
      "No performance findings.",
      prDiffContext,
    ),
    "",
    "### Correctness / Quality",
    ...formatFindingBullets(
      groups.quality,
      "No quality findings.",
      prDiffContext,
    ),
    "",
    "### Documentation / Compliance",
    ...formatFindingBullets(
      groups.compliance,
      "No compliance findings.",
      prDiffContext,
    ),
  );

  if (groups.other.length > 0) {
    lines.push(
      "",
      "### Uncategorized findings",
      "- _These findings omit `sourceRole` or use an unexpected reviewer label._",
      ...formatFindingBullets(
        groups.other,
        "No uncategorized findings.",
        prDiffContext,
      ),
    );
  }

  return lines.join("\n");
}

function impactBucketForSourceRole(
  role: Finding["sourceRole"] | undefined,
): "security" | "performance" | "quality" | "compliance" | "other" {
  const trimmed = typeof role === "string" ? role.trim() : "";
  if (
    trimmed === "security" ||
    trimmed === "performance" ||
    trimmed === "quality" ||
    trimmed === "compliance"
  ) {
    return trimmed;
  }
  return "other";
}

function renderEvidenceSummary(
  findings: readonly Finding[],
  postedCommentCount: number,
  skippedUnanchorable: number,
  prDiffContext: PullRequestDiffContext | undefined,
  runMetadata: Readonly<Record<string, string>> | undefined,
  provenance: ReviewPostProvenance,
): string {
  const lines = [
    "## Why / Evidence / Fix",
    `- Total findings: ${findings.length}`,
    `- Inline comments posted: ${postedCommentCount}`,
  ];
  if (skippedUnanchorable > 0) {
    lines.push(`- Skipped outside PR diff: ${skippedUnanchorable}`);
  }
  lines.push(...formatReviewProvenanceSectionLines(provenance));
  lines.push(...formatReviewCoverageSectionLines(runMetadata));

  if (findings.length === 0) {
    lines.push("", "✅ No findings - code looks good!");
    return lines.join("\n");
  }

  for (const [index, finding] of findings.slice(0, 6).entries()) {
    const caption =
      prDiffContext === undefined
        ? undefined
        : findingInlinePostingCaption(finding, prDiffContext);
    lines.push(
      "",
      `### Finding ${index + 1}: ${severityEmoji(finding.severity)} ${finding.title}`,
      ...(caption === undefined ? [] : [`- _${caption}_`]),
      `- Why: ${finding.description}`,
      `- Evidence: ${finding.evidence}`,
      `- Suggested fix: ${suggestFixFromRole(finding.sourceRole)}`,
    );
  }

  return lines.join("\n");
}

function formatFindingBullets(
  findings: readonly Finding[],
  emptyLine: string,
  prDiffContext: PullRequestDiffContext | undefined,
): readonly string[] {
  if (findings.length === 0) {
    return [`- ✅ ${emptyLine}`];
  }
  return findings.map((finding) => {
    const location =
      finding.file !== undefined && finding.line !== undefined
        ? ` (${finding.file}:${finding.line})`
        : "";
    const caption =
      prDiffContext === undefined
        ? undefined
        : findingInlinePostingCaption(finding, prDiffContext);
    const suffix = caption === undefined ? "" : ` — _${caption}_`;
    return `- ${severityEmoji(finding.severity)} ${finding.title}${location}${suffix}`;
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

export async function getCurrentPullRequestNumber(
  repo: string,
  workspacePath?: string,
): Promise<number> {
  const cwdOpts = { gitAware: true } as const;

  const headBranch = (
    await runCommand(
      ["git", "symbolic-ref", "-q", "--short", "HEAD"],
      workspacePath,
      cwdOpts,
    )
  )?.trim();

  if (headBranch !== undefined && headBranch.length > 0) {
    try {
      const view = await runGh<{ readonly number: number }>(
        ["pr", "view", headBranch, "--repo", repo, "--json", "number"],
        workspacePath,
      );
      if (view !== undefined && Number.isInteger(view.number)) {
        return view.number;
      }
    } catch {
      // Local-only branch or no PR yet — fall through to commit lookup.
    }
  }

  const sha = (
    await runCommand(["git", "rev-parse", "HEAD"], workspacePath, cwdOpts)
  )?.trim();
  if (sha === undefined || sha.length === 0) {
    throw new Error(
      "Could not resolve HEAD for PR discovery; pass --pr <number> explicitly.",
    );
  }

  const pulls = await ghApi<
    ReadonlyArray<{ readonly number: number; readonly state?: string }>
  >(`repos/${repo}/commits/${sha}/pulls`, "GET", undefined, workspacePath);

  if (!Array.isArray(pulls) || pulls.length === 0) {
    throw new Error(
      `No pull request found for HEAD (${sha.slice(0, 12)}) in ${repo}. Check out a PR head branch or pass --pr <number>.`,
    );
  }

  const open = pulls.find((p) => p.state === "open");
  const chosen = open ?? pulls[0];
  if (!Number.isInteger(chosen.number)) {
    throw new Error("Could not resolve PR number from commit metadata.");
  }
  return chosen.number;
}

async function fetchPullRequestHeadSha(
  repo: string,
  prNumber: number,
  workspacePath?: string,
): Promise<string | undefined> {
  const output = await runCommand(
    ["gh", "api", `repos/${repo}/pulls/${prNumber}`, "--jq", ".head.sha"],
    workspacePath,
    { gitAware: true },
  );
  const value = output?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

export async function updateRunResultMetadata(
  artifacts: readonly string[],
  entries: Readonly<Record<string, string>>,
): Promise<void> {
  const resultPath = artifacts.find((artifact) =>
    artifact.endsWith("/result.json"),
  );
  if (resultPath === undefined) {
    return;
  }
  const raw = await readFile(resultPath, "utf8");
  const parsed = JSON.parse(raw) as {
    readonly metadata?: Record<string, string>;
    [key: string]: unknown;
  };
  const metadata = {
    ...(parsed.metadata ?? {}),
    ...entries,
  };
  await writeFile(
    resultPath,
    `${JSON.stringify({ ...parsed, metadata }, null, 2)}\n`,
    "utf8",
  );
}

export async function getRepoNameWithOwner(
  workspacePath?: string,
): Promise<string> {
  try {
    const repo = await runGh<{ readonly nameWithOwner: string }>(
      ["repo", "view", "--json", "nameWithOwner"],
      workspacePath,
    );
    if (repo.nameWithOwner.trim().length > 0) {
      return repo.nameWithOwner;
    }
  } catch {
    // Fall back to remote URL parsing for jj workspaces.
  }
  const fromRemote = await resolveRepoNameWithOwnerFromRemote(workspacePath);
  if (fromRemote === undefined) {
    throw new Error(
      "Could not resolve repository nameWithOwner from gh or remotes.",
    );
  }
  return fromRemote;
}

async function getViewerLogin(workspacePath?: string): Promise<string> {
  const user = await runGh<{ readonly login: string }>(
    ["api", "user"],
    workspacePath,
  );
  if (user.login.trim().length === 0) {
    throw new Error("Could not resolve GitHub login from gh api user.");
  }
  return user.login;
}

async function ghApi<T>(
  path: string,
  method = "GET",
  payload?: unknown,
  workspacePath?: string,
): Promise<T> {
  const args = ["api", path, "--method", method] as string[];
  let inputPath: string | undefined;
  if (payload !== undefined) {
    inputPath = join("/tmp/opencode", `gh-api-${crypto.randomUUID()}.json`);
    await Bun.write(inputPath, `${JSON.stringify(payload)}\n`);
    args.push("--input", inputPath);
  }
  try {
    return await runGh<T>(args, workspacePath);
  } finally {
    if (inputPath !== undefined) {
      await rm(inputPath, { force: true });
    }
  }
}

async function runGhGraphql<T>(
  input: {
    readonly query: string;
    readonly variables?: Readonly<Record<string, unknown>>;
  },
  workspacePath?: string,
): Promise<T> {
  const inputPath = join(
    tmpdir(),
    `aguil-agents-gh-graphql-${crypto.randomUUID()}.json`,
  );
  const body =
    input.variables !== undefined
      ? { query: input.query, variables: input.variables }
      : { query: input.query };
  await writeFile(inputPath, `${JSON.stringify(body)}\n`, "utf8");
  try {
    return await runGh<T>(
      ["api", "graphql", "--input", inputPath],
      workspacePath,
    );
  } finally {
    await rm(inputPath, { force: true });
  }
}

async function runGh<T>(
  args: readonly string[],
  workspacePath?: string,
): Promise<T> {
  const gitAware = await resolveGhCwd(workspacePath);
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const proc = Bun.spawn({
      cmd: ["gh", ...args],
      cwd: gitAware,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      readProcessText(proc.stdout),
      readProcessText(proc.stderr),
      proc.exited,
    ]);
    if (exitCode === 0) {
      if (stdout.trim().length === 0) {
        return undefined as T;
      }
      return JSON.parse(stdout) as T;
    }

    const message = stderr.trim() || `exit code ${exitCode}`;
    const isTransientNetwork =
      /error connecting to api\.github\.com/i.test(message) ||
      /\bTLS handshake timeout\b/i.test(message) ||
      /\btimeout\b/i.test(message) ||
      /\btemporarily unavailable\b/i.test(message) ||
      /\bconnection reset\b/i.test(message) ||
      /\bconnection refused\b/i.test(message) ||
      /\bEOF\b/i.test(message) ||
      /\bno such host\b/i.test(message) ||
      /\bnetwork is unreachable\b/i.test(message);
    if (!isTransientNetwork || attempt === maxAttempts) {
      throw new Error(`gh ${args.join(" ")} failed: ${message}`);
    }

    const backoffMs =
      250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
    await Bun.sleep(backoffMs);
  }

  throw new Error(`gh ${args.join(" ")} failed: exhausted retries`);
}

const ghCwdCache = new Map<string, Promise<string>>();

async function resolveGhCwd(workspacePath?: string): Promise<string> {
  const workspaceCwd = resolveWorkspaceCwd(workspacePath);
  const cached = ghCwdCache.get(workspaceCwd);
  if (cached !== undefined) {
    return cached;
  }

  const pending = (async () => {
    // `resolveGitAwareCwd()` already handles jj workspaces and colocated repos.
    // Keeping all `gh` commands scoped to the git-aware root avoids subtle
    // cwd bugs across different jj/git layouts.
    return resolveGitAwareCwd(workspacePath);
  })();

  ghCwdCache.set(workspaceCwd, pending);
  return pending;
}

async function resolveRepoNameWithOwnerFromRemote(
  workspacePath?: string,
): Promise<string | undefined> {
  const remoteUrl = (
    (await runCommand(["jj", "git", "remote", "list"], workspacePath)) ??
    (await runCommand(["git", "remote", "get-url", "origin"], workspacePath, {
      gitAware: true,
    }))
  )?.trim();
  if (remoteUrl === undefined || remoteUrl.length === 0) {
    return undefined;
  }

  const line = remoteUrl
    .split(/\r?\n/)
    .find((entry) => entry.startsWith("origin "));
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

function resolveWorkspaceCwd(workspacePath?: string): string {
  return workspacePath === undefined ? process.cwd() : resolve(workspacePath);
}

const gitAwareWorkspaceCache = new Map<string, Promise<string>>();
const emittedGitAwareWarnings = new Set<string>();

async function resolveGitAwareCwd(workspacePath?: string): Promise<string> {
  const cwd = resolveWorkspaceCwd(workspacePath);
  const cached = gitAwareWorkspaceCache.get(cwd);
  if (cached !== undefined) {
    return cached;
  }

  const pending = (async () => {
    const resolved = await resolveGitAwarePath(cwd);
    if (
      resolved.warning !== undefined &&
      !emittedGitAwareWarnings.has(resolved.warning)
    ) {
      emittedGitAwareWarnings.add(resolved.warning);
      console.warn(resolved.warning);
    }
    return resolved.gitAwarePath;
  })();

  gitAwareWorkspaceCache.set(cwd, pending);
  return pending;
}

export async function runCommand(
  cmd: readonly string[],
  workspacePath?: string,
  options: { readonly gitAware?: boolean } = {},
): Promise<string | undefined> {
  try {
    const cwd =
      options.gitAware === true
        ? await resolveGitAwareCwd(workspacePath)
        : resolveWorkspaceCwd(workspacePath);
    const proc = Bun.spawn({
      cmd: [...cmd],
      cwd,
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

const pullRequestDiffContextCache = new Map<
  string,
  Promise<PullRequestDiffContext>
>();

export async function loadPullRequestDiffContext(
  repo: string,
  prNumber: number,
  workspacePath?: string,
): Promise<PullRequestDiffContext> {
  const key = `${repo}\0${prNumber}\0${resolveWorkspaceCwd(workspacePath)}`;
  const cached = pullRequestDiffContextCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const pending = loadPullRequestDiffContextUncached(
    repo,
    prNumber,
    workspacePath,
  );
  pullRequestDiffContextCache.set(key, pending);
  pending.catch(() => {
    pullRequestDiffContextCache.delete(key);
  });
  return pending;
}

async function loadPullRequestDiffContextUncached(
  repo: string,
  prNumber: number,
  workspacePath?: string,
): Promise<PullRequestDiffContext> {
  const files = await ghApi<readonly GitHubPullRequestFile[]>(
    `repos/${repo}/pulls/${prNumber}/files?per_page=100`,
    "GET",
    undefined,
    workspacePath,
  );
  const map = new Map<string, ReadonlyMap<number, number>>();
  for (const file of files) {
    map.set(file.filename, extractRightSideHunkPositions(file.patch));
  }
  return map;
}

export function candidateToComment(
  candidate: PendingReviewComment,
  context: PullRequestDiffContext,
): GitHubPendingReviewCommentInput | undefined {
  const position = resolveReviewDiffPosition(
    candidate.path,
    candidate.line,
    context,
  );
  if (position === undefined) {
    return undefined;
  }
  return {
    path: candidate.path,
    position,
    body: candidate.body,
  };
}

function extractRightSideHunkPositions(
  patch: string | undefined,
): ReadonlyMap<number, number> {
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
    }
  }
  return positions;
}
