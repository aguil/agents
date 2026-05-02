import type { Finding, HarnessRunResult } from "@aguil/agents-core";

export interface ReportRenderer {
  render(result: HarnessRunResult): string | Promise<string>;
}

export function actionableFindings(findings: readonly Finding[]): readonly Finding[] {
  return findings.filter(isActionableFinding);
}

export function isActionableFinding(finding: Finding): boolean {
  if (finding.validation.status !== "verified") {
    return false;
  }
  return hasSubstantiveValidationDetails(finding.validation.details);
}

export function dedupeFindings(findings: readonly Finding[]): readonly Finding[] {
  const seen = new Set<string>();
  const deduped: Finding[] = [];

  for (const finding of sortFindings(findings)) {
    const key = findingFingerprint(finding);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(finding);
  }

  return deduped;
}

export function findingFingerprint(finding: Finding): string {
  if (finding.file !== undefined && finding.line !== undefined) {
    return [finding.sourceRole, `${finding.file}:${finding.line}`].join("|");
  }
  if (finding.file !== undefined) {
    return [finding.sourceRole, finding.file, semanticSignature(finding.title)].join("|");
  }
  const semantic = semanticSignature([finding.title, finding.description, finding.evidence].join(" "));
  return [finding.sourceRole, semantic].join("|");
}

export function statusForFindings(findings: readonly Finding[]): HarnessRunResult["status"] {
  if (findings.some((finding) => finding.severity === "critical")) {
    return "failed";
  }
  if (findings.length > 0) {
    return "warnings";
  }
  return "passed";
}

export class MarkdownReportRenderer implements ReportRenderer {
  render(result: HarnessRunResult): string {
    return renderMarkdownReport(result);
  }
}

export function renderMarkdownReport(result: HarnessRunResult): string {
  const findings = sortFindings(result.findings);
  const summary = findings.length === 0
    ? "No verified critical or warning findings."
    : `${findings.length} verified finding${findings.length === 1 ? "" : "s"}.`;

  const sections = findings.map((finding, index) => {
    const location = finding.file
      ? `Location: ${finding.file}${finding.line ? `:${finding.line}` : ""}`
      : "";
    return [
      `## ${index + 1}. ${finding.severity.toUpperCase()}: ${finding.title}`,
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
    ...executionNotes.length > 0 ? [""] : [],
    ...sections,
    "",
  ].join("\n");
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

function hasSubstantiveValidationDetails(details: string): boolean {
  const normalized = details.trim().toLowerCase();
  if (normalized.length < 18) {
    return false;
  }
  const evidenceSignals = [
    "reproduced",
    "validated",
    "verified",
    "inspection",
    "trace",
    "command",
    "output",
    "test",
    "line",
    "diff",
    "path",
  ];
  return evidenceSignals.some((signal) => normalized.includes(signal));
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
