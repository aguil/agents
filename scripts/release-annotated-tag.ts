#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(SCRIPT_PATH));
const DEFAULT_MESSAGE_FILE_RELATIVE = join(
  "distribution",
  "npm",
  "release-tag-message.local",
);
const EXAMPLE_MESSAGE_RELATIVE = join(
  "distribution",
  "npm",
  "release-tag-message.template.example",
);

/** Same acceptance pattern as scripts/prepare-npm-publish.ts. */
function isSemverTriple(version: string): boolean {
  return /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/u.test(
    version,
  );
}

function stripLeadingV(value: string): string {
  return value.startsWith("v") ? value.slice(1) : value;
}

function stripLeadingHashCommentLines(template: string): string {
  const lines = template.split("\n");
  let start = 0;
  while (start < lines.length && lines[start].trimStart().startsWith("#")) {
    start += 1;
  }
  return lines
    .slice(start)
    .join("\n")
    .replace(/^\s*\n+/u, "");
}

function countVersionPlaceholders(template: string): number {
  const needle = "VERSION";
  let count = 0;
  let from = 0;
  while (from < template.length) {
    const idx = template.indexOf(needle, from);
    if (idx === -1) {
      break;
    }
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

function resolveMessageFilePath(explicit: string | undefined): string {
  if (explicit === undefined) {
    return join(REPO_ROOT, DEFAULT_MESSAGE_FILE_RELATIVE);
  }
  return isAbsolute(explicit) ? explicit : join(REPO_ROOT, explicit);
}

function describeMissingMessageFile(templatePath: string): void {
  const examplePath = join(REPO_ROOT, EXAMPLE_MESSAGE_RELATIVE);
  console.error(`Missing tag message file:\n  ${templatePath}\n`);
  if (existsSync(examplePath)) {
    console.error(
      `Create it from the committed format contract (then edit; not committed):\n` +
        `  cp ${EXAMPLE_MESSAGE_RELATIVE} ${DEFAULT_MESSAGE_FILE_RELATIVE}\n`,
    );
  }
  console.error(
    `Or pass a UTF-8 file that contains VERSION exactly once:\n` +
      `  bun run release:tag -- <semver> --message-file /path/to/message.txt`,
  );
}

function resolveTagMessage(
  templatePath: string,
  versionDigits: string,
): string | null {
  if (!existsSync(templatePath)) {
    describeMissingMessageFile(templatePath);
    process.exitCode = 2;
    return null;
  }

  let rawText: string;
  try {
    rawText = readFileSync(templatePath, "utf8");
  } catch (err) {
    console.error(`Could not read ${templatePath}`, err);
    process.exitCode = 2;
    return null;
  }

  const withoutComments = stripLeadingHashCommentLines(rawText.trimEnd());

  const count = countVersionPlaceholders(withoutComments);
  if (count !== 1) {
    console.error(
      `Message file must contain VERSION exactly once (after stripping leading # comment lines); found ${count} in ${templatePath}`,
    );
    process.exitCode = 2;
    return null;
  }

  const message = withoutComments.replaceAll("VERSION", versionDigits);
  if (message.includes("VERSION")) {
    console.error(
      `After substitution VERSION still appeared in annotation (check message file): ${templatePath}`,
    );
    process.exitCode = 2;
    return null;
  }

  return `${message.trimEnd()}\n`;
}

type ParsedCli = Readonly<{
  versionDigits: string;
  push: boolean;
  dryRun: boolean;
  sign: boolean;
  messageFileRelativeOrAbsolute?: string;
  gitCwd?: string;
}>;

function parseArgv(argv: readonly string[]): ParsedCli | null {
  const positionals: string[] = [];
  let push = false;
  let dryRun = false;
  let sign = false;
  let messageFile: string | undefined;
  let gitCwd: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === "--") {
      continue;
    }
    if (tok.startsWith("--")) {
      const eqIdx = tok.indexOf("=");
      const flag = eqIdx !== -1 ? tok.slice(2, eqIdx) : tok.slice(2);
      const inline = eqIdx !== -1 ? tok.slice(eqIdx + 1) : undefined;

      if (flag === "message-file") {
        if (inline !== undefined) {
          messageFile = inline;
        } else {
          const next = argv[i + 1];
          if (next === undefined || next.startsWith("--")) {
            console.error(`--message-file requires a path`);
            process.exitCode = 2;
            return null;
          }
          messageFile = next;
          i += 1;
        }
        continue;
      }

      if (flag === "git-cwd") {
        if (inline !== undefined) {
          gitCwd = inline;
        } else {
          const next = argv[i + 1];
          if (next === undefined || next.startsWith("--")) {
            console.error(`--git-cwd requires a path`);
            process.exitCode = 2;
            return null;
          }
          gitCwd = next;
          i += 1;
        }
        continue;
      }

      const asFlag = eqIdx !== -1 ? `--${flag}` : tok;
      switch (asFlag) {
        case "--push":
          push = true;
          break;
        case "--dry-run":
          dryRun = true;
          break;
        case "--sign":
          sign = true;
          break;
        default:
          console.error(`Unknown flag: ${tok}`);
          console.error(
            `Usage: bun run scripts/release-annotated-tag.ts -- <semver> [--message-file <path>] [--git-cwd <path>] [--push] [--sign] [--dry-run]`,
          );
          process.exitCode = 2;
          return null;
      }
      continue;
    }
    positionals.push(tok);
  }

  if (positionals.length !== 1) {
    if (positionals.length === 0) {
      console.error(
        `Missing semver (digits only preferred, optional leading 'v'): e.g. 0.1.0`,
      );
    } else {
      console.error(
        `Expected exactly one semver argument; got ${positionals.length}.`,
      );
    }
    console.error(
      `Usage: bun run scripts/release-annotated-tag.ts -- <semver> [--message-file <path>] [--git-cwd <path>] [--push] [--sign] [--dry-run]`,
    );
    process.exitCode = 2;
    return null;
  }

  const versionDigits = stripLeadingV(positionals[0] ?? "");
  if (versionDigits.length === 0) {
    console.error(`Empty semver after stripping optional leading v.`);
    process.exitCode = 2;
    return null;
  }

  if (!isSemverTriple(versionDigits)) {
    console.error(`Refusing suspicious version string: "${versionDigits}".`);
    process.exitCode = 2;
    return null;
  }

  return {
    versionDigits,
    push,
    dryRun,
    sign,
    messageFileRelativeOrAbsolute: messageFile,
    gitCwd,
  };
}

