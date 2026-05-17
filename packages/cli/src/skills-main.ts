/**
 * `agents skills` — list manifest, install playbooks to ~/.agents/skills/.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DOCS_SKILLS_ROOT,
  loadSkillsManifest,
  type SkillManifestEntry,
} from "./skills-pack";

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
  if (sub === "list" || sub === "install" || sub === "doctor") {
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
  install [skill-id]   Copy SKILL.md(s) into ~/.agents/skills/<id>/; omit id to install all manifest skills (--dry-run to preview)

Environment:
  AGENTS_CLI           Optional; used by agents doctor (see agents doctor --help)

Canonical playbooks live under docs/skills/<id>/ in the aguil/agents repository.

Verify CLI semver vs bundled skills: agents doctor
`;
}

export function skillsHelpStderrExtras(
  req: SkillsHelpRequest,
): readonly string[] {
  if ("unknownSubcommand" in req && req.unknownSubcommand !== undefined) {
    return [
      `Unknown skills subcommand '${req.unknownSubcommand}'.`,
      "Expected list or install — see 'agents skills --help'.",
    ];
  }
  return [];
}

async function cmdList(): Promise<number> {
  const manifest = await loadSkillsManifest();
  console.log(`${JSON.stringify(manifest, null, 2)}\n`);
  return 0;
}

async function installOneSkill(
  skill: SkillManifestEntry,
  dryRun: boolean,
): Promise<number> {
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

async function cmdInstall(skillId: string, dryRun: boolean): Promise<number> {
  const manifest = await loadSkillsManifest();
  const skill = manifest.skills.find((s) => s.id === skillId);
  if (skill === undefined) {
    console.error(`Unknown skill id: ${skillId}`);
    return 1;
  }
  console.log(`# Skill: ${skill.id}\n`);
  return await installOneSkill(skill, dryRun);
}

async function cmdInstallAll(dryRun: boolean): Promise<number> {
  const manifest = await loadSkillsManifest();
  if (manifest.skills.length === 0) {
    console.error("Manifest lists no skills to install.");
    return 1;
  }
  let code = 0;
  for (const skill of manifest.skills) {
    console.log(`# Skill: ${skill.id}\n`);
    const step = await installOneSkill(skill, dryRun);
    if (step !== 0) {
      code = 1;
    }
  }
  return code;
}

function printUsage(): void {
  console.error(`Usage: agents skills <command> [options]

Commands:
  list                 Print docs/skills/skills.json
  install [skill-id]   Copy into ~/.agents/skills/<id>/; omit id for all skills (--dry-run to preview)

Try: agents skills --help
`);
}

/** argv after the leading \`skills\` token (e.g. \`["list"]\`, \`["install","self-review-checks","--dry-run"]\`). */
export async function runSkillsCli(argv: readonly string[]): Promise<number> {
  const cmd = argv[0];
  if (cmd === undefined || cmd === "--help" || cmd === "-h") {
    printUsage();
    return cmd === undefined ? 1 : 0;
  }
  if (cmd === "list") {
    return await cmdList();
  }
  if (cmd === "install") {
    const dryRun = argv.includes("--dry-run");
    const positional = argv
      .slice(1)
      .filter((a) => a !== "--dry-run" && !a.startsWith("--"));
    const unknownFlag = argv
      .slice(1)
      .find((a) => a.startsWith("--") && a !== "--dry-run");
    if (unknownFlag !== undefined) {
      console.error(`Unknown install flag: ${unknownFlag}`);
      return 1;
    }
    if (positional.length === 0) {
      return await cmdInstallAll(dryRun);
    }
    if (positional.length > 1) {
      console.error(
        "install takes at most one skill id (omit for all skills).",
      );
      return 1;
    }
    const skillId = positional[0];
    if (skillId === "all") {
      return await cmdInstallAll(dryRun);
    }
    return await cmdInstall(skillId, dryRun);
  }
  if (cmd === "doctor") {
    console.error(
      "`agents skills doctor` was removed; use `agents doctor` instead.",
    );
    return 1;
  }
  console.error(`Unknown skills command: ${cmd}`);
  printUsage();
  return 1;
}
