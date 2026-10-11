/**
 * Shell-style tokenizer for exec policy rules (#237).
 *
 * Splits a command the way a POSIX shell reads it before expansion: single
 * quotes, double quotes and backslash escapes are honoured, and the
 * operators found outside quotes are reported as tokens of their own. It is
 * deliberately not a shell parser: it does not expand anything, does not
 * treat `#` as a comment, and does not look inside a substitution. Its job
 * is to tell an operator the shell acts on from the same character inside a
 * quoted argument, so callers can decide whether a command is one simple
 * command.
 *
 * Where this reading and bash's could part ways, the construct is reported
 * as an operator, so the command is never taken for one simple command:
 * an unquoted `#` starting a word (a comment, which can swallow a quote),
 * `$'…'` (ANSI-C quoting, where `\'` does not close the quote), and a
 * `${…}` whose body holds a quote, backslash, `$` or backtick (bash nests
 * quotes inside it, even within double quotes).
 */

/** A word the shell would pass, with its quotes and escapes removed. */
export interface ShellWord {
  readonly kind: "word";
  readonly value: string;
  /** True when any part of the word was quoted or escaped. */
  readonly quoted: boolean;
}

/**
 * An operator found outside quotes. `$(` and a backtick are reported where
 * the shell would run them: outside single quotes, double quotes included.
 * So is a `${…}` this tokenizer cannot read the way bash does, as `${`.
 * `#` starting an unquoted word and `$'` are reported as themselves.
 */
export interface ShellOperatorToken {
  readonly kind: "operator";
  readonly value: string;
  /** File descriptor written ahead of a redirection, as in `2>`. */
  readonly fd?: string;
  /**
   * True when reported from inside double quotes. Its text then stays in the
   * enclosing word, and no closing `)` follows it as a token of its own.
   */
  readonly quoted?: true;
}

export type ShellToken = ShellWord | ShellOperatorToken;

export type ShellTokenizeResult =
  | { readonly ok: true; readonly tokens: readonly ShellToken[] }
  | {
      readonly ok: false;
      readonly error: "unbalanced-quote";
      readonly quote: "'" | '"';
    };

/** Longest first, so `&&` wins over `&` and `>>` over `>`. */
const OPERATORS: readonly string[] = [
  "<<<",
  "&>>",
  "&&",
  "||",
  ">>",
  "<<",
  "<>",
  ">|",
  ">&",
  "<&",
  "&>",
  "$(",
  "|",
  "&",
  ";",
  "(",
  ")",
  "<",
  ">",
  "`",
  "\n",
];

/** Characters a backslash escapes inside double quotes. */
const DOUBLE_QUOTE_ESCAPABLE = new Set(["$", "`", '"', "\\", "\n"]);

function operatorAt(command: string, index: number): string | undefined {
  return OPERATORS.find((operator) => command.startsWith(operator, index));
}

/**
 * True when `index` starts a `${…}` whose body, up to the first `}`, holds a
 * character that bash would read as quoting or another expansion. With none,
 * that `}` is where bash ends it too; with one, the reading can drift.
 */
function opaqueParameterExpansionAt(command: string, index: number): boolean {
  if (!command.startsWith("${", index)) {
    return false;
  }
  for (let cursor = index + 2; cursor < command.length; cursor += 1) {
    const char = command[cursor];
    if (char === "}") {
      return false;
    }
    if (
      char === "'" ||
      char === '"' ||
      char === "\\" ||
      char === "$" ||
      char === "`"
    ) {
      return true;
    }
  }
  return true;
}

/**
 * Remove each backslash-newline the shell removes before it reads the line:
 * outside single quotes, and not after an escaping backslash. Done first, so
 * a continuation cannot split `$(`, `$'` or `${` from what follows and hide
 * it from the checks below. Inside single quotes the pair is literal.
 */
