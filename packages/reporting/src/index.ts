import type { Finding, HarnessRunResult } from "@aguil/agents-core";

export interface ReportRenderer {
  render(result: HarnessRunResult): string | Promise<string>;
}

export function actionableFindings(findings: readonly Finding[]): readonly Finding[] {
  return findings.filter((finding) => finding.validation.status === "verified");
}
