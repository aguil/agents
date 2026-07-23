import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function runAgentsCli(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
  stdin?: string,
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
    ...(stdin === undefined ? {} : { stdin: new TextEncoder().encode(stdin) }),
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

test("--impl is rejected (removed)", async () => {
  const result = await runCodeReviewCli([
    "--impl",
    "config",
    "--adapter",
    "fake",
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("--impl was removed");
});

test("AGENTS_CODE_REVIEW_IMPL is rejected (removed)", async () => {
  const result = await runCodeReviewCli(["--adapter", "fake", "--dry-run"], {
    AGENTS_CODE_REVIEW_IMPL: "config",
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("AGENTS_CODE_REVIEW_IMPL was removed");
});

test("--consensus > 1 is rejected (ADR 0012)", async () => {
  const result = await runCodeReviewCli([
    "--consensus",
    "2",
    "--adapter",
    "fake",
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("ADR 0012");
});

test("code-review dispatches to the config-declared harness", async () => {
  const result = await runCodeReviewCli([
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

test("harness install prompts before overwriting an existing code-review harness", async () => {
  const dest = await mkdtemp(join(tmpdir(), "agents-harness-prompt-"));
  const harnessPath = join(dest, "harnesses", "code-review", "harness.yaml");
  try {
    const firstInstall = await runAgentsCli([
      "harness",
      "install",
      "code-review",
      "--dest",
      dest,
    ]);
    expect(firstInstall.exitCode).toBe(0);

    await writeFile(harnessPath, "custom harness\n", "utf8");
    const declined = await runAgentsCli(
      ["harness", "install", "code-review", "--dest", dest],
      {},
      "n\n",
    );
    expect(declined.exitCode).toBe(1);
    expect(declined.stderr).toContain("Overwrite?");
    expect(await readFile(harnessPath, "utf8")).toBe("custom harness\n");

    const accepted = await runAgentsCli(
      ["harness", "install", "code-review", "--dest", dest],
      {},
      "y\n",
    );
    expect(accepted.exitCode).toBe(0);
    expect(accepted.stderr).toContain("Overwrite?");
    expect(await readFile(harnessPath, "utf8")).toContain(
      "Config-declared code-review harness:",
    );
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});

test("harness install prompts before overwriting existing global manifest", async () => {
  const dest = await mkdtemp(join(tmpdir(), "agents-harness-manifest-"));
  const manifestPath = join(dest, "manifest.yaml");
  try {
    await writeFile(manifestPath, "custom manifest\n", "utf8");
    const declined = await runAgentsCli(
      ["harness", "install", "code-review", "--dest", dest],
      {},
      "n\n",
    );
    expect(declined.exitCode).toBe(1);
    expect(declined.stderr).toContain("Overwrite?");
    expect(await readFile(manifestPath, "utf8")).toBe("custom manifest\n");

    const accepted = await runAgentsCli(
      ["harness", "install", "code-review", "--dest", dest],
      {},
      "yes\n",
    );
    expect(accepted.exitCode).toBe(0);
    expect(await readFile(manifestPath, "utf8")).toContain("code-review");
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});
