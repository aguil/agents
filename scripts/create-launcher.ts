#!/usr/bin/env bun

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const distDir = "dist";
const launcherPath = join(distDir, "agents");

async function main(): Promise<void> {
  await mkdir(distDir, { recursive: true });

  const launcher = `${[
    "#!/usr/bin/env bun",
    "",
    "import { dirname, resolve } from \"node:path\";",
    "import { fileURLToPath } from \"node:url\";",
    "",
    "const launcherDir = dirname(fileURLToPath(import.meta.url));",
    "const bundlePath = resolve(launcherDir, \"index.js\");",
    "const bundle = await import(bundlePath) as { readonly main?: (argv?: readonly string[]) => Promise<number> };",
    "if (typeof bundle.main !== \"function\") {",
    "  throw new Error(\"Bundled CLI did not export a main() function.\");",
    "}",
    "process.exitCode = await bundle.main(process.argv.slice(2));",
    "",
  ].join("\n")}`;

  await writeFile(launcherPath, launcher, "utf8");
  await chmod(launcherPath, 0o755);
  process.stdout.write(`Created launcher at ${launcherPath}\n`);
}

await main();
