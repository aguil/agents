import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function runHarnessCli(
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: [
      "bun",
      "run",
      join(repoRoot, "packages", "cli", "src", "index.ts"),
      "harness",
      "run",
      ...args,
    ],
    cwd: repoRoot,
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
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

test("harness run requires agents-dir and workspace", async () => {
  const result = await runHarnessCli(["incident-triage"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("--agents-dir and --workspace are required");
});

test("harness run --help prints usage instead of the top-level overview", async () => {
  const result = await runHarnessCli(["--help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Usage: agents harness run <id>");
  expect(result.stdout).toContain("--agents-dir <dir>");
  expect(result.stdout).toContain("--workspace <path>");
  expect(result.stdout).not.toContain("Unknown command");
  expect(result.stderr).not.toContain("Unknown command");
});

test("harness run -h matches --help", async () => {
  const result = await runHarnessCli(["-h"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Usage: agents harness run <id>");
  expect(result.stdout).toContain("--force-tool-calls");
});

test("harness run documents --model/--models and rejects malformed --models", async () => {
  const help = await runHarnessCli(["--help"]);
  expect(help.stdout).toContain("--model <model>");
  expect(help.stdout).toContain("--models role=model,...");

  const result = await runHarnessCli([
    "incident-triage",
    "--agents-dir",
    ".agents",
    "--workspace",
    ".",
    "--models",
    "security-missing-equals",
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("invalid --models value");
});

test("harness run --force-tool-calls warns; default options stay non-forcing", async () => {
  const { cursorOptionsForHarnessRun } = await import(
    "../packages/cli/src/harness-run-main"
  );
  const { buildCursorCommand, resolveCursorApprovalFlags } = await import(
    "@aguil/agents-execution"
  );

  const safe = cursorOptionsForHarnessRun(false);
  const forced = cursorOptionsForHarnessRun(true);
  expect(resolveCursorApprovalFlags(safe)).toEqual({
    force: false,
    sandbox: "enabled",
  });
  expect(resolveCursorApprovalFlags(forced)).toEqual({
    force: true,
    sandbox: undefined,
  });

  const base = {
    runId: "run-1",
    roleId: "scout",
    prompt: "x",
    workspacePath: "/repo",
    contextBundlePath: "/scratch/context.json",
    scratchpadPath: "/scratch",
    timeoutMs: 1_000,
    allowedCommands: [] as string[],
  };
  const safeCmd = buildCursorCommand(base, "/scratch/r.json", safe);
  const forcedCmd = buildCursorCommand(base, "/scratch/r.json", forced);
  expect(safeCmd).not.toContain("--force");
  expect(safeCmd).toContain("--sandbox");
  expect(forcedCmd).toContain("--force");
  expect(forcedCmd).not.toContain("--sandbox");

  const workspace = await mkdtemp(join(tmpdir(), "harness-run-force-"));
  try {
    await cp(
      join(repoRoot, "examples", "incident-triage", "fixture"),
      workspace,
      { recursive: true },
    );
    const result = await runHarnessCli([
      "incident-triage",
      "--agents-dir",
      join(repoRoot, "examples", "incident-triage", ".agents"),
      "--workspace",
      workspace,
      "--adapter",
      "fake",
      "--allow-unenforced-policy",
      "--force-tool-calls",
    ]);
    // fake adapter ignores the flag for spawning, but the warn must still fire
    // when a policy-declaring harness is forced (audibility of the weaker posture).
    expect(result.stderr).toContain("--force-tool-calls");
    expect(result.stderr).toContain("collapses hook ask");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("harness run rejects unknown adapters and arguments", async () => {
  const bad = await runHarnessCli([
    "incident-triage",
    "--agents-dir",
    "x",
    "--workspace",
    "y",
    "--adapter",
    "mystery",
  ]);
  expect(bad.exitCode).toBe(1);
  expect(bad.stderr).toContain('unsupported adapter "mystery"');

  const unknown = await runHarnessCli(["incident-triage", "--frobnicate"]);
  expect(unknown.exitCode).toBe(1);
  expect(unknown.stderr).toContain('unknown argument "--frobnicate"');
});

test("harness run executes the full chain via the CLI; pass_check fails an unhealed run", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "harness-run-"));
  try {
    await cp(
      join(repoRoot, "examples", "incident-triage", "fixture"),
      workspace,
      {
        recursive: true,
      },
    );
    const result = await runHarnessCli([
      "incident-triage",
      "--agents-dir",
      join(repoRoot, "examples", "incident-triage", ".agents"),
      "--workspace",
      workspace,
      "--adapter",
      "fake",
      "--allow-unenforced-policy",
    ]);
    // The chain runs end to end (all roles complete)...
    expect(result.stdout).toContain("execution: chain");
    expect(result.stdout).toContain(
      "roles completed: scout,diagnose,fix,verify",
    );
    // ...but the fake agent heals nothing, so the pass_check gate
    // (bun run check.ts) fails the run — deterministic success signal.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("pass_check");
    expect(result.stderr).toContain("run FAILED");
    // Non-cursor adapters must loudly report missing hook enforcement.
    expect(result.stderr).toContain("WITHOUT generated hook enforcement");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a policy-declaring harness fails closed on a non-cursor adapter", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "harness-run-failclosed-"));
  try {
    await cp(
      join(repoRoot, "examples", "incident-triage", "fixture"),
      workspace,
      { recursive: true },
    );
    const result = await runHarnessCli([
      "incident-triage",
      "--agents-dir",
      join(repoRoot, "examples", "incident-triage", ".agents"),
      "--workspace",
      workspace,
      "--adapter",
      "fake",
      // No --allow-unenforced-policy: must refuse rather than run unenforced.
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot enforce it");
    expect(result.stderr).toContain("--allow-unenforced-policy");
    expect(result.stderr).not.toContain("cursor-only");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("claude adapter enforces policy via run-scoped settings (ADR 0023)", async () => {
  const { loadHarness } = await import("@aguil/agents-harness-config");
  const { setUpHookEnforcement } = await import(
    "../packages/cli/src/harness-run-main"
  );
  const loaded = await loadHarness({
    agentsDir: join(repoRoot, "examples", "incident-triage", ".agents"),
    harnessId: "incident-triage",
  });
  const workspace = await mkdtemp(join(tmpdir(), "harness-claude-hooks-"));
  const scratchpadPath = join(workspace, "scratch");
  await mkdir(scratchpadPath, { recursive: true });
  try {
    const enforcement = await setUpHookEnforcement(loaded, {
      adapter: "claude",
      agentsDir: join(repoRoot, "examples", "incident-triage", ".agents"),
      workspace,
      scratchpadPath,
      allowUnenforcedPolicy: false,
    });
    if ("error" in enforcement) {
      throw new Error(enforcement.error);
    }
    expect(enforcement.claudeSettingsPath).toBe(
      join(scratchpadPath, "claude-settings.json"),
    );
    const settingsPath = enforcement.claudeSettingsPath;
    if (settingsPath === undefined) {
      throw new Error("expected claudeSettingsPath");
    }
    const settings = JSON.parse(await Bun.file(settingsPath).text());
    // With no --agents-cli, the bridge is this CLI itself, which setup has
    // already probed (ADR 0023 decision 10).
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(
      `'${process.execPath}' '${join(repoRoot, "packages", "cli", "src", "index.ts")}' ` +
        `policy-eval --format claude --workspace '${workspace}'`,
    );
    // Workspace must not gain a .claude/settings mutation.
    expect(
      await Bun.file(join(workspace, ".claude", "settings.json")).exists(),
    ).toBe(false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("claude setup refuses a bridge that does not fail closed (ADR 0023 decision 10)", async () => {
  const { loadHarness } = await import("@aguil/agents-harness-config");
  const { setUpHookEnforcement } = await import(
    "../packages/cli/src/harness-run-main"
  );
  const agentsDir = join(repoRoot, "examples", "incident-triage", ".agents");
  const loaded = await loadHarness({ agentsDir, harnessId: "incident-triage" });
  const workspace = await mkdtemp(join(tmpdir(), "harness-claude-probe-"));
  const scratchpadPath = join(workspace, "scratch");
  await mkdir(scratchpadPath, { recursive: true });
  // A release older than --format, and a bridge that answers allow.
  const shims = {
    stale: `#!/bin/sh\nprintf '\\033[31mpolicy-eval: unknown argument "--format"\\033[0m\\n' >&2\nexit 1\n`,
    failOpen: `#!/bin/sh\necho '${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } })}'\n`,
    // Each denies, but Claude Code would reject the response and run the tool.
    wrongEvent: `#!/bin/sh\necho '${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", permissionDecision: "deny" } })}'\n`,
    banner: `#!/bin/sh\necho 'agents 0.0.0'\necho '${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } })}'\n`,
  };
  try {
    const errors = await Promise.all(
      Object.entries(shims).map(async ([name, script]) => {
        const agentsCli = join(workspace, name);
        await writeFile(agentsCli, script, { mode: 0o755 });
        await mkdir(join(scratchpadPath, name));
        const enforcement = await setUpHookEnforcement(loaded, {
          adapter: "claude",
          agentsDir,
          workspace,
          scratchpadPath: join(scratchpadPath, name),
          agentsCli,
          allowUnenforcedPolicy: false,
        });
        return "error" in enforcement ? enforcement.error : undefined;
      }),
    );
    expect(errors[0]).toContain(
      'failed its probe (exit 1: policy-eval: unknown argument "--format")',
    );
    expect(errors[1]).toContain(
      'failed its probe (answered "allow" where a deny was required)',
    );
    expect(errors[2]).toContain(
      'failed its probe (answered for "PostToolUse" where PreToolUse was required)',
    );
    expect(errors[3]).toContain(
      "failed its probe (output is not one JSON object",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("claude bridge classifies absolute paths under a filesystem policy (#219)", async () => {
  const { loadHarness } = await import("@aguil/agents-harness-config");
  const { setUpHookEnforcement } = await import(
    "../packages/cli/src/harness-run-main"
  );
  const agentsDir = join(repoRoot, "examples", "incident-triage", ".agents");
  const loaded = await loadHarness({ agentsDir, harnessId: "incident-triage" });
  const workspace = await mkdtemp(join(tmpdir(), "harness-claude-paths-"));
  const scratchpadPath = join(workspace, ".agents-harness", "runs", "r1");
  await mkdir(scratchpadPath, { recursive: true });
  // The generated command names one executable; this one runs the repo's CLI.
  const agentsCli = join(workspace, "agents-shim");
  await writeFile(
    agentsCli,
    `#!/bin/sh\nexec bun run ${JSON.stringify(join(repoRoot, "packages", "cli", "src", "index.ts"))} "$@"\n`,
    { mode: 0o755 },
  );
  try {
    const enforcement = await setUpHookEnforcement(loaded, {
      adapter: "claude",
      agentsDir,
      workspace,
      scratchpadPath,
      agentsCli,
      allowUnenforcedPolicy: false,
    });
    if (
      "error" in enforcement ||
      enforcement.claudeSettingsPath === undefined
    ) {
      throw new Error("expected run-scoped Claude settings");
    }
    const settings = JSON.parse(
      await Bun.file(enforcement.claudeSettingsPath).text(),
    );
    const command: string = settings.hooks.PreToolUse[0].hooks[0].command;
    const roleEnv = enforcement.roleEnv?.("scout") ?? {};
    // Run the bridge exactly as Claude Code would: the generated command
    // under a shell, the role's env, and a PreToolUse payload on stdin.
    const decide = async (tool: string, filePath: string) => {
      const proc = Bun.spawn({
        cmd: ["sh", "-c", command],
        cwd: workspace,
        env: { ...Bun.env, ...roleEnv },
        stdin: new TextEncoder().encode(
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: tool,
            tool_input: { file_path: filePath },
          }),
        ),
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      const lines = stdout.trim().split("\n");
      return JSON.parse(lines[lines.length - 1] ?? "{}").hookSpecificOutput
        ?.permissionDecision as string | undefined;
    };
    const [bundle, write, checkFile, system] = await Promise.all([
      decide("Read", join(scratchpadPath, "context.json")),
      decide("Write", join(workspace, "notes.md")),
      decide("Edit", join(workspace, "check.ts")),
      decide("Read", "/etc/passwd"),
    ]);
    // The role's inputs, handed to it by absolute path, are readable...
    expect(bundle).toBe("allow");
    expect(write).toBe("allow");
    // ...while the policy's deny globs and the workspace boundary still hold.
    expect(checkFile).toBe("deny");
    expect(system).toBe("deny");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

/**
 * Stand-in agent CLIs for AC-1. Each reads the hook configuration its real
 * counterpart would load, offers the same two shell calls to those hooks as
 * that CLI's pre-call event, and runs a call only when no hook blocks it. The
 * real CLIs' own behaviour is what the live check after release covers.
 */
const STUB_SHELL_CALLS = ["touch permitted.txt", "rm victim.txt"];

const STUB_HOST_COMMON = `
import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const calls = ${JSON.stringify(STUB_SHELL_CALLS)};
const runHook = (command, payload) =>
  spawnSync("sh", ["-c", command], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
const lastJson = (stdout) => {
  try {
    return JSON.parse(stdout.trim().split("\\n").at(-1) ?? "");
  } catch {
    return undefined;
  }
};
const offer = (blocked) => {
  for (const command of calls) {
    const denied = blocked(command);
    appendFileSync("host.log", \`\${command}: \${denied ? "blocked" : "ran"}\\n\`);
    if (!denied) spawnSync("sh", ["-c", command]);
  }
};
`;

const STUB_CLAUDE = `${STUB_HOST_COMMON}
const at = process.argv.indexOf("--settings");
const settings =
  at === -1 ? { hooks: {} } : JSON.parse(readFileSync(process.argv[at + 1], "utf8"));
appendFileSync("host.log", \`settings: \${at === -1 ? "none" : process.argv[at + 1]}\\n\`);
offer((command) =>
  (settings.hooks.PreToolUse ?? [])
    .filter((group) => group.matcher === undefined || new RegExp(\`^(?:\${group.matcher})$\`).test("Bash"))
    .flatMap((group) => group.hooks)
    .some((hook) => {
      const result = runHook(hook.command, {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      });
      // Claude Code blocks on exit 2 or a deny; any other exit is non-blocking.
      return (
        result.status === 2 ||
        (result.status === 0 &&
          lastJson(result.stdout)?.hookSpecificOutput?.permissionDecision === "deny")
      );
    }),
);
`;

const STUB_CURSOR = `${STUB_HOST_COMMON}
const workspace = process.argv[process.argv.indexOf("--workspace") + 1];
const config = JSON.parse(readFileSync(\`\${workspace}/.cursor/hooks.json\`, "utf8"));
offer((command) =>
  (config.hooks.beforeShellExecution ?? []).some((hook) => {
    const result = runHook(hook.command, {
      hook_event_name: "beforeShellExecution",
      command,
      cwd: workspace,
    });
    const permission = lastJson(result.stdout)?.permission;
    return permission === "deny" || permission === "ask";
  }),
);
`;

test("one policy blocks the denied call and runs the permitted one on cursor and claude (AC-1)", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ac1-"));
  try {
    const agentsDir = join(root, "agents");
    const binDir = join(root, "bin");
    const harnessDir = join(agentsDir, "harnesses", "ac1");
    await mkdir(harnessDir, { recursive: true });
    await mkdir(join(agentsDir, "policies"), { recursive: true });
    await mkdir(binDir, { recursive: true });
    const shebang = `#!${process.execPath}\n`;
    await writeFile(join(binDir, "claude"), shebang + STUB_CLAUDE, {
      mode: 0o755,
    });
    await writeFile(join(binDir, "agent"), shebang + STUB_CURSOR, {
      mode: 0o755,
    });
    // Cursor's generated hooks name a bare `agents`; this one is the repo's.
    await writeFile(
      join(binDir, "agents"),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(repoRoot, "packages", "cli", "src", "index.ts"))} "$@"\n`,
      { mode: 0o755 },
    );
    await writeFile(
      join(agentsDir, "policies", "ac1.yaml"),
      [
        "id: ac1",
        "description: allows touch, denies rm",
        "capabilities:",
        "  exec:",
        '    allow: ["touch"]',
        '    deny: ["rm"]',
        "",
      ].join("\n"),
    );
    // One harness.yaml, unmodified between the two runs (AC-3).
    const harnessYaml = [
      'spec_version: "0.2"',
      "kind: harness",
      "harness:",
      "  id: ac1",
      "policy: ac1",
      "roles:",
      "  solo:",
      "    description: offers one permitted and one denied shell call",
      "    prompt: |",
      "      noop",
      "",
    ].join("\n");
    await writeFile(join(harnessDir, "harness.yaml"), harnessYaml);

    const runOn = async (adapter: "cursor" | "claude") => {
      const workspace = join(root, adapter);
      await mkdir(workspace);
      await writeFile(join(workspace, "victim.txt"), "keep me");
      // The stubs must win the PATH lookup, or the real CLIs would run.
      const proc = Bun.spawn({
        cmd: [
          "bun",
          "run",
          join(repoRoot, "packages", "cli", "src", "index.ts"),
          "harness",
          "run",
          "ac1",
          "--agents-dir",
          agentsDir,
          "--workspace",
          workspace,
          "--adapter",
          adapter,
        ],
        cwd: repoRoot,
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const cli = { stdout, stderr };
      const log = await Bun.file(join(workspace, "host.log"))
        .text()
        .catch(() => "");
      return {
        cli,
        log,
        permitted: await Bun.file(join(workspace, "permitted.txt")).exists(),
        victim: await Bun.file(join(workspace, "victim.txt")).exists(),
      };
    };
    const [cursor, claude] = await Promise.all([
      runOn("cursor"),
      runOn("claude"),
    ]);

    for (const run of [cursor, claude]) {
      // Neither run is refused, and neither needed --allow-unenforced-policy.
      expect(run.cli.stderr).not.toContain("cannot enforce it");
      expect(run.cli.stderr).not.toContain("failed its probe");
      expect(run.cli.stderr).toContain('enforced under policy "ac1"');
      // The permitted call ran; the denied one was offered and blocked.
      expect(run.log).toContain("touch permitted.txt: ran");
      expect(run.log).toContain("rm victim.txt: blocked");
      expect(run.permitted).toBe(true);
      expect(run.victim).toBe(true);
    }
    // On Claude the policy arrived as run-scoped --settings in the scratchpad.
    expect(claude.log).toMatch(
      /settings: .*\/\.agents-harness\/runs\/[^/]+\/claude-settings\.json/,
    );
    expect(await Bun.file(join(harnessDir, "harness.yaml")).text()).toBe(
      harnessYaml,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  // Two CLI runs, each spawning the bridge per offered call.
}, 60_000);

test("declaring run_end / run_start / role_start warns rather than failing (ADR 0024)", async () => {
  const { setUpHookEnforcement } = await import(
    "../packages/cli/src/harness-run-main"
  );
  const workspace = await mkdtemp(join(tmpdir(), "harness-lifecycle-warn-"));
  const agentsDir = await mkdtemp(join(tmpdir(), "harness-lifecycle-agents-"));
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const harnessDir = join(agentsDir, "harnesses", "lifecycle-warn");
    await mkdir(harnessDir, { recursive: true });
    await writeFile(
      join(harnessDir, "harness.yaml"),
      [
        'spec_version: "0.2"',
        "kind: harness",
        "harness:",
        "  id: lifecycle-warn",
        "roles:",
        "  solo:",
        "    description: noop role for lifecycle warning coverage",
        "    prompt: |",
        "      noop",
        "hooks:",
        "  role_start:",
        "    - command: echo role_start",
        "  run_start:",
        "    - command: echo run_start",
        "  run_end:",
        "    - command: echo run_end",
        "  role_stop:",
        "    - command: echo role_stop",
        "",
      ].join("\n"),
    );
    const { loadHarness } = await import("@aguil/agents-harness-config");
    const loaded = await loadHarness({
      agentsDir,
      harnessId: "lifecycle-warn",
    });
    const enforcement = await setUpHookEnforcement(loaded, {
      adapter: "cursor",
      agentsDir,
      workspace,
      scratchpadPath: workspace,
      allowUnenforcedPolicy: false,
    });
    expect("error" in enforcement).toBe(false);
    const joined = warnings.join("\n");
    expect(joined).toContain("hooks.role_start:");
    expect(joined).toContain("hooks.run_start:");
    expect(joined).toContain("hooks.run_end:");
    expect(joined).toContain("ADR 0024");
    // Still generates mapped events — warning does not refuse the run.
    const hooksPath = join(workspace, ".cursor", "hooks.json");
    const rendered = await Bun.file(hooksPath).text();
    expect(rendered).toContain("echo role_stop");
    expect(rendered).toContain('"stop"');
  } finally {
    console.warn = originalWarn;
    await rm(workspace, { recursive: true, force: true });
    await rm(agentsDir, { recursive: true, force: true });
  }
});

/**
 * Run a one-role harness through the CLI with the given `hooks:` / extra YAML
 * lines, and return the CLI output plus the persisted run result. `cursor` and
 * `claude` resolve to stub executables that exit 0, so their real generators
 * run without a real agent CLI.
 */
async function runLifecycleHarness(options: {
  readonly adapter: "cursor" | "claude" | "fake";
  readonly yaml: readonly string[];
}): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly result: {
    readonly status: string;
    readonly metadata: Record<string, string>;
  };
}> {
  const root = await mkdtemp(join(tmpdir(), "harness-undeliverable-"));
  try {
    const workspace = join(root, "workspace");
    const agentsDir = join(root, "agents");
    const binDir = join(root, "bin");
    const harnessDir = join(agentsDir, "harnesses", "lifecycle-record");
    await mkdir(workspace, { recursive: true });
    await mkdir(harnessDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    for (const name of ["agent", "claude"]) {
      await writeFile(join(binDir, name), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
    }
    await writeFile(
      join(harnessDir, "harness.yaml"),
      [
        'spec_version: "0.2"',
        "kind: harness",
        "harness:",
        "  id: lifecycle-record",
        "roles:",
        "  solo:",
        "    description: noop role for undeliverable-hook record coverage",
        "    prompt: |",
        "      noop",
        ...options.yaml,
        "",
      ].join("\n"),
    );
    const cli = await runHarnessCli(
      [
        "lifecycle-record",
        "--agents-dir",
        agentsDir,
        "--workspace",
        workspace,
        "--adapter",
        options.adapter,
      ],
      { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );
    const artifacts = /^artifacts: (.+)$/m.exec(cli.stdout)?.[1];
    if (artifacts === undefined) {
      throw new Error(`no artifacts line:\n${cli.stdout}\n${cli.stderr}`);
    }
    const result = await Bun.file(join(artifacts, "result.raw.json")).json();
    return { ...cli, result };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Events named by the ADR 0024 setup warnings, in the order printed. */
function warnedLifecycleEvents(stderr: string): string[] {
  return [
    ...stderr.matchAll(/hooks\.(\w+): declared handler cannot fire/g),
  ].map((match) => match[1] ?? "");
}

const ALL_LIFECYCLE_HOOKS = [
  "hooks:",
  "  role_start:",
  "    - command: echo role_start",
  "  role_stop:",
  "    - command: echo role_stop",
  "  run_start:",
  "    - command: echo run_start",
  "  run_end:",
  "    - command: echo run_end",
] as const;

test("a declared run_end is recorded in the run result as undeliverable (ADR 0024)", async () => {
  const run = await runLifecycleHarness({
    adapter: "fake",
    yaml: ["hooks:", "  run_end:", "    - command: echo run_end"],
  });
  expect(run.exitCode).toBe(0);
  expect(run.result.metadata.undeliverable_hooks).toBe("run_end");
});

test("a declared role_start is recorded only where the adapter cannot map it (ADR 0024)", async () => {
  const yaml = ["hooks:", "  role_start:", "    - command: echo role_start"];
  const cursor = await runLifecycleHarness({ adapter: "cursor", yaml });
  expect(cursor.result.metadata.undeliverable_hooks).toBe("role_start");
  // Claude maps SessionStart onto role_start, so nothing is undeliverable.
  const claude = await runLifecycleHarness({ adapter: "claude", yaml });
  expect(claude.result.metadata).not.toHaveProperty("undeliverable_hooks");
});

test("a declared role_stop is recorded only where no generator maps it", async () => {
  const yaml = ["hooks:", "  role_stop:", "    - command: echo role_stop"];
  // fake has no hook generator, so role_stop cannot fire there.
  const fake = await runLifecycleHarness({ adapter: "fake", yaml });
  expect(fake.result.metadata.undeliverable_hooks).toBe("role_stop");
  expect(warnedLifecycleEvents(fake.stderr)).toEqual(["role_stop"]);
  // Cursor maps it to `stop`, Claude to `Stop`.
  for (const adapter of ["cursor", "claude"] as const) {
    const run = await runLifecycleHarness({ adapter, yaml });
    expect(run.result.metadata).not.toHaveProperty("undeliverable_hooks");
  }
});

test("a harness declaring no lifecycle handlers records none and passes (ADR 0024)", async () => {
  const run = await runLifecycleHarness({
    adapter: "fake",
    yaml: [],
  });
  expect(run.exitCode).toBe(0);
  expect(run.result.status).toBe("passed");
  expect(run.result.metadata.undeliverable_hooks ?? "").toBe("");
  expect(warnedLifecycleEvents(run.stderr)).toEqual([]);
});

test("the undeliverable-hooks record names the same events as the setup warning (ADR 0024)", async () => {
  for (const adapter of ["cursor", "claude", "fake"] as const) {
    const run = await runLifecycleHarness({
      adapter,
      yaml: ALL_LIFECYCLE_HOOKS,
    });
    const recorded = (run.result.metadata.undeliverable_hooks ?? "")
      .split(",")
      .filter((event) => event !== "");
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded).toEqual(warnedLifecycleEvents(run.stderr));
  }
});

test("recording undeliverable hooks never changes run status (ADR 0021 / ADR 0024)", async () => {
  // One passing and one gate-failed run, each with and without declarations.
  const failingGate = [
    "execution:",
    "  mode: chain",
    "  order: [solo]",
    '  pass_check: ["false"]',
  ];
  const statuses: string[] = [];
  for (const extra of [[], failingGate]) {
    const plain = await runLifecycleHarness({ adapter: "fake", yaml: extra });
    statuses.push(plain.result.status);
    const declared = await runLifecycleHarness({
      adapter: "fake",
      yaml: [...extra, ...ALL_LIFECYCLE_HOOKS],
    });
    expect(declared.result.metadata.undeliverable_hooks).toBe(
      "role_start,role_stop,run_start,run_end",
    );
    expect(declared.result.status).toBe(plain.result.status);
    expect(declared.exitCode).toBe(plain.exitCode);
    expect(/^status: .+$/m.exec(declared.stdout)?.[0]).toBe(
      /^status: .+$/m.exec(plain.stdout)?.[0],
    );
  }
  expect(statuses).toEqual(["passed", "failed"]);
});

test("enforcement provides per-role env in every mode; hooks file is role-invariant (ADR 0008)", async () => {
  const { loadHarness } = await import("@aguil/agents-harness-config");
  const { setUpHookEnforcement, POLICY_NONE_TOKEN } = await import(
    "../packages/cli/src/harness-run-main"
  );
  const loaded = await loadHarness({
    agentsDir: join(repoRoot, "examples", "incident-triage", ".agents"),
    harnessId: "incident-triage",
  });
  const workspace = await mkdtemp(join(tmpdir(), "harness-env-"));
  try {
    const enforcement = await setUpHookEnforcement(loaded, {
      adapter: "cursor",
      agentsDir: join(repoRoot, "examples", "incident-triage", ".agents"),
      workspace,
      scratchpadPath: workspace,
      allowUnenforcedPolicy: false,
    });
    if ("error" in enforcement) {
      throw new Error(enforcement.error);
    }
    // Per-role policy identity travels via env, not the hooks file.
    expect(enforcement.roleEnv?.("fix")?.AGENTS_POLICY_ID).toBe("triage-fix");
    expect(enforcement.roleEnv?.("scout")?.AGENTS_POLICY_ID).toBe(
      "triage-readonly",
    );
    expect(enforcement.roleEnv?.("scout")?.AGENTS_AGENTS_DIR).toContain(
      ".agents",
    );
    // incident-triage declares a harness-level default, so a role absent
    // from rolePolicies inherits it rather than the @none token.
    expect(enforcement.roleEnv?.("not-a-role")?.AGENTS_POLICY_ID).toBe(
      "triage-readonly",
    );
    expect(POLICY_NONE_TOKEN).toBe("@none");

    // The generated hooks file embeds no policy id and is byte-identical
    // regardless of which role runs next (onRoleStart rewrites are
    // idempotent tamper repair).
    const hooksPath = join(workspace, ".cursor", "hooks.json");
    const before = await Bun.file(hooksPath).text();
    expect(before).toContain("policy-eval");
    expect(before).not.toContain("triage-fix");
    expect(before).not.toContain("triage-readonly");
    expect(before).not.toContain("--policy");
    await enforcement.onRoleStart?.("fix");
    const afterFix = await Bun.file(hooksPath).text();
    expect(afterFix).toBe(before);
    await enforcement.onRoleStart?.("scout");
    expect(await Bun.file(hooksPath).text()).toBe(before);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a role tampering with hooks.json cannot weaken the next role's enforcement", async () => {
  const { loadHarness } = await import("@aguil/agents-harness-config");
  const { setUpHookEnforcement } = await import(
    "../packages/cli/src/harness-run-main"
  );
  const loaded = await loadHarness({
    agentsDir: join(repoRoot, "examples", "incident-triage", ".agents"),
    harnessId: "incident-triage",
  });
  const workspace = await mkdtemp(join(tmpdir(), "harness-tamper-"));
  try {
    const enforcement = await setUpHookEnforcement(loaded, {
      adapter: "cursor",
      agentsDir: join(repoRoot, "examples", "incident-triage", ".agents"),
      workspace,
      scratchpadPath: workspace,
      allowUnenforcedPolicy: false,
    });
    if ("error" in enforcement) {
      throw new Error(enforcement.error);
    }
    const hooksPath = join(workspace, ".cursor", "hooks.json");
    const canonical = await Bun.file(hooksPath).text();
    // Simulate a role stripping the policy bridge mid-run.
    await Bun.write(hooksPath, '{"version":1,"hooks":{}}\n');
    // The next role start must restore canonical enforcement.
    await enforcement.onRoleStart?.("verify");
    expect(await Bun.file(hooksPath).text()).toBe(canonical);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("concurrent runs sharing a workspace converge on identical enforcement bytes", async () => {
  const { loadHarness } = await import("@aguil/agents-harness-config");
  const { setUpHookEnforcement } = await import(
    "../packages/cli/src/harness-run-main"
  );
  const loaded = await loadHarness({
    agentsDir: join(repoRoot, "examples", "incident-triage", ".agents"),
    harnessId: "incident-triage",
  });
  const workspace = await mkdtemp(join(tmpdir(), "harness-concurrent-"));
  try {
    const args = {
      adapter: "cursor" as const,
      agentsDir: join(repoRoot, "examples", "incident-triage", ".agents"),
      workspace,
      scratchpadPath: workspace,
      allowUnenforcedPolicy: false,
    };
    const [a, b] = await Promise.all([
      setUpHookEnforcement(loaded, args),
      setUpHookEnforcement(loaded, args),
    ]);
    if ("error" in a || "error" in b) {
      throw new Error("enforcement setup failed");
    }
    const hooksPath = join(workspace, ".cursor", "hooks.json");
    const settled = await Bun.file(hooksPath).text();
    // Interleave role starts from both "runs" — every write is the same
    // bytes, so ordering is irrelevant and no run can weaken the other.
    await Promise.all([
      a.onRoleStart?.("fix"),
      b.onRoleStart?.("scout"),
      a.onRoleStart?.("verify"),
    ]);
    expect(await Bun.file(hooksPath).text()).toBe(settled);
    // Policy divergence between the runs lives in env, never in the file.
    expect(a.roleEnv?.("fix")?.AGENTS_POLICY_ID).toBe("triage-fix");
    expect(b.roleEnv?.("scout")?.AGENTS_POLICY_ID).toBe("triage-readonly");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("roleEffectivePolicyId resolves role override over harness default", async () => {
  const { loadHarness } = await import("@aguil/agents-harness-config");
  const { roleEffectivePolicyId } = await import(
    "../packages/cli/src/harness-run-main"
  );
  const loaded = await loadHarness({
    agentsDir: join(repoRoot, "examples", "incident-triage", ".agents"),
    harnessId: "incident-triage",
  });
  expect(roleEffectivePolicyId(loaded, "fix")).toBe("triage-fix");
  expect(roleEffectivePolicyId(loaded, "scout")).toBe("triage-readonly");
  expect(roleEffectivePolicyId(loaded, "verify")).toBe("triage-readonly");
});

test("declared context providers collect the bundle for the run", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "harness-ctx-"));
  const agentsDir = await mkdtemp(join(tmpdir(), "harness-ctx-agents-"));
  try {
    await cp(
      join(repoRoot, "examples", "incident-triage", "fixture"),
      workspace,
      { recursive: true },
    );
    const { mkdir: mkdirP, writeFile: writeFileP } = await import(
      "node:fs/promises"
    );
    const dir = join(agentsDir, "harnesses", "ctx-demo");
    await mkdirP(dir, { recursive: true });
    await writeFileP(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.2"',
        "kind: harness",
        "harness: { id: ctx-demo }",
        "context:",
        "  providers:",
        "    - use: static-file",
        "      id: alert",
        "      path: alert.log",
        "roles:",
        "  a:",
        "    description: A",
        '    prompt: "inspect the alert"',
        "execution: { mode: chain, order: [a] }",
      ].join("\n"),
    );
    const result = await runHarnessCli([
      "ctx-demo",
      "--agents-dir",
      agentsDir,
      "--workspace",
      workspace,
      "--adapter",
      "fake",
    ]);
    expect(result.stdout).toContain("execution: chain");
    // The declared static-file provider produced the bundle: it is written
    // under context/ and contains the alert artifact.
    const runsDir = join(workspace, ".agents-harness", "runs");
    const { readdir: readdirP, readFile: readFileP } = await import(
      "node:fs/promises"
    );
    const [runDir] = await readdirP(runsDir);
    const bundleRaw = await readFileP(
      join(runsDir, runDir, "context", "bundle.json"),
      "utf8",
    );
    const bundle = JSON.parse(bundleRaw) as {
      artifacts: Array<{ id: string; content: string }>;
    };
    expect(bundle.artifacts.some((artifact) => artifact.id === "alert")).toBe(
      true,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(agentsDir, { recursive: true, force: true });
  }
});

test("knowledge providers collect auto and search notes into the run bundle", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "harness-knowledge-"));
  const agentsDir = await mkdtemp(join(tmpdir(), "harness-knowledge-agents-"));
  try {
    const {
      mkdir: mkdirP,
      writeFile: writeFileP,
      cp: cpP,
    } = await import("node:fs/promises");
    await cpP(
      join(
        repoRoot,
        "examples",
        "incident-triage",
        "fixture",
        ".agents",
        "knowledge",
      ),
      join(workspace, ".agents", "knowledge"),
      { recursive: true },
    );
    // Knowledge providers resolve the store under the workspace; point the
    // agents dir at a harness that declares both providers (ADR 0022).
    const dir = join(agentsDir, "harnesses", "knowledge-demo");
    await mkdirP(dir, { recursive: true });
    await writeFileP(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.2"',
        "kind: harness",
        "harness: { id: knowledge-demo }",
        "context:",
        "  providers:",
        "    - use: knowledge",
        "    - use: knowledge-search",
        "      tags: [incident, pagination]",
        "      limit: 5",
        "roles:",
        "  a:",
        "    description: A",
        '    prompt: "use the injected knowledge"',
        "execution: { mode: chain, order: [a] }",
      ].join("\n"),
    );
    const result = await runHarnessCli([
      "knowledge-demo",
      "--agents-dir",
      agentsDir,
      "--workspace",
      workspace,
      "--adapter",
      "fake",
    ]);
    expect(result.stdout).toContain("execution: chain");
    const runsDir = join(workspace, ".agents-harness", "runs");
    const { readdir: readdirP, readFile: readFileP } = await import(
      "node:fs/promises"
    );
    const [runDir] = await readdirP(runsDir);
    const bundle = JSON.parse(
      await readFileP(join(runsDir, runDir, "context", "bundle.json"), "utf8"),
    ) as { artifacts: Array<{ id: string }> };
    const ids = bundle.artifacts.map((artifact) => artifact.id);
    expect(ids).toContain("knowledge:pagination-off-by-one");
    expect(ids).toContain("knowledge-search:support-desk-missing-last-row");
    expect(ids).toContain("knowledge-search:pagination-off-by-one");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(agentsDir, { recursive: true, force: true });
  }
});

test("context collection failures use the controlled error surface", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "harness-ctx-fail-"));
  const agentsDir = await mkdtemp(join(tmpdir(), "harness-ctx-fail-agents-"));
  try {
    const { mkdir: mkdirP, writeFile: writeFileP } = await import(
      "node:fs/promises"
    );
    const dir = join(agentsDir, "harnesses", "ctx-fail");
    await mkdirP(dir, { recursive: true });
    await writeFileP(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.2"',
        "kind: harness",
        "harness: { id: ctx-fail }",
        "context:",
        "  providers:",
        "    - use: static-file",
        "      id: gone",
        "      path: no-such-file.txt",
        "      required: true",
        "roles:",
        "  a:",
        "    description: A",
        '    prompt: "p"',
      ].join("\n"),
    );
    const result = await runHarnessCli([
      "ctx-fail",
      "--agents-dir",
      agentsDir,
      "--workspace",
      workspace,
      "--adapter",
      "fake",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("context collection failed");
    // Controlled surface, not a bare stack trace.
    expect(result.stderr).not.toContain("    at ");
    expect(result.stdout).not.toContain("roles completed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(agentsDir, { recursive: true, force: true });
  }
});

test("unknown context provider names abort before any role runs", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "harness-ctx-bad-"));
  const agentsDir = await mkdtemp(join(tmpdir(), "harness-ctx-bad-agents-"));
  try {
    const { mkdir: mkdirP, writeFile: writeFileP } = await import(
      "node:fs/promises"
    );
    const dir = join(agentsDir, "harnesses", "ctx-bad");
    await mkdirP(dir, { recursive: true });
    await writeFileP(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.2"',
        "kind: harness",
        "harness: { id: ctx-bad }",
        "context:",
        "  providers:",
        "    - use: carrier-pigeon",
        "roles:",
        "  a:",
        "    description: A",
        '    prompt: "p"',
      ].join("\n"),
    );
    const result = await runHarnessCli([
      "ctx-bad",
      "--agents-dir",
      agentsDir,
      "--workspace",
      workspace,
      "--adapter",
      "fake",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("carrier-pigeon");
    expect(result.stdout).not.toContain("roles completed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(agentsDir, { recursive: true, force: true });
  }
});

test("enablement expressions gate roles on the collected triage tier", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "harness-enable-"));
  const agentsDir = await mkdtemp(join(tmpdir(), "harness-enable-agents-"));
  try {
    const { mkdir: mkdirP, writeFile: writeFileP } = await import(
      "node:fs/promises"
    );
    const dir = join(agentsDir, "harnesses", "gated");
    await mkdirP(dir, { recursive: true });
    await writeFileP(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.2"',
        "kind: harness",
        "harness: { id: gated }",
        "context:",
        "  providers:",
        "    - use: shell-command",
        "      id: triage",
        '      cmd: ["echo", "lite"]',
        "roles:",
        "  quality:",
        "    description: Always runs",
        '    prompt: "q"',
        "  performance:",
        "    description: Full tier only",
        '    prompt: "p"',
        '    enabled: tier == "full"',
        "  security:",
        "    description: Non-trivial tiers",
        '    prompt: "s"',
        '    enabled: tier != "trivial"',
        "execution: { mode: chain, order: [security, performance, quality] }",
      ].join("\n"),
    );
    const result = await runHarnessCli([
      "gated",
      "--agents-dir",
      agentsDir,
      "--workspace",
      workspace,
      "--adapter",
      "fake",
    ]);
    // tier=lite: performance is gated out, chain order keeps the rest.
    expect(result.stderr).toContain(
      "roles disabled by enablement expressions: performance",
    );
    expect(result.stdout).toContain("roles completed: security,quality");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(agentsDir, { recursive: true, force: true });
  }
});

test("enablement referencing an unavailable binding aborts fail-closed", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "harness-enable-bad-"));
  const agentsDir = await mkdtemp(join(tmpdir(), "harness-enable-bad-agents-"));
  try {
    const { mkdir: mkdirP, writeFile: writeFileP } = await import(
      "node:fs/promises"
    );
    const dir = join(agentsDir, "harnesses", "ungated");
    await mkdirP(dir, { recursive: true });
    // No context providers => no triage artifact => no tier binding.
    await writeFileP(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.2"',
        "kind: harness",
        "harness: { id: ungated }",
        "roles:",
        "  a:",
        "    description: Gated on a binding nothing provides",
        '    prompt: "p"',
        '    enabled: tier == "full"',
        "  b:",
        "    description: Ungated",
        '    prompt: "p"',
      ].join("\n"),
    );
    const result = await runHarnessCli([
      "ungated",
      "--agents-dir",
      agentsDir,
      "--workspace",
      workspace,
      "--adapter",
      "fake",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("role enablement failed");
    expect(result.stdout).not.toContain("roles completed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(agentsDir, { recursive: true, force: true });
  }
});

test("declared reporting template renders report.md into the scratchpad", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "harness-report-"));
  const agentsDir = await mkdtemp(join(tmpdir(), "harness-report-agents-"));
  try {
    const {
      mkdir: mkdirP,
      writeFile: writeFileP,
      readFile: readFileP,
      readdir: readdirP,
    } = await import("node:fs/promises");
    const dir = join(agentsDir, "harnesses", "reported");
    await mkdirP(dir, { recursive: true });
    await writeFileP(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.2"',
        "kind: harness",
        "harness: { id: reported }",
        "reporting:",
        "  template: builtin:outcomes-markdown",
        "roles:",
        "  a:",
        "    description: A",
        '    prompt: "p"',
        "execution: { mode: chain, order: [a] }",
      ].join("\n"),
    );
    const result = await runHarnessCli([
      "reported",
      "--agents-dir",
      agentsDir,
      "--workspace",
      workspace,
      "--adapter",
      "fake",
    ]);
    expect(result.stdout).toContain("report: ");
    const runsDir = join(workspace, ".agents-harness", "runs");
    const [runDir] = await readdirP(runsDir);
    const report = await readFileP(join(runsDir, runDir, "report.md"), "utf8");
    expect(report).toContain("# Harness Report");
    expect(report.endsWith("\n")).toBe(true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(agentsDir, { recursive: true, force: true });
  }
});

test("status is recomputed against pipelined findings, not raw ones", async () => {
  const { markUnsubstantiatedFindings, statusAfterFindingPipelines } =
    await import("@aguil/agents-reporting");

  const critical = markUnsubstantiatedFindings([
    {
      id: "f1",
      severity: "critical",
      title: "T",
      description: "D",
      evidence: "E",
      sourceRole: "quality",
      validation: { status: "verified", details: "Looked at it." },
    },
  ]);
  const compose = (
    rawStatus: "passed" | "warnings" | "failed" | "error",
    overrides: { findingsBlind?: boolean; timedOut?: boolean } = {},
  ) =>
    statusAfterFindingPipelines({
      rawStatus,
      findings: critical,
      findingsBlind: overrides.findingsBlind ?? false,
      timedOut: overrides.timedOut ?? false,
    });

  // The orchestrator judged the raw finding and said "failed"; once the
  // pipeline marks it unsubstantiated the run must not fail on it, or the exit
  // code contradicts the report sitting beside it.
  expect(compose("failed")).toBe("passed");

  // Things a pipeline has no business overturning.
  expect(compose("error")).toBe("error");
  expect(compose("passed", { timedOut: true })).toBe("warnings");
  // A gate-owned harness (`findingsBlind`) keeps a failed pass_check /
  // role outcome regardless of what the pipeline decided (ADR 0021 / #157).
  expect(compose("failed", { findingsBlind: true })).toBe("failed");
});

test("harness run surfaces loader errors with a nonzero exit", async () => {
  const result = await runHarnessCli([
    "no-such-harness",
    "--agents-dir",
    join(repoRoot, "examples", "incident-triage", ".agents"),
    "--workspace",
    "/tmp",
    "--adapter",
    "fake",
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('harness "no-such-harness" not readable');
});

test("harness run reports plan conformance like agents code-review", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "harness-conformance-"));
  const agentsDir = await mkdtemp(
    join(tmpdir(), "harness-conformance-agents-"),
  );
  try {
    const {
      mkdir: mkdirP,
      writeFile: writeFileP,
      readFile: readFileP,
      readdir: readdirP,
    } = await import("node:fs/promises");
    const dir = join(agentsDir, "harnesses", "planned");
    await mkdirP(dir, { recursive: true });
    await writeFileP(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.2"',
        "kind: harness",
        "harness: { id: planned }",
        "context:",
        "  providers:",
        "    - use: acceptance-criteria",
        "      path: criteria.json",
        "reporting:",
        "  template: builtin:code-review-markdown",
        "roles:",
        "  quality:",
        "    description: Q",
        '    prompt: "p"',
        "  conformance:",
        "    description: C",
        '    prompt: "p"',
        "    enabled: acceptance_criteria > 0",
      ].join("\n"),
    );
    const runsDir = join(workspace, ".agents-harness", "runs");
    const latestReport = async (): Promise<string> => {
      const runs = (await readdirP(runsDir)).sort();
      return await readFileP(
        join(runsDir, runs[runs.length - 1] ?? "", "report.md"),
        "utf8",
      );
    };
    const run = () =>
      runHarnessCli([
        "planned",
        "--agents-dir",
        agentsDir,
        "--workspace",
        workspace,
        "--adapter",
        "fake",
      ]);

    await run();
    expect(await latestReport()).toContain(
      "## Plan Conformance\n\nNot run: no acceptance criteria supplied",
    );

    await writeFileP(
      join(workspace, "criteria.json"),
      JSON.stringify({
        version: 1,
        criteria: [{ id: "AC-1", statement: "Holds." }],
      }),
    );
    // Run ids sort by a random suffix within the same second, so clear the
    // first run rather than relying on "latest" ordering.
    await rm(runsDir, { recursive: true, force: true });
    const scheduled = await run();
    expect(scheduled.stdout).toContain("conformance");
    const report = await latestReport();
    // The fake agent reports nothing, so the row is listed, not dropped.
    expect(report).toContain("1 criterion: 0 satisfied");
    expect(report).toContain("- ❔ **AC-1**: no result.");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(agentsDir, { recursive: true, force: true });
  }
});

test("harness run leaves an unrelated conformance role alone", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "harness-own-conformance-"));
  const agentsDir = await mkdtemp(join(tmpdir(), "harness-own-conformance-a-"));
  try {
    const { mkdir: mkdirP, writeFile: writeFileP } = await import(
      "node:fs/promises"
    );
    const dir = join(agentsDir, "harnesses", "own");
    await mkdirP(dir, { recursive: true });
    // A role named `conformance`, but no acceptance-criteria provider.
    await writeFileP(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.2"',
        "kind: harness",
        "harness: { id: own }",
        "roles:",
        "  conformance:",
        "    description: C",
        '    prompt: "p"',
      ].join("\n"),
    );
    const result = await runHarnessCli([
      "own",
      "--agents-dir",
      agentsDir,
      "--workspace",
      workspace,
      "--adapter",
      "fake",
    ]);
    expect(result.stdout).toContain("roles completed: conformance");
    expect(result.stdout).not.toContain("roles failed");

    // The fake agent emits nothing, so check the validator directly with a
    // conformance outcome that is not a code-review verdict.
    const { roleOutcomeValidator } = await import(
      "../packages/cli/src/harness-run-main"
    );
    const ownOutcome = {
      id: "own-1",
      kind: "conformance",
      sourceRole: "conformance",
      title: "Own shape",
      data: { score: 3 },
    };
    expect(
      roleOutcomeValidator({ contextProviders: [], outputSchemas: undefined })({
        roleId: "conformance",
        outcomes: [ownOutcome],
      }),
    ).toEqual([]);
    expect(
      roleOutcomeValidator({
        contextProviders: [{ use: "acceptance-criteria", params: {} }],
        outputSchemas: undefined,
      })({ roleId: "conformance", outcomes: [ownOutcome] }),
    ).toHaveLength(1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(agentsDir, { recursive: true, force: true });
  }
});
