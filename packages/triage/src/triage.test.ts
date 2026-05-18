import { expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Finding } from "@aguil/agents-core";
import {
  AGENTS_CODE_REVIEW_DIR,
  LEGACY_AGENTS_CODE_REVIEW_DIR,
} from "@aguil/agents-core";
import {
  discoverLatestCodeReviewResultPath,
  discoverLatestRunsCodeReviewResultPath,
} from "./discover-code-review-result";
import { canonicalKeyForCodeReviewArtifact } from "./ingest-code-review";
import { computeOutputSlug, fingerprint12 } from "./output-slug";
import { assertOutputDirectoryWillResolveInsideWorkspace } from "./safe-path";
import { sortReviewFindings } from "./sort-items";

test("fingerprint12 is stable hex12 over utf8 ingress key", () => {
  const key = "/abs/path/result.json";
  expect(fingerprint12(key)).toBe(fingerprint12(key));
  expect(fingerprint12(key)).not.toBe(fingerprint12(`${key}!`));
  expect(fingerprint12(key)).toMatch(/^[0-9a-f]{12}$/);
});

test("computeOutputSlug joins sanitized producer and fingerprint", () => {
  const slug = computeOutputSlug("code-review", "/x/result.json");
  expect(slug.startsWith("code-review-")).toBe(true);
  expect(slug.slice("code-review-".length)).toBe(
    fingerprint12("/x/result.json"),
  );
});

test("computeOutputSlug rejects invalid producer slugs", () => {
  expect(() => computeOutputSlug("Code Review", "/k")).toThrow(
    "Invalid --from slug",
  );
  expect(() => computeOutputSlug("foo_bar", "/k")).toThrow(
    "Invalid --from slug",
  );
});

test("canonicalKeyForCodeReviewArtifact normalizes to absolute path", () => {
  const k = canonicalKeyForCodeReviewArtifact("/tmp/./x/../y/result.json");
  expect(k).toContain("y");
  expect(k.startsWith("/")).toBe(true);
});

test("discoverLatestCodeReviewResultPath merges dry-run + runs newest id", async () => {
  const base = await mkdtemp(join(tmpdir(), "agents-triage-discover-"));
  const ws = join(base, "ws");
  await mkdir(
    join(ws, AGENTS_CODE_REVIEW_DIR, "runs", "code-review-AAA-result"),
    {
      recursive: true,
    },
  );
  await mkdir(
    join(ws, AGENTS_CODE_REVIEW_DIR, "dry-run", "code-review-ZZZ-result"),
    {
      recursive: true,
    },
  );
  await writeFile(
    join(
      ws,
      AGENTS_CODE_REVIEW_DIR,
      "runs",
      "code-review-AAA-result",
      "result.json",
    ),
    "{}",
    "utf8",
  );
  await writeFile(
    join(
      ws,
      AGENTS_CODE_REVIEW_DIR,
      "dry-run",
      "code-review-ZZZ-result",
      "result.json",
    ),
    "{}",
    "utf8",
  );
  const p = await discoverLatestCodeReviewResultPath(ws);
  expect(
    typeof p === "string" &&
      p.includes(join(AGENTS_CODE_REVIEW_DIR, "dry-run")),
  ).toBe(true);
  expect(typeof p === "string" && p.includes("code-review-ZZZ-result")).toBe(
    true,
  );
});

test("discoverLatestRunsCodeReviewResultPath prefers newer mtime over lex tie-break", async () => {
  const base = await mkdtemp(join(tmpdir(), "agents-triage-discover-mtime-"));
  const ws = join(base, "ws");
  const runsRoot = join(ws, AGENTS_CODE_REVIEW_DIR, "runs");
  const lexHigh = join(runsRoot, "code-review-20991202000000-high-lex");
  const lexLow = join(runsRoot, "code-review-20991201000000-low-lex");
  await mkdir(lexHigh, { recursive: true });
  await mkdir(lexLow, { recursive: true });
  const highPath = join(lexHigh, "result.json");
  const lowPath = join(lexLow, "result.json");
  await writeFile(highPath, "{}", "utf8");
  await writeFile(lowPath, "{}", "utf8");
  await utimes(highPath, new Date(2020, 0, 1), new Date(2020, 0, 1));
  await utimes(lowPath, new Date(2040, 0, 1), new Date(2040, 0, 1));
  const p = await discoverLatestRunsCodeReviewResultPath(ws);
  expect(
    typeof p === "string" && p.includes("code-review-20991201000000-low-lex"),
  ).toBe(true);
});

