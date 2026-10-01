/**
 * Acceptance-criteria rows: the one machine-readable shape that both the
 * author-side constraint trace (`self-review-checks`) and the reviewer-side
 * code-review `conformance` role read (ADR 0025). Spec:
 * `docs/harnesses/code-review/spec/acceptance-criteria.md`.
 */

export const ACCEPTANCE_CRITERIA_FORMAT_VERSION = 1;

/** Context-bundle artifact id the `acceptance-criteria` provider emits. */
export const ACCEPTANCE_CRITERIA_ARTIFACT_ID = "acceptance-criteria";

/** `HarnessOutcome.kind` for one per-row conformance verdict. */
export const CONFORMANCE_OUTCOME_KIND = "conformance";

export const CONFORMANCE_STATUSES = [
  "satisfied",
  "unsatisfied",
  "unverifiable",
] as const;

export type ConformanceStatus = (typeof CONFORMANCE_STATUSES)[number];

/**
 * How a row can be checked. `diff`: the change itself shows whether the row
 * holds. `runtime`: the behavior is only observable when the code runs, so
 * only a test in the change (or already in the repository) can show it.
 */
export type AcceptanceCriterionCheck = "diff" | "runtime";

export interface AcceptanceCriterion {
  /** Unique within the file; letters, digits, `.`, `_`, `-` (no commas). */
  readonly id: string;
  readonly statement: string;
  readonly check: AcceptanceCriterionCheck;
  /** Tests the change must add, by name or description. */
  readonly requiredTests: readonly string[];
}

export interface AcceptanceCriteriaDocument {
  /** Where the rows were taken from (a plan section, a hand-off message). */
  readonly source?: string;
  readonly criteria: readonly AcceptanceCriterion[];
}

export type ParsedAcceptanceCriteria =
  | { readonly ok: true; readonly document: AcceptanceCriteriaDocument }
  | { readonly ok: false; readonly error: string };

const CRITERION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const DOCUMENT_KEYS = ["version", "source", "criteria"] as const;
const CRITERION_KEYS = ["id", "statement", "check", "required_tests"] as const;

/**
 * Unknown keys are errors, not extras: `requiredTests` or a misspelled
 * `required_tests` would otherwise parse as "no required tests".
 */
function unknownKeyError(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): string | undefined {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  return unknown.length === 0
    ? undefined
    : `${label} has unknown key${unknown.length === 1 ? "" : "s"} ${unknown.map((key) => `"${key}"`).join(", ")} (allowed: ${allowed.join(", ")})`;
}

/**
 * Parse an acceptance-criteria file. Every defect is an error rather than a
 * dropped row: a row that silently disappears is a constraint nobody checks.
 */
