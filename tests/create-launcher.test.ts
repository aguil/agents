import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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

const nodeBin = Bun.which("node");
const canRunLauncher = nodeBin !== null && process.platform !== "win32";

// First line of the real bun@1.3.13 bin/bun.exe placeholder.
const bunPlaceholder =
  'echo "Error: Bun\'s postinstall script was not run." >&2\nexit 1\n';

function fakeBun(label: string): string {
  return `#!/bin/sh\necho "${label} $@"\n`;
}

interface LauncherFixture {
  /** Contents and mode of node_modules/bun/bin/bun.exe; omit for no dependency. */
  packageBun?: { contents: string; mode: number };
  pathBun?: boolean;
}

async function runLauncher(fixture: LauncherFixture): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  root: string;
}> {
  // realpath: require.resolve reports the symlink-free path (macOS /private).
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agents-launcher-")),
  );
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist", "agents"), launcherScript("index.js"));
  await writeFile(join(root, "dist", "index.js"), "");

  if (fixture.packageBun !== undefined) {
    const binDir = join(root, "node_modules", "bun", "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(root, "node_modules", "bun", "package.json"),
      '{"name":"bun","version":"1.3.13"}\n',
    );
    const exe = join(binDir, "bun.exe");
    await writeFile(exe, fixture.packageBun.contents);
    await chmod(exe, fixture.packageBun.mode);
  }

  // A directory named "bun" earlier on PATH must not be picked.
  const dirDecoy = join(root, "decoy");
  await mkdir(join(dirDecoy, "bun"), { recursive: true });
  const pathBin = join(root, "pathbin");
  await mkdir(pathBin);
  if (fixture.pathBun === true) {
    await writeFile(join(pathBin, "bun"), fakeBun("path-bun"));
    await chmod(join(pathBin, "bun"), 0o755);
  }

  const proc = Bun.spawn(
    [nodeBin as string, join(root, "dist", "agents"), "--version"],
    {
      env: { PATH: [dirDecoy, pathBin].join(delimiter) },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  await rm(root, { recursive: true, force: true });
  return { exitCode, stdout, stderr, root };
}

describe.skipIf(!canRunLauncher)("launcher bun resolution", () => {
  test("skips a non-executable placeholder and uses bun on PATH", async () => {
    const result = await runLauncher({
      packageBun: { contents: bunPlaceholder, mode: 0o644 },
      pathBun: true,
    });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("path-bun");
    expect(result.stdout).toContain("--version");
    expect(result.exitCode).toBe(0);
  });

  test("skips a placeholder that the installer marked executable", async () => {
    const result = await runLauncher({
      packageBun: { contents: bunPlaceholder, mode: 0o755 },
      pathBun: true,
    });
    expect(result.stdout).toContain("path-bun");
    expect(result.exitCode).toBe(0);
  });

  test("prefers a working bun dependency over PATH", async () => {
    const result = await runLauncher({
      packageBun: { contents: fakeBun("package-bun"), mode: 0o755 },
      pathBun: true,
    });
    expect(result.stdout).toContain("package-bun");
    expect(result.exitCode).toBe(0);
  });

  test("names the skipped postinstall when no other bun exists", async () => {
    const result = await runLauncher({
      packageBun: { contents: bunPlaceholder, mode: 0o644 },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("without its postinstall script");
    expect(result.stderr).toContain(
      `cd ${join(result.root, "node_modules", "bun")} && node install.js`,
    );
  });

  test("reports a missing bun when nothing is installed", async () => {
    const result = await runLauncher({});
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no bun executable was found");
    expect(result.stderr).not.toContain("postinstall");
  });
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
