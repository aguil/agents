import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextRequest } from "@aguil/agents-context";
import {
  contextRequestParam,
  FileGlobProvider,
  RepositoryDiffProvider,
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

test("StaticFileProvider refuses traversal and absolute escapes unless opted in", async () => {
  await withWorkspace(async (workspacePath) => {
    const outside = join(workspacePath, "..", "escape-marker.txt");
    await writeFile(outside, "host secret");
    try {
      const traversal = new StaticFileProvider({
        id: "escape",
        path: "../escape-marker.txt",
      });
      await expect(
        traversal.collect(makeRequest(workspacePath)),
      ).rejects.toThrow("refuses path outside the workspace");

      const absolute = new StaticFileProvider({ id: "abs", path: outside });
      await expect(
        absolute.collect(makeRequest(workspacePath)),
      ).rejects.toThrow("refuses path outside the workspace");

      const optedIn = new StaticFileProvider({
        id: "fixture",
        path: outside,
        allowOutsideWorkspace: true,
      });
      const artifacts = await optedIn.collect(makeRequest(workspacePath));
      expect(artifacts[0]?.content).toBe("host secret");
    } finally {
      await rm(outside, { force: true });
    }
  });
});

test("StaticFileProvider rejects symlinks targeting outside the workspace", async () => {
  await withWorkspace(async (workspacePath) => {
    const outside = join(workspacePath, "..", "symlink-target-marker.txt");
    await writeFile(outside, "host secret");
    try {
      await symlink(outside, join(workspacePath, "innocent-looking.log"));
      const provider = new StaticFileProvider({
        id: "symlinked",
        path: "innocent-looking.log",
      });
      await expect(
        provider.collect(makeRequest(workspacePath)),
      ).rejects.toThrow("refuses path outside the workspace");
    } finally {
      await rm(outside, { force: true });
    }
  });
});

test("FileGlobProvider skips matches that resolve outside the workspace", async () => {
  await withWorkspace(async (workspacePath) => {
    const outside = join(workspacePath, "..", "glob-escape-marker.txt");
    await writeFile(outside, "host secret");
    try {
      const provider = new FileGlobProvider({
        pattern: "../glob-escape-marker.txt",
      });
      const artifacts = await provider.collect(makeRequest(workspacePath));
      expect(artifacts).toHaveLength(0);
    } finally {
      await rm(outside, { force: true });
    }
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

test("FileGlobProvider bounded selection matches sort-then-slice semantics", async () => {
  await withWorkspace(async (workspacePath) => {
    await mkdir(join(workspacePath, "many"), { recursive: true });
    // Write files in non-sorted creation order.
    const names = ["m.txt", "a.txt", "z.txt", "c.txt", "b.txt", "q.txt"];
    for (const name of names) {
      await writeFile(join(workspacePath, "many", name), name);
    }
    const provider = new FileGlobProvider({
      pattern: "many/*.txt",
      maxFiles: 3,
    });
    const artifacts = await provider.collect(makeRequest(workspacePath));
    expect(artifacts.map((a) => a.title)).toEqual([
      "many/a.txt",
      "many/b.txt",
      "many/c.txt",
    ]);
  });
});

test("FileGlobProvider surfaces scan truncation as a warning artifact", async () => {
  await withWorkspace(async (workspacePath) => {
    await mkdir(join(workspacePath, "many"), { recursive: true });
    for (let i = 0; i < 8; i += 1) {
      await writeFile(join(workspacePath, "many", `f${i}.txt`), String(i));
    }
    const provider = new FileGlobProvider({
      pattern: "many/*.txt",
      maxFiles: 2,
      maxScannedMatches: 4,
    });
    const artifacts = await provider.collect(makeRequest(workspacePath));
    const warning = artifacts.find((a) => a.id.endsWith(":scan-truncated"));
    expect(warning).toBeDefined();
    expect(warning?.content).toContain("matched more than 4 paths");
    expect(
      artifacts.filter((a) => !a.id.endsWith(":scan-truncated")),
    ).toHaveLength(2);
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

test("RepositoryDiffProvider honors params-only diffPath", async () => {
  await withWorkspace(async (workspacePath) => {
    const diffPath = join(workspacePath, "explicit.diff");
    await writeFile(
      diffPath,
      [
        "diff --git a/src/x.ts b/src/x.ts",
        "--- a/src/x.ts",
        "+++ b/src/x.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
    );
    // No deprecated top-level diffPath; params only.
    const provider = new RepositoryDiffProvider(async () => undefined);
    const artifacts = await provider.collect(
      makeRequest(workspacePath, { diffPath }),
    );
    const strategy = artifacts.find((a) => a.id === "diff-strategy");
    expect(strategy?.content).toContain("explicit_diff_path");
    const diff = artifacts.find((a) => a.id === "workspace-diff");
    expect(diff?.content).toContain("+new");
  });
});
