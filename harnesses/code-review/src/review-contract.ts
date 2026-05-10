import type { ReviewTriageTier } from "@aguil/agents-core";

/** Stable wire keys written by the code-review harness into run metadata (`result.json`). */
export const CODE_REVIEW_RUN_METADATA_KEYS = {
  triage: "triage",
  completedRoles: "completed_roles",
  timedOutRoles: "timed_out_roles",
  failedRoles: "failed_roles",
} as const;

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
  };
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
  return roleId;
}
