#!/usr/bin/env bun

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const distDir = "dist";

/**
 * Node shebang shim: npm/npx always have Node; Bun may only exist as this
 * package's dependency after `npm install`. Resolve that first, then PATH /
 * BUN_INSTALL, then re-exec the Bun-targeted bundle (import.meta.main).
 */
export function launcherScript(bundleFile: string): string {
  return `${[
    "#!/usr/bin/env node",
    "",
    'import { spawn } from "node:child_process";',
    'import { accessSync, constants as FsConstants } from "node:fs";',
    'import { createRequire } from "node:module";',
    'import { delimiter, dirname, join, resolve } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "",
    "const launcherDir = dirname(fileURLToPath(import.meta.url));",
    `const bundlePath = resolve(launcherDir, "${bundleFile}");`,
    'const bunBinaryName = process.platform === "win32" ? "bun.exe" : "bun";',
    "",
    "function pathExists(candidate) {",
    "  try {",
    "    accessSync(candidate, FsConstants.F_OK);",
    "    return true;",
    "  } catch {",
    "    return false;",
    "  }",
    "}",
    "",
    "function resolveBunExecutable() {",
    "  const candidates = [];",
    "",
    "  try {",
    "    const require = createRequire(import.meta.url);",
    '    const bunPkgDir = dirname(require.resolve("bun/package.json"));',
    '    candidates.push(join(bunPkgDir, "bin", "bun.exe"));',
    '    if (bunBinaryName !== "bun.exe") {',
    '      candidates.push(join(bunPkgDir, "bin", bunBinaryName));',
    "    }",
    "  } catch {",
    "    // Dependency not installed (local dist/ without npm pack deps).",
    "  }",
    "",
    "  const bunInstall = process.env.BUN_INSTALL;",
    '  if (typeof bunInstall === "string" && bunInstall.length > 0) {',
    '    candidates.push(join(bunInstall, "bin", bunBinaryName));',
    "  }",
    "",
    '  const pathEnv = process.env.PATH ?? "";',
    "  for (const dir of pathEnv.split(delimiter)) {",
    "    if (dir.length === 0) {",
    "      continue;",
    "    }",
    "    candidates.push(join(dir, bunBinaryName));",
    "  }",
    "",
    "  for (const candidate of candidates) {",
    "    if (pathExists(candidate)) {",
    "      return candidate;",
    "    }",
    "  }",
    "  return null;",
    "}",
    "",
    "const bunBin = resolveBunExecutable();",
    "if (bunBin === null) {",
    "  console.error(",
    '    "@aguil/agents requires Bun >= 1.3.13 to run, but no bun executable was found.",',
    "  );",
    "  console.error(",
    '    "Reinstall the package (npm install -g @aguil/agents) so the bun dependency is present,",',
    "  );",
    '  console.error("or install Bun from https://bun.sh and ensure it is on PATH.");',
    "  process.exitCode = 1;",
    "} else {",
    "  const child = spawn(bunBin, [bundlePath, ...process.argv.slice(2)], {",
    '    stdio: "inherit",',
    "    env: process.env,",
    "  });",
    '  child.on("error", (err) => {',
    '    console.error("Failed to start Bun at " + bunBin + ": " + err.message);',
    "    process.exitCode = 1;",
    "  });",
    '  child.on("exit", (code, signal) => {',
    "    if (signal) {",
    "      process.kill(process.pid, signal);",
    "      return;",
    "    }",
    "    process.exitCode = code ?? 1;",
    "  });",
    "}",
    "",
  ].join("\n")}`;
}

async function main(): Promise<void> {
  await mkdir(distDir, { recursive: true });

  const agentsPath = join(distDir, "agents");
  await writeFile(agentsPath, launcherScript("index.js"), "utf8");
  await chmod(agentsPath, 0o755);
  process.stdout.write(`Created launcher at ${agentsPath}\n`);

  const agentsdPath = join(distDir, "agentsd");
  await writeFile(agentsdPath, launcherScript("agentsd.js"), "utf8");
  await chmod(agentsdPath, 0o755);
  process.stdout.write(`Created launcher at ${agentsdPath}\n`);
}

if (import.meta.main) {
  await main();
}
