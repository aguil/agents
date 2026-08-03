import type { Finding, HarnessRunResult } from "@aguil/agents-core";

export const REPORT_TEMPLATE_NAMES = [
  "builtin:code-review-markdown",
  "builtin:outcomes-markdown",
] as const;

export type ReportTemplateName = (typeof REPORT_TEMPLATE_NAMES)[number];

export interface ReportRenderer {
  render(result: HarnessRunResult): string | Promise<string>;
}

/**
 * Mark findings that lack structured backing, rather than removing them
 * (ADR 0019 §3).
 *
 * This used to drop anything whose validation prose failed a keyword test,
 * silently — which hid 43 verified findings across the recorded review
 * history, two of them critical security findings. Nothing removes a finding
 * from a published result now; an unsubstantiated one is reported and left
 * out of run status and triage ingest instead.
 */
export function markUnsubstantiatedFindings(
  findings: readonly Finding[],
): readonly Finding[] {
  return findings.map((finding) => {
    if (!isSubstantiatedFinding(finding)) {
      return { ...finding, unsubstantiated: true };
    }
    if (finding.unsubstantiated === undefined) {
      return finding;
    }
    // Clear rather than pass through. The marker is derived state, and an
    // input that already carries it — from an adapter emitting finding events
    // directly, say — would otherwise take an evidenced finding out of run
    // status and the triage queue. Writing it here means classified output
    // never depends on what the input claimed.
    const { unsubstantiated: _supplied, ...rest } = finding;
    return rest;
  });
}

export function isSubstantiatedFinding(finding: Finding): boolean {
  if (finding.validation.status !== "verified") {
    return false;
  }
  return (finding.validation.evidence ?? []).length > 0;
}

/** Findings that count: published, substantiated, and gate-affecting. */
export function substantiatedFindings(
  findings: readonly Finding[],
): readonly Finding[] {
  return findings.filter((finding) => finding.unsubstantiated !== true);
}

/**
 * Collapse findings sharing a fingerprint, keeping a substantiated one over an
 * unsubstantiated one.
 *
 * The preference is load-bearing rather than cosmetic. Before ADR 0019 the
 * actionable filter ran first and removed unsubstantiated findings outright, so
 * whichever survived to here was substantiated by construction. Now that
 * nothing is removed, a plain first-wins rule lets an unevidenced duplicate
 * evict the evidenced original — and since unsubstantiated findings do not
 * count toward status (§4), that would report a run clean while it held a real
 * finding. That is the #158 failure mode reintroduced through a different door.
 */
export function dedupeFindings(
  findings: readonly Finding[],
): readonly Finding[] {
  const chosen = new Map<string, Finding>();

  for (const finding of sortFindings(findings)) {
    const key = findingFingerprint(finding);
    const incumbent = chosen.get(key);
    if (
      incumbent === undefined ||
      (incumbent.unsubstantiated === true && finding.unsubstantiated !== true)
    ) {
      chosen.set(key, finding);
    }
  }

  return [...chosen.values()];
}

export function findingFingerprint(finding: Finding): string {
  if (finding.file !== undefined && finding.line !== undefined) {
    const semantic = semanticSignature(
      [finding.description, finding.evidence].join(" "),
    );
    return [
      finding.sourceRole,
      `${finding.file}:${finding.line}`,
      semantic,
    ].join("|");
  }
  if (finding.file !== undefined) {
    return [
      finding.sourceRole,
      finding.file,
      semanticSignature(finding.title),
    ].join("|");
  }
  const semantic = semanticSignature(
    [finding.title, finding.description, finding.evidence].join(" "),
  );
  return [finding.sourceRole, semantic].join("|");
}

/**
 * Unsubstantiated findings are reported but do not move the gate (ADR 0019
 * §4) — counting them would flip most runs from clean to non-empty before
 * agents emit structured evidence, and a gate that goes noisy overnight gets
 * ignored rather than heeded.
 */
export function statusForFindings(
  findings: readonly Finding[],
): HarnessRunResult["status"] {
  const counted = substantiatedFindings(findings);
  if (counted.some((finding) => finding.severity === "critical")) {
    return "failed";
  }
  if (counted.length > 0) {
    return "warnings";
  }
  return "passed";
}

export class MarkdownReportRenderer implements ReportRenderer {
  render(result: HarnessRunResult): string {
    return renderMarkdownReport(result);
  }
}