export function parseAcceptanceCriteria(
  text: string,
): ParsedAcceptanceCriteria {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: `not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "top level must be an object" };
  }
  const record = parsed as Record<string, unknown>;
  const unknownTopLevel = unknownKeyError(record, DOCUMENT_KEYS, "top level");
  if (unknownTopLevel !== undefined) {
    return { ok: false, error: unknownTopLevel };
  }
  if (record.version !== ACCEPTANCE_CRITERIA_FORMAT_VERSION) {
    return {
      ok: false,
      error: `"version" must be ${ACCEPTANCE_CRITERIA_FORMAT_VERSION}`,
    };
  }
  if (
    record.source !== undefined &&
    (typeof record.source !== "string" || record.source.length === 0)
  ) {
    return { ok: false, error: `"source" must be a non-empty string` };
  }
  if (!Array.isArray(record.criteria) || record.criteria.length === 0) {
    return { ok: false, error: `"criteria" must be a non-empty list` };
  }
  const criteria: AcceptanceCriterion[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of record.criteria.entries()) {
    const row = parseCriterion(entry, `criteria[${index}]`);
    if (typeof row === "string") {
      return { ok: false, error: row };
    }
    if (seen.has(row.id)) {
      return { ok: false, error: `duplicate criterion id "${row.id}"` };
    }
    seen.add(row.id);
    criteria.push(row);
  }
  return {
    ok: true,
    document: {
      ...(typeof record.source === "string" ? { source: record.source } : {}),
      criteria,
    },
  };
}

function parseCriterion(
  entry: unknown,
  label: string,
): AcceptanceCriterion | string {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return `${label} must be an object`;
  }
  const row = entry as Record<string, unknown>;
  const unknownRowKey = unknownKeyError(row, CRITERION_KEYS, label);
  if (unknownRowKey !== undefined) {
    return unknownRowKey;
  }
  if (typeof row.id !== "string" || !CRITERION_ID_PATTERN.test(row.id)) {
    return `${label}.id must match ${CRITERION_ID_PATTERN.source}`;
  }
  if (typeof row.statement !== "string" || row.statement.trim().length === 0) {
    return `${label}.statement must be a non-empty string`;
  }
  const check = row.check ?? "diff";
  if (check !== "diff" && check !== "runtime") {
    return `${label}.check must be "diff" or "runtime"`;
  }
  const requiredTests = row.required_tests ?? [];
  if (
    !Array.isArray(requiredTests) ||
    requiredTests.some(
      (test) => typeof test !== "string" || test.trim().length === 0,
    )
  ) {
    return `${label}.required_tests must be a list of non-empty strings`;
  }
  return {
    id: row.id,
    statement: row.statement,
    check,
    requiredTests: requiredTests as string[],
  };
}

/**
 * What the `acceptance-criteria` provider found. `absent` and `invalid` are
 * recorded rather than omitted so a run without criteria can say why the
 * conformance role did not run instead of passing silently.
 */
export interface AcceptanceCriteriaArtifactContent {
  readonly status: "loaded" | "absent" | "invalid";
  readonly reason: string;
  readonly sources: readonly string[];
  readonly criteria: readonly AcceptanceCriterion[];
}

/**
 * Read the provider's artifact content back; undefined when malformed.
 *
 * Replayed bundles are loaded without per-artifact validation, so every row
 * is checked here too: a row that is not a well-formed criterion would
 * otherwise count toward enabling the role and crash whatever reads it.
 */
export function readAcceptanceCriteriaArtifact(
  content: string,
): AcceptanceCriteriaArtifactContent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Partial<AcceptanceCriteriaArtifactContent>;
  if (
    (record.status !== "loaded" &&
      record.status !== "absent" &&
      record.status !== "invalid") ||
    typeof record.reason !== "string" ||
    !Array.isArray(record.sources) ||
    record.sources.some((source) => typeof source !== "string") ||
    !Array.isArray(record.criteria) ||
    !record.criteria.every(isAcceptanceCriterion) ||
    // Outcome ids and report rows are keyed by criterion id, so a repeated
    // id would let one verdict stand in for two rows.
    new Set(record.criteria.map((row) => row.id)).size !==
      record.criteria.length
  ) {
    return undefined;
  }
  return record as AcceptanceCriteriaArtifactContent;
}

function isAcceptanceCriterion(value: unknown): value is AcceptanceCriterion {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const row = value as Partial<AcceptanceCriterion>;
  return (
    typeof row.id === "string" &&
    CRITERION_ID_PATTERN.test(row.id) &&
    typeof row.statement === "string" &&
    (row.check === "diff" || row.check === "runtime") &&
    Array.isArray(row.requiredTests) &&
    row.requiredTests.every((test) => typeof test === "string")
  );
}

export interface ConformanceVerdict {
  readonly criterion: string;
  readonly status: ConformanceStatus;
  readonly detail: string;
}

/** Read one conformance outcome's `data`; undefined when not one. */
export function readConformanceVerdict(outcome: {
  readonly kind: string;
  readonly data: Readonly<Record<string, unknown>>;
}): ConformanceVerdict | undefined {
  if (outcome.kind !== CONFORMANCE_OUTCOME_KIND) {
    return undefined;
  }
  const { criterion, status, detail } = outcome.data;
  if (
    typeof criterion !== "string" ||
    typeof status !== "string" ||
    !(CONFORMANCE_STATUSES as readonly string[]).includes(status)
  ) {
    return undefined;
  }
  return {
    criterion,
    status: status as ConformanceStatus,
    detail: typeof detail === "string" ? detail : "",
  };
}
