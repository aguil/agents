import { expect, test } from "bun:test";
import type { Finding } from "@aguil/agents-core";
import { canonicalKeyForCodeReviewArtifact } from "./ingest-code-review";
import { computeOutputSlug, fingerprint12 } from "./output-slug";
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