/**
 * Run status once the declared finding pipelines have classified the findings.
 *
 * The orchestrator computes status before those pipelines run, so it judges
 * raw findings that do not yet carry the `unsubstantiated` marker. Every entry
 * point that applies pipelines must therefore recompute, or a finding excluded
 * from the gate still fails the run — the report says "not counted" while the
 * exit code says otherwise.
 *
 * This lives here, shared, because both entry points previously derived status
 * independently and disagreed: `harness run` and `agents code-review` reached
 * different answers for the same document, which is how the divergence went
 * unnoticed.
 *
 * Only the findings-derived part moves. A failed or timed-out role stands, and
 * `findingsBlind` (a harness whose status is owned by a gate — chain
 * `pass_check` or validation-loop — rather than finding severity) is returned
 * untouched: no pipeline can talk a failed pass_check into success. Bare
 * `execution` without a gate stays findings-driven (issue #157 / ADR 0021).
 */
export function statusAfterFindingPipelines(input: {
  readonly rawStatus: HarnessRunResult["status"];
  readonly findings: readonly Finding[];
  readonly findingsBlind: boolean;
  readonly timedOut: boolean;
}): HarnessRunResult["status"] {
  if (input.rawStatus === "error") {
    return "error";
  }
  if (input.findingsBlind) {
    return input.rawStatus;
  }
  const fromFindings = statusForFindings(input.findings);
  if (fromFindings === "failed") {
    return "failed";
  }
  if (fromFindings === "warnings" || input.timedOut) {
    return "warnings";
  }
  return "passed";
}

export function renderMarkdownReport(result: HarnessRunResult): string {
  const all = sortFindings(result.findings);
  const findings = all.filter((finding) => finding.unsubstantiated !== true);
  const unsubstantiated = all.filter(
    (finding) => finding.unsubstantiated === true,
  );
  // The uncounted findings belong in the summary even though they do not move
  // the gate. Omitting them reproduces the defect ADR 0019 exists to fix, in
  // the one line an operator is most likely to read and stop at.
  const counted =
    findings.length === 0
      ? "No verified critical or warning findings."
      : `${findings.length} verified finding${findings.length === 1 ? "" : "s"}.`;
  const summary =
    unsubstantiated.length === 0
      ? counted
      : `${counted} ${unsubstantiated.length} further finding${
          unsubstantiated.length === 1 ? "" : "s"
        } reported but not counted.`;

  const sections = findings.map((finding, index) => {
    const location = finding.file
      ? `Location: ${finding.file}${finding.line ? `:${finding.line}` : ""}`
      : "";
    return [
      `## ${index + 1}. ${severityEmoji(finding.severity)} ${finding.title}`,
      location,
      `Source: ${finding.sourceRole}`,
      "",
      finding.description,
      "",
      `Evidence: ${finding.evidence}`,
      "",
      `Validation: ${finding.validation.status} - ${finding.validation.details}`,
    ]
      .filter(Boolean)
      .join("\n");
  });

  const executionNotes = buildExecutionNotes(result.metadata);

  return [
    "# Code Review Report",
    "",
    `Run: ${result.runId}`,
    `Status: ${result.status}`,
    `Summary: ${summary}`,
    "",
    ...executionNotes,
    ...(executionNotes.length > 0 ? [""] : []),
    ...sections,
    ...renderUnsubstantiatedSection(unsubstantiated),
    "",
  ].join("\n");
}

/**
 * Findings the run produced but did not count (ADR 0019 §4). They are listed
 * rather than dropped: withholding one silently is the defect this section
 * exists to prevent.
 */
function renderUnsubstantiatedSection(
  findings: readonly Finding[],
): readonly string[] {
  if (findings.length === 0) {
    return [];
  }
  return [
    "",
    `## Reported but not counted (${findings.length})`,
    "",
    "Each of these is either not `validation.status: verified` or carries no",
    "`validation.evidence`, so it is excluded from run status and from the",
    "triage queue. They are listed here rather than discarded; judge them",
    "yourself.",
    "",
    ...findings.flatMap((finding) => [
      `### ${severityEmoji(finding.severity)} ${finding.title}`,
      ...(finding.file === undefined
        ? []
        : [
            `Location: ${finding.file}${finding.line === undefined ? "" : `:${finding.line}`}`,
          ]),
      `Source: ${finding.sourceRole}`,
      "",
      finding.description,
      `Evidence: ${finding.evidence}`,
      `Validation: ${finding.validation.status} - ${finding.validation.details}`,
      "",
    ]),
  ];
}

