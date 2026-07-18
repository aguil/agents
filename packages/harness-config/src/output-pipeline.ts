import type { Finding, HarnessOutcome } from "@aguil/agents-core";
import {
  FINDING_OUTCOME_KIND,
  harnessOutcomeToFinding,
} from "@aguil/agents-core";
import { validateFinding } from "@aguil/agents-execution";
import { actionableFindings, dedupeFindings } from "@aguil/agents-reporting";
import type {
  FindingDeduperStrategy,
  FindingFilterStrategy,
  OutputSchemas,
} from "./index";

export interface OutcomeSchemaViolation {
  readonly outcomeId: string;
  readonly kind: string;
  readonly errors: readonly string[];
}

export interface ApplyFindingPipelinesConfig {
  readonly filters?: readonly FindingFilterStrategy[];
  readonly dedupers?: readonly FindingDeduperStrategy[];
}

export function validateOutcomesAgainstSchemas(
  outcomes: readonly HarnessOutcome[],
  schemas: OutputSchemas,
): readonly OutcomeSchemaViolation[] {
  const violations: OutcomeSchemaViolation[] = [];

  for (const outcome of outcomes) {
    const schema = schemas[outcome.kind];
    if (schema === undefined) {
      continue;
    }

    const errors =
      schema === "builtin:finding"
        ? validateFindingOutcome(outcome)
        : validateRecordOutcome(outcome, schema);
    if (errors.length > 0) {
      violations.push({
        outcomeId: outcome.id,
        kind: outcome.kind,
        errors,
      });
    }
  }

  return violations;
}

export function applyFindingPipelines(
  findings: readonly Finding[],
  config: ApplyFindingPipelinesConfig,
): readonly Finding[] {
  let result = findings;
  for (const filter of config.filters ?? []) {
    switch (filter) {
      case "builtin:actionable":
        result = actionableFindings(result);
        break;
    }
  }
  for (const deduper of config.dedupers ?? []) {
    switch (deduper) {
      case "builtin:fingerprint":
        result = dedupeFindings(result);
        break;
    }
  }
  return result;
}

function validateFindingOutcome(outcome: HarnessOutcome): readonly string[] {
  if (outcome.kind !== FINDING_OUTCOME_KIND) {
    return [`builtin:finding requires kind "${FINDING_OUTCOME_KIND}"`];
  }
  const finding =
    harnessOutcomeToFinding(outcome) ??
    ({
      id: outcome.id,
      title: outcome.title,
      sourceRole: outcome.sourceRole,
      ...outcome.data,
    } as unknown);
  return validateFinding(finding).errors;
}

function validateRecordOutcome(
  outcome: HarnessOutcome,
  schema: Exclude<OutputSchemas[string], string>,
): readonly string[] {
  const errors: string[] = [];
  const record = outcome as unknown as Readonly<Record<string, unknown>>;
  for (const field of schema.required ?? []) {
    if (!Object.hasOwn(record, field) || isEmpty(record[field])) {
      errors.push(`required field "${field}" must be present and non-empty`);
    }
  }
  for (const key of schema.dataRequired ?? []) {
    if (!Object.hasOwn(outcome.data, key)) {
      errors.push(`data_required key "${key}" must be present`);
    }
  }
  return errors;
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length === 0) ||
    (Array.isArray(value) && value.length === 0)
  );
}
