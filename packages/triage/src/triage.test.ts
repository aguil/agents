import { expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding } from "@aguil/agents-core";
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
  await mkdir(join(ws, ".review-agent", "runs", "code-review-AAA-result"), {
    recursive: true,
  });
  await mkdir(join(ws, ".review-agent", "dry-run", "code-review-ZZZ-result"), {
    recursive: true,
  });
  await writeFile(
    join(ws, ".review-agent", "runs", "code-review-AAA-result", "result.json"),
    "{}",
    "utf8",
  );
  await writeFile(
    join(
      ws,
      ".review-agent",
      "dry-run",
      "code-review-ZZZ-result",
      "result.json",
    ),
    "{}",
    "utf8",
  );
  const p = await discoverLatestCodeReviewResultPath(ws);
  expect(
    typeof p === "string" && p.includes(join(".review-agent", "dry-run")),
  ).toBe(true);
  expect(typeof p === "string" && p.includes("code-review-ZZZ-result")).toBe(
    true,
  );
});

test("discoverLatestRunsCodeReviewResultPath only considers runs/", async () => {
  const base = await mkdtemp(join(tmpdir(), "agents-triage-runs-only-"));
  const ws = join(base, "ws");
  await mkdir(join(ws, ".review-agent", "runs", "code-review-BBB"), {
    recursive: true,
  });
  await mkdir(join(ws, ".review-agent", "dry-run", "code-review-ZZZ"), {
    recursive: true,
  });
  await writeFile(
    join(ws, ".review-agent", "runs", "code-review-BBB", "result.json"),
    "{}",
    "utf8",
  );
  await writeFile(
    join(ws, ".review-agent", "dry-run", "code-review-ZZZ", "result.json"),
    "{}",
    "utf8",
  );
  const p = await discoverLatestRunsCodeReviewResultPath(ws);
  expect(
    typeof p === "string" && p.includes(join(".review-agent", "runs")),
  ).toBe(true);
  expect(typeof p === "string" && p.includes("code-review-BBB")).toBe(true);
});

test("discoverLatestCodeReviewResultPath skips symlinked run directory entries", async () => {
  const base = await mkdtemp(join(tmpdir(), "agents-triage-skip-symlink-run-"));
  const ws = join(base, "ws");
  const runsRoot = join(ws, ".review-agent", "runs");
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
