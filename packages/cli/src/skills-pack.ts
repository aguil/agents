/**
 * Resolve the published / dev layout root that contains `docs/skills/skills.json`
 * (walk upward from this module).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_SRC_DIR = dirname(fileURLToPath(import.meta.url));

function findDocsSkillsPackRoot(): string {
  let dir = CLI_SRC_DIR;
  for (let i = 0; i < 10; i += 1) {
    const marker = join(dir, "docs", "skills", "skills.json");
    if (existsSync(marker)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(
    "Could not locate docs/skills/skills.json (run from aguil/agents checkout or use an installed @aguil/agents layout that ships docs/skills/).",
  );
}

export const AGENTS_PACK_ROOT = findDocsSkillsPackRoot();
export const DOCS_SKILLS_ROOT = join(AGENTS_PACK_ROOT, "docs", "skills");
export const SKILLS_MANIFEST_PATH = join(DOCS_SKILLS_ROOT, "skills.json");

/** Semver from the pack root `package.json` (`@aguil/agents`, dev or npm install). */
export function readAgentsMonorepoVersion(): string {
  const rootPkg = join(AGENTS_PACK_ROOT, "package.json");
  try {
    const raw = readFileSync(rootPkg, "utf8");
    const j = JSON.parse(raw) as { version?: string };
    if (typeof j.version === "string" && j.version.length > 0) {
      return j.version;
    }
  } catch {
    // ignore missing or invalid package.json
  }
  return "0.0.0";
}

export type SkillManifestEntry = {
  readonly id: string;
  readonly path: string;
  readonly summary: string;
  readonly minAgentsVersion: string;
  readonly tags?: readonly string[];
};

export type SkillsManifest = {
  readonly schemaVersion: number;
  readonly skills: readonly SkillManifestEntry[];
};

export async function loadSkillsManifest(): Promise<SkillsManifest> {
  const url = Bun.pathToFileURL(SKILLS_MANIFEST_PATH).href;
  const mod = (await import(url, { with: { type: "json" } })) as {
    default: SkillsManifest;
  };
  return mod.default;
}

export function tryMonorepoCliArgv(): readonly string[] | null {
  const rootPkg = join(AGENTS_PACK_ROOT, "package.json");
  const cliEntry = join(AGENTS_PACK_ROOT, "packages", "cli", "src", "index.ts");
  if (!existsSync(rootPkg) || !existsSync(cliEntry)) {
    return null;
  }
  try {
    const j = JSON.parse(readFileSync(rootPkg, "utf8")) as { name?: string };
    if (j.name !== "@aguil/agents") {
      return null;
    }
  } catch {
    return null;
  }
  const bun = Bun.which("bun");
  if (bun === null) {
    return null;
  }
  return [bun, cliEntry];
}
