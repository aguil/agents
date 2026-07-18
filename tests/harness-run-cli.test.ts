import { expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function runHarnessCli(
  args: readonly string[],
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
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
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
