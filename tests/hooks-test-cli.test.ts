import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesAgentsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "agents-dir",
);

async function runHooksTest(
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: [
      "bun",
      "run",
      join(repoRoot, "packages", "cli", "src", "index.ts"),
      "hooks",
      "test",
      ...args,
    ],
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function baseArgs(event = "beforeShellExecution"): string[] {
  return [
    "--policy",
    "triage-readonly",
    "--agents-dir",
    fixturesAgentsDir,
    "--event",
    event,
  ];
}

test("denied command prints deny and exits 2", async () => {
  const result = await runHooksTest([
    ...baseArgs(),
    "--input",
    '{"command":"rm -rf /"}',
  ]);

  expect(result.exitCode).toBe(2);
  expect(result.stdout).toContain("deny");
  expect(result.stdout).toContain("exec-denied");
  expect(result.stdout).toContain(
    "Command is denied by policy triage-readonly",
  );
});

test("allowed command exits 0", async () => {
  const result = await runHooksTest([
    ...baseArgs(),
    "--input",
    '{"command":"bun test tests/x.test.ts"}',
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("verdict: allow");
});

test("unknown command requiring confirmation exits 3", async () => {
  const result = await runHooksTest([
    ...baseArgs(),
    "--input",
    '{"command":"curl https://example.com"}',
  ]);

  expect(result.exitCode).toBe(3);
  expect(result.stdout).toContain("verdict: escalate");
});

test("--format json emits a raw parseable verdict", async () => {
  const result = await runHooksTest([
    ...baseArgs(),
    "--input",
    '{"command":"rm -rf /"}',
    "--format",
    "json",
  ]);

  expect(JSON.parse(result.stdout)).toEqual({
    verdict: "deny",
    reason: "exec-denied",
  });
});

test("missing or unknown event prints usage and exits 1", async () => {
  const missing = await runHooksTest(baseArgs().slice(0, -2));
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr).toContain("Usage: agents hooks test");

  const unknown = await runHooksTest(baseArgs("beforeLaunch"));
  expect(unknown.exitCode).toBe(1);
  expect(unknown.stderr).toContain("Usage: agents hooks test");
});

test("unreadable policy fails loudly with exit 1 (dev tool, not enforcement)", async () => {
  // Contrast with policy-eval, which fails CLOSED (deny, exit 0) on load
  // errors because it sits on the enforcement path. The probe tool must
  // instead surface the load failure to the author.
  const result = await runHooksTest([
    "--policy",
    "no-such-policy",
    "--agents-dir",
    fixturesAgentsDir,
    "--event",
    "beforeShellExecution",
    "--input",
    '{"command":"echo hi"}',
  ]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("no-such-policy");
  expect(result.stdout).not.toContain("verdict:");
});

test("--input file path reaches the afterFileEdit evaluator", async () => {
  const result = await runHooksTest([
    ...baseArgs("afterFileEdit"),
    "--input",
    '{"file_path":".env"}',
  ]);

  expect(result.exitCode).toBe(2);
  expect(result.stdout).toContain("filesystem-denied");
});
