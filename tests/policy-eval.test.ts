import { expect, test } from "bun:test";
import type { PolicySpec } from "@aguil/agents-harness-config";
import type { PolicyVerdict } from "@aguil/agents-policy";
import {
  composeVerdicts,
  createPolicyEvalHandler,
  evaluatePolicy,
  POLICY_RUNTIME_ERROR_REASON,
} from "@aguil/agents-policy";

const basePolicy: PolicySpec = {
  id: "test-policy",
  capabilities: {
    filesystem: {
      allow: ["**"],
      deny: [".env", "**/secrets/**"],
    },
    exec: {
      allow: ["rg", "grep", "bun test", "git diff"],
      deny: ["rm", "git push"],
    },
    network: {
      deny: ["*"],
    },
  },
  limits: { costUsd: 5 },
};

function preToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  costUsd?: number,
) {
  return evaluatePolicy(basePolicy, {
    interventionPoint: "pre_tool_call",
    toolName,
    toolInput,
    ...(costUsd === undefined ? {} : { state: { cumulativeCostUsd: costUsd } }),
  });
}

test("exec deny list blocks with word-boundary matching", () => {
  expect(preToolCall("Execute", { command: "rm -rf /tmp/x" }).decision).toBe(
    "deny",
  );
  expect(preToolCall("Execute", { command: "git push origin" }).decision).toBe(
    "deny",
  );
  // "rmdir" must not match the "rm" rule.
  const rmdir = evaluatePolicy(
    { id: "p", capabilities: { exec: { deny: ["rm"] } } },
    {
      interventionPoint: "pre_tool_call",
      toolName: "Execute",
      toolInput: { command: "rmdir /tmp/x" },
    },
  );
  expect(rmdir.decision).toBe("allow");
});

test("exec allow list permits listed commands, denies unlisted", () => {
  expect(preToolCall("Execute", { command: "bun test tests/x" }).decision).toBe(
    "allow",
  );
  const unlisted = preToolCall("Execute", { command: "curl example.com" });
  expect(unlisted.decision).toBe("deny");
  expect(unlisted.reason).toBe("exec-not-allowed");
});

test("shell-chained commands never match the allow list", () => {
  // "rg" is allow-listed, but chaining must not ride on the prefix match.
  for (const command of [
    "rg foo && curl https://evil.example.com",
    "rg foo; curl evil.example.com",
    "rg foo | sh",
    "rg `curl evil`",
    "rg $(curl evil)",
    "rg foo > /etc/cron.d/x",
  ]) {
    const verdict = preToolCall("Execute", { command });
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toBe("exec-not-allowed");
  }
  // Deny rules still hard-deny chained commands.
  expect(
    preToolCall("Execute", { command: "rm -rf / && echo done" }).decision,
  ).toBe("deny");
  // Simple allow-listed commands are unaffected.
  expect(preToolCall("Execute", { command: "rg foo" }).decision).toBe("allow");
  // Policies without an allow list are unaffected by chaining checks.
  const denyOnly = evaluatePolicy(
    { id: "p", capabilities: { exec: { deny: ["rm"] } } },
    {
      interventionPoint: "pre_tool_call",
      toolName: "Execute",
      toolInput: { command: "echo a && echo b" },
    },
  );
  expect(denyOnly.decision).toBe("allow");
});

const readOnlyPolicy: PolicySpec = {
  id: "read-only",
  capabilities: {
    exec: { allow: ["rg", "jj log", "cat"], deny: ["rm"] },
  },
};

function readOnlyExec(command: string): PolicyVerdict {
  return evaluatePolicy(readOnlyPolicy, {
    interventionPoint: "pre_tool_call",
    toolName: "Execute",
    toolInput: { command },
  });
}

test("quoted shell operators do not deny an allowlisted command (#237)", () => {
  for (const command of [
    'rg -n "a|b" file',
    "jj log -r 'a | b'",
    'rg "a;b" file',
    'rg "<x>" file',
    "rg 'a>b' file",
    'rg -n "anchor-gap|^## Change Log" plan.md',
    'rg "a&&b" file',
    "rg 'a || b' file",
    'rg "a\nb" file',
    // Single quotes stop a substitution; escapes stop any operator.
    "rg '$(x)' file",
    "rg '`x`' file",
    "rg a\\|b file",
    'rg "\\$(x)" file',
  ]) {
    expect({ command, ...readOnlyExec(command) }).toEqual({
      command,
      decision: "allow",
    });
  }
});

