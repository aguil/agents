import type {
  PolicyCapabilityRules,
  PolicySpec,
} from "@aguil/agents-harness-config";
import {
  allowRuleMatches,
  argumentsOf,
  denyRuleMatches,
  leadingWords,
  ruleWords,
  simpleCommandsOf,
} from "./exec-matching";
import { tokenizeShellCommand } from "./shell-tokenizer";

export { allowEntryRunsAnything, policyLoadWarnings } from "./allow-warnings";
export type {
  ShellOperatorToken,
  ShellToken,
  ShellTokenizeResult,
  ShellWord,
} from "./shell-tokenizer";
export { tokenizeShellCommand } from "./shell-tokenizer";

export type PolicyVerdictDecision =
  | "allow"
  | "warn"
  | "deny"
  | "escalate"
  | "transform";

export interface PolicyVerdict {
  readonly decision: PolicyVerdictDecision;
  /** Low-cardinality code (e.g. "exec-denied"). */
  readonly reason?: string;
  /** Human/agent-facing explanation. */
  readonly message?: string;
  /**
   * The policy rule behind the verdict, phrased for the agent: the entry
   * that matched, or the entry that was missing (#238). It names the rule,
   * never the full command. Absent on allow and on evaluator failures.
   */
  readonly rule?: string;
  /** Replacement tool input; only meaningful for "transform". */
  readonly transform?: Readonly<Record<string, unknown>>;
}

/**
 * Reserved reason for evaluator failures (fail-closed). Policy rules must
 * never emit this reason themselves.
 */
export const POLICY_RUNTIME_ERROR_REASON = "policy-runtime-error";

/**
 * Reserved AGENTS_POLICY_ID token for roles that explicitly run without a
 * policy: the bridge treats it as an allow no-op. Distinct from a MISSING
 * variable, which means the enforcement env was stripped and must deny
 * (fail closed). '@' is outside the policy id grammar, so the token cannot
 * collide with a real policy id (ADR 0008).
 */
export const POLICY_NONE_TOKEN = "@none";

export type PolicyInterventionPoint =
  | "pre_tool_call"
  | "post_tool_call"
  | "role_start"
  | "role_stop"
  | "run_start"
  | "run_end";

/**
 * What the caller knows that the evaluator cannot find out itself (JC-20).
 * The evaluator has no file-system access, so the caller resolves paths.
 */
export interface PolicyEvalOptions {
  /**
   * The workspace-relative form of an absolute path inside the run's
   * workspace, symbolic links resolved as for a file tool's path; undefined
   * for a path outside it. The policy-eval bridge supplies it from
   * `--workspace`. Without it, an absolute argument is not checked against
   * `filesystem.deny` (JC-15).
   */
  readonly relativizeWorkspacePath?: (
    absolutePath: string,
  ) => string | undefined;
}

export interface PolicyEvalInput {
  readonly interventionPoint: PolicyInterventionPoint;
  readonly toolName?: string;
  readonly toolInput?: Readonly<Record<string, unknown>>;
  readonly state?: {
    readonly elapsedMs?: number;
    readonly cumulativeCostUsd?: number;
  };
}

const VERDICT_SEVERITY: Readonly<Record<PolicyVerdictDecision, number>> = {
  deny: 4,
  escalate: 3,
  transform: 2,
  warn: 1,
  allow: 0,
};

export const ALLOW_VERDICT: PolicyVerdict = { decision: "allow" };

/**
 * Compose verdicts from the policy evaluator and any user hooks:
 * deny > escalate > transform > warn > allow. A deny anywhere wins — user
 * hooks can tighten but never override a policy deny.
 */
export function composeVerdicts(
  verdicts: readonly PolicyVerdict[],
): PolicyVerdict {
  let composed = ALLOW_VERDICT;
  for (const verdict of verdicts) {
    if (
      VERDICT_SEVERITY[verdict.decision] > VERDICT_SEVERITY[composed.decision]
    ) {
      composed = verdict;
    }
  }
  return composed;
}

/**
 * The word-boundary prefix of ADR 0006 §2 on the raw string: deny "rm"
 * blocks "rm -rf x" but not "rmdir". Kept as a second way for a deny rule to
 * match, beside ADR 0026's reading, so no command denied before is allowed.
 */
function commandMatchesRule(command: string, rule: string): boolean {
  return command === rule || command.startsWith(`${rule} `);
}

