import { constants as FsConstants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { AGENTS_PACK_ROOT, readAgentsMonorepoVersion } from "./skills-pack";

const CODE_REVIEW_HARNESS_ID = "code-review";
const INSTALL_VERSION_FILE = ".agents-package-version";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, FsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function printUsage(): void {
  console.error(`Usage: agents harness <command> [options]

Commands:
  run ...                         Run a generic harness
  install code-review [options]   Install the packaged code-review harness into ~/.agents

Install options:
  --dest <path>                   Target .agents directory (default ~/.agents)
  --dry-run                       Print planned writes without changing files

Try: agents harness install code-review --help
`);
}

function parseInstallArgs(argv: readonly string[]):
  | {
      readonly ok: true;
      readonly harnessId: string;
      readonly dest: string;
      readonly dryRun: boolean;
    }
  | { readonly ok: false; readonly error: string; readonly help?: boolean } {
  const positional: string[] = [];
  let dest = join(homedir(), ".agents");
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { ok: false, error: "", help: true };
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--dest") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, error: "--dest requires a path" };
      }
      dest = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--dest=")) {
      dest = arg.slice("--dest=".length);
      continue;
    }
    if (arg.startsWith("--")) {
      return { ok: false, error: `Unknown install flag: ${arg}` };
    }
    positional.push(arg);
  }

  if (positional.length !== 1) {
    return {
      ok: false,
      error: "install requires exactly one harness id (currently: code-review)",
    };
  }
  return { ok: true, harnessId: positional[0], dest, dryRun };
}

async function copyWithLog(
  src: string,
  dest: string,
  dryRun: boolean,
): Promise<void> {
  console.log(`${dryRun ? "Would write" : "Wrote"}: ${dest}`);
  if (dryRun) {
    return;
  }
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
}

async function installCodeReviewHarness(
  destRaw: string,
  dryRun: boolean,
): Promise<number> {
  const destAgentsDir = resolve(destRaw);
  const packagedAgentsDir = join(AGENTS_PACK_ROOT, ".agents");
  const packagedHarnessDir = join(
    packagedAgentsDir,
    "harnesses",
    CODE_REVIEW_HARNESS_ID,
  );
  const packagedPolicyPath = join(
    packagedAgentsDir,
    "policies",
    "code-review-readonly.yaml",
  );
  const packagedManifestPath = join(packagedAgentsDir, "manifest.yaml");
  const promptSourceDir = join(
    AGENTS_PACK_ROOT,
    "harnesses",
    CODE_REVIEW_HARNESS_ID,
    "prompts",
  );

  for (const required of [
    join(packagedHarnessDir, "harness.yaml"),
    packagedPolicyPath,
    packagedManifestPath,
    promptSourceDir,
  ]) {
    if (!(await pathExists(required))) {
      console.error(`Missing packaged harness artifact: ${required}`);
      return 1;
    }
  }

  const destHarnessDir = join(
    destAgentsDir,
    "harnesses",
    CODE_REVIEW_HARNESS_ID,
  );
  const destPolicyDir = join(destAgentsDir, "policies");
  const version = readAgentsMonorepoVersion();

  console.log(
    `Installing ${CODE_REVIEW_HARNESS_ID} harness from ${AGENTS_PACK_ROOT} to ${destAgentsDir}`,
  );

  if (!dryRun) {
    await mkdir(destHarnessDir, { recursive: true });
    await mkdir(destPolicyDir, { recursive: true });
    await mkdir(join(destHarnessDir, "prompts"), { recursive: true });
  }

  await copyWithLog(
    packagedManifestPath,
    join(destAgentsDir, "manifest.yaml"),
    dryRun,
  );
  await copyWithLog(
    packagedPolicyPath,
    join(destPolicyDir, "code-review-readonly.yaml"),
    dryRun,
  );

  const rawHarness = await readFile(
    join(packagedHarnessDir, "harness.yaml"),
    "utf8",
  );
  const installedHarness = rawHarness.replaceAll(
    "../../../harnesses/code-review/prompts/",
    "prompts/",
  );
  const harnessDest = join(destHarnessDir, "harness.yaml");
  console.log(`${dryRun ? "Would write" : "Wrote"}: ${harnessDest}`);
  if (!dryRun) {
    await writeFile(harnessDest, installedHarness, "utf8");
  }

  for (const entry of await readdir(promptSourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    await copyWithLog(
      join(promptSourceDir, entry.name),
      join(destHarnessDir, "prompts", basename(entry.name)),
      dryRun,
    );
  }

  const versionDest = join(destHarnessDir, INSTALL_VERSION_FILE);
  console.log(`${dryRun ? "Would write" : "Wrote"}: ${versionDest}`);
  if (!dryRun) {
    await writeFile(versionDest, `${version}\n`, "utf8");
  }

  return 0;
}

export async function runHarnessCli(argv: readonly string[]): Promise<number> {
  const cmd = argv[0];
  if (cmd === undefined || cmd === "--help" || cmd === "-h") {
    printUsage();
    return cmd === undefined ? 1 : 0;
  }
  if (cmd !== "install") {
    console.error(`Unknown harness command: ${cmd}`);
    printUsage();
    return 1;
  }

  const parsed = parseInstallArgs(argv.slice(1));
  if (!parsed.ok) {
    if (parsed.help === true) {
      printUsage();
      return 0;
    }
    console.error(parsed.error);
    return 1;
  }
  if (parsed.harnessId !== CODE_REVIEW_HARNESS_ID) {
    console.error(`Unknown harness id: ${parsed.harnessId}`);
    return 1;
  }
  return await installCodeReviewHarness(parsed.dest, parsed.dryRun);
}
