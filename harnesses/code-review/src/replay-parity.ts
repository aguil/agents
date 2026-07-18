/**
 * Replay-parity referee (#73 Tier 2).
 *
 * Replays corpus entries through the code-review pipeline via
 * ReplayAgentAdapter and compares deterministic fields against the entry's
 * recorded result.json. Every delta must either match an adjudication in
 * the corpus ledger (adjudications.json, matched by entry name AND exact
 * delta hash) or the entry fails parity.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding, HarnessRunResult } from "@aguil/agents-core";
import { ReplayAgentAdapter } from "@aguil/agents-execution";
import { findingFingerprint } from "@aguil/agents-reporting";
import { runCodeReview } from "./index";

export interface FindingKey {
  readonly id: string;
  readonly severity: string;
  readonly file: string | null;
  readonly fingerprint: string;
}

export interface ParityDelta {
  readonly missingFromReplay?: readonly FindingKey[];
  readonly extraInReplay?: readonly FindingKey[];
  readonly tier?: { readonly recorded: string; readonly replayed: string };
  readonly status?: { readonly recorded: string; readonly replayed: string };
}

export type EntryVerdict =
  | { readonly kind: "match" }
  | {
      readonly kind: "adjudicated";
      readonly delta: ParityDelta;
      readonly deltaHash: string;
      readonly reason: string;
    }
  | {
      readonly kind: "delta";
      readonly delta: ParityDelta;
      readonly deltaHash: string;
    };

interface RecordedResult {
  readonly status?: string;
  readonly findings?: readonly Finding[];
  readonly metadata?: Readonly<Record<string, string>>;
}

interface Adjudication {
  readonly entry: string;
  readonly deltaHash: string;
  readonly reason: string;
  readonly decision: string;
}

export function findingKey(finding: Finding): FindingKey {
  return {
    id: finding.id,
    severity: finding.severity,
    file: finding.file ?? null,
    fingerprint: findingFingerprint(finding),
  };
}

function sortKeys(keys: readonly FindingKey[]): readonly FindingKey[] {
  return [...keys].sort((a, b) =>
    `${a.fingerprint}${a.id}`.localeCompare(`${b.fingerprint}${b.id}`),
  );
}

/**
 * Statuses that derive purely from findings. Recorded `error` statuses come
 * from live process failures (spawn errors, timeouts) that stdout replay
 * cannot reproduce, so status comparison is scoped to this set — findings
 * and tier still compare for every entry.
 */
const FINDING_DERIVED_STATUSES: ReadonlySet<string> = new Set([
  "passed",
  "warnings",
  "failed",
]);

export function computeDelta(
  recorded: RecordedResult,
  replayed: HarnessRunResult,
): ParityDelta | undefined {
  const recordedKeys = new Map(
    (recorded.findings ?? []).map((finding) => {
      const key = findingKey(finding);
      return [`${key.fingerprint}:${key.id}`, key] as const;
    }),
  );
  const replayedKeys = new Map(
    replayed.findings.map((finding) => {
      const key = findingKey(finding);
      return [`${key.fingerprint}:${key.id}`, key] as const;
    }),
  );

  const missingFromReplay = sortKeys(
    [...recordedKeys.entries()]
      .filter(([mapKey]) => !replayedKeys.has(mapKey))
      .map(([, key]) => key),
  );
  const extraInReplay = sortKeys(
    [...replayedKeys.entries()]
      .filter(([mapKey]) => !recordedKeys.has(mapKey))
      .map(([, key]) => key),
  );

  const recordedTier = recorded.metadata?.triage ?? "?";
  const replayedTier = replayed.metadata?.triage ?? "?";

  const recordedStatus = recorded.status ?? "?";
  const compareStatus = FINDING_DERIVED_STATUSES.has(recordedStatus);

  const delta: ParityDelta = {
    ...(missingFromReplay.length > 0 ? { missingFromReplay } : {}),
    ...(extraInReplay.length > 0 ? { extraInReplay } : {}),
    ...(recordedTier === replayedTier
      ? {}
      : { tier: { recorded: recordedTier, replayed: replayedTier } }),
    ...(compareStatus && recordedStatus !== replayed.status
      ? { status: { recorded: recordedStatus, replayed: replayed.status } }
      : {}),
  };
  return Object.keys(delta).length === 0 ? undefined : delta;
}

/** Canonical serialization: stable key order via sorted JSON stringify. */
export function deltaHash(delta: ParityDelta): string {
  const canonical = JSON.stringify(delta, (_key, value) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : value,
  );
  return createHash("sha256").update(canonical).digest("hex");
}

export async function replayEntry(
  corpusDir: string,
  entryName: string,
): Promise<{ recorded: RecordedResult; replayed: HarnessRunResult }> {
  const entryDir = join(corpusDir, "runs", entryName);
  const recorded = (await Bun.file(
    join(entryDir, "result.json"),
  ).json()) as RecordedResult;
  const scratch = await mkdtemp(join(tmpdir(), "replay-parity-"));
  try {
    const replayed = await runCodeReview({
      workspacePath: scratch,
      scratchpadRoot: join(scratch, "runs"),
      contextBundlePath: join(entryDir, "context", "bundle.json"),
      adapter: new ReplayAgentAdapter({ runDir: entryDir }),
    });
    return { recorded, replayed };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function judgeEntry(
  corpusDir: string,
  entryName: string,
  adjudications: readonly Adjudication[],
): Promise<EntryVerdict> {
  const { recorded, replayed } = await replayEntry(corpusDir, entryName);
  const delta = computeDelta(recorded, replayed);
  if (delta === undefined) {
    return { kind: "match" };
  }
  const hash = deltaHash(delta);
  const adjudication = adjudications.find(
    (candidate) =>
      candidate.entry === entryName &&
      candidate.deltaHash === hash &&
      candidate.decision === "accepted",
  );
  if (adjudication !== undefined) {
    return {
      kind: "adjudicated",
      delta,
      deltaHash: hash,
      reason: adjudication.reason,
    };
  }
  return { kind: "delta", delta, deltaHash: hash };
}

export async function loadAdjudications(
  corpusDir: string,
): Promise<readonly Adjudication[]> {
  const file = Bun.file(join(corpusDir, "adjudications.json"));
  if (!(await file.exists())) {
    return [];
  }
  const parsed = (await file.json()) as {
    adjudications?: readonly Adjudication[];
  };
  return parsed.adjudications ?? [];
}
