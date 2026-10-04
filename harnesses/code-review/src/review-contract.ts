import type { ReviewTriageTier } from "@aguil/agents-core";

/** Stable wire keys written by the code-review harness into run metadata (`result.json`). */
export const CODE_REVIEW_RUN_METADATA_KEYS = {
  triage: "triage",
  completedRoles: "completed_roles",
  timedOutRoles: "timed_out_roles",
  failedRoles: "failed_roles",
  /**
   * How many published findings were excluded from status and triage — either
   * not `validation.status: verified`, or carrying no `validation.evidence`
   * (ADR 0019 §4).
   */
  unsubstantiatedFindings: "unsubstantiated_findings",
  /**
   * `scheduled` or `not_run` for the optional conformance role (ADR 0025).
   * Absent when the harness declares no such role.
   */
  conformance: "conformance",
  /** Why the conformance role was or was not scheduled. */
  conformanceReason: "conformance_reason",
  /** Comma-separated criterion ids the conformance role was given. */
  conformanceCriteria: "conformance_criteria",
  /**
   * Comma-separated criterion ids the role returned a verdict for, in
   * criteria order. Present only when the role was scheduled.
   */
  conformanceReported: "conformance_reported",
} as const;

/**
 * Optional role that checks a change against acceptance-criteria rows
 * (ADR 0025). Gated by its own CEL binding, not by triage tier, so it is
 * deliberately absent from {@link CODE_REVIEW_ROLE_IDS}.
 */
export const CODE_REVIEW_CONFORMANCE_ROLE_ID = "conformance";

export type CodeReviewConformanceState = "scheduled" | "not_run";

/** Canonical full role order for scheduling and review-coverage summaries. */
export const CODE_REVIEW_ROLE_IDS = [
  "security",
  "performance",
  "quality",
  "compliance",
] as const;

export type CodeReviewRoleId = (typeof CODE_REVIEW_ROLE_IDS)[number];

export interface CodeReviewRunMetadata {
  readonly triageTier: ReviewTriageTier | undefined;
  /** Raw `triage` field when present (may be non-canonical when `triageTier` is undefined). */
  readonly triageRaw: string | undefined;
  readonly completedRoles: readonly string[];
  readonly timedOutRoles: readonly string[];
  readonly failedRoles: readonly string[];
  /**
   * Findings published but excluded from run status and triage (ADR 0019 §4),
   * because `validation.status` is not `verified` or `validation.evidence` is
   * absent or empty. Both limbs count: a `not_reproduced` finding is uncounted
   * even when it cites the command that failed to reproduce it. Absent from
   * older runs, which is why it parses to 0 rather than being required.
   */
  readonly unsubstantiatedFindings: number;
  /** Undefined when the run's harness declared no conformance role. */
  readonly conformance: CodeReviewConformanceState | undefined;
  readonly conformanceReason: string | undefined;
  readonly conformanceCriteria: readonly string[];
  /** Undefined when not recorded (role not scheduled, or an older run). */
  readonly conformanceReported: readonly string[] | undefined;
}

/** Same type as {@link CodeReviewRunMetadata}; named for tooling / schema references. */
export type RunMetadataSchema = CodeReviewRunMetadata;

export function parseMetadataRolesList(
  raw: string | undefined,
): readonly string[] {
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function parseTriageTierFromRunMetadata(
  raw: string | undefined,
): ReviewTriageTier | undefined {
  if (raw === "trivial" || raw === "lite" || raw === "full") {
    return raw;
  }
  return undefined;
}

export function parseCodeReviewRunMetadata(
  record: Readonly<Record<string, string | undefined>> | undefined,
): CodeReviewRunMetadata {
  if (record === undefined) {
    return {
      triageTier: undefined,
      triageRaw: undefined,
      completedRoles: [],
      timedOutRoles: [],
      failedRoles: [],
      unsubstantiatedFindings: 0,
      conformance: undefined,
      conformanceReason: undefined,
      conformanceCriteria: [],
      conformanceReported: undefined,
    };
  }
  const trimmedTriage =
    record[CODE_REVIEW_RUN_METADATA_KEYS.triage]?.trim() ?? "";
  const triageRaw = trimmedTriage.length === 0 ? undefined : trimmedTriage;
  return {
    triageTier: parseTriageTierFromRunMetadata(triageRaw),
    triageRaw,
    completedRoles: parseMetadataRolesList(
      record[CODE_REVIEW_RUN_METADATA_KEYS.completedRoles],
    ),
    timedOutRoles: parseMetadataRolesList(
      record[CODE_REVIEW_RUN_METADATA_KEYS.timedOutRoles],
    ),
    failedRoles: parseMetadataRolesList(
      record[CODE_REVIEW_RUN_METADATA_KEYS.failedRoles],
    ),
    unsubstantiatedFindings: parseMetadataCount(
      record[CODE_REVIEW_RUN_METADATA_KEYS.unsubstantiatedFindings],
    ),
    conformance: parseConformanceState(
      record[CODE_REVIEW_RUN_METADATA_KEYS.conformance],
    ),
    conformanceReason:
      record[CODE_REVIEW_RUN_METADATA_KEYS.conformanceReason]?.trim() ||
      undefined,
    conformanceCriteria: parseMetadataRolesList(
      record[CODE_REVIEW_RUN_METADATA_KEYS.conformanceCriteria],
    ),
    conformanceReported:
      record[CODE_REVIEW_RUN_METADATA_KEYS.conformanceReported] === undefined
        ? undefined
        : parseMetadataRolesList(
            record[CODE_REVIEW_RUN_METADATA_KEYS.conformanceReported],
          ),
  };
}

function parseConformanceState(
  raw: string | undefined,
): CodeReviewConformanceState | undefined {
  return raw === "scheduled" || raw === "not_run" ? raw : undefined;
}

/**
 * A non-negative count off the wire. Anything unparseable reads as 0, matching
 * how the roles lists treat absence: a run recorded before the key existed is
 * not a run with a broken count.
 */
function parseMetadataCount(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** Roles scheduled for each triage tier (single source for harness + CLI). */
export function expectedRolesForTriageTier(
  tier: ReviewTriageTier,
): readonly CodeReviewRoleId[] {
  if (tier === "trivial") {
    return ["quality"];
  }
  if (tier === "lite") {
    return ["security", "quality", "compliance"];
  }
  return [...CODE_REVIEW_ROLE_IDS];
}

export function roleReviewSectionLabel(roleId: string): string {
  if (roleId === "security") {
    return "Security";
  }
  if (roleId === "performance") {
    return "Runtime / Performance";
  }
  if (roleId === "quality") {
    return "Correctness / Quality";
  }
  if (roleId === "compliance") {
    return "Documentation / Compliance";
  }
  if (roleId === CODE_REVIEW_CONFORMANCE_ROLE_ID) {
    return "Plan Conformance";
  }
  return roleId;
}
