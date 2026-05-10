#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
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
}>;

function parseArgv(argv: readonly string[]): ParsedCli | null {
  const positionals: string[] = [];
  let push = false;
  let dryRun = false;
  let sign = false;
  let messageFile: string | undefined;

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
            `Usage: bun run scripts/release-annotated-tag.ts -- <semver> [--message-file <path>] [--push] [--sign] [--dry-run]`,
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
      `Usage: bun run scripts/release-annotated-tag.ts -- <semver> [--message-file <path>] [--push] [--sign] [--dry-run]`,
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
  };
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

  if (cli.dryRun) {
    process.stdout.write(`[dry-run] message file: ${templatePath}\n`);
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

  const tagArgs = [
    ...(cli.sign ? (["tag", "-s"] as const) : (["tag", "-a"] as const)),
    tagName,
    "-F",
    "-",
  ];

  if (
    !runGit(git, [...tagArgs], REPO_ROOT, {
      input: Buffer.from(message, "utf8"),
    })
  ) {
    return;
  }

  if (cli.push) {
    runGit(git, ["push", "origin", tagName], REPO_ROOT);
  }
}

main();
