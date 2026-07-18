import { expect, test } from "bun:test";
import type { Finding, HarnessOutcome } from "@aguil/agents-core";
import { findingToHarnessOutcome } from "@aguil/agents-core";
import { validateFinding } from "@aguil/agents-execution";
import type { OutputSchemas } from "@aguil/agents-harness-config";
import {
  applyFindingPipelines,
  validateOutcomesAgainstSchemas,
} from "@aguil/agents-harness-config";
import { actionableFindings, dedupeFindings } from "@aguil/agents-reporting";

const validFinding: Finding = {
  id: "finding-1",
  severity: "warning",
  title: "Unsafe fallback",
  description: "The fallback bypasses the validation gate.",
  evidence: "Inspection of src/fallback.ts line 42 reproduced the bypass.",
  sourceRole: "quality",
  validation: {
    status: "verified",
    details: "Reproduced with the validation test command.",
  },
  file: "src/fallback.ts",
  line: 42,
};

test("builtin:finding outcome validation matches validateFinding", () => {
  const validOutcome = findingToHarnessOutcome(validFinding);
  const invalidOutcome: HarnessOutcome = {
    id: "finding-2",
    kind: "finding",
    sourceRole: "quality",
    title: "Malformed finding",
    data: {
      severity: "urgent",
      description: "This severity is unsupported.",
      evidence: "The payload also omits validation.",
    },
  };
  const schemas: OutputSchemas = { finding: "builtin:finding" };

  expect(validateOutcomesAgainstSchemas([validOutcome], schemas)).toEqual([]);

  const violations = validateOutcomesAgainstSchemas(
    [validOutcome, invalidOutcome],
    schemas,
  );
  const expected = validateFinding({
    id: invalidOutcome.id,
    title: invalidOutcome.title,
    sourceRole: invalidOutcome.sourceRole,
    ...invalidOutcome.data,
  });
  expect(violations).toHaveLength(1);
  expect(violations[0]?.errors).toEqual(expected.errors);
});

test("record schemas report required fields and data keys", () => {
  const evidenceOutcome = {
    id: "evidence-1",
    kind: "evidence",
    sourceRole: "scout",
    title: "Observed alert",
    data: {},
    summary: "",
  } satisfies HarnessOutcome & { readonly summary: string };
  const undeclaredOutcome: HarnessOutcome = {
    id: "note-1",
    kind: "note",
    sourceRole: "scout",
    title: "Unconstrained note",
    data: {},
  };
  const schemas: OutputSchemas = {
    evidence: {
      required: ["summary"],
      dataRequired: ["alert"],
    },
  };

  expect(
    validateOutcomesAgainstSchemas(
      [evidenceOutcome, undeclaredOutcome],
      schemas,
    ),
  ).toEqual([
    {
      outcomeId: "evidence-1",
      kind: "evidence",
      errors: [
        'required field "summary" must be present and non-empty',
        'data_required key "alert" must be present',
      ],
    },
  ]);
});

test("finding pipelines match reporting composition exactly", () => {
  const duplicate: Finding = {
    ...validFinding,
    id: "finding-duplicate",
  };
  const notReproduced: Finding = {
    ...validFinding,
    id: "finding-not-reproduced",
    title: "Unconfirmed concern",
    validation: {
      status: "not_reproduced",
      details: "Could not reproduce with the validation test command.",
    },
  };
  const findings = [duplicate, notReproduced, validFinding];

  const expected = dedupeFindings(actionableFindings(findings));
  expect(
    applyFindingPipelines(findings, {
      filters: ["builtin:actionable"],
      dedupers: ["builtin:fingerprint"],
    }),
  ).toEqual(expected);
});
