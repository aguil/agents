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
import { createInterface } from "node:readline/promises";
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

function isYes(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

async function confirmOverwrite(
  existingPaths: readonly string[],
): Promise<boolean> {
  const rendered =
    existingPaths.length === 1
      ? existingPaths[0]
      : `\n${existingPaths.map((path) => `  - ${path}`).join("\n")}`;
  const message = `${CODE_REVIEW_HARNESS_ID} install would replace existing file${existingPaths.length === 1 ? "" : "s"} at ${rendered}. Overwrite? [y/N] `;
  if (process.stdin.isTTY) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      return isYes(await rl.question(message));
    } finally {
      rl.close();
    }
  }

  process.stderr.write(message);
  const raw = await Bun.stdin.text();
  process.stderr.write("\n");
  return isYes(raw.split(/\r?\n/, 1)[0]);
}

async function existingPaths(
  paths: readonly string[],
): Promise<readonly string[]> {
  const found: string[] = [];
  for (const path of paths) {
    if (await pathExists(path)) {
      found.push(path);
    }
  }
  return found;
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
  const harnessDest = join(destHarnessDir, "harness.yaml");
  const manifestDest = join(destAgentsDir, "manifest.yaml");
  const policyDest = join(destPolicyDir, "code-review-readonly.yaml");
  const promptDestDir = join(destHarnessDir, "prompts");
  const promptEntries = (
    await readdir(promptSourceDir, { withFileTypes: true })
  )
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name);
  const promptDests = promptEntries.map((entryName) =>
    join(promptDestDir, basename(entryName)),
  );
  const versionDest = join(destHarnessDir, INSTALL_VERSION_FILE);
  const pathsToWrite = [
    join(destAgentsDir, "manifest.yaml"),
    policyDest,
    harnessDest,
    ...promptDests,
    versionDest,
  ];

  console.log(
    `Installing ${CODE_REVIEW_HARNESS_ID} harness from ${AGENTS_PACK_ROOT} to ${destAgentsDir}`,
  );

  const pathsThatWouldBeReplaced = await existingPaths(pathsToWrite);
  if (pathsThatWouldBeReplaced.length > 0) {
    if (dryRun) {
      console.log(
        `Existing code-review harness files detected; install would prompt before overwriting ${pathsThatWouldBeReplaced.length} file${pathsThatWouldBeReplaced.length === 1 ? "" : "s"}.`,
      );
    } else if (!(await confirmOverwrite(pathsThatWouldBeReplaced))) {
      console.error(
        "Install aborted; existing code-review harness files left unchanged.",
      );
      return 1;
    }
  }

  if (!dryRun) {
    await mkdir(destHarnessDir, { recursive: true });
    await mkdir(destPolicyDir, { recursive: true });
    await mkdir(join(destHarnessDir, "prompts"), { recursive: true });
  }

  await copyWithLog(packagedManifestPath, manifestDest, dryRun);
  await copyWithLog(packagedPolicyPath, policyDest, dryRun);

  const rawHarness = await readFile(
    join(packagedHarnessDir, "harness.yaml"),
    "utf8",
  );
  const installedHarness = rawHarness.replaceAll(
    "../../../harnesses/code-review/prompts/",
    "prompts/",
  );
  console.log(`${dryRun ? "Would write" : "Wrote"}: ${harnessDest}`);
  if (!dryRun) {
    await writeFile(harnessDest, installedHarness, "utf8");
  }

  for (const entryName of promptEntries) {
    await copyWithLog(
      join(promptSourceDir, entryName),
      join(promptDestDir, basename(entryName)),
      dryRun,
    );
  }

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
