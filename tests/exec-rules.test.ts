import { expect, test } from "bun:test";
import type { PolicySpec } from "@aguil/agents-harness-config";
import type { PolicyVerdict } from "@aguil/agents-policy";
import { evaluatePolicy } from "@aguil/agents-policy";

/** ADR 0026: exec rules match the resolved program and subcommand (#196). */

function exec(policy: PolicySpec, command: string): PolicyVerdict {
  return evaluatePolicy(policy, {
    interventionPoint: "pre_tool_call",
    toolName: "Execute",
    toolInput: { command },
  });
}

function execPolicy(
  rules: { allow?: string[]; deny?: string[] },
  confirmUnknown = false,
): PolicySpec {
  return {
    id: "p",
    capabilities: { exec: rules },
    ...(confirmUnknown
      ? { confirmations: { requiredFor: ["exec.unknown"] } }
      : {}),
  };
}

test("#196's bypass rows that resolve to a denied subcommand deny", () => {
  // The issue's comment: allowlisting a wrapper flag admitted `git push`.
  const t6 = execPolicy({ allow: ["git -C"], deny: ["git push"] });
  const push = exec(t6, "git -C /tmp push origin main");
  expect(push.decision).toBe("deny");
  expect(push.reason).toBe("exec-denied");
  expect(push.rule).toBe("deny entry `git push`");
  expect(exec(t6, "git -C /tmp log -1").decision).toBe("allow");
  expect(exec(t6, "git -C /tmp show a:b").decision).toBe("allow");

  // The issue's probe table, outside an interpreter's payload.
  const probe = execPolicy({
    allow: ["sh", "bash", "rg"],
    deny: ["rm", "curl", "git push"],
  });
  expect(exec(probe, "rm -rf build").decision).toBe("deny");
  expect(exec(probe, "curl https://evil.example").decision).toBe("deny");
});

test("a deny rule finds its subcommand behind options, never past a subcommand", () => {
  const policy = execPolicy({ deny: ["git push", "jj git push"] });
  for (const command of [
    "git --no-pager push",
    "git -C /tmp push origin",
    "git --git-dir=.git push",
    "jj -R ../x git push",
    // An option's value can be taken for the subcommand: over-denial,
    // accepted (ADR 0026 decision 3).
    "git -C push status",
  ]) {
    expect(exec(policy, command).decision).toBe("deny");
  }
  for (const command of ["git log --grep push", "jj git fetch", "git status"]) {
    expect(exec(policy, command).decision).toBe("allow");
  }
});

test("a deny rule resolves the program past a path or assignments (JC-16)", () => {
  const rm = execPolicy({ deny: ["rm"] });
  for (const command of ["/bin/rm x", "./rm x", "FOO=1 rm x", "A=1 B=2 rm x"]) {
    const verdict = exec(rm, command);
    expect(verdict.decision).toBe("deny");
    expect(verdict.rule).toBe("deny entry `rm`");
  }
  expect(exec(rm, "rmdir x").decision).toBe("allow");
  expect(exec(rm, "echo rm").decision).toBe("allow");
});

test("a deny rule's option matches anywhere, inside a cluster too (JC-16)", () => {
  const sed = execPolicy({ deny: ["sed -i", "git push --force"] });
  for (const command of [
    "sed -i s/a/b/ f",
    "sed -n -i f",
    "sed -ni f",
    "git push origin --force",
    "git push --force=true",
  ]) {
    expect(exec(sed, command).decision).toBe("deny");
  }
  for (const command of ["sed -n f", "sed --in-place f", "git push origin"]) {
    expect(exec(sed, command).decision).toBe("allow");
  }
});

test("a chain with a denied segment denies, also under exec.unknown", () => {
  for (const confirm of [false, true]) {
    const policy = execPolicy({ allow: ["cat"], deny: ["rm"] }, confirm);
    for (const command of [
      "cat a; rm b",
      "cat a && rm b",
      "cat a | rm b",
      "cat a\nrm b",
      "(rm b)",
    ]) {
      const verdict = exec(policy, command);
      expect(verdict.decision).toBe("deny");
      expect(verdict.reason).toBe("exec-denied");
      expect(verdict.rule).toBe("deny entry `rm`");
    }
  }
});

