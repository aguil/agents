import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentsInstructionsProvider,
  BUILTIN_CONTEXT_PROVIDER_NAMES,
  FileGlobProvider,
  PullRequestMetadataProvider,
  PullRequestReferencedDocsProvider,
  RepositoryDiffProvider,
  resolveContextProvider,
  ShellCommandProvider,
  StaticFileProvider,
} from "@aguil/agents-context";

test("builtin context provider names resolve to their provider classes", () => {
  expect(BUILTIN_CONTEXT_PROVIDER_NAMES).toEqual([
    "git-diff",
    "pr-metadata",
    "pr-referenced-docs",
    "agents-md",
    "static-file",
    "shell-command",
    "file-glob",
  ]);
  expect(resolveContextProvider("git-diff", {})).toBeInstanceOf(
    RepositoryDiffProvider,
  );
  expect(resolveContextProvider("pr-metadata", {})).toBeInstanceOf(
    PullRequestMetadataProvider,
  );
  expect(resolveContextProvider("pr-referenced-docs", {})).toBeInstanceOf(
    PullRequestReferencedDocsProvider,
  );
  expect(resolveContextProvider("agents-md", {})).toBeInstanceOf(
    AgentsInstructionsProvider,
  );
  expect(
    resolveContextProvider("static-file", { id: "one", path: "one.txt" }),
  ).toBeInstanceOf(StaticFileProvider);
  expect(
    resolveContextProvider("shell-command", { id: "echo", cmd: ["echo"] }),
  ).toBeInstanceOf(ShellCommandProvider);
  expect(
    resolveContextProvider("file-glob", { pattern: "**/*.md" }),
  ).toBeInstanceOf(FileGlobProvider);
});

test("zero-param context providers reject params", () => {
  for (const use of [
    "git-diff",
    "pr-metadata",
    "pr-referenced-docs",
    "agents-md",
  ]) {
    expect(() => resolveContextProvider(use, { extra: true })).toThrow(
      `context provider "${use}" has unsupported params: extra (supported: none)`,
    );
  }
});

test("static-file and shell-command params map to provider options", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "context-registry-"));
  const request = {
    workspacePath,
    scratchpadPath: join(workspacePath, ".scratch"),
  };
  try {
    await writeFile(join(workspacePath, "large.txt"), "x".repeat(100));
    const staticProvider = resolveContextProvider("static-file", {
      id: "bounded-file",
      path: "large.txt",
      title: "Bounded File",
      required: true,
      max_bytes: 10,
    });
    const staticArtifacts = await staticProvider.collect(request);
    expect(staticArtifacts[0]?.id).toBe("bounded-file");
    expect(staticArtifacts[0]?.title).toBe("Bounded File");
    expect(staticArtifacts[0]?.content).toContain("[truncated at 10 bytes]");

    const shellProvider = resolveContextProvider("shell-command", {
      id: "bounded-shell",
      cmd: ["sh", "-c", "printf 1234567890"],
      title: "Bounded Shell",
      max_bytes: 5,
    });
    const shellArtifacts = await shellProvider.collect(request);
    expect(shellArtifacts[0]?.id).toBe("bounded-shell");
    expect(shellArtifacts[0]?.title).toBe("Bounded Shell");
    expect(shellArtifacts[0]?.content).toContain("[truncated at 5 bytes]");
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("build-time-only provider options cannot be set through params", () => {
  for (const key of [
    "allow_workspace_escape",
    "allowWorkspaceEscape",
    "allow_outside_workspace",
    "allowOutsideWorkspace",
  ]) {
    expect(() =>
      resolveContextProvider("static-file", {
        id: "file",
        path: "file.txt",
        [key]: true,
      }),
    ).toThrow("build-time-only");
  }
  for (const key of ["command_runner", "commandRunner"]) {
    expect(() =>
      resolveContextProvider("shell-command", {
        id: "command",
        cmd: ["true"],
        [key]: async () => "",
      }),
    ).toThrow("build-time-only");
  }
});

test("unknown providers list all available builtin names", () => {
  expect(() => resolveContextProvider("unknown", {})).toThrow(
    `available: ${BUILTIN_CONTEXT_PROVIDER_NAMES.join(", ")}`,
  );
});

test("provider params are strictly typed", () => {
  expect(() =>
    resolveContextProvider("shell-command", {
      id: "bad",
      cmd: "echo bad",
    }),
  ).toThrow('param "cmd" must be a non-empty list');
  expect(() =>
    resolveContextProvider("static-file", {
      id: "bad",
      path: "file.txt",
      max_bytes: -1,
    }),
  ).toThrow('param "max_bytes" must be a positive integer');
  expect(() =>
    resolveContextProvider("file-glob", {
      pattern: "*.md",
      max_files: 1.5,
    }),
  ).toThrow('param "max_files" must be a positive integer');
});
