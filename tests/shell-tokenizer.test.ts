import { expect, test } from "bun:test";
import type { ShellToken } from "@aguil/agents-policy";
import { tokenizeShellCommand } from "@aguil/agents-policy";

function tokens(command: string): readonly ShellToken[] {
  const parsed = tokenizeShellCommand(command);
  if (!parsed.ok) {
    throw new Error(`unexpected parse failure for ${command}`);
  }
  return parsed.tokens;
}

function words(command: string): string[] {
  return tokens(command).flatMap((token) =>
    token.kind === "word" ? [token.value] : [],
  );
}

function operators(command: string): string[] {
  return tokens(command).flatMap((token) =>
    token.kind === "operator" ? [token.value] : [],
  );
}

test("tokenizer splits words and strips quotes and escapes", () => {
  expect(words(`rg -n "a|b" plan.md`)).toEqual(["rg", "-n", "a|b", "plan.md"]);
  expect(words(`jj log -r 'a | b'`)).toEqual(["jj", "log", "-r", "a | b"]);
  expect(words(`rg a\\|b x`)).toEqual(["rg", "a|b", "x"]);
  expect(words(`echo "a"'b'c`)).toEqual(["echo", "abc"]);
  expect(words(`echo '' ""`)).toEqual(["echo", "", ""]);
  expect(words("  rg\tx  ")).toEqual(["rg", "x"]);
  // Inside double quotes a backslash escapes only $ ` " \ and newline.
  expect(words(`echo "a\\"b" "c\\d" "e\\\\"`)).toEqual([
    "echo",
    'a"b',
    "c\\d",
    "e\\",
  ]);
  // Inside single quotes nothing is an escape.
  expect(words(`echo 'a\\'`)).toEqual(["echo", "a\\"]);
  // A backslash-newline continues the line; a trailing backslash is literal.
  expect(words("rg a\\\nb")).toEqual(["rg", "ab"]);
  expect(words("echo a\\")).toEqual(["echo", "a\\"]);
});

test("tokenizer marks quoted words", () => {
  const parsed = tokens(`'rg' x "y"`);
  expect(parsed).toEqual([
    { kind: "word", value: "rg", quoted: true },
    { kind: "word", value: "x", quoted: false },
    { kind: "word", value: "y", quoted: true },
  ]);
});

test("tokenizer reports operators outside quotes only", () => {
  expect(operators(`rg -n "a|b" plan.md`)).toEqual([]);
  expect(operators(`rg "a;b" x`)).toEqual([]);
  expect(operators(`rg "<x>" x`)).toEqual([]);
  expect(operators(`rg 'a>b' x`)).toEqual([]);
  expect(operators(`rg "a&&b" 'c||d' "e\nf"`)).toEqual([]);
  expect(operators("rg x | sh")).toEqual(["|"]);
  expect(operators("cat a; rm b")).toEqual([";"]);
  expect(operators("a && b || c & d")).toEqual(["&&", "||", "&"]);
  expect(operators("a\nb")).toEqual(["\n"]);
  expect(operators("(a)")).toEqual(["(", ")"]);
  expect(operators("a > b >> c < d << e <<< f <> g >| h")).toEqual([
    ">",
    ">>",
    "<",
    "<<",
    "<<<",
    "<>",
    ">|",
  ]);
  expect(operators("a 2>&1 &> b &>> c")).toEqual([">&", "&>", "&>>"]);
  // An escaped operator is a literal character.
  expect(operators("rg a\\;b x")).toEqual([]);
  // `#` is not read as a comment: what follows still counts.
  expect(operators("rg x #; rm y")).toEqual([";"]);
});

test("tokenizer names the descriptor of a numbered redirection", () => {
  expect(tokens("cmd 2>err")).toEqual([
    { kind: "word", value: "cmd", quoted: false },
    { kind: "operator", value: ">", fd: "2" },
    { kind: "word", value: "err", quoted: false },
  ]);
  // A quoted or spaced number is an argument, not a descriptor.
  expect(tokens(`cmd "2">err`)[1]).toEqual({
    kind: "word",
    value: "2",
    quoted: true,
  });
  expect(tokens("cmd 2 >err")[1]).toEqual({
    kind: "word",
    value: "2",
    quoted: false,
  });
});

test("tokenizer reports substitutions outside single quotes", () => {
  expect(operators("rg $(x)")).toEqual(["$(", ")"]);
  expect(operators("rg `x`")).toEqual(["`", "`"]);
  // Double quotes do not stop a substitution.
  expect(operators(`rg "$(x)"`)).toEqual(["$("]);
  expect(operators('rg "`x`"')).toEqual(["`", "`"]);
  expect(operators(`rg "a $(x) b"`)).toEqual(["$("]);
  // Single quotes and escapes do.
  expect(operators(`rg '$(x)' '\`x\`'`)).toEqual([]);
  expect(operators(`rg "\\$(x)" "\\\`x\\\`"`)).toEqual([]);
  // A bare `$` is not an operator.
  expect(operators(`rg "$HOME" $PATH`)).toEqual([]);
});

test("tokenizer fails on an unbalanced quote", () => {
  expect(tokenizeShellCommand(`rg "a|b`)).toEqual({
    ok: false,
    error: "unbalanced-quote",
    quote: '"',
  });
  expect(tokenizeShellCommand("rg 'a")).toEqual({
    ok: false,
    error: "unbalanced-quote",
    quote: "'",
  });
  // An escaped closing quote leaves the double quote open.
  expect(tokenizeShellCommand(`rg "a\\"`).ok).toBe(false);
  // An escaped opening quote is a literal character.
  expect(tokenizeShellCommand(`rg \\"a`).ok).toBe(true);
});