function isInsideGitWorkTree(git: string, cwd: string): boolean {
  const result = spawnSync(git, ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0 && result.stdout?.trim() === "true";
}

/**
 * Jujutsu stores the repo database at `<working-tree>/.jj/repo`.
 * In a linked workspace, `.jj/repo` is a **file** whose contents are a path (often relative to
 * the workspace root) to the backing `.jj/repo` **directory**. The git working tree is two levels
 * above that directory (`…/repo` → `…/.jj` → working tree root).
 */
function workingTreeFromJjRepoStore(storePath: string): string {
  return dirname(dirname(storePath));
}

function discoverGitRootViaJjWorkspace(startDir: string): string | null {
  let dir = resolvePath(startDir);
  while (true) {
    const jjRepo = join(dir, ".jj", "repo");
    if (existsSync(jjRepo)) {
      try {
        const st = statSync(jjRepo);
        if (st.isDirectory()) {
          return dir;
        }
        if (st.isFile()) {
          const raw = readFileSync(jjRepo, "utf8").trim();
          if (raw.length === 0) {
            return null;
          }
          const storePath = resolveJjPointerToRepoStore(dir, raw);
          if (storePath === null) {
            return null;
          }
          return workingTreeFromJjRepoStore(storePath);
        }
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

function resolveJjPointerToRepoStore(
  workspaceRoot: string,
  raw: string,
): string | null {
  const candidates = isAbsolute(raw)
    ? [resolvePath(raw)]
    : [
        resolvePath(workspaceRoot, raw),
        resolvePath(join(workspaceRoot, ".jj"), raw),
      ];

  for (const normalized of candidates) {
    if (!existsSync(normalized)) {
      continue;
    }
    const targetSt = statSync(normalized);
    if (targetSt.isDirectory()) {
      return normalized;
    }
  }
  return null;
}

function resolveGitCwd(
  cliGitCwd: string | undefined,
  git: string,
): string | null {
  const raw =
    cliGitCwd !== undefined && cliGitCwd.length > 0
      ? cliGitCwd
      : process.env.RELEASE_TAG_GIT_CWD?.trim();
  if (raw !== undefined && raw.length > 0) {
    const resolved = isAbsolute(raw)
      ? resolvePath(raw)
      : resolvePath(process.cwd(), raw);
    if (!existsSync(resolved)) {
      console.error(
        `--git-cwd / RELEASE_TAG_GIT_CWD path does not exist:\n  ${resolved}`,
      );
      process.exitCode = 2;
      return null;
    }
    return resolved;
  }

  if (isInsideGitWorkTree(git, REPO_ROOT)) {
    return REPO_ROOT;
  }

  const triedStarts = new Set<string>();
  for (const start of [process.cwd(), REPO_ROOT]) {
    const key = resolvePath(start);
    if (triedStarts.has(key)) {
      continue;
    }
    triedStarts.add(key);
    const fromJj = discoverGitRootViaJjWorkspace(start);
    if (fromJj !== null && isInsideGitWorkTree(git, fromJj)) {
      return fromJj;
    }
  }

  return REPO_ROOT;
}

function assertGitWorkTree(git: string, cwd: string): boolean {
  const ok = isInsideGitWorkTree(git, cwd);
  if (!ok) {
    console.error(
      `Not a git working tree (no .git reachable from):\n  ${cwd}\n`,
    );
    console.error(
      `Run from your canonical clone, or set the repo where tags should be created:\n` +
        `  bun run release:tag -- 0.1.0 --git-cwd /path/to/aguil/agents\n` +
        `  # or: RELEASE_TAG_GIT_CWD=/path/to/aguil/agents bun run release:tag -- 0.1.0\n`,
    );
    console.error(
      `(If you use a jj workspace with a .jj/repo pointer file, run from that tree so the path can be resolved; or pass --git-cwd explicitly.)\n`,
    );
    process.exitCode = 128;
    return false;
  }
  return true;
}

function runGit(
  git: string,
  args: readonly string[],
  cwd: string,
  options?: Readonly<{ input?: Buffer }>,
): boolean {
  const result = spawnSync(git, [...args], {
    cwd,
    stdio:
      options?.input !== undefined
        ? ["pipe", "inherit", "inherit"]
        : ["inherit", "inherit", "inherit"],
    input: options?.input,
  });
  const code = typeof result.status === "number" ? result.status : 1;
  if (code !== 0) {
    process.exitCode = code || 1;
    return false;
  }
  return true;
}

function main(): void {
  const cli = parseArgv(Bun.argv.slice(2));
  if (cli === null) {
    return;
  }

  const templatePath = resolveMessageFilePath(
    cli.messageFileRelativeOrAbsolute,
  );
  const message = resolveTagMessage(templatePath, cli.versionDigits);
  if (message === null) {
    return;
  }

  const tagName = `v${cli.versionDigits}`;
  const git = process.env.GIT ?? "git";

  const gitCwd = resolveGitCwd(cli.gitCwd, git);
  if (gitCwd === null) {
    return;
  }

  if (cli.dryRun) {
    process.stdout.write(`[dry-run] message file: ${templatePath}\n`);
    process.stdout.write(`[dry-run] git working directory: ${gitCwd}\n`);
    process.stdout.write(`[dry-run] tag annotation message:\n\n${message}\n`);
    const tagArgs = [
      ...(cli.sign ? (["tag", "-s"] as const) : (["tag", "-a"] as const)),
      tagName,
      "-F",
      "-",
    ];
    process.stdout.write(
      `\n[dry-run] ${git} ${tagArgs.map((part) => (/\s/u.test(part) ? JSON.stringify(part) : part)).join(" ")} <stdin:message>\n`,
    );
    if (cli.push) {
      process.stdout.write(`[dry-run] ${git} push origin ${tagName}\n`);
    }
    return;
  }

  if (!assertGitWorkTree(git, gitCwd)) {
    return;
  }

  const tagArgs = [
    ...(cli.sign ? (["tag", "-s"] as const) : (["tag", "-a"] as const)),
    tagName,
    "-F",
    "-",
  ];

  if (
    !runGit(git, [...tagArgs], gitCwd, {
      input: Buffer.from(message, "utf8"),
    })
  ) {
    return;
  }

  if (cli.push) {
    runGit(git, ["push", "origin", tagName], gitCwd);
  }
}

main();