/**
 * Allow-prefix matching is only safe for a single simple command: the shell
 * executes the whole string, so "rg foo && curl evil" must not count as an
 * allow-list match for "rg" (it would bypass exec and network rules). Any
 * operator the shell acts on (a chain, pipe, substitution or redirection)
 * disqualifies the command, and so does a quote the tokenizer cannot close.
 * An operator inside quotes is an argument, not chaining (#237).
 *
 * Returns what disqualifies the command, phrased for a denial, or undefined
 * for a single simple command.
 */
function shellChainingIn(command: string): string | undefined {
  const parsed = tokenizeShellCommand(command);
  if (!parsed.ok) {
    return `an unbalanced \`${parsed.quote}\``;
  }
  const operator = parsed.tokens.find((token) => token.kind === "operator");
  if (operator === undefined) {
    return undefined;
  }
  return (
    OPERATOR_PHRASES[operator.value] ??
    `\`${operator.fd ?? ""}${operator.value}\` outside quotes`
  );
}

/** Operators whose denial reads better than "`<op>` outside quotes". */
const OPERATOR_PHRASES: Readonly<Record<string, string>> = {
  "\n": "a newline outside quotes",
  "$(": "a `$(…)` substitution",
  "`": "a backtick substitution",
  "#": "a `#` comment",
  "$'": "`$'…'` quoting",
  "${": `a \`\${…}\` holding quotes or expansions`,
};

/** The program a command runs, for naming the allow entry it lacks. */
function commandProgram(command: string): string {
  const parsed = tokenizeShellCommand(command);
  const first = parsed.ok ? parsed.tokens[0] : undefined;
  return first?.kind === "word"
    ? first.value
    : (command.split(/\s+/)[0] ?? command);
}

/**
 * The rule an unlisted command lacks. Where allow entries name the same
 * program, they are listed, so the agent sees which forms are allowed.
 */
