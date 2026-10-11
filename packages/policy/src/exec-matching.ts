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
/**
 * How deep quoted substitutions are read by recursion. Each level
 * re-tokenizes its body, so deeper bodies use the rough split, which reads
 * every word in one pass and so finds no fewer.
 */
const MAX_QUOTED_SUBSTITUTION_DEPTH = 8;

export function simpleCommandsOf(
  raw: string,
  depth = 0,
): readonly SimpleCommand[] {
  if (depth > MAX_QUOTED_SUBSTITUTION_DEPTH) {
    return roughSimpleCommands(raw);
  }
  const command = decodeAnsiCQuotes(raw);
  const parsed = tokenizeShellCommand(command);
  const commands = parsed.ok
    ? groupSimpleCommands(parsed.tokens)
    : roughSimpleCommands(command);
  // A substitution inside double quotes stays in its word as text; read its
  // body from the command itself.
  for (const body of doubleQuotedSubstitutionBodies(command)) {
    commands.push(...simpleCommandsOf(body, depth + 1));
  }
  return commands;
}

/**
 * Rewrite each `$'…'` outside quotes as the single-quoted string bash makes
 * of it, escapes decoded, so `$'\162m' x` reads as `rm x`. The tokenizer
 * reports `$'` rather than parsing it (JC-19), which keeps it from allow;
 * deny and the argument check need what it says.
 */
function decodeAnsiCQuotes(raw: string): string {
  const command = removeLineContinuations(raw);
  let result = "";
  let inDouble = false;
  let index = 0;
  while (index < command.length) {
    const char = command[index] as string;
    if (char === "\\") {
      result += command.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (!inDouble && char === "'") {
      const close = command.indexOf("'", index + 1);
      const end = close === -1 ? command.length : close + 1;
      result += command.slice(index, end);
      index = end;
      continue;
    }
    if (!inDouble && command.startsWith("$'", index)) {
      const decoded = decodeAnsiCBody(command, index + 2);
      if (decoded === undefined) {
        // Unterminated: leave it for the tokenizer to fail on.
        result += command.slice(index);
        break;
      }
      result += `'${decoded.value.replaceAll("'", "'\\''")}'`;
      index = decoded.end;
      continue;
    }
    if (char === '"') {
      inDouble = !inDouble;
    }
    result += char;
    index += 1;
  }
  return result;
}

const ANSI_C_ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};

