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

test("harness run executes the incident-triage example chain with the fake adapter", async () => {
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
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("execution: chain");
    expect(result.stdout).toContain(
      "roles completed: scout,diagnose,fix,verify",
    );
    // Non-cursor adapters must loudly report missing hook enforcement.
    expect(result.stderr).toContain("WITHOUT generated hook enforcement");
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
