import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  placeholderAdapterPostRefusal,
  replacePendingPullRequestReview,
} from "@aguil/agents-code-review-post";

/**
 * #180: a result from the placeholder `fake` adapter is not posted unless
 * someone passes --allow-fake. The poster is a stub `gh` on PATH that records
 * each call and fails, so a test can see whether posting was reached without
 * touching a real pull request.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleFixture = join(
  repoRoot,
  "tests",
  "fixtures",
  "config-dispatch-bundle.json",
);
const REFUSAL =
  "Refusing to post: this result comes from the placeholder 'fake' adapter, which runs no model, so it is not a review. Re-run with a real adapter (claude, cursor or opencode), or pass --allow-fake to post it anyway.";

/** The poster's first call: it resolves the repository before anything else. */
const POSTER_FIRST_CALL = "repo view --json nameWithOwner";

let dir: string;
let ghLog: string;
let stubBin: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agents-post-placeholder-"));
  ghLog = join(dir, "gh-calls.log");
  stubBin = join(dir, "bin");
  await mkdir(stubBin);
  const gh = join(stubBin, "gh");
  await writeFile(
    gh,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ghLog}'\necho "stubbed poster: refusing to reach GitHub" >&2\nexit 1\n`,
    "utf8",
  );
  await chmod(gh, 0o755);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function runCli(
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: [
      "bun",
      "run",
      join(repoRoot, "packages", "cli", "src", "index.ts"),
      ...args,
    ],
    cwd: dir,
    env: {
      ...Bun.env,
      PATH: [stubBin, Bun.env.PATH ?? ""].join(delimiter),
      XDG_CONFIG_HOME: join(dir, "xdg"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function ghCalls(): Promise<readonly string[]> {
  try {
    return (await readFile(ghLog, "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function writeResult(adapter: string): Promise<string> {
  const path = join(dir, "result.json");
  await writeFile(
    path,
    JSON.stringify({
      runId: "run-placeholder",
      status: "passed",
      findings: [],
      artifacts: [],
      metadata: {
        run_id: "run-placeholder",
        adapter,
        pr_number: "7",
        pr_reviewed_head_sha: "a".repeat(40),
      },
    }),
    "utf8",
  );
  return path;
}

function postArgs(resultPath: string, ...extra: string[]): string[] {
  return [
    "code-review",
    "post",
    "--workspace",
    dir,
    "--result",
    resultPath,
    "--no-confirm",
    ...extra,
  ];
}

test("code-review post refuses a fake result and never reaches the poster", async () => {
  const result = await runCli(postArgs(await writeResult("fake")));

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(REFUSAL);
  expect(await ghCalls()).toEqual([]);
});

test("code-review post --allow-fake reaches the poster with a fake result", async () => {
  const result = await runCli(
    postArgs(await writeResult("fake"), "--allow-fake"),
  );

  expect(result.stderr).not.toContain("Refusing to post");
  expect((await ghCalls())[0]).toBe(POSTER_FIRST_CALL);
});

test("code-review post reaches the poster with a real-adapter result, unchanged", async () => {
  const result = await runCli(postArgs(await writeResult("cursor")));

  expect(result.stderr).not.toContain("Refusing to post");
  expect((await ghCalls())[0]).toBe(POSTER_FIRST_CALL);
});

test("a fake run with --pending-review refuses to post after writing its report", async () => {
  const result = await runCli([
    "code-review",
    "--adapter",
    "fake",
    "--pending-review",
    "--post-pr",
    "7",
    "--workspace",
    dir,
    "--context-bundle",
    bundleFixture,
  ]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(REFUSAL);
  expect(result.stdout).toContain("Report: ");
  expect(await ghCalls()).not.toContain(POSTER_FIRST_CALL);
});

test("the shared guard refuses only a fake result, unless allowed", () => {
  expect(placeholderAdapterPostRefusal({ adapter: "fake" }, undefined)).toBe(
    REFUSAL,
  );
  expect(placeholderAdapterPostRefusal({ adapter: "fake" }, true)).toBe(
    undefined,
  );
  expect(placeholderAdapterPostRefusal({ adapter: "cursor" }, undefined)).toBe(
    undefined,
  );
  // A result with no recorded adapter posts as it did before.
  expect(placeholderAdapterPostRefusal({}, undefined)).toBe(undefined);
  expect(placeholderAdapterPostRefusal(undefined, undefined)).toBe(undefined);
});

test("the poster itself refuses a fake result a caller forgot to check", async () => {
  await expect(
    replacePendingPullRequestReview({
      findings: [],
      prNumber: 7,
      reviewSummaryStyle: "impact",
      noConfirm: true,
      replacePendingReview: false,
      workspacePath: dir,
      runMetadata: { adapter: "fake" },
    }),
  ).rejects.toThrow(REFUSAL);
  expect(await ghCalls()).toEqual([]);
});
