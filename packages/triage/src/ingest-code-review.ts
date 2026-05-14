import { realpath } from "node:fs/promises";
import { join, normalize, relative, resolve, sep } from "node:path";
import type { Finding, HarnessRunResult } from "@aguil/agents-core";
import { nowIso } from "@aguil/agents-core";
import { discoverLatestCodeReviewResultPath } from "./discover-code-review-result";
import { readUtf8FileNoFollow } from "./no-follow-io";
import { computeOutputSlug } from "./output-slug";
import { assertResolvedPathInsideWorkspace } from "./safe-path";
import { sortReviewFindings } from "./sort-items";
import type { TriageEnvelopeV1, TriageItemAnchor, TriageItemV1 } from "./types";
import { TRIAGE_ENVELOPE_SCHEMA_ID } from "./types";

const CODE_REVIEW_FROM = "code-review";

interface StoredHarnessResult extends HarnessRunResult {
  readonly reportPath?: string;
  readonly contextBundlePath?: string;
}

function findingToItem(finding: Finding): TriageItemV1 {
  const anchors: TriageItemAnchor[] =
    finding.file !== undefined && finding.file.trim().length > 0
      ? [{ path: finding.file, line: finding.line }]
      : [];

  let detail = finding.description.trim();
  const evidence = finding.evidence.trim();
  if (evidence.length > 0) {
    detail +=
      detail.length > 0
        ? `\n\nEvidence:\n${evidence}`
        : `Evidence:\n${evidence}`;
  }

  return {
    id: finding.id,
    kind: "code_review_finding",
    severity: finding.severity,
    title: finding.title,
    detail,
    anchors,
    source: {
      producer: CODE_REVIEW_FROM,
      sourceRole: finding.sourceRole,
      validationStatus: finding.validation.status,
    },
  };
}

export async function resolveCodeReviewResultPath(options: {
  readonly workspacePath: string;
  readonly resultPath?: string;
}): Promise<string> {
  if (options.resultPath !== undefined) {
    const t = options.resultPath.trim();
    if (t.length > 0) {
      return resolve(options.workspacePath, t);
    }
  }
  const discovered = await discoverLatestCodeReviewResultPath(
    options.workspacePath,
  );
  if (discovered === undefined) {
    throw new Error(
      `No code-review result.json found under ${options.workspacePath}/.review-agent/dry-run or …/runs (use --result <path>).`,
    );
  }
  return discovered;
}

/** Resolve absolute path fingerprint for deterministic `outputSlug` (path-based ingress key). */
export function canonicalKeyForCodeReviewArtifact(
  resultAbsolutePath: string,
): string {
  return normalize(resolve(resultAbsolutePath));
}

/** Build envelope from a stored harness `result.json` (does not rerun reviewers). */
export async function buildEnvelopeFromCodeReviewResult(options: {
  readonly workspacePath: string;
  readonly resultAbsolutePath: string;
}): Promise<TriageEnvelopeV1> {
  const firstResolved = await assertResolvedPathInsideWorkspace(
    options.workspacePath,
    options.resultAbsolutePath,
  );
  const { candidateReal } = await assertResolvedPathInsideWorkspace(
    options.workspacePath,
    options.resultAbsolutePath,
  );
  if (firstResolved.candidateReal !== candidateReal) {
    throw new Error(
      "Code-review result path resolution changed during triage ingest.",
    );
  }
  const rel = relative(firstResolved.workspaceReal, candidateReal);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("Code-review result path escapes workspace.");
  }
  const anchored = join(firstResolved.workspaceReal, rel);
  const reResolved = await realpath(anchored);
  if (reResolved !== candidateReal) {
    throw new Error(
      "Code-review result path moved relative to workspace anchor before read.",
    );
  }
  const raw = await readUtf8FileNoFollow(reResolved);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (e) {
    throw new Error(
      `Invalid JSON at ${reResolved}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { findings?: unknown }).findings)
  ) {
    throw new Error(`Invalid result envelope at ${reResolved}.`);
  }
  const doc = parsed as StoredHarnessResult;
  const sorted = sortReviewFindings(doc.findings);
  const canonicalKey = normalize(reResolved);
  const outputSlug = computeOutputSlug(CODE_REVIEW_FROM, canonicalKey);

  const metadata =
    typeof doc.metadata === "object" && doc.metadata !== null
      ? (doc.metadata as Record<string, string>)
      : undefined;

  const items = sorted.map(findingToItem);

  const envelope: TriageEnvelopeV1 = {
    schemaId: TRIAGE_ENVELOPE_SCHEMA_ID,
    schemaVersion: 1,
    generatedAt: nowIso(),
    workspacePath: options.workspacePath,
    outputSlug,
    upstream: {
      producer: CODE_REVIEW_FROM,
      resultPath: reResolved,
      upstreamRunId: doc.runId,
      ...(metadata === undefined ? {} : { metadataSubset: metadata }),
    },
    items,
  };

  return envelope;
}

export { CODE_REVIEW_FROM };
