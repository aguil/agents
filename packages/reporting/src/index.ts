import type { Finding, HarnessRunResult } from "@aguil/agents-core";

export interface ReportRenderer {
  render(result: HarnessRunResult): string | Promise<string>;
}

export function actionableFindings(findings: readonly Finding[]): readonly Finding[] {
  return findings.filter((finding) => finding.validation.status === "verified");
}

export function dedupeFindings(findings: readonly Finding[]): readonly Finding[] {
  const seen = new Set<string>();
  const deduped: Finding[] = [];

  for (const finding of sortFindings(findings)) {
    const key = [
      finding.file ?? "",
      finding.line?.toString() ?? "",
      finding.title.toLowerCase().trim(),
    ].join(":");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(finding);
  }

  return deduped;
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
  if (timedOutRoles.length === 0 && failedRoles.length === 0) {
    return [];
  }

  const notes = ["## Execution Notes"];
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
