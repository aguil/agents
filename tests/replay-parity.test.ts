import { expect, test } from "bun:test";
import type { Finding, HarnessRunResult } from "@aguil/agents-core";
import {
  computeDelta,
  deltaHash,
  findingKey,
} from "../harnesses/code-review/src/replay-parity";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "quality-example",
    severity: "warning",
    title: "Example finding",
    description: "Example description.",
    evidence: "Example evidence.",
    sourceRole: "quality",
    validation: { status: "verified", details: "example" },
    file: "src/index.ts",
    line: 10,
    ...overrides,
  };
}

function replayed(
  findings: readonly Finding[],
  overrides: Partial<HarnessRunResult> = {},
): HarnessRunResult {
  return {
    runId: "replay",
    status: "warnings",
    findings,
    artifacts: [],
    metadata: { triage: "full" },
    ...overrides,
  };
}

test("identical results produce no delta", () => {
  const shared = [finding()];
  expect(
    computeDelta(
      { status: "warnings", findings: shared, metadata: { triage: "full" } },
      replayed(shared),
    ),
  ).toBeUndefined();
});

test("missing and extra findings are keyed by fingerprint and sorted", () => {
  const recordedOnly = finding({ id: "quality-recorded-only" });
  const replayedOnly = finding({
    id: "quality-replayed-only",
    title: "Different finding",
    file: "src/other.ts",
  });
  const delta = computeDelta(
    {
      status: "warnings",
      findings: [recordedOnly],
      metadata: { triage: "full" },
    },
    replayed([replayedOnly]),
  );
  expect(delta?.missingFromReplay?.map((key) => key.id)).toEqual([
    "quality-recorded-only",
  ]);
  expect(delta?.extraInReplay?.map((key) => key.id)).toEqual([
    "quality-replayed-only",
  ]);
  expect(delta?.status).toBeUndefined();
});

test("tier and finding-derived status changes are deltas", () => {
  const delta = computeDelta(
    { status: "passed", findings: [], metadata: { triage: "lite" } },
    replayed([], { status: "warnings", metadata: { triage: "full" } }),
  );
  expect(delta?.tier).toEqual({ recorded: "lite", replayed: "full" });
  expect(delta?.status).toEqual({ recorded: "passed", replayed: "warnings" });
});

test("recorded error statuses are excluded from status comparison", () => {
  // Live-run process failures (spawn errors, timeouts) cannot be reproduced
  // by stdout replay; findings still compare.
  const delta = computeDelta(
    { status: "error", findings: [], metadata: { triage: "full" } },
    replayed([], { status: "passed" }),
  );
  expect(delta).toBeUndefined();
});

test("timeout-derived warnings are excluded from status comparison", () => {
  // Role timeouts map overall status to warnings even with unchanged
  // findings; replay does not re-enforce live timeouts, so such entries
  // would otherwise report spurious status deltas. Findings still compare.
  const timedOut = {
    status: "warnings",
    findings: [],
    metadata: { triage: "full", timed_out_roles: "performance" },
  };
  expect(computeDelta(timedOut, replayed([], { status: "passed" }))).toBe(
    undefined,
  );
  // Finding deltas on a timed-out entry still surface.
  const withFinding = computeDelta(
    { ...timedOut, findings: [finding()] },
    replayed([], { status: "passed" }),
  );
  expect(withFinding?.missingFromReplay).toHaveLength(1);
  expect(withFinding?.status).toBeUndefined();
});

test("deltaHash is stable across object key order and distinct per delta", () => {
  const a = computeDelta(
    { status: "passed", findings: [], metadata: { triage: "lite" } },
    replayed([], { status: "warnings", metadata: { triage: "full" } }),
  );
  const b = computeDelta(
    { status: "passed", findings: [], metadata: { triage: "full" } },
    replayed([], { status: "warnings", metadata: { triage: "full" } }),
  );
  if (a === undefined || b === undefined) {
    throw new Error("expected deltas");
  }
  expect(deltaHash(a)).toBe(deltaHash({ ...a }));
  expect(deltaHash(a)).not.toBe(deltaHash(b));
  expect(deltaHash(a)).toMatch(/^[0-9a-f]{64}$/);
});

test("findingKey carries the canonical fingerprint", () => {
  const key = findingKey(finding());
  expect(key.fingerprint.length).toBeGreaterThan(0);
  expect(key.file).toBe("src/index.ts");
  // Fingerprint must be insensitive to prose-only edits (the reporting
  // package's canonical fingerprint contract).
  const reworded = findingKey(
    finding({ validation: { status: "verified", details: "other words" } }),
  );
  expect(reworded.fingerprint).toBe(key.fingerprint);
});
