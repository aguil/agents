import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function runAgentsCli(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: [
      "bun",
      "run",
      join(repoRoot, "packages", "cli", "src", "index.ts"),
      ...args,
    ],
    cwd: repoRoot,
    env: { ...Bun.env, ...env },
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

async function runCodeReviewCli(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await runAgentsCli(["code-review", ...args], env);
}

const bundleFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "config-dispatch-bundle.json",
);

test("unknown --impl values are rejected", async () => {
  const result = await runCodeReviewCli([
    "--impl",
    "bogus",
    "--adapter",
    "fake",
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Invalid --impl value: bogus");
});

test("--impl config refuses consensus runs (ADR 0012)", async () => {
  const result = await runCodeReviewCli([
    "--impl",
    "config",
    "--consensus",
    "2",
    "--adapter",
    "fake",
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("ADR 0012");
});

test("--impl config dispatches to the config-declared harness", async () => {
  const result = await runCodeReviewCli([
    "--impl",
    "config",
    "--adapter",
    "fake",
    "--dry-run",
    "--log",
    "summary",
    "--workspace",
    repoRoot,
    "--context-bundle",
    bundleFixture,
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("(config-declared harness)");
  expect(result.stdout).toContain("Code review passed.");
});

test("AGENTS_CODE_REVIEW_IMPL=config selects the config path without flags", async () => {
  const result = await runCodeReviewCli(
    [
      "--adapter",
      "fake",
      "--dry-run",
      "--log",
      "summary",
      "--workspace",
      repoRoot,
      "--context-bundle",
      bundleFixture,
    ],
    { AGENTS_CODE_REVIEW_IMPL: "config" },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("(config-declared harness)");
});

test("harness install materializes code-review for explicit --agents-dir runs", async () => {
  const dest = await mkdtemp(join(tmpdir(), "agents-harness-install-"));
  const workspace = await mkdtemp(join(tmpdir(), "agents-harness-workspace-"));
  try {
    const install = await runAgentsCli([
      "harness",
      "install",
      "code-review",
      "--dest",
      dest,
    ]);
    expect(install.exitCode).toBe(0);
    expect(install.stdout).toContain("harness.yaml");
    expect(install.stdout).toContain(".agents-package-version");

    const result = await runCodeReviewCli([
      "--impl",
      "config",
      "--agents-dir",
      dest,
      "--adapter",
      "fake",
      "--dry-run",
      "--log",
      "summary",
      "--workspace",
      workspace,
      "--context-bundle",
      bundleFixture,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Config harness source: explicit");
    expect(result.stdout).toContain("Code review passed.");
  } finally {
    await rm(dest, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
