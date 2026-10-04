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

/**
 * A conformance verdict that is not `satisfied` must come with a finding
 * titled `[<criterion id>] …`, because only findings reach run status and
 * triage. Without this check, a role that reported an unsatisfied row but
 * skipped the finding would leave a passing run under a failing report.
 * The finding is not synthesized (ADR 0025 rules that out); the role's
 * output is rejected instead, which marks the role failed.
 */
export function conformanceOutcomeViolations(input: {
  readonly roleId: string;
  readonly outcomes: readonly HarnessOutcome[];
}): readonly {
  readonly outcomeId: string;
  readonly kind: string;
  readonly errors: readonly string[];
}[] {
  if (input.roleId !== CODE_REVIEW_CONFORMANCE_ROLE_ID) {
    return [];
  }
  const findingTitles = input.outcomes
    .filter((outcome) => outcome.kind === "finding")
    .map((outcome) => outcome.title);
  return input.outcomes.flatMap((outcome) => {
    const verdict = readConformanceVerdict(outcome);
    if (verdict === undefined || verdict.status === "satisfied") {
      return [];
    }
    const prefix = `[${verdict.criterion}]`;
    return findingTitles.some((title) => title.startsWith(prefix))
      ? []
      : [
          {
            outcomeId: outcome.id,
            kind: outcome.kind,
            errors: [
              `criterion ${verdict.criterion} is ${verdict.status} but no finding titled "${prefix} …" was emitted`,
            ],
          },
        ];
  });
}
