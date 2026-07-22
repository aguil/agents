import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("config-driven code review filters non-actionable findings and dedupes by fingerprint", async () => {
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

    expect(result.findings.map((entry) => entry.id)).toEqual(["verified-first"]);
    expect(result.status).toBe("warnings");
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
