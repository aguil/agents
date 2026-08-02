import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveConfigHarnessSource,
  runCodeReviewFromConfig,
} from "@aguil/agents-code-review/config-runner";
import type { ContextBundle } from "@aguil/agents-context";
import type { Finding } from "@aguil/agents-core";
import { createAgentEvent } from "@aguil/agents-core";
import type { AgentAdapter, AgentRunRequest } from "@aguil/agents-execution";

const AGENTS_DIR = join(import.meta.dir, "..", ".agents");

function finding(id: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id,
    severity: "warning",
    title: "Verified issue",
    description: "The changed branch returns stale state.",
    evidence: "Reproduced by the deterministic parity test.",
    sourceRole: "quality",
    validation: {
      status: "verified",
      details: "Reproduced with deterministic test input.",
      evidence: [{ kind: "command", command: "bun test", exitCode: 0 }],
    },
    file: "src/example.ts",
    line: 12,
    ...overrides,
  };
}

interface RoleScript {
  readonly findings?: readonly Finding[];
  readonly fail?: boolean;
  readonly errorReason?: string;
}

function scriptedAdapter(
  scripts: Readonly<Record<string, RoleScript>>,
): AgentAdapter {
  return {
    name: "scripted",
    capabilities: () => ({
      streaming: false,
      structuredOutput: true,
      readOnlyMode: true,
      mcp: false,
      cancellation: false,
    }),
    async *run(request: AgentRunRequest) {
      const script = scripts[request.roleId] ?? {};
      for (const emitted of script.findings ?? []) {
        yield createAgentEvent({
          runId: request.runId,
          roleId: request.roleId,
          type: "finding",
          data: emitted,
        });
      }
      if (script.fail === true || script.errorReason !== undefined) {
        yield createAgentEvent({
          runId: request.runId,
          roleId: request.roleId,
          type: "error",
          data: { reason: script.errorReason ?? "boom" },
        });
      }
    },
  };
}

async function writeBundle(
  root: string,
  tier: "trivial" | "full",
): Promise<string> {
  const path = join(root, `context-${tier}.json`);
  const bundle: ContextBundle = {
    id: `recorded-${tier}`,
    artifacts: [
      {
        id: "triage",
        title: "Recorded triage",
        content: tier,
      },
      {
        id: "diff-strategy",
        title: "Recorded diff strategy",
        content: [
          "PR Number: 73",
          "PR Head SHA: abc123",
          "Reviewed At: 2026-07-18T20:00:00.000Z",
        ].join("\n"),
      },
    ],
  };
  await writeFile(path, JSON.stringify(bundle), "utf8");
  return path;
}

async function runConfigured(
  workspacePath: string,
  contextBundlePath: string,
  adapter: AgentAdapter,
  strict = false,
) {
  return await runCodeReviewFromConfig({
    agentsDir: AGENTS_DIR,
    workspacePath,
    runId: "code-review-parity",
    contextBundlePath,
    adapter,
    strict,
    scratchpadRoot: join(workspacePath, "configured"),
  });
}

