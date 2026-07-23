#!/usr/bin/env bun

import { constants as FsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(SCRIPT_PATH));
const DEFAULT_OUT_DIR = ".npm-publish-pack";

type ManifestShape = Record<string, unknown>;

function stripLeadingV(value: string): string {
  return value.startsWith("v") ? value.slice(1) : value;
}

function resolveVersion(cliVersion: string | undefined): string {
  if (cliVersion !== undefined && cliVersion.length > 0) {
    return stripLeadingV(cliVersion);
  }
  const env = process.env.NPM_PUBLISH_VERSION;
  if (env !== undefined && env.length > 0) {
    return stripLeadingV(env);
  }

  console.error(
    "Missing semver for the publishable tarball. Provide one of:\n" +
      "  bun run scripts/prepare-npm-publish.ts -- --version 1.2.3\n" +
      "  NPM_PUBLISH_VERSION=1.2.3 bun run scripts/prepare-npm-publish.ts",
  );
  process.exitCode = 2;
  return "";
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate, FsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseArgvSlice(argv: readonly string[]): Map<string, string | true> {
  const map = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === "--") {
      continue;
    }
    if (tok.startsWith("--")) {
      const eqIdx = tok.indexOf("=");
      if (eqIdx !== -1) {
        map.set(tok.slice(2, eqIdx), tok.slice(eqIdx + 1));
      } else {
        const flag = tok.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          map.set(flag, true);
        } else {
          map.set(flag, next);
          i += 1;
        }
      }
    }
  }
  return map;
}

async function main(): Promise<void> {
  const flags = parseArgvSlice(Bun.argv.slice(2));

  const cliVersionCandidate = flags.get("version");
  const cliVersion =
    typeof cliVersionCandidate === "string" ? cliVersionCandidate : undefined;

  const outRelative =
    typeof flags.get("outdir") === "string"
      ? (flags.get("outdir") as string)
      : DEFAULT_OUT_DIR;

  const version = resolveVersion(cliVersion);
  if (version.length === 0) {
    return;
  }

  const semverMatch =
    /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/u.test(
      version,
    );
  if (!semverMatch) {
    console.error(`Refusing suspicious version string: "${version}".`);
    process.exitCode = 2;
    return;
  }

  const outDir = join(REPO_ROOT, outRelative);

  const distAgentsSource = join(REPO_ROOT, "dist", "agents");
  const distBundleSource = join(REPO_ROOT, "dist", "index.js");

  if (
    !(await pathExists(distAgentsSource)) ||
    !(await pathExists(distBundleSource))
  ) {
    console.error(
      "Missing bundled CLI under dist/. Run `bun run build` before preparing npm publish artifacts.",
    );
    process.exitCode = 2;
    return;
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, "dist"), { recursive: true });

  await copyFile(distAgentsSource, join(outDir, "dist", "agents"));
  await copyFile(distBundleSource, join(outDir, "dist", "index.js"));
  await chmod(join(outDir, "dist", "agents"), 0o755);

  const manifestPath = join(
    REPO_ROOT,
    "distribution",
    "npm",
    "cli-package.manifest.json",
  );
  const manifestJson = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as ManifestShape;
  const publishableManifest: ManifestShape = {
    ...manifestJson,
    version,
  };

  await writeFile(
    join(outDir, "package.json"),
    `${JSON.stringify(publishableManifest, null, 2)}\n`,
    "utf8",
  );

  const readmeNpmSource = join(REPO_ROOT, "README.npm.md");
  const readmeNpmFallback = join(REPO_ROOT, "README.md");
  if (await pathExists(readmeNpmSource)) {
    await copyFile(readmeNpmSource, join(outDir, "README.md"));
  } else if (await pathExists(readmeNpmFallback)) {
    await copyFile(readmeNpmFallback, join(outDir, "README.md"));
  } else {
    await writeFile(
      join(outDir, "README.md"),
      `# @aguil/agents\n\nSee the repository README for detailed usage.\n`,
      "utf8",
    );
  }

  const licenseSource = join(REPO_ROOT, "LICENSE");
  if (!(await pathExists(licenseSource))) {
    console.error(
      `Missing LICENSE at ${licenseSource}; npm publishes require an explicit license file.`,
    );
    process.exitCode = 2;
    return;
  }
  await copyFile(licenseSource, join(outDir, "LICENSE"));

  const docsSkillsSource = join(REPO_ROOT, "docs", "skills");
  if (await pathExists(docsSkillsSource)) {
    await cp(docsSkillsSource, join(outDir, "docs", "skills"), {
      recursive: true,
    });
  } else {
    console.error(
      `Missing docs/skills at ${docsSkillsSource}; agents skills requires this tree in the publish pack.`,
    );
    process.exitCode = 2;
    return;
  }

  const agentsConfigSource = join(REPO_ROOT, ".agents");
  if (await pathExists(agentsConfigSource)) {
    await cp(agentsConfigSource, join(outDir, ".agents"), {
      recursive: true,
    });
  } else {
    console.error(
      `Missing .agents at ${agentsConfigSource}; the packaged code-review harness is required for agents code-review.`,
    );
    process.exitCode = 2;
    return;
  }

  const codeReviewPromptsSource = join(
    REPO_ROOT,
    "harnesses",
    "code-review",
    "prompts",
  );
  if (await pathExists(codeReviewPromptsSource)) {
    await cp(
      codeReviewPromptsSource,
      join(outDir, "harnesses", "code-review", "prompts"),
      {
        recursive: true,
      },
    );
  } else {
    console.error(
      `Missing code-review prompts at ${codeReviewPromptsSource}; packaged harness prompt_path references require this tree.`,
    );
    process.exitCode = 2;
    return;
  }

  console.log(`Prepared npm publish tarball contents at ${outDir}`);
}

await main();
