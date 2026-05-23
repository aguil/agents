#!/usr/bin/env bun

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const distDir = "dist";

function launcherScript(bundleFile: string): string {
  return `${[
    "#!/usr/bin/env bun",
    "",
    'import { dirname, resolve } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "",
    "const launcherDir = dirname(fileURLToPath(import.meta.url));",
    `const bundlePath = resolve(launcherDir, "${bundleFile}");`,
    "const bundle = await import(bundlePath) as { readonly main?: (argv?: readonly string[]) => Promise<number> };",
    'if (typeof bundle.main !== "function") {',
    '  throw new Error("Bundled entry did not export a main() function.");',
    "}",
    "process.exitCode = await bundle.main(process.argv.slice(2));",
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

await main();
