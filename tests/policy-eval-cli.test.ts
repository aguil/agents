import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPolicyEvalHandler } from "@aguil/agents-policy";
import {
  normalizeHookPayload,
  relativizeContainedPaths,
} from "../packages/cli/src/policy-eval-main";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesAgentsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "agents-dir",
);

async function runPolicyEval(
  args: readonly string[],
  stdinPayload: unknown,
  reservedEnv: Readonly<Record<string, string>> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env = Object.fromEntries(
    Object.entries(Bun.env).filter(
      ([key]) => key !== "AGENTS_POLICY_ID" && key !== "AGENTS_AGENTS_DIR",
    ),
  );
  const proc = Bun.spawn({
    cmd: [
      "bun",
      "run",
      join(repoRoot, "packages", "cli", "src", "index.ts"),
      "policy-eval",
      ...args,
    ],
    cwd: repoRoot,
    env: { ...env, ...reservedEnv },
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
  expect(String(response.agent_message)).toContain("triage-readonly");
});

test("a Cursor denial names the rule, not the command (#238)", async () => {
  const result = await runPolicyEval(
    ["--policy", "triage-readonly", "--agents-dir", fixturesAgentsDir],
    {
      hook_event_name: "beforeShellExecution",
      command: "rm -rf /tmp/secret-target",
    },
  );
  expect(lastJsonLine(result.stdout)).toEqual({
    permission: "deny",
    user_message:
      "Blocked by policy triage-readonly (exec-denied): deny entry `rm`",
    agent_message:
      "Blocked by policy triage-readonly (exec-denied): deny entry `rm`",
  });
});

test("a Claude denial names the rule, not the command (#238)", async () => {
  const args = [
    "--policy",
    "triage-readonly",
    "--agents-dir",
    fixturesAgentsDir,
    "--format",
    "claude",
  ];
  const exec = await runPolicyEval(args, {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git push origin secret-branch" },
  });
  expect(lastJsonLine(exec.stdout)).toEqual({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "Blocked by policy triage-readonly (exec-denied): deny entry `git push`",
    },
  });
  const read = await runPolicyEval(args, {
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: "config/secrets/key.pem" },
  });
  expect(
    (
      lastJsonLine(read.stdout) as {
        hookSpecificOutput: { permissionDecisionReason: string };
      }
    ).hookSpecificOutput.permissionDecisionReason,
  ).toBe(
    "Blocked by policy triage-readonly (filesystem-denied): deny entry `**/secrets/**`",
  );
});

