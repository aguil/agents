import { expect, test } from "bun:test";
import type { HarnessRunResult } from "@aguil/agents-core";
import {
  renderMarkdownReport,
  renderOutcomesMarkdownReport,
  resolveReportRenderer,
} from "@aguil/agents-reporting";

test("code-review template resolves to the existing renderer", () => {
  const result: HarnessRunResult = {
    runId: "review-1",
    status: "warnings",
    findings: [
      {
        id: "finding-1",
        severity: "critical",
        title: "Unsafe write",
        description: "A write bypasses validation.",
        evidence: "The unchecked value reaches the filesystem.",
        sourceRole: "security",
        validation: {
          status: "verified",
          details: "Verified by inspection of the write path.",
        },
        file: "src/write.ts",
        line: 42,
      },
      {
        id: "finding-2",
        severity: "warning",
        title: "Missing fallback",
        description: "The fallback is absent.",
        evidence: "The error branch returns directly.",
        sourceRole: "quality",
        validation: {
          status: "verified",
          details: "Validated by a focused error-path test.",
        },
      },
    ],
    artifacts: [],
  };

  const renderer = resolveReportRenderer("builtin:code-review-markdown");
  expect(renderer).toBe(renderMarkdownReport);
  expect(renderer(result)).toBe(renderMarkdownReport(result));
});

test("outcomes template groups roles and renders non-empty data", () => {
  const result: HarnessRunResult = {
    runId: "outcomes-1",
    status: "passed",
    findings: [],
    outcomes: [
      {
        id: "evidence-1",
        kind: "evidence",
        sourceRole: "scout",
        title: "Alert observed",
        data: { alert: "disk-full", count: 2 },
      },
      {
        id: "decision-1",
        kind: "decision",
        sourceRole: "diagnose",
        title: "Escalate",
        data: {},
      },
      {
        id: "evidence-2",
        kind: "evidence",
        sourceRole: "scout",
        title: "Host identified",
        data: {},
      },
    ],
    artifacts: [],
  };

  const first = renderOutcomesMarkdownReport(result);
  const second = renderOutcomesMarkdownReport(result);

  expect(first).toBe(second);
  expect(first).toContain("Summary: 3 outcomes across 2 roles.");
  expect(first.indexOf("## scout")).toBeLessThan(first.indexOf("## diagnose"));
  expect(first.indexOf("Alert observed")).toBeLessThan(
    first.indexOf("Host identified"),
  );
  expect(first).toContain(
    '- **[evidence] Alert observed** (evidence-1)\n  ```json\n  {\n    "alert": "disk-full",\n    "count": 2\n  }\n  ```',
  );
  expect(first).toContain("- **[decision] Escalate** (decision-1)");
  expect(first).not.toContain("decision-1)\n  ```json");
  expect(first).toEndWith("\n");
});

test("unknown report templates list supported names", () => {
  expect(() => resolveReportRenderer("builtin:unknown")).toThrow(
    'unknown report template "builtin:unknown" (supported: builtin:code-review-markdown, builtin:outcomes-markdown)',
  );
});

const PLACEHOLDER_OPENING =
  "> **Not a review.** This run used the placeholder `fake` adapter: no model ran, so finding nothing here says nothing about the change.";

function emptyResult(metadata?: Record<string, string>): HarnessRunResult {
  return {
    runId: "review-adapter",
    status: "passed",
    findings: [],
    artifacts: [],
    ...(metadata === undefined ? {} : { metadata }),
  };
}

test("a fake report opens by saying it is not a review and names its adapter", () => {
  const report = renderMarkdownReport(emptyResult({ adapter: "fake" }));
  const lines = report.split("\n");

  expect(lines.slice(0, 3)).toEqual([
    "# Code Review Report",
    "",
    PLACEHOLDER_OPENING,
  ]);
  const status = lines.indexOf("Status: passed");
  expect(lines[status + 1]).toBe("Adapter: fake");
  expect(report).not.toContain("Model:");
});

test("a real-adapter report names its adapter and model, without the placeholder line", () => {
  const report = renderMarkdownReport(
    emptyResult({
      adapter: "cursor",
      cursor_model: "grok-4.7-medium",
      cursor_models: "security=gpt-5.6-sol-high",
    }),
  );
  const lines = report.split("\n");

  const status = lines.indexOf("Status: passed");
  expect(lines.slice(status + 1, status + 3)).toEqual([
    "Adapter: cursor",
    "Model: grok-4.7-medium; per-role security=gpt-5.6-sol-high",
  ]);
  expect(report).not.toContain("Not a review");
});

test("a real-adapter report with no recorded model names only the adapter", () => {
  const report = renderMarkdownReport(emptyResult({ adapter: "claude" }));

  expect(report).toContain("Status: passed\nAdapter: claude\nSummary:");
  expect(report).not.toContain("Model:");
});

test("a result that records no adapter renders as before", () => {
  const report = renderMarkdownReport(emptyResult());

  expect(report).not.toContain("Adapter:");
  expect(report).not.toContain("Not a review");
  expect(report).toContain("Status: passed\nSummary:");
});

test("the outcomes template identifies the adapter the same way", () => {
  const fakeReport = renderOutcomesMarkdownReport(
    emptyResult({ adapter: "fake" }),
  );
  expect(fakeReport.split("\n").slice(0, 3)).toEqual([
    "# Harness Report",
    "",
    PLACEHOLDER_OPENING,
  ]);
  expect(fakeReport).toContain("Status: passed\nAdapter: fake\nSummary:");

  const realReport = renderOutcomesMarkdownReport(
    emptyResult({ adapter: "opencode", opencode_model: "kimi-k3" }),
  );
  expect(realReport).toContain(
    "Status: passed\nAdapter: opencode\nModel: kimi-k3\nSummary:",
  );
  expect(realReport).not.toContain("Not a review");

  const unrecorded = renderOutcomesMarkdownReport(emptyResult());
  expect(unrecorded).not.toContain("Adapter:");
});
