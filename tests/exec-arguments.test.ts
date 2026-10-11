import { expect, test } from "bun:test";
import type { PolicySpec } from "@aguil/agents-harness-config";
import type { PolicyEvalOptions, PolicyVerdict } from "@aguil/agents-policy";
import { evaluatePolicy } from "@aguil/agents-policy";

/** ADR 0026 decision 5: a command's arguments meet filesystem.deny (#104). */

function exec(
  policy: PolicySpec,
  command: string,
  options?: PolicyEvalOptions,
): PolicyVerdict {
  return evaluatePolicy(
    policy,
    {
      interventionPoint: "pre_tool_call",
      toolName: "Execute",
      toolInput: { command },
    },
    options,
  );
}

const readPolicy: PolicySpec = {
  id: "reads",
  capabilities: {
    filesystem: { allow: ["**"], deny: [".env", "**/secrets/**"] },
    exec: { allow: ["cat", "rg", "ls", "echo"], deny: ["rm"] },
  },
};

test("a redirection's target is an argument, with or without an allow list", () => {
  const noAllow: PolicySpec = {
    id: "no-allow",
    capabilities: { filesystem: { deny: [".env"] } },
  };
  for (const policy of [noAllow, readPolicy]) {
    for (const command of [
      "cat < .env",
      "cat <.env",
      "cat 0< .env",
      "echo x > .env",
      "echo x >> ./.env",
      "echo x 2> .env",
      "echo x &> .env",
    ]) {
      const verdict = exec(policy, command);
      expect(verdict.decision).toBe("deny");
      expect(verdict.reason).toBe("filesystem-denied");
      expect(verdict.rule).toBe("deny entry `.env`");
    }
  }
  // A here-document's delimiter and a here-string are not paths.
  expect(exec(noAllow, "cat <<.env").decision).toBe("allow");
  expect(exec(noAllow, "cat <<< .env").decision).toBe("allow");
});

test("an unlisted command naming a denied path denies rather than escalates (JC-14)", () => {
  const confirm: PolicySpec = {
    ...readPolicy,
    capabilities: {
      ...readPolicy.capabilities,
      exec: { allow: ["rg"], deny: ["rm"] },
    },
    confirmations: { requiredFor: ["exec.unknown"] },
  };
  const verdict = exec(confirm, "cat .env");
  expect(verdict.decision).toBe("deny");
  expect(verdict.reason).toBe("filesystem-denied");
  expect(verdict.rule).toBe("deny entry `.env`");
  // Without a denied path the same command still escalates.
  expect(exec(confirm, "cat README.md").decision).toBe("escalate");
});

test("every simple command's arguments are checked, substitutions included", () => {
  for (const command of [
    "echo $(cat .env)",
    'echo "$(cat .env)"',
    "rg x src; cat config/secrets/key",
    "ls | cat .env",
    "rg --file=.env x",
  ]) {
    expect(exec(readPolicy, command).decision).toBe("deny");
  }
});

test("an exec denial outranks the argument check", () => {
  const verdict = exec(readPolicy, "rm .env");
  expect(verdict.reason).toBe("exec-denied");
  expect(verdict.rule).toBe("deny entry `rm`");
});

test("an argument outside the workspace is not checked (JC-15)", () => {
  for (const command of [
    "ls /tmp",
    "cat /etc/hostname",
    "cat ../other/.env",
    "cat /abs/ws/.env",
    "rg x src",
    "cat .",
  ]) {
    expect(exec(readPolicy, command).decision).toBe("allow");
  }
  // filesystem.allow is not applied to arguments: most are not paths.
  const narrowAllow: PolicySpec = {
    id: "narrow",
    capabilities: {
      filesystem: { allow: ["src/**"], deny: [".env"] },
      exec: { allow: ["rg"] },
    },
  };
  expect(exec(narrowAllow, "rg pattern docs").decision).toBe("allow");
});

test("an absolute argument inside the workspace is checked where the caller knows it", () => {
  const options: PolicyEvalOptions = {
    relativizeWorkspacePath: (path) =>
      path.startsWith("/abs/ws/") ? path.slice("/abs/ws/".length) : undefined,
  };
  const inside = exec(readPolicy, "cat /abs/ws/.env", options);
  expect(inside.decision).toBe("deny");
  expect(inside.rule).toBe("deny entry `.env`");
  expect(exec(readPolicy, "cat /abs/ws/src/x.ts", options).decision).toBe(
    "allow",
  );
  expect(exec(readPolicy, "cat /etc/hostname", options).decision).toBe("allow");
});

test("a policy without filesystem.deny is unaffected", () => {
  const execOnly: PolicySpec = {
    id: "exec-only",
    capabilities: { exec: { allow: ["cat"] } },
  };
  expect(exec(execOnly, "cat .env").decision).toBe("allow");
});

test("a path inside an option or operand word, or ANSI-C quoting, is checked", () => {
  for (const command of [
    "rg --file=.env x",
    "rg -f.env x",
    "dd if=.env of=out",
    "cat $'.env'",
    "cat $'\\x2eenv'",
  ]) {
    const verdict = exec(readPolicy, command);
    expect(verdict.decision).toBe("deny");
    expect(verdict.rule).toBe("deny entry `.env`");
  }
  expect(exec(readPolicy, "rg -n -e pattern src").decision).toBe("allow");
});

test("a comment's words are read, so a comment cannot hide a path", () => {
  const verdict = exec(readPolicy, "cat README.md # not .env");
  expect(verdict.decision).toBe("deny");
  expect(verdict.rule).toBe("deny entry `.env`");
});