test("config-driven code review marks unevidenced findings and dedupes by fingerprint", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "config-parity-"));
  try {
    const contextBundlePath = await writeBundle(workspacePath, "full");
    const duplicate = finding("duplicate-second");
    const adapter = scriptedAdapter({
      quality: {
        findings: [
          finding("verified-first"),
          duplicate,
          finding("not-reproduced", {
            title: "Unconfirmed issue",
            // A distinct file keeps this out of the fingerprint group above,
            // so the assertion below is about classification rather than
            // deduplication.
            file: "src/other.ts",
            validation: {
              status: "not_reproduced",
              details: "Could not reproduce with deterministic test input.",
            },
          }),
        ],
      },
    });

    const result = await runConfigured(
      workspacePath,
      contextBundlePath,
      adapter,
    );

    // The unevidenced finding survives to result.json — dropping it is the
    // defect ADR 0019 corrects — while the fingerprint duplicate does not.
    // Ordered by title, so the unconfirmed one leads.
    expect(result.findings.map((entry) => entry.id)).toEqual([
      "not-reproduced",
      "verified-first",
    ]);
    expect(
      result.findings.map((entry) => entry.unsubstantiated === true),
    ).toEqual([true, false]);
    // Status counts only the substantiated one.
    expect(result.status).toBe("warnings");
    expect(result.metadata?.unsubstantiated_findings).toBe("1");
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("an unevidenced critical does not fail a config-driven run", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "config-critical-"));
  try {
    const contextBundlePath = await writeBundle(workspacePath, "full");
    const adapter = scriptedAdapter({
      quality: {
        findings: [
          finding("unevidenced-critical", {
            severity: "critical",
            validation: {
              status: "verified",
              details: "Read the file and it looked wrong.",
            },
          }),
        ],
      },
    });

    const result = await runConfigured(
      workspacePath,
      contextBundlePath,
      adapter,
    );

    // The orchestrator sees a raw critical and says "failed" before the
    // pipeline classifies it. Letting that through would fail the run on a
    // finding the same run reports as not counted — and only a critical
    // reaches that branch, which is why a warning-only case missed it.
    expect(result.findings.map((entry) => entry.unsubstantiated)).toEqual([
      true,
    ]);
    expect(result.status).toBe("passed");
    expect(result.metadata?.unsubstantiated_findings).toBe("1");
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("an agent-supplied marker never reaches the result", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "config-supplied-"));
  try {
    const contextBundlePath = await writeBundle(workspacePath, "full");
    const adapter = scriptedAdapter({
      quality: {
        // Emitted as a direct finding event, which does not pass through the
        // JSONL envelope coercion — the path three earlier fixes missed.
        findings: [
          finding("self-suppressed", {
            severity: "critical",
            unsubstantiated: true,
          }),
        ],
      },
    });

    const result = await runConfigured(
      workspacePath,
      contextBundlePath,
      adapter,
    );

    // The finding is evidenced, so honoring its marker would hide a critical
    // from the gate on the agent's say-so.
    expect(result.findings.map((entry) => entry.unsubstantiated)).toEqual([
      undefined,
    ]);
    expect(result.status).toBe("failed");
    expect(result.metadata?.unsubstantiated_findings).toBe("0");
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("a declared pass_check decides the run on the config path too", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "config-pass-check-"));
  try {
    const agentsDir = join(workspacePath, "agents-dir");
    const harnessDir = join(agentsDir, "harnesses", "code-review");
    await mkdir(harnessDir, { recursive: true });
    const writeHarness = (passCheck: string) =>
      writeFile(
        join(harnessDir, "harness.yaml"),
        [
          'spec_version: "0.4"',
          "kind: harness",
          "harness: { id: code-review }",
          "roles:",
          "  quality:",
          "    description: Quality",
          "    prompt: Review the change.",
          "execution:",
          "  mode: chain",
          "  order: [quality]",
          `  pass_check: ${passCheck}`,
          "reporting: { template: builtin:code-review-markdown }",
        ].join("\n"),
        "utf8",
      );
    const contextBundlePath = await writeBundle(workspacePath, "full");
    const run = () =>
      runCodeReviewFromConfig({
        agentsDir,
        workspacePath,
        runId: "code-review-pass-check",
        contextBundlePath,
        adapter: scriptedAdapter({}),
        scratchpadRoot: join(workspacePath, "configured"),
      });

    // Writing the working directory proves both halves: that the command ran
    // at all, and that it ran against the workspace rather than wherever the
    // driver happens to live.
    await writeHarness('["sh", "-c", "pwd > ran-in.txt; exit 1"]');
    expect((await run()).status).toBe("failed");
    expect((await Bun.file(join(workspacePath, "ran-in.txt")).text()).trim()) //
      .toBe(workspacePath);

    await writeHarness('["true"]');
    expect((await run()).status).toBe("passed");
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("a harness this path cannot enforce is refused, not run inert", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "config-unenforceable-"));
  try {
    const agentsDir = join(workspacePath, "agents-dir");
    const harnessDir = join(agentsDir, "harnesses", "code-review");
    await mkdir(harnessDir, { recursive: true });
    await mkdir(join(agentsDir, "policies"), { recursive: true });
    await writeFile(
      join(agentsDir, "policies", "readonly.yaml"),
      [
        "id: readonly",
        "capabilities:",
        "  filesystem:",
        "    deny: ['**']",
      ].join("\n"),
      "utf8",
    );
    const contextBundlePath = await writeBundle(workspacePath, "full");
    const writeHarness = (extra: readonly string[]) =>
      writeFile(
        join(harnessDir, "harness.yaml"),
        [
          'spec_version: "0.4"',
          "kind: harness",
          "harness: { id: code-review }",
          "roles:",
          "  quality:",
          "    description: Quality",
          "    prompt: Review the change.",
          "reporting: { template: builtin:code-review-markdown }",
          ...extra,
        ].join("\n"),
        "utf8",
      );
    const run = () =>
      runCodeReviewFromConfig({
        agentsDir,
        workspacePath,
        runId: "code-review-unenforceable",
        contextBundlePath,
        adapter: scriptedAdapter({}),
        scratchpadRoot: join(workspacePath, "configured"),
      });

    await writeHarness(["policy: readonly"]);
    await expect(run()).rejects.toThrow("harness declares policy");

    await writeHarness(["hooks:", "  pre_tool_call:", "    - command: 'true'"]);
    await expect(run()).rejects.toThrow("harness declares hooks");

    // The shipped harness declares neither, so the guard is not a change in
    // behavior for anyone running the real thing.
    await writeHarness([]);
    expect((await run()).status).toBe("passed");
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("config-driven trivial tier schedules only quality", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "config-trivial-"));
  try {
    const contextBundlePath = await writeBundle(workspacePath, "trivial");
    const result = await runConfigured(
      workspacePath,
      contextBundlePath,
      scriptedAdapter({}),
    );

    expect(result.metadata?.completed_roles).toBe("quality");
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("config-driven partial-role failures surface failed_roles metadata", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "config-failure-parity-"));
  try {
    const contextBundlePath = await writeBundle(workspacePath, "full");
    const result = await runConfigured(
      workspacePath,
      contextBundlePath,
      scriptedAdapter({ performance: { fail: true } }),
    );

    expect(result.status).toBe("error");
    expect(result.metadata?.failed_roles).toBe("performance");
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("config-driven timeout and strict-mode statuses", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "config-timeout-parity-"));
  try {
    const contextBundlePath = await writeBundle(workspacePath, "full");
    const timeoutScripts = { performance: { errorReason: "timed_out" } };
    const nonStrict = await runConfigured(
      workspacePath,
      contextBundlePath,
      scriptedAdapter(timeoutScripts),
    );
    const strict = await runConfigured(
      workspacePath,
      contextBundlePath,
      scriptedAdapter(timeoutScripts),
      true,
    );

    expect(nonStrict.status).toBe("warnings");
    expect(strict.status).toBe("error");
    expect(nonStrict.metadata?.timed_out_roles).toBe("performance");
    expect(strict.metadata?.timed_out_roles).toBe("performance");
    expect(nonStrict.metadata?.failed_roles).toBe("");
    expect(strict.metadata?.failed_roles).toBe("");
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("config-driven code review falls back to the packaged harness without workspace .agents", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "config-package-"));
  const homePath = await mkdtemp(join(tmpdir(), "config-package-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = homePath;
  try {
    const contextBundlePath = await writeBundle(workspacePath, "trivial");
    const result = await runCodeReviewFromConfig({
      workspacePath,
      scratchpadRoot: join(workspacePath, "configured"),
      runId: "code-review-package-fallback",
      contextBundlePath,
      adapter: scriptedAdapter({}),
    });

    expect(result.metadata?.config_harness_source).toBe("package");
    expect(result.metadata?.config_harness_agents_dir).toBe(AGENTS_DIR);
    expect(result.status).toBe("passed");
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(workspacePath, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
  }
});

test("config harness resolver precedence is workspace over global over package", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "config-precedence-"));
  const homePath = await mkdtemp(join(tmpdir(), "config-precedence-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = homePath;
  try {
    expect((await resolveConfigHarnessSource(workspacePath)).source).toBe(
      "package",
    );

    await mkdir(join(homePath, ".agents", "harnesses", "code-review"), {
      recursive: true,
    });
    await writeFile(
      join(homePath, ".agents", "harnesses", "code-review", "harness.yaml"),
      "kind: harness\n",
    );
    expect((await resolveConfigHarnessSource(workspacePath)).source).toBe(
      "user-global",
    );

    await mkdir(join(workspacePath, ".agents", "harnesses", "code-review"), {
      recursive: true,
    });
    await writeFile(
      join(
        workspacePath,
        ".agents",
        "harnesses",
        "code-review",
        "harness.yaml",
      ),
      "kind: harness\n",
    );
    expect((await resolveConfigHarnessSource(workspacePath)).source).toBe(
      "workspace",
    );
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(workspacePath, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
  }
});