function missingExecAllowRule(
  allow: readonly string[],
  command: string,
): string {
  const program = commandProgram(command);
  const related = allow.filter(
    (rule) => rule === program || rule.startsWith(`${program} `),
  );
  return related.length === 0
    ? `no allow entry for \`${program}\``
    : `no allow entry for this \`${program}\` command; allowed: ${related
        .map((rule) => `\`${rule}\``)
        .join(", ")}`;
}

function pathMatchesRule(relativePath: string, rule: string): boolean {
  if (rule === "*" || rule === "**") {
    return true;
  }
  return new Bun.Glob(rule).match(relativePath);
}

/**
 * Collapse `.` / `..` segments with posix semantics so traversal aliases
 * ("src/../.env") cannot dodge deny globs written against canonical
 * workspace-relative paths. Returns undefined when the path escapes the
 * workspace root or is absolute — globs cannot classify those, so callers
 * must treat them as denied under any filesystem-ruled policy.
 */
function canonicalizeCandidatePath(path: string): string | undefined {
  if (isAbsoluteCandidatePath(path)) {
    return undefined;
  }
  const segments: string[] = [];
  for (const segment of path.split(/[\\/]+/)) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return undefined;
      }
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/");
}

function isAbsoluteCandidatePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function hostMatchesRule(host: string, rule: string): boolean {
  if (rule === "*") {
    return true;
  }
  return host === rule || host.endsWith(`.${rule}`);
}

const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "Create",
  "MultiEdit",
  "NotebookEdit",
]);

function extractCommand(input: PolicyEvalInput): string | undefined {
  const command = input.toolInput?.command;
  return typeof command === "string" && command.trim().length > 0
    ? command.trim()
    : undefined;
}

function extractFilePath(input: PolicyEvalInput): string | undefined {
  // Claude Code's NotebookEdit names its file `notebook_path`.
  const candidate =
    input.toolInput?.file_path ??
    input.toolInput?.path ??
    input.toolInput?.notebook_path;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

function extractHost(input: PolicyEvalInput): string | undefined {
  const url = input.toolInput?.url;
  if (typeof url !== "string" || url.length === 0) {
    return undefined;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

type RulesResult =
  | { readonly status: "denied"; readonly rule: string }
  | { readonly status: "allowed"; readonly rule?: string }
  | { readonly status: "unlisted" };

function evaluateRules(
  rules: PolicyCapabilityRules | undefined,
  candidate: string,
  matches: (candidate: string, rule: string) => boolean,
): RulesResult {
  if (rules === undefined) {
    return { status: "allowed" };
  }
  const denied = rules.deny?.find((rule) => matches(candidate, rule));
  if (denied !== undefined) {
    return { status: "denied", rule: denied };
  }
  if (rules.allow === undefined || rules.allow.length === 0) {
    return { status: "allowed" };
  }
  const allowed = rules.allow.find((rule) => matches(candidate, rule));
  return allowed === undefined
    ? { status: "unlisted" }
    : { status: "allowed", rule: allowed };
}

/**
 * Exec rules (ADR 0026 decisions 1 to 4). Deny rules are checked against
 * every simple command, substitutions included, by program and subcommand;
 * allow rules against the command's leading words, as a word prefix. A
 * command with an operator outside quotes still matches an allow rule here,
 * and evaluateExec then makes it unlisted, naming the operator.
 */
function evaluateExecRules(
  exec: PolicyCapabilityRules | undefined,
  command: string,
): RulesResult {
  if (exec === undefined) {
    return { status: "allowed" };
  }
  const commands = simpleCommandsOf(command);
  const denied = exec.deny?.find((rule) => {
    if (commandMatchesRule(command, rule)) {
      return true;
    }
    const words = ruleWords(rule);
    return commands.some((simple) => denyRuleMatches(simple, words));
  });
  if (denied !== undefined) {
    return { status: "denied", rule: denied };
  }
  if (exec.allow === undefined || exec.allow.length === 0) {
    return { status: "allowed" };
  }
  const words = leadingWords(command);
  const allowed = exec.allow.find((rule) =>
    allowRuleMatches(words, ruleWords(rule)),
  );
  return allowed === undefined
    ? { status: "unlisted" }
    : { status: "allowed", rule: allowed };
}

function evaluateExec(
  policy: PolicySpec,
  input: PolicyEvalInput,
): PolicyVerdict {
  const command = extractCommand(input);
  if (command === undefined) {
    return ALLOW_VERDICT;
  }
  const exec = policy.capabilities?.exec;
  const result = evaluateExecRules(exec, command);
  if (result.status === "denied") {
    return {
      decision: "deny",
      reason: "exec-denied",
      message: `Command is denied by policy ${policy.id}: ${command}`,
      rule: `deny entry \`${result.rule}\``,
    };
  }
  let missingRule: string | undefined;
  if (result.status === "unlisted") {
    missingRule = missingExecAllowRule(exec?.allow ?? [], command);
  } else if (result.rule !== undefined) {
    // Chained/substituted commands never qualify as allow-list matches: the
    // shell runs the entire string, so a matched prefix proves nothing about
    // the rest. Deny matches stand; allow matches downgrade to unlisted.
    const chaining = shellChainingIn(command);
    if (chaining !== undefined) {
      missingRule = `allow entry \`${result.rule}\` does not cover ${chaining}`;
    }
  }
  if (missingRule === undefined) {
    return ALLOW_VERDICT;
  }
  if (policy.confirmations?.requiredFor.includes("exec.unknown")) {
    return {
      decision: "escalate",
      reason: "exec-unknown-confirmation",
      message: `Command is not on the allow list of policy ${policy.id} and requires approval: ${command}`,
      rule: missingRule,
    };
  }
  return {
    decision: "deny",
    reason: "exec-not-allowed",
    message: `Command is not on the allow list of policy ${policy.id}: ${command}`,
    rule: missingRule,
  };
}

/**
 * A command's arguments meet `filesystem.deny` (ADR 0026 decision 5, JC-7).
 * Every word after the program in each simple command, the value of every
 * `--name=value` word, and every redirection's file target are checked
 * against the deny globs, canonicalized as a file tool's path is. It runs on
 * every command the exec rules do not deny, unlisted ones included (JC-14):
 * composed with evaluateExec, its deny outranks an escalation. An argument
 * absolute outside the workspace, or escaping it, is not checked (JC-15).
 * `filesystem.allow` is not applied: most arguments are not paths.
 */
