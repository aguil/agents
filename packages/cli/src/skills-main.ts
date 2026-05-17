/**
 * `agents skills` — list manifest, doctor against `agents --version`, install playbooks to ~/.agents/skills/.
 */
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_SRC_DIR = dirname(fileURLToPath(import.meta.url));

function findDocsSkillsAnchorDir(): string {
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

const REPO_ROOT = findDocsSkillsAnchorDir();
const DOCS_SKILLS_ROOT = join(REPO_ROOT, "docs", "skills");
const MANIFEST_PATH = join(DOCS_SKILLS_ROOT, "skills.json");

type SkillManifestEntry = {
  readonly id: string;
  readonly path: string;
  readonly summary: string;
  readonly minAgentsVersion: string;
  readonly tags?: readonly string[];
};

type SkillsManifest = {
  readonly schemaVersion: number;
  readonly skills: readonly SkillManifestEntry[];
};

export type SkillsHelpRequest =
  | { readonly kind: "overview" }
  | { readonly kind: "overview"; readonly unknownSubcommand: string };

function stripHelpTokens(argv: readonly string[]): readonly string[] {
  return argv.filter((t) => t !== "--help" && t !== "-h");
}

/** Resolve when user ran `agents skills … --help`. */
export function resolveSkillsHelp(
  argv: readonly string[],
): SkillsHelpRequest | null {
  if (argv.length === 0 || argv[0] !== "skills") {
    return null;
  }
  if (!argv.some((t) => t === "--help" || t === "-h")) {
    return null;
  }
  const rest = [...stripHelpTokens(argv.slice(1))];
  if (rest.length === 0 || rest[0].startsWith("--")) {
    return { kind: "overview" };
  }
  const sub = rest[0];
  if (sub === "list" || sub === "doctor" || sub === "install") {
    return { kind: "overview" };
  }
  return { kind: "overview", unknownSubcommand: sub };
}

export function renderSkillsHelp(req: SkillsHelpRequest): string {
  const bad =
    "unknownSubcommand" in req && req.unknownSubcommand !== undefined
      ? `Note: unknown subcommand '${req.unknownSubcommand}' (stderr has details).\n\n`
      : "";
  return `${bad}Usage: agents skills <command> [options]

Commands:
  list                 Print docs/skills/skills.json
  doctor               Verify agents --version satisfies each skill's minAgentsVersion
  install <skill-id>   Copy SKILL.md into ~/.agents/skills/<id>/ (--dry-run to preview commands only)

Environment:
  AGENTS_CLI           Path to agents launcher for doctor (optional; default: PATH lookup)

Canonical playbooks live under docs/skills/<id>/ in the aguil/agents repository.
`;
}

export function skillsHelpStderrExtras(
  req: SkillsHelpRequest,
): readonly string[] {
  if ("unknownSubcommand" in req && req.unknownSubcommand !== undefined) {
    return [
      `Unknown skills subcommand '${req.unknownSubcommand}'.`,
      "Expected list, doctor, or install — see 'agents skills --help'.",
    ];
  }
  return [];
}

async function loadManifest(): Promise<SkillsManifest> {
  const url = Bun.pathToFileURL(MANIFEST_PATH).href;
  const mod = (await import(url, { with: { type: "json" } })) as {
    default: SkillsManifest;
  };
  return mod.default;
}

function parseSemverPrefix(v: string): readonly [number, number, number] {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(v.trim());
  if (m === null) {
    return [0, 0, 0];
  }
  return [
    Number.parseInt(m[1] ?? "0", 10),
    Number.parseInt(m[2] ?? "0", 10),
    Number.parseInt(m[3] ?? "0", 10),
  ];
}

function semverGte(candidate: string, minimum: string): boolean {
  const a = parseSemverPrefix(candidate);
  const b = parseSemverPrefix(minimum);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) {
      return a[i] > b[i];
    }
  }
  return true;
}

function resolveAgentsExecutable(): string | null {
  const fromEnv = process.env.AGENTS_CLI?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return Bun.which("agents");
}

