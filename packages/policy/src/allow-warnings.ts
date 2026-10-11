/**
 * Load-time warnings for `exec.allow` entries that void the deny lists (ADR
 * 0026 decision 6, JC-4, JC-6). An allowlisted interpreter or command runner
 * runs whatever its payload or arguments say, and no text rule sees inside
 * that, so the author is told when the policy loads. A warning never fails
 * the load (ADR 0024 §3).
 */

import type { PolicySpec } from "@aguil/agents-harness-config";
import { ruleWords } from "./exec-matching";

/**
 * Interpreters: an entry warns when every word after the program is an
 * option or could be an option's value. Adding a name only adds warnings;
 * removing one hides a voided deny list (ADR 0026 decision 6).
 */
const INTERPRETERS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "python",
  "python3",
  "node",
  "bun",
  "deno",
  "perl",
  "ruby",
  "git",
]);

/** Command runners: an entry warns whatever follows the program. */
const COMMAND_RUNNERS: ReadonlySet<string> = new Set([
  "env",
  "xargs",
  "sudo",
  "find",
]);

/**
 * Whether an `exec.allow` entry admits a payload, alias or command that can
 * run anything. `bash script.sh` and `bun test` name what runs, so they do
 * not (JC-18); `bash`, `python3 -c` and `git -C /tmp` do.
 */
export function allowEntryRunsAnything(entry: string): boolean {
  const [program, ...rest] = ruleWords(entry);
  if (program === undefined) {
    return false;
  }
  const name = program.split("/").pop() ?? program;
  if (COMMAND_RUNNERS.has(name)) {
    return true;
  }
  if (!INTERPRETERS.has(name)) {
    return false;
  }
  // Read as ADR 0026 decision 3 reads a command: a word right after an
  // option with no attached value may be that value.
  let previousTakesValue = false;
  for (const word of rest) {
    if (word.length > 1 && word.startsWith("-")) {
      previousTakesValue = /^-[^-]$/.test(word) || /^--[^=]+$/.test(word);
      continue;
    }
    if (!previousTakesValue) {
      return false;
    }
    previousTakesValue = false;
  }
  return true;
}

/**
 * One warning per `exec.allow` entry that runs anything, naming the policy,
 * the entry and the deny rules it voids: every `exec.deny` rule, and
 * `filesystem.deny` for reads.
 */
export function policyLoadWarnings(policy: PolicySpec): readonly string[] {
  const allow = policy.capabilities?.exec?.allow ?? [];
  const execDeny = policy.capabilities?.exec?.deny ?? [];
  const filesystemDeny = policy.capabilities?.filesystem?.deny ?? [];
  const voided = [
    ...(execDeny.length === 0 ? [] : [`exec.deny ${quoteList(execDeny)}`]),
    ...(filesystemDeny.length === 0
      ? []
      : [`filesystem.deny ${quoteList(filesystemDeny)} for reads`]),
  ];
  const consequence =
    voided.length === 0
      ? "so no deny rule added to this policy would hold for it"
      : `so these deny rules do not hold for it: ${voided.join("; ")}`;
  return allow
    .filter(allowEntryRunsAnything)
    .map(
      (entry) =>
        `policy ${policy.id}: exec.allow entry \`${entry}\` can run any command behind it, ${consequence} (ADR 0026)`,
    );
}

function quoteList(rules: readonly string[]): string {
  return rules.map((rule) => `\`${rule}\``).join(", ");
}