function evaluateExecArguments(
  policy: PolicySpec,
  input: PolicyEvalInput,
  options: PolicyEvalOptions,
): PolicyVerdict {
  const deny = policy.capabilities?.filesystem?.deny;
  const command = extractCommand(input);
  if (command === undefined || deny === undefined || deny.length === 0) {
    return ALLOW_VERDICT;
  }
  for (const simple of simpleCommandsOf(command)) {
    for (const word of [...argumentsOf(simple), ...simple.redirectionTargets]) {
      const value = /^--[^=]+=(.+)$/.exec(word)?.[1];
      for (const candidate of value === undefined ? [word] : [word, value]) {
        const path = argumentPath(candidate, options);
        const rule =
          path === undefined
            ? undefined
            : deny.find((glob) => pathMatchesRule(path, glob));
        if (rule !== undefined) {
          return {
            decision: "deny",
            reason: "filesystem-denied",
            message: `Command names a path denied by policy ${policy.id}: ${path}`,
            rule: `deny entry \`${rule}\``,
          };
        }
      }
    }
  }
  return ALLOW_VERDICT;
}

/** An argument as a workspace-relative path, or undefined when unchecked. */
function argumentPath(
  word: string,
  options: PolicyEvalOptions,
): string | undefined {
  const relative = isAbsoluteCandidatePath(word)
    ? options.relativizeWorkspacePath?.(word)
    : word;
  const path =
    relative === undefined ? undefined : canonicalizeCandidatePath(relative);
  return path === "" ? undefined : path;
}

function evaluateFilesystem(
  policy: PolicySpec,
  input: PolicyEvalInput,
): PolicyVerdict {
  const rawPath = extractFilePath(input);
  if (rawPath === undefined) {
    return ALLOW_VERDICT;
  }
  const path = canonicalizeCandidatePath(rawPath);
  if (path === undefined) {
    // Absolute or workspace-escaping path: rules written against
    // workspace-relative paths cannot classify it — deny when the policy
    // has filesystem rules at all, allow when it does not.
    if (policy.capabilities?.filesystem === undefined) {
      return ALLOW_VERDICT;
    }
    return {
      decision: "deny",
      reason: "filesystem-uncontained-path",
      message: `Path escapes the workspace or is absolute and cannot be classified by policy ${policy.id}: ${rawPath}`,
      rule: "filesystem rules cover only paths inside the workspace",
    };
  }
  const result = evaluateRules(
    policy.capabilities?.filesystem,
    path,
    pathMatchesRule,
  );
  if (result.status === "denied") {
    return {
      decision: "deny",
      reason: "filesystem-denied",
      message: `Path is denied by policy ${policy.id}: ${path}`,
      rule: `deny entry \`${result.rule}\``,
    };
  }
  if (result.status === "unlisted") {
    return {
      decision: "deny",
      reason: "filesystem-not-allowed",
      message: `Path is not on the allow list of policy ${policy.id}: ${path}`,
      rule: `no allow entry for \`${path}\``,
    };
  }
  if (
    input.toolName !== undefined &&
    WRITE_TOOL_NAMES.has(input.toolName) &&
    policy.confirmations?.requiredFor.includes("filesystem.write")
  ) {
    return {
      decision: "escalate",
      reason: "filesystem-write-confirmation",
      message: `Write to ${path} requires approval under policy ${policy.id}`,
      rule: "confirmation `filesystem.write`",
    };
  }
  return ALLOW_VERDICT;
}

function evaluateNetwork(
  policy: PolicySpec,
  input: PolicyEvalInput,
): PolicyVerdict {
  const host = extractHost(input);
  if (host === undefined) {
    return ALLOW_VERDICT;
  }
  const result = evaluateRules(
    policy.capabilities?.network,
    host,
    hostMatchesRule,
  );
  if (result.status === "denied") {
    return {
      decision: "deny",
      reason: "network-denied",
      message: `Network access to ${host} is denied by policy ${policy.id}`,
      rule: `deny entry \`${result.rule}\``,
    };
  }
  if (result.status === "unlisted") {
    return {
      decision: "deny",
      reason: "network-not-allowed",
      message: `Host is not on the allow list of policy ${policy.id}: ${host}`,
      rule: `no allow entry for \`${host}\``,
    };
  }
  return ALLOW_VERDICT;
}

const COST_WARN_FRACTION = 0.8;