test("discoverLatestRunsCodeReviewResultPath agrees with valid pointer when sole run", async () => {
  const base = await mkdtemp(join(tmpdir(), "agents-triage-pointer-"));
  const ws = join(base, "ws");
  const runsRoot = join(ws, AGENTS_CODE_REVIEW_DIR, "runs");
  const dirA = join(runsRoot, "code-review-20990101000000-a");
  await mkdir(dirA, { recursive: true });
  const resultPath = join(dirA, "result.json");
  await writeFile(resultPath, "{}", "utf8");
  await writeFile(
    join(runsRoot, ".code-review-latest-result"),
    `${resultPath}\n`,
    "utf8",
  );
  const p = await discoverLatestRunsCodeReviewResultPath(ws);
  expect(p).toBe(resultPath);
});

test("discoverLatestRunsCodeReviewResultPath prefers newer run over stale pointer", async () => {
  const base = await mkdtemp(join(tmpdir(), "agents-triage-stale-pointer-"));
  const ws = join(base, "ws");
  const runsRoot = join(ws, AGENTS_CODE_REVIEW_DIR, "runs");
  const dirOld = join(runsRoot, "code-review-20990101000000-old");
  const dirNew = join(runsRoot, "code-review-20990102000000-new");
  await mkdir(dirOld, { recursive: true });
  await mkdir(dirNew, { recursive: true });
  const oldPath = join(dirOld, "result.json");
  const newPath = join(dirNew, "result.json");
  await writeFile(oldPath, "{}", "utf8");
  await writeFile(newPath, "{}", "utf8");
  await utimes(oldPath, new Date(2020, 0, 1), new Date(2020, 0, 1));
  await utimes(newPath, new Date(2040, 0, 1), new Date(2040, 0, 1));
  await writeFile(
    join(runsRoot, ".code-review-latest-result"),
    `${oldPath}\n`,
    "utf8",
  );
  const p = await discoverLatestRunsCodeReviewResultPath(ws);
  expect(p).toBe(newPath);
});

test("discoverLatestRunsCodeReviewResultPath ignores pointer when AGENTS_CODE_REVIEW_DISCOVER_FULL_SCAN=1", async () => {
  const prev = process.env.AGENTS_CODE_REVIEW_DISCOVER_FULL_SCAN;
  process.env.AGENTS_CODE_REVIEW_DISCOVER_FULL_SCAN = "1";
  try {
    const base = await mkdtemp(join(tmpdir(), "agents-triage-pointer-full-"));
    const ws = join(base, "ws");
    const runsRoot = join(ws, AGENTS_CODE_REVIEW_DIR, "runs");
    const dirLo = join(runsRoot, "code-review-20991201000000-lo");
    const dirHi = join(runsRoot, "code-review-20991202000000-hi");
    await mkdir(dirLo, { recursive: true });
    await mkdir(dirHi, { recursive: true });
    const loPath = join(dirLo, "result.json");
    const hiPath = join(dirHi, "result.json");
    await writeFile(loPath, "{}", "utf8");
    await writeFile(hiPath, "{}", "utf8");
    await utimes(loPath, new Date(2040, 0, 1), new Date(2040, 0, 1));
    await utimes(hiPath, new Date(2020, 0, 1), new Date(2020, 0, 1));
    await writeFile(
      join(runsRoot, ".code-review-latest-result"),
      `${hiPath}\n`,
      "utf8",
    );
    const p = await discoverLatestRunsCodeReviewResultPath(ws);
    expect(p).toBe(loPath);
  } finally {
    if (prev === undefined) {
      delete process.env.AGENTS_CODE_REVIEW_DISCOVER_FULL_SCAN;
    } else {
      process.env.AGENTS_CODE_REVIEW_DISCOVER_FULL_SCAN = prev;
    }
  }
});

test("discoverLatestRunsCodeReviewResultPath only considers runs/", async () => {
  const base = await mkdtemp(join(tmpdir(), "agents-triage-runs-only-"));
  const ws = join(base, "ws");
  await mkdir(join(ws, AGENTS_CODE_REVIEW_DIR, "runs", "code-review-BBB"), {
    recursive: true,
  });
  await mkdir(join(ws, AGENTS_CODE_REVIEW_DIR, "dry-run", "code-review-ZZZ"), {
    recursive: true,
  });
  await writeFile(
    join(ws, AGENTS_CODE_REVIEW_DIR, "runs", "code-review-BBB", "result.json"),
    "{}",
    "utf8",
  );
  await writeFile(
    join(
      ws,
      AGENTS_CODE_REVIEW_DIR,
      "dry-run",
      "code-review-ZZZ",
      "result.json",
    ),
    "{}",
    "utf8",
  );
  const p = await discoverLatestRunsCodeReviewResultPath(ws);
  expect(
    typeof p === "string" && p.includes(join(AGENTS_CODE_REVIEW_DIR, "runs")),
  ).toBe(true);
  expect(typeof p === "string" && p.includes("code-review-BBB")).toBe(true);
});