export function renderOutcomesMarkdownReport(result: HarnessRunResult): string {
  const outcomes = result.outcomes ?? [];
  const outcomesByRole = new Map<string, (typeof outcomes)[number][]>();
  for (const outcome of outcomes) {
    const roleOutcomes = outcomesByRole.get(outcome.sourceRole);
    if (roleOutcomes === undefined) {
      outcomesByRole.set(outcome.sourceRole, [outcome]);
    } else {
      roleOutcomes.push(outcome);
    }
  }

  const roleSections: string[] = [];
  for (const [sourceRole, roleOutcomes] of outcomesByRole) {
    roleSections.push(`## ${sourceRole}`);
    for (const outcome of roleOutcomes) {
      roleSections.push(
        `- **[${outcome.kind}] ${outcome.title}** (${outcome.id})`,
      );
      if (Object.keys(outcome.data).length > 0) {
        const json = JSON.stringify(outcome.data, null, 2)
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n");
        roleSections.push(`  \`\`\`json\n${json}\n  \`\`\``);
      }
    }
    roleSections.push("");
  }

  const summary =
    outcomes.length === 0
      ? "No outcomes emitted."
      : `${outcomes.length} outcome${outcomes.length === 1 ? "" : "s"} across ${outcomesByRole.size} role${outcomesByRole.size === 1 ? "" : "s"}.`;

  return [
    "# Harness Report",
    "",
    `Run: ${result.runId}`,
    `Status: ${result.status}`,
    `Summary: ${summary}`,
    "",
    ...roleSections,
  ].join("\n");
}

export function resolveReportRenderer(
  name: string,
): (result: HarnessRunResult) => string {
  switch (name) {
    case "builtin:code-review-markdown":
      return renderMarkdownReport;
    case "builtin:outcomes-markdown":
      return renderOutcomesMarkdownReport;
    default:
      throw new Error(
        `unknown report template "${name}" (supported: ${REPORT_TEMPLATE_NAMES.join(", ")})`,
      );
  }
}

function sortFindings(findings: readonly Finding[]): readonly Finding[] {
  return [...findings].sort((left, right) => {
    const severity = severityRank(left.severity) - severityRank(right.severity);
    if (severity !== 0) {
      return severity;
    }
    return left.title.localeCompare(right.title);
  });
}

function severityRank(severity: Finding["severity"]): number {
  return severity === "critical" ? 0 : 1;
}

export function severityEmoji(severity: Finding["severity"]): string {
  if (severity === "critical") {
    return "🔴";
  }
  if (severity === "warning") {
    return "⚠️";
  }
  return "❓";
}

function buildExecutionNotes(
  metadata: Readonly<Record<string, string>> | undefined,
): readonly string[] {
  if (metadata === undefined) {
    return [];
  }

  const timedOutRoles = parseRoleList(metadata.timed_out_roles);
  const failedRoles = parseRoleList(metadata.failed_roles);
  const strictMode = metadata.strict_mode === "true";
  if (timedOutRoles.length === 0 && failedRoles.length === 0 && !strictMode) {
    return [];
  }

  const notes = ["## Execution Notes"];
  notes.push(`- Strict mode: ${strictMode ? "enabled" : "disabled"}`);
  if (timedOutRoles.length > 0) {
    notes.push(`- Timed out roles: ${timedOutRoles.join(", ")}`);
  }
  if (failedRoles.length > 0) {
    notes.push(`- Failed roles: ${failedRoles.join(", ")}`);
  }
  return notes;
}

function parseRoleList(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const STOP_WORDS = new Set([
  "this",
  "that",
  "with",
  "from",
  "into",
  "only",
  "when",
  "where",
  "would",
  "should",
  "could",
  "using",
  "used",
  "than",
  "then",
  "there",
  "their",
  "because",
  "which",
  "while",
  "have",
  "has",
  "been",
  "were",
  "through",
]);

function semanticSignature(text: string): string {
  const tokens = (text.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
    .filter((token) => token.length >= 4)
    .filter((token) => !STOP_WORDS.has(token));
  if (tokens.length === 0) {
    return text.toLowerCase().trim().replace(/\s+/g, " ");
  }

  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => {
      const byCount = right[1] - left[1];
      if (byCount !== 0) {
        return byCount;
      }
      return left[0].localeCompare(right[0]);
    })
    .slice(0, 8)
    .map(([token]) => token)
    .join(".");
}