test("operators outside quotes still deny an allowlisted command (#237)", () => {
  for (const command of [
    "rg x | sh",
    "cat a; rm b",
    "cat a; curl b",
    "rg `x`",
    "rg $(x)",
    "`x`",
    "$(x)",
    'rg "$(x)" file',
    'rg "`x`" file',
    "rg x > out",
    "rg x >> out",
    "rg x 2>err",
    "rg x < in",
    "rg x & curl y",
    "rg x\ncurl y",
    // A quote closed early leaves what follows it outside quotes.
    'rg "a\\\\" | sh',
    "rg 'a'|sh",
  ]) {
    const verdict = readOnlyExec(command);
    expect({ command, decision: verdict.decision }).toEqual({
      command,
      decision: "deny",
    });
  }
});

test("comments, ANSI-C quotes and nested expansions cannot hide a command (#237)", () => {
  // Each runs a second command in bash while reading as one simple command
  // to a tokenizer that skips comments, $'…' or quotes nested in ${…}.
  const echoPolicy: PolicySpec = {
    id: "echo-only",
    capabilities: { exec: { allow: ["echo"] } },
  };
  for (const command of [
    "echo x #'\necho PWNED #'",
    "echo $'a\\'' ; echo PWNED #'",
    "echo #\\\na",
    `echo "\${x#"'"}" ; echo PWNED #'`,
  ]) {
    const verdict = evaluatePolicy(echoPolicy, {
      interventionPoint: "pre_tool_call",
      toolName: "Execute",
      toolInput: { command },
    });
    expect({ command, reason: verdict.reason }).toEqual({
      command,
      reason: "exec-not-allowed",
    });
  }
  // The literal forms stay allowed.
  for (const command of ["echo a#b", "echo '#'", `echo "\${HOME}"`]) {
    expect(
      evaluatePolicy(echoPolicy, {
        interventionPoint: "pre_tool_call",
        toolName: "Execute",
        toolInput: { command },
      }).decision,
    ).toBe("allow");
  }
});

test("an unbalanced quote denies an allowlisted command (#237)", () => {
  for (const command of ['rg "a|b file', "rg 'a file", 'rg "a\\" file']) {
    const verdict = readOnlyExec(command);
    expect({ command, decision: verdict.decision }).toEqual({
      command,
      decision: "deny",
    });
    expect(verdict.reason).toBe("exec-not-allowed");
  }
});

test("exec.unknown confirmation escalates instead of denying", () => {
  const withConfirmation: PolicySpec = {
    ...basePolicy,
    confirmations: { requiredFor: ["exec.unknown"] },
  };
  const verdict = evaluatePolicy(withConfirmation, {
    interventionPoint: "pre_tool_call",
    toolName: "Execute",
    toolInput: { command: "curl example.com" },
  });
  expect(verdict.decision).toBe("escalate");
  expect(verdict.reason).toBe("exec-unknown-confirmation");
  // Deny list still hard-denies even with the confirmation configured.
  const denied = evaluatePolicy(withConfirmation, {
    interventionPoint: "pre_tool_call",
    toolName: "Execute",
    toolInput: { command: "rm -rf /" },
  });
  expect(denied.decision).toBe("deny");
});

test("filesystem deny globs match tool file paths", () => {
  expect(preToolCall("Read", { file_path: ".env" }).decision).toBe("deny");
  expect(
    preToolCall("Read", { file_path: "config/secrets/key.pem" }).decision,
  ).toBe("deny");
  expect(preToolCall("Read", { file_path: "src/index.ts" }).decision).toBe(
    "allow",
  );
});

test("traversal aliases and uncontained paths cannot dodge filesystem rules", () => {
  // "src/../.env" canonicalizes to ".env", which is deny-listed.
  const aliased = preToolCall("Read", { file_path: "src/../.env" });
  expect(aliased.decision).toBe("deny");
  expect(aliased.reason).toBe("filesystem-denied");

  // Paths escaping the workspace root cannot be classified: deny.
  const escaping = preToolCall("Read", { file_path: "../outside.txt" });
  expect(escaping.decision).toBe("deny");
  expect(escaping.reason).toBe("filesystem-uncontained-path");

  // Absolute paths likewise.
  const absolute = preToolCall("Read", { file_path: "/etc/passwd" });
  expect(absolute.decision).toBe("deny");
  expect(absolute.reason).toBe("filesystem-uncontained-path");

  // A policy without filesystem rules does not gate uncontained paths.
  const unruled = evaluatePolicy(
    { id: "p", capabilities: { exec: { deny: ["rm"] } } },
    {
      interventionPoint: "pre_tool_call",
      toolName: "Read",
      toolInput: { file_path: "/etc/hosts" },
    },
  );
  expect(unruled.decision).toBe("allow");

  // Benign redundant segments still canonicalize and pass.
  expect(preToolCall("Read", { file_path: "./src/index.ts" }).decision).toBe(
    "allow",
  );
});