function tryMonorepoCliArgv(): readonly string[] | null {
  const rootPkg = join(REPO_ROOT, "package.json");
  const cliEntry = join(REPO_ROOT, "packages", "cli", "src", "index.ts");
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

async function runAgentsVersionArgv(
  argv: readonly string[],
): Promise<string | null> {
  const proc = Bun.spawn([...argv], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    return null;
  }
  const out = await new Response(proc.stdout).text();
  const line = out.trim().split(/\r?\n/u)[0]?.trim();
  return line ?? null;
}

async function cmdList(): Promise<number> {
  const manifest = await loadManifest();
  console.log(`${JSON.stringify(manifest, null, 2)}\n`);
  return 0;
}

async function cmdDoctor(): Promise<number> {
  const manifest = await loadManifest();
  const exe = resolveAgentsExecutable();
  const mono = tryMonorepoCliArgv();
  let versionArgv: readonly string[];
  let label: string;
  if (exe !== null) {
    versionArgv = [exe, "--version"];
    label = exe;
  } else if (mono !== null) {
    versionArgv = [...mono, "--version"];
    label = versionArgv.join(" ");
  } else {
    console.error(
      "Could not find `agents` on PATH. Install `@aguil/agents` globally or set AGENTS_CLI to your launcher.",
    );
    return 1;
  }
  const ver = await runAgentsVersionArgv(versionArgv);
  if (ver === null) {
    console.error(`Could not read version from: ${label}`);
    return 1;
  }
  console.log(`agents: ${label}`);
  console.log(`version: ${ver}`);
  let ok = true;
  for (const s of manifest.skills) {
    const pass = semverGte(ver, s.minAgentsVersion);
    if (!pass) {
      ok = false;
    }
    console.log(
      `${pass ? "ok" : "FAIL"}  skill=${s.id}  need>=${s.minAgentsVersion}`,
    );
  }
  return ok ? 0 : 1;
}

async function cmdInstall(skillId: string, dryRun: boolean): Promise<number> {
  const manifest = await loadManifest();
  const skill = manifest.skills.find((s) => s.id === skillId);
  if (skill === undefined) {
    console.error(`Unknown skill id: ${skillId}`);
    return 1;
  }
  const src = join(DOCS_SKILLS_ROOT, skill.path);
  if (!existsSync(src)) {
    console.error(`Missing skill file: ${src}`);
    return 1;
  }
  const home = homedir();
  const destDir = join(home, ".agents", "skills", skill.id);
  const destFile = join(destDir, "SKILL.md");

  const unixMk = `mkdir -p "${destDir}"`;
  const unixCp = `cp "${src}" "${destFile}"`;
  const psMk = `New-Item -ItemType Directory -Force -Path "${destDir.replaceAll("/", "\\")}"`;
  const psCp = `Copy-Item -Path "${src.replaceAll("/", "\\")}" -Destination "${destFile.replaceAll("/", "\\")}" -Force`;

  console.log(
    "# Install into Cursor-style global skills tree (Unix / Git Bash)",
  );
  console.log(unixMk);
  console.log(unixCp);
  console.log("");
  console.log("# Same targets (Windows PowerShell)");
  console.log(psMk);
  console.log(psCp);
  console.log("");

  if (!dryRun) {
    await mkdir(destDir, { recursive: true });
    await copyFile(src, destFile);
    console.log(`Wrote: ${destFile}`);
  } else {
    console.log("(dry-run: no files written)");
  }
  return 0;
}

function printUsage(): void {
  console.error(`Usage: agents skills <command> [options]

Commands:
  list                 Print docs/skills/skills.json
  doctor               Verify agents --version satisfies minAgentsVersion
  install <skill-id>   Copy into ~/.agents/skills/<id>/ (--dry-run to preview)

Try: agents skills --help
`);
}

/** argv after the leading \`skills\` token (e.g. \`["list"]\`, \`["install","review-fix-loop","--dry-run"]\`). */
export async function runSkillsCli(argv: readonly string[]): Promise<number> {
  const cmd = argv[0];
  if (cmd === undefined || cmd === "--help" || cmd === "-h") {
    printUsage();
    return cmd === undefined ? 1 : 0;
  }
  if (cmd === "list") {
    return await cmdList();
  }
  if (cmd === "doctor") {
    return await cmdDoctor();
  }
  if (cmd === "install") {
    const skillId = argv[1];
    if (skillId === undefined || skillId.length === 0) {
      console.error("install requires a skill id (see agents skills list).");
      return 1;
    }
    const dryRun = argv.includes("--dry-run");
    return await cmdInstall(skillId, dryRun);
  }
  console.error(`Unknown skills command: ${cmd}`);
  printUsage();
  return 1;
}
