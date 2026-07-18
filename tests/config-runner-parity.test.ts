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

function scriptedAdapter(
  findingsByRole: Readonly<Record<string, readonly Finding[]>>,
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
      for (const emitted of findingsByRole[request.roleId] ?? []) {
        yield createAgentEvent({
          runId: request.runId,
          roleId: request.roleId,
          type: "finding",
          data: emitted,
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
): Promise<{
  readonly imperative: CodeReviewRunResult;
  readonly configured: CodeReviewRunResult;
}> {
  const shared = {
    workspacePath,
    runId: "code-review-parity",
    contextBundlePath,
    adapter,
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
      quality: [
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
