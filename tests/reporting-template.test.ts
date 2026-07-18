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
