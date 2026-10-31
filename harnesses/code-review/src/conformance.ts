import {
  type AcceptanceCriteriaArtifactContent,
  CONFORMANCE_OUTCOME_KIND,
  type Finding,
  type HarnessOutcome,
  harnessOutcomeToFinding,
  readConformanceVerdict,
} from "@aguil/agents-core";
import { isSubstantiatedFinding } from "@aguil/agents-reporting";
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
 * The rows themselves, for the conformance role's prompt. Reading them from
 * the bundle is not dependable: the artifact comes after everything else in
 * it, so a capped read can stop short of it behind large referenced documents,
 * and a search outside the role's worktree can be refused. Either way the role
 * used to judge rows from the PR's paraphrase of them (#300). The JSON is
 * indented, so no row's text can start a line and close the fence.
 *
 * The closing line is here because the adapter's envelope ends by saying not
 * to emit finding lines when there are none. A live run on #301 stopped there
 * with four verdicts in prose and no outcome lines. It sits in the suffix so
 * installed harnesses get it too.
 */
export function conformancePromptSuffix(input: {
  readonly roleId: string;
  readonly criteria: AcceptanceCriteriaArtifactContent | undefined;
}): string | undefined {
  if (
    input.roleId !== CODE_REVIEW_CONFORMANCE_ROLE_ID ||
    input.criteria?.status !== "loaded" ||
    input.criteria.criteria.length === 0
  ) {
    return undefined;
  }
  return [
    "## Acceptance-criteria rows",
    "",
    "These are all of this run's rows, copied from the context bundle's `acceptance-criteria` artifact. Judge each row by this text. You do not need to read the criteria file or search the bundle for it.",
    "",
    "```json",
    JSON.stringify(input.criteria.criteria, null, 2),
    "```",
    "",
    "Emit one `outcome` line for every row, including a `satisfied` row and a run with no findings. The rule below about finding lines does not apply to outcome lines, and a verdict written only as prose is not recorded.",
  ].join("\n");
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
      // Only the conformance role's verdicts count (the orchestrator stamps
      // sourceRole with the role that actually ran).
      .filter(
        (outcome) => outcome.sourceRole === CODE_REVIEW_CONFORMANCE_ROLE_ID,
      )
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
  const findings = input.outcomes
    .map((outcome) => harnessOutcomeToFinding(outcome))
    .filter((finding): finding is Finding => finding !== undefined);
  return input.outcomes.flatMap((outcome) => {
    const verdict = readConformanceVerdict(outcome);
    if (verdict === undefined) {
      return outcome.kind === CONFORMANCE_OUTCOME_KIND
        ? [
            {
              outcomeId: outcome.id,
              kind: outcome.kind,
              errors: [
                "conformance verdict needs a string criterion, a status of satisfied, unsatisfied, or unverifiable, and a non-empty detail",
              ],
            },
          ]
        : [];
    }
    if (verdict.status === "satisfied") {
      return [];
    }
    const prefix = `[${verdict.criterion}]`;
    // The finding has to count toward status with the weight the verdict
    // carries: an unsubstantiated one is set aside by the actionable filter,
    // a warning would understate an unsatisfied row, and a critical would
    // turn "could not verify" into a claimed failure.
    const severity = verdict.status === "unsatisfied" ? "critical" : "warning";
    const counted = findings.some(
      (finding) =>
        finding.title.startsWith(prefix) &&
        isSubstantiatedFinding(finding) &&
        finding.severity === severity,
    );
    return counted
      ? []
      : [
          {
            outcomeId: outcome.id,
            kind: outcome.kind,
            errors: [
              `criterion ${verdict.criterion} is ${verdict.status} but no ${severity} finding titled "${prefix} …" with validation evidence was emitted`,
            ],
          },
        ];
  });
}

/**
 * Under `--strict`, a scheduled conformance role must give every criterion a
 * verdict. A role that reported nothing otherwise left every row "no result"
 * in a passing run that read like a clean review (#277). Outside `--strict`
 * the report still marks each missing row unchecked.
 */
export function conformanceCoverageViolations(input: {
  readonly roleId: string;
  readonly outcomes: readonly HarnessOutcome[];
  readonly strictMode?: boolean;
  readonly metadata?: Readonly<Record<string, string>>;
}): readonly {
  readonly outcomeId: string;
  readonly kind: string;
  readonly errors: readonly string[];
}[] {
  if (
    input.roleId !== CODE_REVIEW_CONFORMANCE_ROLE_ID ||
    input.strictMode !== true ||
    input.metadata === undefined
  ) {
    return [];
  }
  const keys = CODE_REVIEW_RUN_METADATA_KEYS;
  const reported = (
    conformanceReportedMetadata({
      metadata: input.metadata,
      outcomes: input.outcomes.map((outcome) => ({
        ...outcome,
        sourceRole: input.roleId,
      })),
    })[keys.conformanceReported] ?? ""
  ).split(",");
  const missing = (input.metadata[keys.conformanceCriteria] ?? "")
    .split(",")
    .filter(
      (criterion) => criterion.length > 0 && !reported.includes(criterion),
    );
  return missing.length === 0
    ? []
    : [
        {
          outcomeId: CODE_REVIEW_CONFORMANCE_ROLE_ID,
          kind: CONFORMANCE_OUTCOME_KIND,
          errors: [
            `--strict: no conformance verdict for ${missing.join(", ")}; every scheduled criterion needs one`,
          ],
        },
      ];
}