/** The text of a `$'…'` body starting at `start`, and where it ends. */
function decodeAnsiCBody(
  command: string,
  start: number,
): { readonly value: string; readonly end: number } | undefined {
  let value = "";
  let index = start;
  while (index < command.length) {
    const char = command[index] as string;
    if (char === "'") {
      return { value, end: index + 1 };
    }
    if (char !== "\\") {
      value += char;
      index += 1;
      continue;
    }
    const next = command[index + 1];
    if (next === undefined) {
      return undefined;
    }
    const simple = ANSI_C_ESCAPES[next];
    const numeric =
      /^[0-7]{1,3}/.exec(command.slice(index + 1)) ??
      (next === "x"
        ? /^x([0-9A-Fa-f]{1,2})/.exec(command.slice(index + 1))
        : null) ??
      (next === "u"
        ? /^u([0-9A-Fa-f]{1,4})/.exec(command.slice(index + 1))
        : null) ??
      (next === "U"
        ? /^U([0-9A-Fa-f]{1,8})/.exec(command.slice(index + 1))
        : null);
    if (simple !== undefined) {
      value += simple;
      index += 2;
    } else if (numeric !== null) {
      const code =
        numeric[1] === undefined
          ? Number.parseInt(numeric[0], 8)
          : Number.parseInt(numeric[1], 16);
      value += code === 0 ? "" : String.fromCodePoint(Math.min(code, 0x10ffff));
      index += 1 + numeric[0].length;
    } else if (next === "c" && command[index + 2] !== undefined) {
      value += String.fromCharCode(
        (command[index + 2] as string).toUpperCase().charCodeAt(0) ^ 0x40,
      );
      index += 3;
    } else {
      value += `\\${next}`;
      index += 2;
    }
  }
  return undefined;
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

/**
 * Index of the `)` closing a `(` opened before `start`, or the end. Quotes
 * and comments are skipped, as bash skips them reading a `$(…)` body.
 */
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
    } else if (
      char === "#" &&
      (index === start || /[\s;|&()]/.test(command[index - 1] as string))
    ) {
      // A comment runs to the end of the line, and a `)` inside it does
      // not close the substitution.
      const newline = command.indexOf("\n", index);
      index = newline === -1 ? command.length : newline - 1;
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
 * Allow matching (ADR 0026 decision 4, JC-13, JC-17): the word-boundary
 * prefix of ADR 0006 §2 on the raw command, as before, with one widening:
 * the program may be quoted or escaped (`'rg' x`), since the shell runs the
 * same program. Nothing else is read more loosely, so `git  log` and
 * `git "log"` stay unlisted under `allow: [git log]`, and an assignment or a
 * different path in front of the program matches nothing.
 */
export function allowRuleMatches(command: string, rule: string): boolean {
  if (command === rule || command.startsWith(`${rule} `)) {
    return true;
  }
  const commandEnd = firstRawWordEnd(command);
  const ruleEnd = firstRawWordEnd(rule);
  const program = singleWordValue(command.slice(0, commandEnd));
  if (
    program === undefined ||
    program !== singleWordValue(rule.slice(0, ruleEnd))
  ) {
    return false;
  }
  const rewritten = rule.slice(0, ruleEnd) + command.slice(commandEnd);
  return rewritten === rule || rewritten.startsWith(`${rule} `);
}

/** Where the first word's raw text ends: unquoted blank or operator. */
function firstRawWordEnd(text: string): number {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (quote === "'") {
      if (char === "'") {
        quote = undefined;
      }
    } else if (char === "\\") {
      index += 1;
    } else if (quote === '"') {
      if (char === '"') {
        quote = undefined;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/[\s;|&<>()`$]/.test(char)) {
      return index;
    }
  }
  return text.length;
}

/** The value of text the tokenizer reads as exactly one word. */
function singleWordValue(text: string): string | undefined {
  const parsed = tokenizeShellCommand(text);
  if (!parsed.ok || parsed.tokens.length !== 1) {
    return undefined;
  }
  const [token] = parsed.tokens;
  return token?.kind === "word" ? token.value : undefined;
}

/**
 * Words the shell reads as grammar, not as a program, where a command can
 * start: `{ rm x; }`, `if rm x; then :; fi`, `! rm x`, `time rm x` and
 * `coproc rm x` all run `rm`.
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
  "coproc",
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
  return restMatches(command.words.slice(start + 1), rest, 0, 0, new Map());
}

/**
 * Whether `rule[ruleIndex..]` matches from `args[from]`. Each pair is tried
 * once, memoized, so option values that repeat a rule word cannot make the
 * search grow faster than words times rule words times candidates.
 */
function restMatches(
  args: readonly string[],
  rule: readonly string[],
  ruleIndex: number,
  from: number,
  seen: Map<string, boolean>,
): boolean {
  const word = rule[ruleIndex];
  if (word === undefined) {
    return true;
  }
  const key = `${ruleIndex}:${from}`;
  const known = seen.get(key);
  if (known !== undefined) {
    return known;
  }
  const result = isOption(word)
    ? args.some((arg) => optionMatches(arg, word)) &&
      restMatches(args, rule, ruleIndex + 1, from, seen)
    : subcommandCandidates(args, from).some(
        (index) =>
          args[index] === word &&
          restMatches(args, rule, ruleIndex + 1, index + 1, seen),
      );
  seen.set(key, result);
  return result;
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
