import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodeReviewRunResult,
  runCodeReview,
} from "@aguil/agents-code-review";
import { runCodeReviewFromConfig } from "@aguil/agents-code-review/config-runner";
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

async function runBoth(
  workspacePath: string,
  contextBundlePath: string,
  adapter: AgentAdapter,
  strict = false,
): Promise<{
  readonly imperative: CodeReviewRunResult;
  readonly configured: CodeReviewRunResult;
}> {
  const shared = {
    workspacePath,
    runId: "code-review-parity",
    contextBundlePath,
    adapter,
    strict,
  };
  const imperative = await runCodeReview({
    ...shared,
    scratchpadRoot: join(workspacePath, "imperative"),
  });
  const configured = await runCodeReviewFromConfig({
    ...shared,
    agentsDir: AGENTS_DIR,
    scratchpadRoot: join(workspacePath, "configured"),
  });
  return { imperative, configured };
}

test("config-driven code review matches deterministic imperative fields", async () => {
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

    const { imperative, configured } = await runBoth(
      workspacePath,
      contextBundlePath,
      adapter,
    );

    expect(configured.findings).toEqual(imperative.findings);
    expect(configured.status).toBe(imperative.status);
    expect({
      triage: configured.metadata?.triage,
      contextFingerprint: configured.metadata?.context_fingerprint,
      consensusRuns: configured.metadata?.consensus_runs,
      consensusMode: configured.metadata?.consensus_mode,
      consensusDropped: configured.metadata?.consensus_dropped_findings,
    }).toEqual({
      triage: imperative.metadata?.triage,
      contextFingerprint: imperative.metadata?.context_fingerprint,
      consensusRuns: imperative.metadata?.consensus_runs,
      consensusMode: imperative.metadata?.consensus_mode,
      consensusDropped: imperative.metadata?.consensus_dropped_findings,
    });
    expect(await readFile(configured.reportPath)).toEqual(
      await readFile(imperative.reportPath),
    );
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("config-driven trivial tier schedules only quality", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "config-trivial-"));
  try {
    const contextBundlePath = await writeBundle(workspacePath, "trivial");
    const { imperative, configured } = await runBoth(
      workspacePath,
      contextBundlePath,
      scriptedAdapter({}),
    );

    expect(configured.metadata?.completed_roles).toBe("quality");
    expect(configured.metadata?.completed_roles).toBe(
      imperative.metadata?.completed_roles,
    );
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("config-driven partial-role failures match imperative status metadata", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "config-failure-parity-"));
  try {
    const contextBundlePath = await writeBundle(workspacePath, "full");
    const { imperative, configured } = await runBoth(
      workspacePath,
      contextBundlePath,
      scriptedAdapter({ performance: { fail: true } }),
    );

    expect(imperative.status).toBe("error");
    expect(configured.status).toBe(imperative.status);
    expect(configured.metadata?.failed_roles).toBe(
      imperative.metadata?.failed_roles,
    );
    expect(configured.metadata?.failed_roles).toBe("performance");
    expect(configured.metadata?.timed_out_roles).toBe(
      imperative.metadata?.timed_out_roles,
    );
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("config-driven timeout and strict-mode statuses match imperative behavior", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "config-timeout-parity-"));
  try {
    const contextBundlePath = await writeBundle(workspacePath, "full");
    const timeoutScripts = { performance: { errorReason: "timed_out" } };
    const nonStrict = await runBoth(
      workspacePath,
      contextBundlePath,
      scriptedAdapter(timeoutScripts),
    );
    const strict = await runBoth(
      workspacePath,
      contextBundlePath,
      scriptedAdapter(timeoutScripts),
      true,
    );

    expect(nonStrict.imperative.status).toBe("warnings");
    expect(nonStrict.configured.status).toBe(nonStrict.imperative.status);
    expect(strict.imperative.status).toBe("error");
    expect(strict.configured.status).toBe(strict.imperative.status);
    expect(strict.imperative.status).not.toBe(nonStrict.imperative.status);
    expect(strict.configured.status).not.toBe(nonStrict.configured.status);

    for (const pair of [nonStrict, strict]) {
      expect(pair.configured.metadata?.timed_out_roles).toBe(
        pair.imperative.metadata?.timed_out_roles,
      );
      expect(pair.configured.metadata?.timed_out_roles).toBe("performance");
      expect(pair.configured.metadata?.failed_roles).toBe(
        pair.imperative.metadata?.failed_roles,
      );
      expect(pair.configured.metadata?.failed_roles).toBe("");
    }
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});