export function removeLineContinuations(command: string): string {
  let result = "";
  let mode: "plain" | "single" | "double" = "plain";
  let index = 0;
  while (index < command.length) {
    const char = command[index];
    if (mode === "single") {
      result += char;
      if (char === "'") {
        mode = "plain";
      }
      index += 1;
      continue;
    }
    if (char === "\\") {
      const next = command[index + 1];
      if (next === "\n") {
        index += 2;
        continue;
      }
      result += next === undefined ? char : char + next;
      index += 2;
      continue;
    }
    if (mode === "plain" && char === "'") {
      mode = "single";
    } else if (char === '"') {
      mode = mode === "double" ? "plain" : "double";
    }
    result += char;
    index += 1;
  }
  return result;
}

export function tokenizeShellCommand(raw: string): ShellTokenizeResult {
  const command = removeLineContinuations(raw);
  const tokens: ShellToken[] = [];
  let value = "";
  let quoted = false;
  let inWord = false;

  const flush = () => {
    if (inWord) {
      tokens.push({ kind: "word", value, quoted });
    }
    value = "";
    quoted = false;
    inWord = false;
  };

  let index = 0;
  while (index < command.length) {
    const char = command[index];

    if (char === "#" && !inWord) {
      // A comment runs to the end of the line and can hide a quote. Nothing
      // after it is read; it is reported so the command is never simple.
      tokens.push({ kind: "operator", value: "#" });
      value += char;
      inWord = true;
      index += 1;
      continue;
    }

    if (command.startsWith("$'", index)) {
      // ANSI-C quoting lets `\'` escape the quote. Not parsed; reported.
      tokens.push({ kind: "operator", value: "$'" });
    }

    if (opaqueParameterExpansionAt(command, index)) {
      tokens.push({ kind: "operator", value: "${" });
    }

    if (char === "'") {
      const close = command.indexOf("'", index + 1);
      if (close === -1) {
        return { ok: false, error: "unbalanced-quote", quote: "'" };
      }
      value += command.slice(index + 1, close);
      quoted = true;
      inWord = true;
      index = close + 1;
      continue;
    }

    if (char === '"') {
      let cursor = index + 1;
      let closed = false;
      while (cursor < command.length) {
        const inner = command[cursor];
        if (inner === '"') {
          closed = true;
          break;
        }
        if (inner === "\\" && cursor + 1 < command.length) {
          const next = command[cursor + 1];
          if (DOUBLE_QUOTE_ESCAPABLE.has(next)) {
            if (next !== "\n") {
              value += next;
            }
            cursor += 2;
            continue;
          }
        }
        if (opaqueParameterExpansionAt(command, cursor)) {
          tokens.push({ kind: "operator", value: "${", quoted: true });
        }
        if (inner === "`" || command.startsWith("$(", cursor)) {
          // The shell runs a substitution inside double quotes. Report it,
          // and keep its text in the word: nothing here looks inside it.
          tokens.push({
            kind: "operator",
            value: inner === "`" ? "`" : "$(",
            quoted: true,
          });
        }
        value += inner;
        cursor += 1;
      }
      if (!closed) {
        return { ok: false, error: "unbalanced-quote", quote: '"' };
      }
      quoted = true;
      inWord = true;
      index = cursor + 1;
      continue;
    }

    if (char === "\\") {
      const next = command[index + 1];
      if (next === undefined) {
        // A trailing backslash is a literal backslash.
        value += char;
        inWord = true;
        index += 1;
        continue;
      }
      if (next !== "\n") {
        // A backslash-newline is a line continuation and leaves nothing.
        value += next;
        quoted = true;
        inWord = true;
      }
      index += 2;
      continue;
    }

    if (char === " " || char === "\t") {
      flush();
      index += 1;
      continue;
    }

    const operator = operatorAt(command, index);
    if (operator !== undefined) {
      // `2>file`: an unquoted all-digit word directly ahead of a
      // redirection names the descriptor it redirects.
      const fd =
        (operator.startsWith("<") || operator.startsWith(">")) &&
        inWord &&
        !quoted &&
        /^\d+$/.test(value)
          ? value
          : undefined;
      if (fd !== undefined) {
        value = "";
        inWord = false;
      } else {
        flush();
      }
      tokens.push({
        kind: "operator",
        value: operator,
        ...(fd === undefined ? {} : { fd }),
      });
      index += operator.length;
      continue;
    }

    value += char;
    inWord = true;
    index += 1;
  }
  flush();
  return { ok: true, tokens };
}
