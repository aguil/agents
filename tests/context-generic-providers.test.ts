import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextRequest } from "@aguil/agents-context";
import {
  contextRequestParam,
  FileGlobProvider,
  ShellCommandProvider,
  StaticFileProvider,
} from "@aguil/agents-context";

async function withWorkspace<T>(
  fn: (workspacePath: string) => Promise<T>,
): Promise<T> {
  const workspacePath = await mkdtemp(join(tmpdir(), "ctx-providers-"));
  try {
    return await fn(workspacePath);
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
}

function makeRequest(
  workspacePath: string,
  params?: Readonly<Record<string, unknown>>,
): ContextRequest {
  return {
    workspacePath,
    scratchpadPath: join(workspacePath, ".scratch"),
    params,
  };
}

test("StaticFileProvider reads a workspace-relative file", async () => {
  await withWorkspace(async (workspacePath) => {
    await writeFile(join(workspacePath, "alert.log"), "ERROR: pager duty\n");
    const provider = new StaticFileProvider({
      id: "incident-log",
      path: "alert.log",
      title: "Incident Alert Log",
    });
    const artifacts = await provider.collect(makeRequest(workspacePath));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].id).toBe("incident-log");
    expect(artifacts[0].title).toBe("Incident Alert Log");
    expect(artifacts[0].content).toContain("ERROR: pager duty");
  });
});

test("StaticFileProvider omits missing optional files and throws for required ones", async () => {
  await withWorkspace(async (workspacePath) => {
    const optional = new StaticFileProvider({
      id: "maybe",
      path: "does-not-exist.txt",
    });
    expect(await optional.collect(makeRequest(workspacePath))).toHaveLength(0);

    const required = new StaticFileProvider({
      id: "must-have",
      path: "does-not-exist.txt",
      required: true,
    });
    await expect(required.collect(makeRequest(workspacePath))).rejects.toThrow(
      'static-file provider "must-have"',
    );
  });
});

test("StaticFileProvider truncates oversized content", async () => {
  await withWorkspace(async (workspacePath) => {
    await writeFile(join(workspacePath, "big.log"), "y".repeat(60_000));
    const provider = new StaticFileProvider({
      id: "big",
      path: "big.log",
      maxBytes: 1000,
    });
    const artifacts = await provider.collect(makeRequest(workspacePath));
    expect(artifacts[0].content).toContain("[truncated at 1000 bytes]");
    expect(Buffer.byteLength(artifacts[0].content, "utf8")).toBeLessThan(1100);
  });
});

test("ShellCommandProvider captures stdout and records failures without throwing", async () => {
  await withWorkspace(async (workspacePath) => {
    const ok = new ShellCommandProvider({
      id: "test-status",
      cmd: ["echo", "1 test failed"],
    });
    const okArtifacts = await ok.collect(makeRequest(workspacePath));
    expect(okArtifacts[0].content).toContain("1 test failed");

    const failing = new ShellCommandProvider({
      id: "broken",
      cmd: ["false"],
      commandRunner: async () => undefined,
    });
    const failedArtifacts = await failing.collect(makeRequest(workspacePath));
    expect(failedArtifacts).toHaveLength(1);
    expect(failedArtifacts[0].content).toContain("Command failed: false");
  });
});

test("FileGlobProvider collects matching files up to maxFiles in sorted order", async () => {
  await withWorkspace(async (workspacePath) => {
    await mkdir(join(workspacePath, "docs"), { recursive: true });
    await writeFile(join(workspacePath, "docs", "b.md"), "# b");
    await writeFile(join(workspacePath, "docs", "a.md"), "# a");
    await writeFile(join(workspacePath, "docs", "c.md"), "# c");
    await writeFile(join(workspacePath, "unrelated.txt"), "nope");

    const provider = new FileGlobProvider({
      pattern: "docs/*.md",
      maxFiles: 2,
    });
    const artifacts = await provider.collect(makeRequest(workspacePath));
    expect(artifacts.map((a) => a.title)).toEqual(["docs/a.md", "docs/b.md"]);
    expect(artifacts[0].id).toBe("file-glob:docs/a.md");
    expect(artifacts[0].content).toBe("# a");
  });
});

test("contextRequestParam prefers legacy fields, falls back to params", async () => {
  await withWorkspace(async (workspacePath) => {
    const legacy: ContextRequest = {
      workspacePath,
      scratchpadPath: join(workspacePath, ".scratch"),
      pullRequestNumber: 42,
      params: { pullRequestNumber: 99, alertPath: "alert.log" },
    };
    expect(contextRequestParam(legacy, "pullRequestNumber")).toBe(42);
    expect(contextRequestParam(legacy, "alertPath")).toBe("alert.log");
    expect(contextRequestParam(legacy, "missing")).toBeUndefined();

    const paramsOnly = makeRequest(workspacePath, { pullRequestNumber: 7 });
    expect(contextRequestParam(paramsOnly, "pullRequestNumber")).toBe(7);
  });
});
