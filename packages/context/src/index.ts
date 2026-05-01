import { ensureDirectory, writeJsonFile, writeTextFile } from "@aguil/agents-core";
import type { ReviewTriageTier } from "@aguil/agents-core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ContextRequest {
  readonly workspacePath: string;
  readonly diffPath?: string;
  readonly scratchpadPath: string;
}

export interface ContextArtifact {
  readonly id: string;
  readonly title: string;
  readonly path?: string;
  readonly content: string;
}

export interface ContextProvider {
  readonly name: string;
  collect(request: ContextRequest): Promise<readonly ContextArtifact[]>;
}

export interface ContextBundle {
  readonly id: string;
  readonly artifacts: readonly ContextArtifact[];
}

export interface WrittenContextBundle {
  readonly bundle: ContextBundle;
  readonly jsonPath: string;
  readonly markdownPath: string;
}

export class StaticContextProvider implements ContextProvider {
  readonly name = "static";

  constructor(private readonly artifacts: readonly ContextArtifact[]) {}

  async collect(): Promise<readonly ContextArtifact[]> {
    return this.artifacts;
  }
}

export class AgentsInstructionsProvider implements ContextProvider {
  readonly name = "agents-instructions";

  async collect(request: ContextRequest): Promise<readonly ContextArtifact[]> {
    const path = join(request.workspacePath, "AGENTS.md");
    try {
      return [
        {
          id: "agents-md",
          title: "Repository AGENTS.md",
          path,
          content: await readFile(path, "utf8"),
        },
      ];
    } catch {
      return [];
    }
  }
}

export class RepositoryDiffProvider implements ContextProvider {
  readonly name = "repository-diff";

  async collect(request: ContextRequest): Promise<readonly ContextArtifact[]> {
    const diff = request.diffPath
      ? await readFile(request.diffPath, "utf8")
      : await collectRepositoryDiff(request.workspacePath);

    return [
      {
        id: "workspace-diff",
        title: "Workspace Diff",
        content: diff.trim().length > 0 ? diff : "No workspace diff detected.",
      },
      {
        id: "changed-files",
        title: "Changed Files",
        content: changedFilesFromDiff(diff).join("\n") || "No changed files detected.",
      },
      {
        id: "triage",
        title: "Risk Triage",
        content: classifyDiff(diff),
      },
    ];
  }
}

export async function collectContextBundle(
  id: string,
  request: ContextRequest,
  providers: readonly ContextProvider[],
): Promise<ContextBundle> {
  const artifacts = (
    await Promise.all(providers.map((provider) => provider.collect(request)))
  ).flat();
  return { id, artifacts };
}

export async function writeContextBundle(
  bundle: ContextBundle,
  scratchpadPath: string,
): Promise<WrittenContextBundle> {
  const contextPath = join(scratchpadPath, "context");
  await ensureDirectory(contextPath);
  const jsonPath = await writeJsonFile(join(contextPath, "bundle.json"), bundle);
  const markdownPath = await writeTextFile(
    join(contextPath, "bundle.md"),
    renderContextBundle(bundle),
  );
  return { bundle, jsonPath, markdownPath };
}

export function renderContextBundle(bundle: ContextBundle): string {
  const sections = bundle.artifacts.map((artifact) => {
    const source = artifact.path ? `\nSource: ${artifact.path}` : "";
    return `## ${artifact.title}${source}\n\n${artifact.content.trim()}\n`;
  });
  return `# Context Bundle: ${bundle.id}\n\n${sections.join("\n")}`;
}

export function classifyDiff(diff: string): ReviewTriageTier {
  const changedLines = diff
    .split(/\r?\n/)
    .filter((line) => /^[+-]/.test(line) && !line.startsWith("+++") && !line.startsWith("---"))
    .length;
  const changedFiles = changedFilesFromDiff(diff).length;

  if (changedLines <= 10 && changedFiles <= 2) {
    return "trivial";
  }
  if (changedLines <= 250 && changedFiles <= 12) {
    return "lite";
  }
  return "full";
}

export function changedFilesFromDiff(diff: string): readonly string[] {
  const files = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match) {
      files.add(match[2]);
    }
  }
  return [...files].sort();
}

export async function collectRepositoryDiff(workspacePath: string): Promise<string> {
  return (
    (await runCommand(["jj", "diff", "--git"], workspacePath)) ??
    (await runCommand(["git", "diff", "--no-ext-diff", "--"], workspacePath)) ??
    ""
  );
}

async function runCommand(cmd: readonly string[], cwd: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn({ cmd: [...cmd], cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return exitCode === 0 ? stdout : undefined;
  } catch {
    return undefined;
  }
}
