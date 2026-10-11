/**
 * How exec rules read a command (ADR 0026). The tokenizer gives words and
 * operators; this module groups them into simple commands, resolves a deny
 * rule's program and subcommand against each one, and matches allow rules as
 * a word prefix. Deny reads a command generously and allow reads it strictly,
 * so where the text is ambiguous the failure is a visible over-denial.
 */

import type { ShellToken } from "./shell-tokenizer";
import {
  removeLineContinuations,
  tokenizeShellCommand,
} from "./shell-tokenizer";

/** One simple command: its words, and the targets of its redirections. */
export interface SimpleCommand {
  readonly words: readonly string[];
  /**
   * Words after a redirection that names a file (`<`, `>`, `>>`, `<>`,
   * `>|`, `&>`, `&>>`, `>&`, `<&`, numbered or not). The word after `<<` or
   * `<<<` is a delimiter or a string, so it is in neither list.
   */
  readonly redirectionTargets: readonly string[];
}

/** Operators that end a simple command (ADR 0026 decision 1). */
const CONTROL_OPERATORS: ReadonlySet<string> = new Set([
  "|",
  "||",
  "&&",
  ";",
  "&",
  "\n",
]);

/** Redirections whose target is a file. */
const FILE_REDIRECTIONS: ReadonlySet<string> = new Set([
  "<",
  ">",
  ">>",
  "<>",
  ">|",
  "&>",
  "&>>",
  ">&",
  "<&",
]);

