import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding } from "@aguil/agents-core";
import { discoverLatestCodeReviewResultPath } from "./discover-code-review-result";
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