function evaluateCost(
  policy: PolicySpec,
  input: PolicyEvalInput,
): PolicyVerdict {
  const limit = policy.limits?.costUsd;
  const spent = input.state?.cumulativeCostUsd;
  if (limit === undefined || spent === undefined) {
    return ALLOW_VERDICT;
  }
  if (spent >= limit) {
    return {
      decision: "deny",
      reason: "cost-budget-exceeded",
      message: `Cumulative cost $${spent.toFixed(2)} reached the $${limit.toFixed(2)} budget of policy ${policy.id}`,
      rule: `cost budget $${limit.toFixed(2)}`,
    };
  }
  if (spent >= limit * COST_WARN_FRACTION) {
    return {
      decision: "warn",
      reason: "cost-budget-warning",
      message: `Cumulative cost $${spent.toFixed(2)} is above ${COST_WARN_FRACTION * 100}% of the $${limit.toFixed(2)} budget of policy ${policy.id}`,
      rule: `cost budget $${limit.toFixed(2)}`,
    };
  }
  return ALLOW_VERDICT;
}

/**
 * Evaluate one intervention point against a resolved policy. Never throws:
 * evaluator errors return deny with the reserved runtime-error reason
 * (fail-closed, ACS semantics).
 */
export function evaluatePolicy(
  policy: PolicySpec,
  input: PolicyEvalInput,
  options: PolicyEvalOptions = {},
): PolicyVerdict {
  try {
    if (
      input.interventionPoint !== "pre_tool_call" &&
      input.interventionPoint !== "post_tool_call"
    ) {
      // Lifecycle points currently carry no enforced constraints beyond
      // cost, which is checked everywhere.
      return evaluateCost(policy, input);
    }
    // A deny entry is the command's own rule, so it is named first;
    // otherwise a denied path says more than a missing allow entry.
    const execVerdict = evaluateExec(policy, input);
    const argumentVerdict = evaluateExecArguments(policy, input, options);
    return composeVerdicts([
      ...(execVerdict.reason === "exec-denied"
        ? [execVerdict, argumentVerdict]
        : [argumentVerdict, execVerdict]),
      evaluateFilesystem(policy, input),
      evaluateNetwork(policy, input),
      evaluateCost(policy, input),
    ]);
  } catch (error) {
    return {
      decision: "deny",
      reason: POLICY_RUNTIME_ERROR_REASON,
      message: `Policy evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Hook-shaped input (JSON stdin contract used by the hook pipeline).
 *
 * Deliberately carries NO state fields: hook stdin comes from the adapter
 * process, not the harness runtime, so cost/elapsed accounting from that
 * channel is not trustworthy. Cost enforcement happens where the runtime
 * itself calls evaluatePolicy with runtime-owned state.
 */
export interface PolicyHookInput {
  readonly hook_event: string;
  readonly tool_name?: string;
  readonly tool_input?: Readonly<Record<string, unknown>>;
}

export interface PolicyHookOutput {
  readonly verdict: PolicyVerdictDecision;
  readonly reason?: string;
  /** The verdict's rule (PolicyVerdict.rule), for the bridge's denial text. */
  readonly rule?: string;
  readonly updated_input?: Readonly<Record<string, unknown>>;
}

const HOOK_EVENT_TO_INTERVENTION: Readonly<
  Record<string, PolicyInterventionPoint>
> = {
  pre_tool_call: "pre_tool_call",
  post_tool_call: "post_tool_call",
  role_start: "role_start",
  role_stop: "role_stop",
  run_start: "run_start",
  run_end: "run_end",
};

/**
 * Adapt the hook JSON contract to the evaluator. This is the builtin
 * handler the runtime registers first at each mapped intervention point;
 * user hooks run after and compose via composeVerdicts (deny wins).
 */
export function createPolicyEvalHandler(
  policy: PolicySpec,
  options: PolicyEvalOptions = {},
): (input: PolicyHookInput) => PolicyHookOutput {
  return (input) => {
    const interventionPoint = HOOK_EVENT_TO_INTERVENTION[input.hook_event];
    if (interventionPoint === undefined) {
      return {
        verdict: "deny",
        reason: POLICY_RUNTIME_ERROR_REASON,
      };
    }
    const verdict = evaluatePolicy(
      policy,
      {
        interventionPoint,
        toolName: input.tool_name,
        toolInput: input.tool_input,
      },
      options,
    );
    return {
      verdict: verdict.decision,
      ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
      ...(verdict.rule === undefined ? {} : { rule: verdict.rule }),
      ...(verdict.transform === undefined
        ? {}
        : { updated_input: verdict.transform }),
    };
  };
}
