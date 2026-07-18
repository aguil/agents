import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeHookPayload } from "../packages/cli/src/policy-eval-main";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesAgentsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "agents-dir",
);

async function runPolicyEval(
  args: readonly string[],
  stdinPayload: unknown,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: [
      "bun",
      "run",
      join(repoRoot, "packages", "cli", "src", "index.ts"),
      "policy-eval",
      ...args,
    ],
    cwd: repoRoot,
    stdin: new TextEncoder().encode(JSON.stringify(stdinPayload)),
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

function lastJsonLine(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}

test("denied command in Cursor payload shape yields permission deny", async () => {
  const result = await runPolicyEval(
    ["--policy", "triage-readonly", "--agents-dir", fixturesAgentsDir],
    {
      hook_event_name: "beforeShellExecution",
      command: "rm -rf /tmp/x",
      cwd: "/tmp",
    },
  );
  expect(result.exitCode).toBe(0);
  const response = lastJsonLine(result.stdout);
  expect(response.permission).toBe("deny");
  expect(String(response.agentMessage)).toContain("triage-readonly");
});

test("allowed command yields permission allow", async () => {
  const result = await runPolicyEval(
    ["--policy", "triage-readonly", "--agents-dir", fixturesAgentsDir],
    {
      hook_event_name: "beforeShellExecution",
      command: "bun test tests/x.test.ts",
    },
  );
  expect(lastJsonLine(result.stdout).permission).toBe("allow");
});

test("unlisted command escalates to ask via exec.unknown confirmation", async () => {
  // Fixture policy has confirmations.requiredFor: [exec.unknown].
  const result = await runPolicyEval(
    ["--policy", "triage-readonly", "--agents-dir", fixturesAgentsDir],
    {
      hook_event_name: "beforeShellExecution",
      command: "curl https://example.com",
    },
  );
  expect(lastJsonLine(result.stdout).permission).toBe("ask");
});

test("missing policy fails closed with deny", async () => {
  const result = await runPolicyEval(
    ["--policy", "no-such-policy", "--agents-dir", fixturesAgentsDir],
    { hook_event_name: "beforeShellExecution", command: "echo hi" },
  );
  expect(lastJsonLine(result.stdout).permission).toBe("deny");
  expect(result.stderr).toContain("could not load policy");
});

test("invalid stdin fails closed with deny", async () => {
  const proc = Bun.spawn({
    cmd: [
      "bun",
      "run",
      join(repoRoot, "packages", "cli", "src", "index.ts"),
      "policy-eval",
      "--policy",
      "triage-readonly",
      "--agents-dir",
      fixturesAgentsDir,
    ],
    cwd: repoRoot,
    stdin: new TextEncoder().encode("this is not json"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  expect(lastJsonLine(stdout).permission).toBe("deny");
});

test("normalizeHookPayload maps Cursor events and lifts top-level fields", () => {
  const shell = normalizeHookPayload({
    hook_event_name: "beforeShellExecution",
    command: "rg foo",
  });
  expect(shell.hook_event).toBe("pre_tool_call");
  expect(shell.tool_name).toBe("Execute");
  expect(shell.tool_input?.command).toBe("rg foo");

  const edit = normalizeHookPayload({
    hook_event_name: "afterFileEdit",
    file_path: "src/x.ts",
  });
  expect(edit.hook_event).toBe("post_tool_call");
  expect(edit.tool_input?.file_path).toBe("src/x.ts");

  const canonical = normalizeHookPayload({
    hook_event: "pre_tool_call",
    tool_name: "WebFetch",
    tool_input: { url: "https://example.com" },
  });
  expect(canonical.hook_event).toBe("pre_tool_call");
  expect(canonical.tool_input?.url).toBe("https://example.com");
});
