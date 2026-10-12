import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentRunRequest,
  buildClaudeCodePrompt,
  buildCursorPrompt,
  buildOpenCodePrompt,
} from "@aguil/agents-execution";

const request: AgentRunRequest = {
  runId: "run-1",
  roleId: "quality",
  prompt: "Review this change.",
  workspacePath: "/repo",
  contextBundlePath: "/scratch/context.json",
  scratchpadPath: "/scratch/roles/quality",
  timeoutMs: 1_000,
  allowedCommands: [],
};

function expectNoParseableEnvelope(content: string, label: string): void {
  for (const line of content.split("\n")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed === "object" && parsed !== null) {
      expect(
        "finding" in parsed || "outcome" in parsed,
        `${label} contains a parseable envelope example: ${line}`,
      ).toBe(false);
    }
  }
}

test("adapter prompts contain no copy-pasteable envelope examples", () => {
  const requestPath = "/scratch/roles/quality/quality.request.json";
  const prompts = [
    ["OpenCode", buildOpenCodePrompt(request)],
    ["Claude Code", buildClaudeCodePrompt(request, requestPath)],
    ["Cursor", buildCursorPrompt(request, requestPath)],
  ] as const;

  for (const [label, prompt] of prompts) {
    expectNoParseableEnvelope(prompt, label);
  }
});

test("code-review prompt files contain no copy-pasteable envelope examples", async () => {
  const promptsDir = join(
    import.meta.dir,
    "..",
    "harnesses",
    "code-review",
    "prompts",
  );
  const glob = new Bun.Glob("*.md");
  const promptFiles = await Array.fromAsync(glob.scan({ cwd: promptsDir }));
  expect(promptFiles.length).toBeGreaterThanOrEqual(4);

  for (const file of promptFiles) {
    const content = await readFile(join(promptsDir, file), "utf8");
    expectNoParseableEnvelope(content, file);
  }
});

function promptsFor(
  envelope: AgentRunRequest["envelope"],
): ReadonlyArray<readonly [string, string]> {
  const requestPath = "/scratch/roles/quality/quality.request.json";
  const withEnvelope: AgentRunRequest = {
    ...request,
    metadata: { vcs_mode: "jj" },
    ...(envelope === undefined ? {} : { envelope }),
  };
  return [
    ["opencode", buildOpenCodePrompt(withEnvelope)],
    ["claude", buildClaudeCodePrompt(withEnvelope, requestPath)],
    ["cursor", buildCursorPrompt(withEnvelope, requestPath)],
  ];
}

test("a harness-run prompt names its inputs and VCS, with no role, write or finding rule (#211)", () => {
  for (const [label, prompt] of promptsFor("harness-run")) {
    expect(prompt, label).toStartWith("Review this change.");
    expect(prompt, label).toContain("Context bundle: /scratch/context.json");
    expect(prompt, label).toContain(
      "Machine-readable run request: /scratch/roles/quality/quality.request.json",
    );
    expect(prompt, label).toContain("This workspace uses jujutsu.");
    expect(prompt, label).not.toMatch(/read-only/i);
    expect(prompt, label).not.toContain("Do not edit");
    expect(prompt, label).not.toMatch(/finding|code-review|specialist/i);
  }
});

test("a code-review prompt keeps the reviewer envelope, named or by default (#211)", () => {
  for (const envelope of ["code-review", undefined] as const) {
    for (const [label, prompt] of promptsFor(envelope)) {
      const name = `${label} (${envelope ?? "default"})`;
      expect(prompt, name).toContain("Stay read-only. Do not edit files.");
      expect(prompt, name).toContain("code-review");
      expect(prompt, name).toContain("single top-level key `finding`");
      expect(prompt, name).toContain("This workspace uses jujutsu.");
    }
  }
});