test("a denial without a rule keeps the policy and reason (#238)", async () => {
  const result = await runPolicyEval(
    ["--policy", "triage-readonly", "--agents-dir", fixturesAgentsDir],
    { hook_event_name: "TotallyUnknownEvent" },
  );
  expect(lastJsonLine(result.stdout)).toEqual({
    permission: "deny",
    user_message: "Blocked by policy triage-readonly (policy-runtime-error)",
    agent_message: "Blocked by policy triage-readonly (policy-runtime-error)",
  });
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

test("policy identity and agents dir fall back to inherited env", async () => {
  const result = await runPolicyEval(
    [],
    {
      hook_event_name: "beforeShellExecution",
      command: "rm -rf /tmp/x",
    },
    {
      AGENTS_POLICY_ID: "triage-readonly",
      AGENTS_AGENTS_DIR: fixturesAgentsDir,
    },
  );
  expect(result.exitCode).toBe(0);
  expect(lastJsonLine(result.stdout).permission).toBe("deny");
  expect(String(lastJsonLine(result.stdout).agent_message)).toContain(
    "triage-readonly",
  );
});

test("@none explicitly allows without loading a policy", async () => {
  const result = await runPolicyEval(
    [],
    { hook_event_name: "beforeShellExecution", command: "rm -rf /tmp/x" },
    {
      AGENTS_POLICY_ID: "@none",
      AGENTS_AGENTS_DIR: join(repoRoot, "does-not-exist"),
    },
  );
  expect(result.exitCode).toBe(0);
  expect(lastJsonLine(result.stdout)).toEqual({ permission: "allow" });
  expect(result.stderr).toBe("");
});

test("missing policy flag and env fails closed with deny", async () => {
  const result = await runPolicyEval([], {
    hook_event_name: "beforeShellExecution",
    command: "echo hi",
  });
  expect(result.exitCode).toBe(0);
  expect(lastJsonLine(result.stdout)).toEqual({ permission: "deny" });
  expect(result.stderr).toContain("AGENTS_POLICY_ID is missing");
  expect(result.stderr).toContain("environment may have been stripped");
});

test("policy flag takes precedence over inherited env", async () => {
  const result = await runPolicyEval(
    ["--policy", "triage-readonly", "--agents-dir", fixturesAgentsDir],
    {
      hook_event_name: "beforeShellExecution",
      command: "rm -rf /tmp/x",
    },
    {
      AGENTS_POLICY_ID: "@none",
      AGENTS_AGENTS_DIR: join(repoRoot, "does-not-exist"),
    },
  );
  expect(lastJsonLine(result.stdout).permission).toBe("deny");
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

test("stdin-supplied cost state cannot influence the verdict", async () => {
  // Fixture policy has cost_usd: 2.5; a payload claiming zero spend must
  // not matter because stdin state is dropped entirely — and conversely a
  // payload claiming huge spend must not deny an allowed command.
  const result = await runPolicyEval(
    ["--policy", "triage-readonly", "--agents-dir", fixturesAgentsDir],
    {
      hook_event_name: "beforeShellExecution",
      command: "bun test",
      state: { cumulative_cost_usd: 999 },
    },
  );
  expect(lastJsonLine(result.stdout).permission).toBe("allow");
});

test("normalizeHookPayload drops stdin state", () => {
  const normalized = normalizeHookPayload({
    hook_event: "pre_tool_call",
    tool_input: { command: "rg foo" },
    state: { cumulative_cost_usd: 0 },
  });
  expect("state" in normalized).toBe(false);
});

test("normalizeHookPayload lifts nested MCP arguments", () => {
  const mcpNested = normalizeHookPayload({
    hook_event_name: "beforeMCPExecution",
    tool_name: "fetch_url",
    tool_input: { arguments: { url: "https://evil.example.com/x" } },
  });
  expect(mcpNested.hook_event).toBe("pre_tool_call");
  expect(mcpNested.tool_input?.url).toBe("https://evil.example.com/x");

  const mcpTopLevel = normalizeHookPayload({
    hook_event_name: "beforeMCPExecution",
    arguments: { path: "/etc/passwd" },
  });
  expect(mcpTopLevel.tool_input?.path).toBe("/etc/passwd");

  // Explicit canonical fields win over nested arguments.
  const both = normalizeHookPayload({
    hook_event: "pre_tool_call",
    tool_input: {
      url: "https://explicit.example.com",
      arguments: { url: "https://nested.example.com" },
    },
  });
  expect(both.tool_input?.url).toBe("https://explicit.example.com");
});

test("MCP-shaped payload with nested url is denied by network policy", async () => {
  const result = await runPolicyEval(
    ["--policy", "triage-readonly", "--agents-dir", fixturesAgentsDir],
    {
      hook_event_name: "beforeMCPExecution",
      tool_name: "fetch_url",
      tool_input: { arguments: { url: "https://example.com/data" } },
    },
  );
  expect(lastJsonLine(result.stdout).permission).toBe("deny");
});

test("normalizeHookPayload maps Claude Code event names (ADR 0023)", () => {
  const pre = normalizeHookPayload({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo hi" },
  });
  expect(pre.hook_event).toBe("pre_tool_call");
  expect(pre.tool_name).toBe("Bash");
  expect(pre.tool_input?.command).toBe("echo hi");

  const post = normalizeHookPayload({ hook_event_name: "PostToolUse" });
  expect(post.hook_event).toBe("post_tool_call");

  const stop = normalizeHookPayload({ hook_event_name: "Stop" });
  expect(stop.hook_event).toBe("role_stop");

  const start = normalizeHookPayload({ hook_event_name: "SessionStart" });
  expect(start.hook_event).toBe("role_start");
});

test("policy-eval --format defaults to cursor and encodes claude deny", async () => {
  const { encodeClaudePolicyResponse, encodeCursorPolicyResponse } =
    await import("../packages/cli/src/policy-eval-main");
  expect(encodeCursorPolicyResponse({ permission: "deny" })).toEqual({
    permission: "deny",
  });
  expect(
    encodeClaudePolicyResponse({
      permission: "deny",
      agentMessage: "nope",
    }),
  ).toEqual({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "nope",
    },
  });

  const cursorDefault = await runPolicyEval(
    ["--policy", "triage-readonly", "--agents-dir", fixturesAgentsDir],
    {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
    },
  );
  // Unknown/denied by policy still Cursor-shaped when --format omitted.
  const cursorBody = lastJsonLine(cursorDefault.stdout);
  expect(cursorBody.permission).toBeDefined();

  const claudeDeny = await runPolicyEval(
    [
      "--policy",
      "triage-readonly",
      "--agents-dir",
      fixturesAgentsDir,
      "--format",
      "claude",
    ],
    {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "curl https://evil.example" },
    },
  );
  const body = lastJsonLine(claudeDeny.stdout) as {
    hookSpecificOutput?: { permissionDecision?: string };
  };
  expect(body.hookSpecificOutput?.permissionDecision).toBeDefined();
});

test("unknown hook event still denies (ADR 0023 decision 7)", async () => {
  const result = await runPolicyEval(
    [
      "--policy",
      "triage-readonly",
      "--agents-dir",
      fixturesAgentsDir,
      "--format",
      "claude",
    ],
    { hook_event_name: "TotallyUnknownEvent" },
  );
  const body = lastJsonLine(result.stdout) as {
    hookSpecificOutput: { permissionDecision: string };
  };
  expect(body.hookSpecificOutput.permissionDecision).toBe("deny");
});

test("--workspace classifies a symlinked path by the file it reaches", async () => {
  const base = await mkdtemp(join(tmpdir(), "policy-eval-symlink-"));
  const workspace = join(base, "ws");
  const outside = join(base, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "s");
  await writeFile(join(workspace, ".env"), "TOKEN=x");
  await symlink(outside, join(workspace, "escape"));
  await symlink(join(workspace, ".env"), join(workspace, "notes.txt"));
  await symlink(join(outside, "new.txt"), join(workspace, "dangling"));
  try {
    const decide = async (tool: string, filePath: string) => {
      const result = await runPolicyEval(
        [
          "--policy",
          "triage-readonly",
          "--agents-dir",
          fixturesAgentsDir,
          "--format",
          "claude",
          "--workspace",
          workspace,
        ],
        {
          hook_event_name: "PreToolUse",
          tool_name: tool,
          tool_input: { file_path: filePath },
        },
      );
      const body = lastJsonLine(result.stdout) as {
        hookSpecificOutput: { permissionDecision: string };
      };
      return body.hookSpecificOutput.permissionDecision;
    };
    const [escaping, aliasOfEnv, dangling, fresh, backOut] = await Promise.all([
      decide("Read", join(workspace, "escape", "secret.txt")),
      decide("Read", join(workspace, "notes.txt")),
      decide("Write", join(workspace, "dangling")),
      decide("Write", join(workspace, "new-dir", "fresh.md")),
      // Lexically <ws>/outside/secret.txt; physically escape/.. is base.
      decide("Read", `${workspace}/escape/../outside/secret.txt`),
    ]);
    // A link inside the root to a file outside it is outside.
    expect(escaping).toBe("deny");
    // A link to .env is .env, whatever it is called.
    expect(aliasOfEnv).toBe("deny");
    // A dangling link could land anywhere.
    expect(dangling).toBe("deny");
    // A file that doesn't exist yet, in a directory that doesn't either, is
    // still inside.
    expect(fresh).toBe("allow");
    // `..` after a link steps out of where the link leads.
    expect(backOut).toBe("deny");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("Claude's NotebookEdit path is classified by filesystem rules", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "policy-eval-notebook-"));
  try {
    const decide = async (notebookPath: string) => {
      const result = await runPolicyEval(
        [
          "--policy",
          "triage-readonly",
          "--agents-dir",
          fixturesAgentsDir,
          "--format",
          "claude",
          "--workspace",
          workspace,
        ],
        {
          hook_event_name: "PreToolUse",
          tool_name: "NotebookEdit",
          tool_input: { notebook_path: notebookPath, new_source: "x = 1" },
        },
      );
      const body = lastJsonLine(result.stdout) as {
        hookSpecificOutput: { permissionDecision: string };
      };
      return body.hookSpecificOutput.permissionDecision;
    };
    const [notebook, dotEnv, outside] = await Promise.all([
      decide(join(workspace, "analysis.ipynb")),
      decide(join(workspace, ".env")),
      decide("/etc/analysis.ipynb"),
    ]);
    // Without notebook_path the evaluator saw no path and allowed all three.
    expect(notebook).toBe("allow");
    expect(dotEnv).toBe("deny");
    expect(outside).toBe("deny");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("--workspace lets filesystem rules classify Claude's absolute paths (#219)", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "policy-eval-workspace-"));
  try {
    const decide = async (
      filePath: string,
      withWorkspace = true,
    ): Promise<string | undefined> => {
      const result = await runPolicyEval(
        [
          "--policy",
          "triage-readonly",
          "--agents-dir",
          fixturesAgentsDir,
          "--format",
          "claude",
          ...(withWorkspace ? ["--workspace", workspace] : []),
        ],
        {
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: { file_path: filePath },
        },
      );
      const body = lastJsonLine(result.stdout) as {
        hookSpecificOutput: { permissionDecision: string };
      };
      return body.hookSpecificOutput.permissionDecision;
    };
    // Each decision is its own bridge process; run them concurrently.
    const [
      contained,
      dotEnv,
      aliased,
      system,
      escaping,
      root,
      withoutWorkspace,
    ] = await Promise.all([
      decide(join(workspace, "src", "index.ts")),
      decide(join(workspace, ".env")),
      decide(join(workspace, "src", "..", ".env")),
      decide("/etc/passwd"),
      decide(join(workspace, "..", "outside.txt")),
      decide(workspace),
      decide(join(workspace, "src", "index.ts"), false),
    ]);
    // triage-readonly allows "**" and denies ".env": contained paths are now
    // classified by those rules.
    expect(contained).toBe("allow");
    expect(dotEnv).toBe("deny");
    expect(aliased).toBe("deny");
    // Outside the root, and the root itself, stay uncontained.
    expect(system).toBe("deny");
    expect(escaping).toBe("deny");
    expect(root).toBe("deny");
    // Without --workspace every absolute path is still uncontained.
    expect(withoutWorkspace).toBe("deny");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("relativizeContainedPaths accepts the workspace's realpath alias", async () => {
  const real = await mkdtemp(join(tmpdir(), "policy-eval-real-"));
  const link = `${real}-link`;
  await symlink(real, link);
  try {
    const rewritten = relativizeContainedPaths(
      {
        hook_event: "pre_tool_call",
        tool_name: "Glob",
        tool_input: { path: join(real, "src"), pattern: "*.ts" },
      },
      link,
    );
    expect(rewritten.tool_input).toEqual({ path: "src", pattern: "*.ts" });
  } finally {
    await rm(link, { force: true });
    await rm(real, { recursive: true, force: true });
  }
});

/** A Cursor `beforeReadFile` payload, shaped as cursor-agent 2026.10.01-14929f9 sends it. */
function cursorReadPayload(filePath: string, workspace: string) {
  return {
    conversation_id: "c",
    generation_id: "g",
    model: "m",
    content: "READ-HOOK-CONTENT-SENTINEL",
    file_path: filePath,
    attachments: [],
    session_id: "s",
    hook_event_name: "beforeReadFile",
    cursor_version: "2026.10.01-14929f9",
    workspace_roots: [workspace],
  };
}

test("a Cursor native read of a denied path is refused with permission deny (#198)", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "policy-eval-read-"));
  try {
    const args = [
      "--policy",
      "triage-readonly",
      "--agents-dir",
      fixturesAgentsDir,
      "--workspace",
      workspace,
    ];
    const denied = await runPolicyEval(
      args,
      cursorReadPayload(join(workspace, ".env"), workspace),
    );
    expect(denied.exitCode).toBe(0);
    expect(lastJsonLine(denied.stdout)).toEqual({
      permission: "deny",
      user_message:
        "Blocked by policy triage-readonly (filesystem-denied): deny entry `.env`",
      agent_message:
        "Blocked by policy triage-readonly (filesystem-denied): deny entry `.env`",
    });
    const nested = await runPolicyEval(
      args,
      cursorReadPayload(join(workspace, "a", "secrets", "k.pem"), workspace),
    );
    expect(lastJsonLine(nested.stdout).permission).toBe("deny");
    const allowed = await runPolicyEval(
      args,
      cursorReadPayload(join(workspace, "src", "main.ts"), workspace),
    );
    expect(lastJsonLine(allowed.stdout)).toEqual({ permission: "allow" });
    // The file's content never leaves the bridge, on any path.
    for (const run of [denied, nested, allowed]) {
      expect(run.stdout + run.stderr).not.toContain(
        "READ-HOOK-CONTENT-SENTINEL",
      );
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("without --workspace a native read's absolute path stays uncontained (#198)", async () => {
  // Why the Cursor bridge is now generated with --workspace (JC-8).
  const result = await runPolicyEval(
    ["--policy", "triage-readonly", "--agents-dir", fixturesAgentsDir],
    cursorReadPayload("/tmp/ws/src/main.ts", "/tmp/ws"),
  );
  expect(lastJsonLine(result.stdout)).toEqual({
    permission: "deny",
    user_message:
      "Blocked by policy triage-readonly (filesystem-uncontained-path): filesystem rules cover only paths inside the workspace",
    agent_message:
      "Blocked by policy triage-readonly (filesystem-uncontained-path): filesystem rules cover only paths inside the workspace",
  });
});

test("beforeReadFile normalizes to a pre-tool read without the file's content (#198)", () => {
  const normalized = normalizeHookPayload(
    cursorReadPayload("/w/src/a.ts", "/w"),
  );
  expect(normalized).toEqual({
    hook_event: "pre_tool_call",
    tool_name: "Read",
    tool_input: { file_path: "/w/src/a.ts" },
  });
  // A read is not a write: the filesystem.write confirmation does not fire.
  const handler = createPolicyEvalHandler({
    id: "write-confirm",
    capabilities: { filesystem: { allow: ["**"] } },
    confirmations: { requiredFor: ["filesystem.write"] },
  });
  expect(
    handler(
      relativizeContainedPaths(
        normalizeHookPayload(cursorReadPayload("/w/src/a.ts", "/w")),
        "/w",
      ),
    ),
  ).toEqual({ verdict: "allow" });
});

test("a Cursor denial travels under user_message and agent_message, the keys cursor-agent reads (JC-23)", async () => {
  const { encodeCursorPolicyResponse } = await import(
    "../packages/cli/src/policy-eval-main"
  );
  expect(
    encodeCursorPolicyResponse({ permission: "deny", agentMessage: "why" }),
  ).toEqual({ permission: "deny", user_message: "why", agent_message: "why" });
  const result = await runPolicyEval(
    ["--policy", "triage-readonly", "--agents-dir", fixturesAgentsDir],
    { hook_event_name: "beforeShellExecution", command: "git push origin x" },
  );
  const response = lastJsonLine(result.stdout);
  const text =
    "Blocked by policy triage-readonly (exec-denied): deny entry `git push`";
  // beforeShellExecution and beforeReadFile build the agent's error from
  // user_message; only preToolUse forwards agent_message.
  expect(response.user_message).toBe(text);
  expect(response.agent_message).toBe(text);
  expect("agentMessage" in response).toBe(false);
});

test("on Claude, an absolute argument to a denied path inside the workspace denies (#104)", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "policy-eval-argument-"));
  await writeFile(join(workspace, ".env"), "TOKEN=x");
  try {
    const decide = async (command: string) => {
      const result = await runPolicyEval(
        [
          "--policy",
          "triage-readonly",
          "--agents-dir",
          fixturesAgentsDir,
          "--format",
          "claude",
          "--workspace",
          workspace,
        ],
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command },
        },
      );
      return lastJsonLine(result.stdout);
    };
    expect(await decide(`rg TOKEN ${join(workspace, ".env")}`)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "Blocked by policy triage-readonly (filesystem-denied): deny entry `.env`",
      },
    });
    // Outside the workspace the argument is not checked (JC-15).
    expect(await decide("rg TOKEN /etc/hostname")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
