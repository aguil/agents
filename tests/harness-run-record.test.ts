import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "@aguil/agents-core";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Run {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly status: string;
  readonly events: readonly AgentEvent[];
}

/**
 * Runs `harness run --adapter opencode` against a stub `opencode` that prints
 * what its role's prompt asks for: `EMIT <base64 line>` prints the line, and
 * `EXIT <code>` exits with that code.
 */
async function runHarness(
  roles: Readonly<Record<string, string>>,
  extraArgs: readonly string[] = [],
): Promise<Run> {
  const root = await mkdtemp(join(tmpdir(), "harness-unaccepted-"));
  try {
    const workspace = join(root, "workspace");
    const agentsDir = join(root, "agents");
    const binDir = join(root, "bin");
    const harnessDir = join(agentsDir, "harnesses", "unaccepted");
    await mkdir(workspace, { recursive: true });
    await mkdir(harnessDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "opencode"),
      [
        `#!${process.execPath}`,
        "const prompt = process.argv.at(-1) ?? '';",
        "const emit = /^EMIT (\\S+)/m.exec(prompt);",
        "if (emit) console.log(Buffer.from(emit[1], 'base64').toString('utf8'));",
        "const exit = /^EXIT (\\d+)/m.exec(prompt);",
        "if (exit) process.exit(Number(exit[1]));",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    await writeFile(
      join(harnessDir, "harness.yaml"),
      [
        'spec_version: "0.2"',
        "kind: harness",
        "harness:",
        "  id: unaccepted",
        "output:",
        "  schemas:",
        "    claim:",
        "      data_required: [number, result]",
        "roles:",
        ...Object.entries(roles).flatMap(([role, prompt]) => [
          `  ${role}:`,
          `    description: ${role}`,
          "    prompt: |",
          `      ${prompt}`,
        ]),
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
        "unaccepted",
        "--agents-dir",
        agentsDir,
        "--workspace",
        workspace,
        "--adapter",
        "opencode",
        ...extraArgs,
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
    const artifacts = /^artifacts: (.+)$/m.exec(stdout)?.[1];
    if (artifacts === undefined) {
      throw new Error(`no artifacts line:\n${stdout}\n${stderr}`);
    }
    const events = (await Bun.file(join(artifacts, "events.jsonl")).text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AgentEvent);
    const status = /^status: (\S+)$/m.exec(stdout)?.[1] ?? "";
    return { stdout, stderr, exitCode, status, events };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function emitPrompt(line: string): string {
  return `EMIT ${Buffer.from(line, "utf8").toString("base64")}`;
}

test("a role failing on a process error or a schema violation leaves its reason in events.jsonl and the summary (JC-7)", async () => {
  const run = await runHarness({
    crash: "EXIT 3",
    "schema-violation": emitPrompt(
      JSON.stringify({
        outcome: {
          id: "c1",
          kind: "claim",
          sourceRole: "schema-violation",
          title: "Claim without its result",
          data: { number: 1 },
        },
      }),
    ),
  });
  expect(run.status).toBe("error");
  const firstError = (role: string) =>
    run.events.find((event) => event.roleId === role && event.type === "error")
      ?.message;
  expect(firstError("crash")).toBe("opencode exited with code 3");
  expect(firstError("schema-violation")).toBe(
    "role output violates declared outcome schemas",
  );
  expect(run.stdout).toContain("- crash: opencode exited with code 3");
  expect(run.stdout).toContain(
    "- schema-violation: role output violates declared outcome schemas",
  );
});
