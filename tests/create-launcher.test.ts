import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launcherScript } from "../scripts/create-launcher";

test("launcherScript uses a Node shebang and resolves the bun dependency", () => {
  const script = launcherScript("index.js");
  expect(script.startsWith("#!/usr/bin/env node\n")).toBe(true);
  expect(script).toContain('require.resolve("bun/package.json")');
  expect(script).toContain('join(bunPkgDir, "bin", "bun.exe")');
  expect(script).toContain('resolve(launcherDir, "index.js")');
  expect(script).toContain(
    "spawn(bunBin, [bundlePath, ...process.argv.slice(2)]",
  );
  expect(script).not.toContain("#!/usr/bin/env bun");
});

test("launcherScript embeds the requested bundle file name", () => {
  const agentsd = launcherScript("agentsd.js");
  expect(agentsd).toContain('resolve(launcherDir, "agentsd.js")');
  expect(agentsd).not.toContain('resolve(launcherDir, "index.js")');
});

test("npm publish manifest depends on bun so fresh installs get a runtime", async () => {
  const manifestPath = join(
    import.meta.dir,
    "..",
    "distribution",
    "npm",
    "cli-package.manifest.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    dependencies?: Record<string, string>;
    engines?: Record<string, string>;
    bin?: Record<string, string>;
  };
  expect(manifest.dependencies?.bun).toBe("1.3.13");
  expect(manifest.engines?.bun).toBe(">=1.3.13");
  expect(manifest.engines?.node).toBe(">=20");
  expect(manifest.bin?.agents).toBe("./dist/agents");
});