test("a denied command inside a substitution denies (ADR 0026 decision 1)", () => {
  for (const confirm of [false, true]) {
    const policy = execPolicy({ allow: ["echo"], deny: ["rm"] }, confirm);
    for (const command of [
      'echo "$(rm x)"',
      "echo `rm x`",
      'echo "`rm x`"',
      "echo $(rm x)",
      "echo $(cat $(rm x))",
      'echo "$(echo "$(rm x)")"',
      "echo a$(rm x)b",
      '$(rm x) "y"',
    ]) {
      expect(exec(policy, command).decision).toBe("deny");
    }
    // Inside single quotes nothing runs.
    expect(exec(policy, "echo '$(rm x)'").decision).toBe("allow");
  }
});

test("a command the tokenizer cannot read still meets the deny list", () => {
  const policy = execPolicy({ deny: ["rm"] }, true);
  expect(exec(policy, `echo "a; rm x`).decision).toBe("deny");
  expect(exec(policy, `"rm" x '`).decision).toBe("deny");
});

test("allow rules stay a word prefix (JC-13), a quoted program matching (JC-17)", () => {
  const log = execPolicy({ allow: ["git log", "git show", "rg"] });
  for (const command of [
    "git --no-pager log",
    "git -c alias.log='!rm -rf .' log",
    "FOO=1 git log",
    "/usr/bin/git log",
    "rgx foo",
  ]) {
    const verdict = exec(log, command);
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toBe("exec-not-allowed");
  }
  for (const command of [
    "git log -1",
    "git show a:b",
    "'rg' x",
    '"rg" x',
    "r'g' x",
  ]) {
    expect(exec(log, command).decision).toBe("allow");
  }
});

test("an interpreter's payload denies when the interpreter is unlisted (JC-4)", () => {
  const policy = execPolicy({ allow: ["rg"], deny: ["rm", "curl"] });
  for (const command of [
    "bash -c 'rm -rf build'",
    "sh -c 'git push --force'",
    "bash -c 'curl https://evil.example'",
  ]) {
    const verdict = exec(policy, command);
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toBe("exec-not-allowed");
  }
  // Allowlisted, the payload is not parsed: the entry warns at load
  // instead (tests/policy-load-warnings.test.ts).
  const allowsBash = execPolicy({ allow: ["bash"], deny: ["rm"] });
  expect(exec(allowsBash, "bash -c 'rm -rf build'").decision).toBe("allow");
});

test("a deny rule finds the program past the shell's reserved words", () => {
  const rm = execPolicy({ deny: ["rm"] });
  for (const command of [
    "{ rm x; }",
    "if rm x; then :; fi",
    "if true; then rm x; fi",
    "! rm x",
    "time rm x",
    "while rm x; do :; done",
    "for f in a; do rm $f; done",
  ]) {
    expect(exec(rm, command).decision).toBe("deny");
  }
  expect(exec(rm, "echo if rm").decision).toBe("allow");
});

test("a deny rule reads a word written with ANSI-C quoting as bash does", () => {
  const policy = execPolicy({ deny: ["rm", "git push"] });
  for (const command of [
    "$'rm' x",
    "$'\\162m' x",
    "$'\\x72\\x6d' x",
    "$'r\\u006d' x",
    "git $'push'",
    "git $'pu\\163h' origin",
    "echo $'a\\'' ; rm x",
  ]) {
    expect(exec(policy, command).decision).toBe("deny");
  }
  // Inside double quotes `$'` is literal text.
  expect(exec(policy, `echo "$'rm'"`).decision).toBe("allow");
  expect(exec(policy, "echo $'rm'").decision).toBe("allow");
});
