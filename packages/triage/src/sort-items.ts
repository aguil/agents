import type { Finding } from "@aguil/agents-core";
import { findingFingerprint } from "@aguil/agents-reporting";

function compareFinding(a: Finding, b: Finding): number {
  if (a.severity !== b.severity) {
    if (a.severity === "critical") {
      return -1;
    }
    return 1;
  }
  const fa = findingFingerprint(a);
  const fb = findingFingerprint(b);
  if (fa !== fb) {
    return fa.localeCompare(fb);
  }
  return a.id.localeCompare(b.id);
}

/** Deterministic reviewer finding order mapped 1:1 to triage rows. */
export function sortReviewFindings(
  findings: readonly Finding[],
): readonly Finding[] {
  return [...findings].sort(compareFinding);
}
