import { expect, test } from "bun:test";
import type { Finding, HarnessOutcome } from "@aguil/agents-core";
import {
  FINDING_OUTCOME_KIND,
  findingToHarnessOutcome,
  harnessOutcomeToFinding,
  isFindingOutcome,
} from "@aguil/agents-core";

const sampleFinding: Finding = {
  id: "finding-1",
  severity: "critical",
  title: "SQL injection in query builder",
  description: "User input interpolated into raw SQL.",
  evidence: "src/db/query.ts:42 uses template literal with req.query.name",
  sourceRole: "security",
  validation: { status: "verified", details: "Reproduced with test payload" },
  file: "src/db/query.ts",
  line: 42,
};

test("findingToHarnessOutcome preserves identity fields and moves the rest to data", () => {
  const outcome = findingToHarnessOutcome(sampleFinding);
  expect(outcome.id).toBe(sampleFinding.id);
  expect(outcome.kind).toBe(FINDING_OUTCOME_KIND);
  expect(outcome.sourceRole).toBe(sampleFinding.sourceRole);
  expect(outcome.title).toBe(sampleFinding.title);
  expect(outcome.data.severity).toBe("critical");
  expect(outcome.data.file).toBe("src/db/query.ts");
  expect(outcome.data.line).toBe(42);
});

test("finding round-trips through HarnessOutcome without loss", () => {
  const roundTripped = harnessOutcomeToFinding(
    findingToHarnessOutcome(sampleFinding),
  );
  expect(roundTripped).toEqual(sampleFinding);
});

test("round-trip preserves findings without optional file/line", () => {
  const { file: _file, line: _line, ...rest } = sampleFinding;
  const minimal: Finding = rest;
  const roundTripped = harnessOutcomeToFinding(
    findingToHarnessOutcome(minimal),
  );
  expect(roundTripped).toEqual(minimal);
});

test("non-finding outcomes are not coerced into findings", () => {
  const triageOutcome: HarnessOutcome = {
    id: "diagnosis-1",
    kind: "diagnosis",
    sourceRole: "diagnose",
    title: "Root cause: off-by-one in pagination cursor",
    data: {
      rootCause: "cursor advanced before boundary check",
      remediation: "clamp cursor before increment",
      verificationStatus: "pending",
    },
  };
  expect(isFindingOutcome(triageOutcome)).toBe(false);
  expect(harnessOutcomeToFinding(triageOutcome)).toBeUndefined();
});

test("finding-kinded outcome with malformed data is rejected", () => {
  const malformed: HarnessOutcome = {
    id: "bad-1",
    kind: FINDING_OUTCOME_KIND,
    sourceRole: "security",
    title: "Missing required fields",
    data: { severity: "critical" },
  };
  expect(isFindingOutcome(malformed)).toBe(false);
  expect(harnessOutcomeToFinding(malformed)).toBeUndefined();
});