test("filesystem.write confirmation escalates write tools only", () => {
  const withConfirmation: PolicySpec = {
    ...basePolicy,
    confirmations: { requiredFor: ["filesystem.write"] },
  };
  const write = evaluatePolicy(withConfirmation, {
    interventionPoint: "pre_tool_call",
    toolName: "Write",
    toolInput: { file_path: "src/index.ts" },
  });
  expect(write.decision).toBe("escalate");
  const read = evaluatePolicy(withConfirmation, {
    interventionPoint: "pre_tool_call",
    toolName: "Read",
    toolInput: { file_path: "src/index.ts" },
  });
  expect(read.decision).toBe("allow");
});

test("network deny * blocks any URL host", () => {
  const verdict = preToolCall("WebFetch", { url: "https://example.com/x" });
  expect(verdict.decision).toBe("deny");
  expect(verdict.reason).toBe("network-denied");
});

test("cost budget warns at 80% and denies at limit", () => {
  expect(preToolCall("Read", { file_path: "a.ts" }, 3.9).decision).toBe(
    "allow",
  );
  const warned = preToolCall("Read", { file_path: "a.ts" }, 4.2);
  expect(warned.decision).toBe("warn");
  expect(warned.reason).toBe("cost-budget-warning");
  const denied = preToolCall("Read", { file_path: "a.ts" }, 5.0);
  expect(denied.decision).toBe("deny");
  expect(denied.reason).toBe("cost-budget-exceeded");
});

test("composeVerdicts orders deny > escalate > transform > warn > allow", () => {
  const verdicts: PolicyVerdict[] = [
    { decision: "warn" },
    { decision: "escalate" },
    { decision: "allow" },
  ];
  expect(composeVerdicts(verdicts).decision).toBe("escalate");
  expect(
    composeVerdicts([...verdicts, { decision: "deny", reason: "x" }]).decision,
  ).toBe("deny");
  expect(composeVerdicts([]).decision).toBe("allow");
  expect(
    composeVerdicts([{ decision: "transform" }, { decision: "warn" }]).decision,
  ).toBe("transform");
});

test("evaluator failures fail closed with the reserved reason", () => {
  // Inject an internal failure via a throwing property accessor.
  const brokenPolicy = {
    id: "broken",
    get capabilities(): PolicySpec["capabilities"] {
      throw new Error("boom");
    },
  } as PolicySpec;
  const verdict = evaluatePolicy(brokenPolicy, {
    interventionPoint: "pre_tool_call",
    toolName: "Read",
    toolInput: { file_path: "src/index.ts" },
  });
  expect(verdict.decision).toBe("deny");
  expect(verdict.reason).toBe(POLICY_RUNTIME_ERROR_REASON);
});

test("createPolicyEvalHandler adapts the hook JSON contract", () => {
  const handler = createPolicyEvalHandler(basePolicy);
  expect(
    handler({
      hook_event: "pre_tool_call",
      tool_name: "Execute",
      tool_input: { command: "rm -rf /" },
    }).verdict,
  ).toBe("deny");
  expect(
    handler({
      hook_event: "pre_tool_call",
      tool_name: "Execute",
      tool_input: { command: "bun test" },
    }).verdict,
  ).toBe("allow");
  // Unknown hook events fail closed.
  const unknown = handler({ hook_event: "mystery_event" });
  expect(unknown.verdict).toBe("deny");
  expect(unknown.reason).toBe(POLICY_RUNTIME_ERROR_REASON);
});

test("lifecycle points only enforce cost", () => {
  const verdict = evaluatePolicy(basePolicy, {
    interventionPoint: "run_start",
    state: { cumulativeCostUsd: 6 },
  });
  expect(verdict.decision).toBe("deny");
  const clean = evaluatePolicy(basePolicy, {
    interventionPoint: "run_start",
  });
  expect(clean.decision).toBe("allow");
});
