import {
  type AcceptanceCriteriaArtifactContent,
  type HarnessOutcome,
  readConformanceVerdict,
} from "@aguil/agents-core";
import {
  CODE_REVIEW_CONFORMANCE_ROLE_ID,
  CODE_REVIEW_RUN_METADATA_KEYS,
} from "./review-contract";

/**
 * Run metadata recording whether the conformance role ran and why (ADR 0025).
 * A harness that declares no conformance role gets no keys, so its report is
 * unchanged; one that declares it always says which way it went, because a
 * role that silently did not run reads exactly like one that found nothing.
 */
export function conformanceRunMetadata(input: {
  readonly declaredRoleIds: readonly string[];
  readonly enabledRoleIds: readonly string[];
  readonly criteria: AcceptanceCriteriaArtifactContent | undefined;
}): Readonly<Record<string, string>> {
  if (!input.declaredRoleIds.includes(CODE_REVIEW_CONFORMANCE_ROLE_ID)) {
    return {};
  }
  const keys = CODE_REVIEW_RUN_METADATA_KEYS;
  if (input.enabledRoleIds.includes(CODE_REVIEW_CONFORMANCE_ROLE_ID)) {
    return {
      [keys.conformance]: "scheduled",
      [keys.conformanceReason]: input.criteria?.reason ?? "",
      [keys.conformanceCriteria]: (input.criteria?.criteria ?? [])
        .map((criterion) => criterion.id)
        .join(","),
    };
  }
  return {
    [keys.conformance]: "not_run",
    [keys.conformanceReason]: notRunReason(input.criteria),
  };
}

function notRunReason(
  criteria: AcceptanceCriteriaArtifactContent | undefined,
): string {
  if (criteria === undefined) {
    return "the context bundle has no well-formed acceptance-criteria artifact (no `acceptance-criteria` provider, a bundle recorded before it existed, or a malformed one)";
  }
  if (criteria.status === "loaded") {
    return `criteria loaded (${criteria.reason}), but the role's \`enabled\` expression is false`;
  }
  return criteria.status === "invalid"
    ? `acceptance criteria could not be used: ${criteria.reason}`
    : criteria.reason;
}

/**
 * Which scheduled criteria actually got a verdict, recorded after the run so
 * consumers that only see metadata (posted reviews) cannot claim a row was
 * checked when the role never reported it.
 */
export function conformanceReportedMetadata(input: {
  readonly metadata: Readonly<Record<string, string>>;
  readonly outcomes: readonly HarnessOutcome[] | undefined;
}): Readonly<Record<string, string>> {
  const keys = CODE_REVIEW_RUN_METADATA_KEYS;
  if (input.metadata[keys.conformance] !== "scheduled") {
    return {};
  }
  const reported = new Set(
    (input.outcomes ?? [])
      .map((outcome) => readConformanceVerdict(outcome)?.criterion)
      .filter((criterion) => criterion !== undefined),
  );
  const criteria = (input.metadata[keys.conformanceCriteria] ?? "")
    .split(",")
    .filter((criterion) => criterion.length > 0);
  return {
    [keys.conformanceReported]: criteria
      .filter((criterion) => reported.has(criterion))
      .join(","),
  };
}
