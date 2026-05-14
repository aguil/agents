import type { Finding } from "@aguil/agents-core";
import { findingFingerprint } from "@aguil/agents-reporting";

function compareDecorated(
  a: { readonly f: Finding; readonly fp: string },
  b: { readonly f: Finding; readonly fp: string },
): number {
  if (a.f.severity !== b.f.severity) {
    if (a.f.severity === "critical") {
      return -1;
    }
    return 1;
  }
  if (a.fp !== b.fp) {
    return a.fp.localeCompare(b.fp);
  }
  return a.f.id.localeCompare(b.f.id);
}

/** Deterministic reviewer finding order mapped 1:1 to triage rows. */
export function sortReviewFindings(
  findings: readonly Finding[],
): readonly Finding[] {
  const decorated = findings.map((f) => ({
    f,
    fp: findingFingerprint(f),
  }));
  decorated.sort(compareDecorated);
  return decorated.map((d) => d.f);
}
