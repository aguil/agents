import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const EMPTY_RUN_WARNING =
  "harness run: the chain run passed with no outcomes and no findings.";

/**
 * Runs a two-role chain harness, `draft` then `report`. With `opencode`, a
 * stub CLI prints the line after `EMIT ` in each role's prompt; with `fake`,
 * roles emit nothing and write nothing.
 */
async function runChain(options: {
  readonly adapter: "fake" | "opencode";
  readonly passCheck?: readonly string[];
  readonly reportExists?: boolean;
  readonly emit?: string;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const root = await mkdtemp(join(tmpdir(), "harness-deliverable-"));
  try {
    const workspace = join(root, "workspace");
    const agentsDir = join(root, "agents");
    const binDir = join(root, "bin");
    const harnessDir = join(agentsDir, "harnesses", "deliverable");
    await mkdir(join(workspace, "reports"), { recursive: true });
    await mkdir(harnessDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    if (options.reportExists === true) {
      await writeFile(join(workspace, "reports", "out.md"), "# Report\n");
    }
    await writeFile(
      join(binDir, "opencode"),
      [
        `#!${process.execPath}`,
        "const prompt = process.argv.at(-1) ?? '';",
        "const emit = /^EMIT (.+)$/m.exec(prompt);",
        "if (emit) console.log(emit[1]);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const prompt =
      options.emit === undefined ? "Write the report." : `EMIT ${options.emit}`;
    await writeFile(
      join(harnessDir, "harness.yaml"),
      [
        'spec_version: "0.2"',
        "kind: harness",
        "harness:",
        "  id: deliverable",
        "roles:",
        "  draft:",
        "    description: drafts",
        "    prompt: |",
        "      Draft the report.",
        "  report:",
        "    description: writes reports/out.md",
        "    prompt: |",
        `      ${prompt}`,
        "execution:",
        "  mode: chain",
        "  order: [draft, report]",
        ...(options.passCheck === undefined
          ? []
          : [`  pass_check: ${JSON.stringify(options.passCheck)}`]),
        "",
      ].join("\n"),
    );
    const proc = Bun.spawn({
      cmd: [
        "bun",
        "run",
        join(repoRoot, "packages", "cli", "src", "index.ts"),
        "harness",
        "run",
        "deliverable",
        "--agents-dir",
        agentsDir,
        "--workspace",
        workspace,
        "--adapter",
        options.adapter,
      ],
      cwd: repoRoot,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// The pattern packages/harness-config/README.md documents.
const DOCUMENTED_PASS_CHECK = ["test", "-e", "reports/out.md"];

test("a chain run whose report role writes nothing fails the documented pass_check (#238 item 1)", async () => {
  const run = await runChain({
    adapter: "fake",
    passCheck: DOCUMENTED_PASS_CHECK,
  });
  expect(run.stdout).toContain("status: failed");
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain(
    'pass_check "test -e reports/out.md" exited 1; run FAILED',
  );
});

test("the documented pass_check passes once the deliverable exists", async () => {
  const run = await runChain({
    adapter: "fake",
    passCheck: DOCUMENTED_PASS_CHECK,
    reportExists: true,
  });
  expect(run.stdout).toContain("status: passed");
  expect(run.exitCode).toBe(0);
});

test("a chain run that passes having emitted nothing prints the warning (JC-4)", async () => {
  const run = await runChain({ adapter: "fake" });
  expect(run.stdout).toContain("status: passed");
  expect(run.exitCode).toBe(0);
  expect(run.stderr).toContain(EMPTY_RUN_WARNING);
  expect(run.stderr).toContain('["test", "-e", "<path>"]');
});

test("a chain run that emits an outcome prints no empty-run warning", async () => {
  const run = await runChain({
    adapter: "opencode",
    emit: JSON.stringify({
      outcome: {
        id: "report",
        kind: "report",
        sourceRole: "report",
        title: "Report written",
        data: { path: "reports/out.md" },
      },
    }),
  });
  expect(run.stdout, run.stderr).toContain("status: passed");
  expect(run.stdout).toContain("- [report] report: Report written (report)");
  expect(run.stderr).not.toContain(EMPTY_RUN_WARNING);
});
