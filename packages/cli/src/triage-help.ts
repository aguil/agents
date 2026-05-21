/** Contextual `--help` for `agents triage`. */

import { stripLegacyTriageIngestArgv } from "./parse-triage-argv";

export type TriageHelpRequest = {
  readonly kind: "overview";
  /** Present when user wrote a stray positional, e.g. `agents triage oops --help` */
  readonly unknownPositional?: string;
};

function stripHelpTokens(argv: readonly string[]): readonly string[] {
  return argv.filter((t) => t !== "--help" && t !== "-h");
}

export function resolveTriageHelp(
  argv: readonly string[],
): TriageHelpRequest | null {
  if (argv.length === 0 || !argv.some((t) => t === "--help" || t === "-h")) {
    return null;
  }
  let rest = [...stripHelpTokens(argv)];
  if (rest[0] !== "triage") {
    return null;
  }
  rest = [...stripLegacyTriageIngestArgv(rest.slice(1))];

  if (rest.length === 0 || rest[0].startsWith("-")) {
    return { kind: "overview" };
  }
  return { kind: "overview", unknownPositional: rest[0] };
}

export function renderTriageHelp(req: TriageHelpRequest): string {
  return buildTriageHelp(req.unknownPositional);
}

export function triageHelpStderrExtras(
  req: TriageHelpRequest,
): readonly string[] {
  if (req.unknownPositional !== undefined) {
    return [
      `Unexpected triage positional argument '${req.unknownPositional}'.`,
      `Use options only (they begin with '-') — see 'agents triage --help'.`,
    ];
  }
  return [];
}

function buildTriageHelp(bad?: string): string {
  const lead =
    bad !== undefined
      ? `Note: unexpected argument '${bad}' (stderr has details).\n\n`
      : "";
  return `${lead}Usage: agents triage [options]

Read structured producer output and emit normalized triage queues under
<workspace>/.agents-triage/<outputSlug>/ (outputSlug encodes --from + ingress fingerprint).

Producers: code-review (harness result.json), pr-feedback (feedback.json from agents pr-feedback collect).
This command does not run reviewers or collect threads — produce upstream artifacts first.

Required:

  --from <producer>          code-review | pr-feedback

Optional:

  --workspace <dir>         Repo scope (default: cwd)
  --result <path>           Ingress artifact: code-review result.json (default: newest under .agents-code-review/) or pr-feedback feedback.json (required for pr-feedback)
  --format json|toon|both   Output mode (default: both → JSON + TOON when @toon-format/toon is installed; otherwise JSON only with a warning)
  --output <dir>            Target directory (default: <workspace>/.agents-triage/<outputSlug>/)
  --stdout                  Print exactly one format (--format json|toon required)

Default files (omit --stdout):

  <workspace>/.agents-triage/<outputSlug>/triage-queue.json
  <workspace>/.agents-triage/<outputSlug>/triage-queue.toon  (only when TOON encoding runs; needs optional @toon-format/toon)

Examples:

  agents code-review --workspace /repo
  agents triage --from code-review --workspace /repo
  agents pr-feedback collect --pr 42 --repo org/repo --workspace /repo
  agents triage --from pr-feedback --result /repo/.agents-pr-feedback/org-repo-42/feedback.json --workspace /repo

This repository ignores .agents-triage/ queues via .gitignore so local artifacts stay untracked.

(Accepts legacy spelling: agents triage ingest --from … → same behavior.)
`;
}
