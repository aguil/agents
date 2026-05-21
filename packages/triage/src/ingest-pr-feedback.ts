import { realpath } from "node:fs/promises";
import { join, normalize, relative, resolve, sep } from "node:path";
import { nowIso } from "@aguil/agents-core";
import {
  PR_FEEDBACK_SCHEMA_ID,
  type PrFeedbackDocumentV1,
  type PrFeedbackItemV1,
} from "@aguil/agents-pr-feedback";
import { readUtf8FileNoFollow } from "./no-follow-io";
import { computeOutputSlug } from "./output-slug";
import { assertResolvedPathInsideWorkspace } from "./safe-path";
import type { TriageEnvelopeV1, TriageItemV1 } from "./types";
import { TRIAGE_ENVELOPE_SCHEMA_ID } from "./types";

export const PR_FEEDBACK_FROM = "pr-feedback";

function feedbackItemToTriageItem(
  item: PrFeedbackItemV1,
  repository: string,
  pullNumber: number,
): TriageItemV1 {
  return {
    id: item.id,
    kind: item.kind,
    severity: item.severity,
    title: item.title,
    detail: item.detail,
    anchors: item.anchors.map((a) => ({
      path: a.path,
      ...(a.line !== undefined ? { line: a.line } : {}),
    })),
    source: {
      producer: PR_FEEDBACK_FROM,
      threadId: item.source.threadId,
      authorLogin: item.source.authorLogin,
      repository,
      pullNumber: String(pullNumber),
    },
  };
}

export function canonicalKeyForPrFeedbackArtifact(
  feedbackAbsolutePath: string,
): string {
  return normalize(resolve(feedbackAbsolutePath));
}

export async function resolvePrFeedbackResultPath(options: {
  readonly workspacePath: string;
  readonly resultPath?: string;
}): Promise<string> {
  if (options.resultPath !== undefined) {
    const t = options.resultPath.trim();
    if (t.length > 0) {
      return resolve(options.workspacePath, t);
    }
  }
  throw new Error(
    "pr-feedback triage requires --result <path> to feedback.json from agents pr-feedback collect.",
  );
}

export async function buildEnvelopeFromPrFeedbackResult(options: {
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
      "PR feedback path resolution changed during triage ingest.",
    );
  }
  const rel = relative(firstResolved.workspaceReal, candidateReal);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("PR feedback path escapes workspace.");
  }
  const anchored = join(firstResolved.workspaceReal, rel);
  const reResolved = await realpath(anchored);
  if (reResolved !== candidateReal) {
    throw new Error(
      "PR feedback path moved relative to workspace anchor before read.",
    );
  }
  const reResolvedAgain = await realpath(anchored);
  if (reResolvedAgain !== reResolved) {
    throw new Error("PR feedback path moved immediately before read.");
  }
  const raw = await readUtf8FileNoFollow(reResolvedAgain);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (e) {
    throw new Error(
      `Invalid JSON at ${reResolved}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Invalid feedback envelope at ${reResolved}.`);
  }
  const doc = parsed as PrFeedbackDocumentV1;
  if (doc.schemaId !== PR_FEEDBACK_SCHEMA_ID) {
    throw new Error(`Invalid feedback schemaId at ${reResolved}.`);
  }
  if (!Array.isArray(doc.items)) {
    throw new Error(`Invalid feedback items at ${reResolved}.`);
  }

  const sorted = [...doc.items].sort((a, b) => a.id.localeCompare(b.id));
  const canonicalKey = normalize(reResolved);
  const outputSlug = computeOutputSlug(PR_FEEDBACK_FROM, canonicalKey);
  const items = sorted.map((item) =>
    feedbackItemToTriageItem(item, doc.repository, doc.pullNumber),
  );

  return {
    schemaId: TRIAGE_ENVELOPE_SCHEMA_ID,
    schemaVersion: 1,
    generatedAt: nowIso(),
    workspacePath: options.workspacePath,
    outputSlug,
    upstream: {
      producer: PR_FEEDBACK_FROM,
      resultPath: reResolved,
      metadataSubset: {
        repository: doc.repository,
        pullNumber: String(doc.pullNumber),
      },
    },
    items,
  };
}
