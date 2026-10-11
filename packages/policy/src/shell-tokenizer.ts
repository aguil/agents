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
 */
export interface ShellOperatorToken {
  readonly kind: "operator";
  readonly value: string;
  /** File descriptor written ahead of a redirection, as in `2>`. */
  readonly fd?: string;
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

export function tokenizeShellCommand(command: string): ShellTokenizeResult {
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
        if (inner === "`" || command.startsWith("$(", cursor)) {
          // The shell runs a substitution inside double quotes. Report it,
          // and keep its text in the word: nothing here looks inside it.
          tokens.push({ kind: "operator", value: inner === "`" ? "`" : "$(" });
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