/** Redirections whose target is not a path. */
const OTHER_REDIRECTIONS: ReadonlySet<string> = new Set(["<<", "<<<"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface Frame {
  readonly closer: ")" | "`" | undefined;
  words: string[];
  targets: string[];
  /** The redirection waiting for its target word. */
  pending: string | undefined;
}

/**
 * Split a command into its simple commands, a substitution's contents and a
 * subshell's forming simple commands of their own. Never fails: when the
 * tokenizer cannot read the command (an unbalanced quote), it is split on
 * whitespace and operator characters instead, which finds more words, not
 * fewer.
 */
export function simpleCommandsOf(command: string): readonly SimpleCommand[] {
  const parsed = tokenizeShellCommand(command);
  const commands = parsed.ok
    ? groupSimpleCommands(parsed.tokens)
    : roughSimpleCommands(command);
  // A substitution inside double quotes stays in its word as text; read its
  // body from the command itself.
  for (const body of doubleQuotedSubstitutionBodies(command)) {
    commands.push(...simpleCommandsOf(body));
  }
  return commands;
}

function groupSimpleCommands(tokens: readonly ShellToken[]): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  const stack: Frame[] = [newFrame(undefined)];
  const finish = (frame: Frame) => {
    if (frame.words.length > 0 || frame.targets.length > 0) {
      commands.push({ words: frame.words, redirectionTargets: frame.targets });
    }
    frame.words = [];
    frame.targets = [];
    frame.pending = undefined;
  };
  for (const token of tokens) {
    const frame = stack[stack.length - 1] as Frame;
    if (token.kind === "word") {
      if (frame.pending === undefined) {
        frame.words.push(token.value);
      } else {
        if (FILE_REDIRECTIONS.has(frame.pending)) {
          frame.targets.push(token.value);
        }
        frame.pending = undefined;
      }
      continue;
    }
    // An operator inside double quotes keeps its text in the word, so it
    // opens nothing here; doubleQuotedSubstitutionBodies reads its body.
    if (token.quoted === true) {
      continue;
    }
    const operator = token.value;
    if (FILE_REDIRECTIONS.has(operator) || OTHER_REDIRECTIONS.has(operator)) {
      frame.pending = operator;
    } else if (CONTROL_OPERATORS.has(operator)) {
      finish(frame);
    } else if (operator === "(" || operator === "$(") {
      // A subshell or a substitution: its contents are simple commands of
      // their own, and the command around a substitution carries on after.
      if (operator === "(") {
        finish(frame);
      }
      stack.push(newFrame(")"));
    } else if (operator === ")") {
      finish(frame);
      if (stack.length > 1 && frame.closer === ")") {
        stack.pop();
      }
    } else if (operator === "`") {
      if (frame.closer === "`") {
        finish(frame);
        stack.pop();
      } else {
        stack.push(newFrame("`"));
      }
    }
    // `#`, `$'` and `${` mark where bash may read differently; the words
    // around them are still read, which can only find more to deny.
  }
  for (const frame of stack.reverse()) {
    finish(frame);
  }
  return commands;
}

function newFrame(closer: Frame["closer"]): Frame {
  return { closer, words: [], targets: [], pending: undefined };
}

/** The fallback for a command the tokenizer cannot read. */
function roughSimpleCommands(command: string): SimpleCommand[] {
  return removeLineContinuations(command)
    .replace(/['"\\]/g, "")
    .split(/[;|&\n()`]+/)
    .map((segment) => segment.split(/[\s<>]+/).filter((word) => word !== ""))
    .filter((words) => words.length > 0)
    .map((words) => ({ words, redirectionTargets: [] }));
}

/**
 * The bodies of the `$(…)` and backtick substitutions that sit inside double
 * quotes, where the tokenizer keeps them in a word. Bodies nested deeper are
 * found when each body is split in turn.
 */
function doubleQuotedSubstitutionBodies(raw: string): string[] {
  const command = removeLineContinuations(raw);
  const bodies: string[] = [];
  let inDouble = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (!inDouble) {
      if (char === "'") {
        const close = command.indexOf("'", index + 1);
        if (close === -1) {
          break;
        }
        index = close;
      } else if (char === '"') {
        inDouble = true;
      }
      continue;
    }
    if (char === '"') {
      inDouble = false;
    } else if (char === "`") {
      const close = closingBacktick(command, index + 1);
      bodies.push(command.slice(index + 1, close));
      index = close;
    } else if (command.startsWith("$(", index)) {
      const close = closingParenthesis(command, index + 2);
      bodies.push(command.slice(index + 2, close));
      index = close;
    }
  }
  return bodies;
}

/** Index of the backtick closing one opened before `start`, or the end. */
function closingBacktick(command: string, start: number): number {
  for (let index = start; index < command.length; index += 1) {
    if (command[index] === "\\") {
      index += 1;
    } else if (command[index] === "`") {
      return index;
    }
  }
  return command.length;
}

/** Index of the `)` closing a `(` opened before `start`, or the end. */
function closingParenthesis(command: string, start: number): number {
  let depth = 1;
  for (let index = start; index < command.length; index += 1) {
    const char = command[index];
    if (char === "\\") {
      index += 1;
    } else if (char === "'") {
      const close = command.indexOf("'", index + 1);
      index = close === -1 ? command.length : close;
    } else if (char === '"') {
      index = closingDoubleQuote(command, index + 1);
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return command.length;
}

function closingDoubleQuote(command: string, start: number): number {
  for (let index = start; index < command.length; index += 1) {
    if (command[index] === "\\") {
      index += 1;
    } else if (command[index] === '"') {
      return index;
    }
  }
  return command.length;
}

/** A rule's words, read the way a command's are. */
export function ruleWords(rule: string): readonly string[] {
  const parsed = tokenizeShellCommand(rule);
  if (!parsed.ok) {
    return rule.split(/\s+/).filter((word) => word !== "");
  }
  return parsed.tokens.flatMap((token) =>
    token.kind === "word" ? [token.value] : [],
  );
}

/**
 * The command's words up to its first operator: what an allow rule is
 * matched against. A command with an operator is unlisted whatever these
 * match, so the words after it never matter to allow.
 */
export function leadingWords(command: string): readonly string[] {
  const parsed = tokenizeShellCommand(command);
  if (!parsed.ok) {
    return roughSimpleCommands(command)[0]?.words ?? [];
  }
  const words: string[] = [];
  for (const token of parsed.tokens) {
    if (token.kind === "operator") {
      break;
    }
    words.push(token.value);
  }
  return words;
}

/**
 * Allow matching (ADR 0026 decision 4): the command's words begin with the
 * rule's, compared whole. The program is compared as the rule writes it, so
 * an assignment or a different path in front matches nothing.
 */
export function allowRuleMatches(
  words: readonly string[],
  rule: readonly string[],
): boolean {
  return (
    rule.length > 0 &&
    rule.length <= words.length &&
    rule.every((word, index) => words[index] === word)
  );
}

/**
 * Words the shell reads as grammar, not as a program, where a command can
 * start: `{ rm x; }`, `if rm x; then :; fi`, `! rm x` and `time rm x` all run
 * `rm`.
 */
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  "!",
  "{",
  "}",
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "time",
]);

/**
 * Where the program sits, past any leading reserved words and `NAME=value`
 * assignments.
 */
function programIndex(words: readonly string[]): number {
  let index = 0;
  while (
    index < words.length &&
    (RESERVED_WORDS.has(words[index] as string) ||
      ASSIGNMENT.test(words[index] as string))
  ) {
    index += 1;
  }
  return index;
}

/** The words after the program: what the argument check reads. */
export function argumentsOf(command: SimpleCommand): readonly string[] {
  return command.words.slice(programIndex(command.words) + 1);
}

function lastPathComponent(word: string): string {
  const parts = word.split("/");
  return parts[parts.length - 1] ?? word;
}

function isOption(word: string): boolean {
  return word.length > 1 && word.startsWith("-");
}

/** `-C` or `--git-dir`: an option whose value, if any, is the next word. */
function isOptionWithoutAttachedValue(word: string): boolean {
  return /^-[^-]$/.test(word) || /^--[^=]+$/.test(word);
}

/**
 * Deny matching (ADR 0026 decisions 2 and 3): assignments are skipped, the
 * program is compared by its last path component, and each later rule word
 * is resolved among the command's words, an option anywhere and a
 * subcommand among the candidates the scan allows.
 */
export function denyRuleMatches(
  command: SimpleCommand,
  rule: readonly string[],
): boolean {
  const [ruleProgram, ...rest] = rule;
  const start = programIndex(command.words);
  const program = command.words[start];
  if (
    ruleProgram === undefined ||
    program === undefined ||
    lastPathComponent(program) !== lastPathComponent(ruleProgram)
  ) {
    return false;
  }
  return restMatches(command.words.slice(start + 1), rest, 0);
}

function restMatches(
  args: readonly string[],
  rule: readonly string[],
  from: number,
): boolean {
  const [word, ...rest] = rule;
  if (word === undefined) {
    return true;
  }
  if (isOption(word)) {
    return args.some((arg) => optionMatches(arg, word))
      ? restMatches(args, rest, from)
      : false;
  }
  return subcommandCandidates(args, from).some(
    (index) => args[index] === word && restMatches(args, rest, index + 1),
  );
}

/**
 * Indexes of the words that may be the subcommand, scanning from `from`:
 * options are skipped, and a non-option word ends the scan unless it may be
 * the value of the option before it.
 */
function subcommandCandidates(args: readonly string[], from: number): number[] {
  const candidates: number[] = [];
  let previousTakesValue = false;
  for (let index = from; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (isOption(arg)) {
      previousTakesValue = isOptionWithoutAttachedValue(arg);
      continue;
    }
    candidates.push(index);
    if (!previousTakesValue) {
      break;
    }
    previousTakesValue = false;
  }
  return candidates;
}

/**
 * The command carries a rule's option: as the same word, as `--name=value`
 * for a long option, or inside a cluster for a single-letter one.
 */
function optionMatches(arg: string, option: string): boolean {
  if (arg === option) {
    return true;
  }
  if (option.startsWith("--")) {
    return arg.startsWith(`${option}=`);
  }
  if (/^-[^-]$/.test(option)) {
    return /^-[^-]/.test(arg) && arg.slice(1).includes(option.slice(1));
  }
  return false;
}