test("discoverLatestRunsCodeReviewResultPath finds legacy .review-agent when new tree is empty", async () => {
  const base = await mkdtemp(join(tmpdir(), "agents-triage-legacy-runs-only-"));
  const ws = join(base, "ws");
  const legacyRuns = join(ws, LEGACY_AGENTS_CODE_REVIEW_DIR, "runs");
  const dir = join(legacyRuns, "code-review-20990101000000-legacy-only");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "result.json"), "{}", "utf8");
  const p = await discoverLatestRunsCodeReviewResultPath(ws);
  expect(p).toBe(join(dir, "result.json"));
});

test("discoverLatestCodeReviewResultPath skips symlinked run directory entries", async () => {
  const base = await mkdtemp(join(tmpdir(), "agents-triage-skip-symlink-run-"));
  const ws = join(base, "ws");
  const runsRoot = join(ws, AGENTS_CODE_REVIEW_DIR, "runs");
  const realDir = join(runsRoot, "code-review-20260501000000-real");
  await mkdir(realDir, { recursive: true });
  await writeFile(join(realDir, "result.json"), "{}", "utf8");
  await symlink(
    realDir,
    join(runsRoot, "code-review-20260502000000-symlink"),
    "dir",
  );
  const p = await discoverLatestCodeReviewResultPath(ws);
  expect(
    typeof p === "string" && p.includes("code-review-20260501000000-real"),
  ).toBe(true);
});

test("discoverLatestRunsCodeReviewResultPath skips symlinked result.json leaf", async () => {
  const base = await mkdtemp(
    join(tmpdir(), "agents-triage-skip-symlink-result-"),
  );
  const ws = join(base, "ws");
  const runsRoot = join(ws, AGENTS_CODE_REVIEW_DIR, "runs");
  const older = join(runsRoot, "code-review-20260501000000-older");
  const newer = join(runsRoot, "code-review-20260502000000-newer");
  await mkdir(older, { recursive: true });
  await mkdir(newer, { recursive: true });
  await writeFile(join(older, "result.json"), "{}", "utf8");
  await symlink(join(older, "result.json"), join(newer, "result.json"), "file");
  const p = await discoverLatestRunsCodeReviewResultPath(ws);
  expect(
    typeof p === "string" && p.includes("code-review-20260501000000-older"),
  ).toBe(true);
});

test("discoverLatestRunsCodeReviewResultPath skips symlinked runs root", async () => {
  const base = await mkdtemp(
    join(tmpdir(), "agents-triage-skip-symlink-runs-root-"),
  );
  const ws = join(base, "ws");
  const stolen = join(ws, "stolen");
  const fakeRun = join(stolen, "code-review-20991231000000-fake");
  await mkdir(fakeRun, { recursive: true });
  await writeFile(join(fakeRun, "result.json"), "{}", "utf8");
  const runsLink = join(ws, AGENTS_CODE_REVIEW_DIR, "runs");
  await mkdir(dirname(runsLink), { recursive: true });
  await symlink(stolen, runsLink, "dir");
  const p = await discoverLatestRunsCodeReviewResultPath(ws);
  expect(p).toBeUndefined();
});

test("assertOutputDirectoryWillResolveInsideWorkspace rejects escape before mkdir", async () => {
  const base = await mkdtemp(join(tmpdir(), "agents-triage-safe-"));
  await mkdir(join(base, "ws", "nested"), { recursive: true });
  await expect(
    assertOutputDirectoryWillResolveInsideWorkspace(
      join(base, "ws"),
      join(base, "escape-target"),
    ),
  ).rejects.toThrow(/outside workspace/u);
});

test("assertOutputDirectoryWillResolveInsideWorkspace rejects broken symlink ancestor", async () => {
  const base = await mkdtemp(join(tmpdir(), "agents-triage-broken-symlink-"));
  const ws = join(base, "ws");
  await mkdir(join(ws, "nested"), { recursive: true });
  const danglingTarget = join(
    tmpdir(),
    `agents-dangle-${Math.random().toString(36).slice(2)}`,
  );
  await symlink(danglingTarget, join(ws, "nested", "broken"), "dir");
  await expect(
    assertOutputDirectoryWillResolveInsideWorkspace(
      ws,
      join(ws, "nested", "broken", "out", "deep"),
    ),
  ).rejects.toThrow(/Broken symlink/u);
});

test("sortReviewFindings orders by severity then fingerprint then id", () => {
  const baseWarning: Omit<Finding, "id"> = {
    severity: "warning",
    title: "Same title",
    description: "d",
    evidence: "e",
    sourceRole: "quality",
    validation: { status: "verified", details: "ok" },
  };
  const w1: Finding = { ...baseWarning, id: "b" };
  const w2: Finding = { ...baseWarning, id: "a" };
  const c: Finding = {
    ...baseWarning,
    id: "c",
    severity: "critical",
  };
  expect(sortReviewFindings([w1, c, w2]).map((f) => f.id)).toEqual([
    "c",
    "a",
    "b",
  ]);
});
