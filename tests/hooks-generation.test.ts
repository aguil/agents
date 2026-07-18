import { expect, test } from "bun:test";
import type { HooksSpec } from "@aguil/agents-harness-config";
import {
  generateCursorHooksConfig,
  renderCursorHooksConfig,
} from "@aguil/agents-hooks";

const sampleHooks: HooksSpec = {
  pre_tool_call: [
    { command: "/h/hooks/validate-shell.sh", matcher: "Execute", timeoutS: 10 },
  ],
  post_tool_call: [{ command: "prettier --write {{tool_input.file_path}}" }],
  role_stop: [{ command: "/h/hooks/check-coverage.sh" }],
  run_end: [{ command: "echo done" }],
};

test("policy bridge is the first handler on every mapped tool event", () => {
  const { config } = generateCursorHooksConfig({
    hooks: sampleHooks,
    policyId: "triage-readonly",
    agentsDir: "/repo/.agents",
  });
  const shell = config.hooks.beforeShellExecution ?? [];
  const mcp = config.hooks.beforeMCPExecution ?? [];
  expect(shell[0].command).toContain('policy-eval --policy "triage-readonly"');
  expect(shell[0].command).toContain('--agents-dir "/repo/.agents"');
  expect(mcp[0].command).toContain('policy-eval --policy "triage-readonly"');
  // User hook comes after the bridge, carrying its matcher as an env
  // prefix the handler script can filter on.
  expect(shell[1].command).toBe(
    'HOOK_MATCHER="Execute" /h/hooks/validate-shell.sh',
  );
  expect(shell[1].timeout).toBe(10);
});

test("policy bridge also precedes post_tool_call user hooks (afterFileEdit)", () => {
  const { config } = generateCursorHooksConfig({
    hooks: sampleHooks,
    policyId: "triage-readonly",
  });
  const fileEdit = config.hooks.afterFileEdit ?? [];
  expect(fileEdit[0].command).toContain(
    'policy-eval --policy "triage-readonly"',
  );
  expect(fileEdit[1].command).toContain("prettier");
});

test("canonical events project to Cursor equivalents; unmappable events are reported", () => {
  const { config, skippedEvents } = generateCursorHooksConfig({
    hooks: sampleHooks,
  });
  expect(config.hooks.afterFileEdit?.[0].command).toContain("prettier");
  expect(config.hooks.stop?.[0].command).toBe("/h/hooks/check-coverage.sh");
  expect(skippedEvents).toEqual(["run_end"]);
  // No policy → no bridge entries; user pre_tool_call hooks project to both
  // Cursor tool events, carrying the matcher env prefix.
  expect(config.hooks.beforeShellExecution?.[0].command).toBe(
    'HOOK_MATCHER="Execute" /h/hooks/validate-shell.sh',
  );
  expect(config.hooks.beforeMCPExecution?.[0].command).toBe(
    'HOOK_MATCHER="Execute" /h/hooks/validate-shell.sh',
  );
});

test("renderCursorHooksConfig emits stable versioned JSON", () => {
  const { config } = generateCursorHooksConfig({ hooks: {} });
  const rendered = renderCursorHooksConfig(config);
  expect(JSON.parse(rendered)).toEqual({ version: 1, hooks: {} });
  expect(rendered.endsWith("\n")).toBe(true);
});
