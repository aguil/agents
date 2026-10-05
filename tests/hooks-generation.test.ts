import { expect, test } from "bun:test";
import {
  HOOK_EVENTS,
  type HookEvent,
  type HookHandlerSpec,
  type HooksSpec,
} from "@aguil/agents-harness-config";
import {
  ADAPTER_HOOK_CAPABILITIES,
  cursorHookEventDispatchability,
  generateCursorHooksConfig,
  HOOK_ADAPTER_IDS,
  hookEventAdapterDispatchability,
  LIFECYCLE_HOOK_EVENTS,
  renderCursorHooksConfig,
  undispatchableLifecycleHookWarnings,
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
    policyBridge: true,
  });
  const shell = config.hooks.beforeShellExecution ?? [];
  const mcp = config.hooks.beforeMCPExecution ?? [];
  expect(shell[0].command).toBe('"agents" policy-eval');
  expect(mcp[0].command).toBe('"agents" policy-eval');
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
    policyBridge: true,
  });
  const fileEdit = config.hooks.afterFileEdit ?? [];
  expect(fileEdit[0].command).toBe('"agents" policy-eval');
  expect(fileEdit[1].command).toContain("prettier");
});

test("custom policy bridge CLI is JSON-quoted without role-specific data", () => {
  const { config } = generateCursorHooksConfig({
    hooks: sampleHooks,
    policyBridge: true,
    agentsCli: "/tools/agents cli",
  });
  const rendered = renderCursorHooksConfig(config);
  expect(config.hooks.beforeShellExecution?.[0].command).toBe(
    '"/tools/agents cli" policy-eval',
  );
  expect(rendered).not.toContain("triage-readonly");
  expect(rendered).not.toContain("/repo/.agents");
  expect(rendered).not.toContain("--policy");
  expect(rendered).not.toContain("--agents-dir");
});

test("canonical events project to Cursor equivalents; unmappable events are reported", () => {
  const { config, skippedEvents } = generateCursorHooksConfig({
    hooks: sampleHooks,
  });
  expect(config.hooks.afterFileEdit?.[0].command).toContain("prettier");
  expect(config.hooks.stop?.[0].command).toBe("/h/hooks/check-coverage.sh");
  // Fixture artifact: sampleHooks declares only run_end among the unmapped
  // events, so skippedEvents is ["run_end"] here. The dispatchability contract
  // below is what pins the full surface (ADR 0024 §4) — do not treat this
  // equality as the contract.
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

test("every HookEvent has an explicit Cursor dispatchability (ADR 0024 skip contract)", () => {
  const rows = cursorHookEventDispatchability();
  expect(rows.map((row) => row.event)).toEqual([...HOOK_EVENTS]);

  // Written out rather than derived from CURSOR_EVENT_MAPPING, so a dropped
  // or added mapping fails here instead of passing by construction.
  const expectedDispatchable: Readonly<Record<HookEvent, boolean>> = {
    pre_tool_call: true,
    post_tool_call: true,
    role_start: false,
    role_stop: true,
    run_start: false,
    run_end: false,
  };
  for (const { event, dispatchable } of rows) {
    expect(dispatchable).toBe(expectedDispatchable[event]);
  }

  // The three inert lifecycle events stay undispatchable until orchestrator
  // dispatch (run_*) or an adapter mapping (role_start) lands — never by
  // projecting a session-end onto a run boundary.
  expect(LIFECYCLE_HOOK_EVENTS).toContain("role_start");
  expect(LIFECYCLE_HOOK_EVENTS).toContain("run_start");
  expect(LIFECYCLE_HOOK_EVENTS).toContain("run_end");
  expect(LIFECYCLE_HOOK_EVENTS).toHaveLength(3);
  for (const event of LIFECYCLE_HOOK_EVENTS) {
    expect(expectedDispatchable[event]).toBe(false);
  }
});

test("adapter × HookEvent dispatchability matrix is complete (ADR 0023)", () => {
  // Every adapter decides every event: a native list, or [] for unmappable.
  // An omitted key would still yield a row below, reported as undispatchable,
  // so the decision itself is checked here rather than through the rows.
  expect(ADAPTER_HOOK_CAPABILITIES.map((caps) => caps.adapter).sort()).toEqual(
    [...HOOK_ADAPTER_IDS].sort(),
  );
  for (const caps of ADAPTER_HOOK_CAPABILITIES) {
    expect([caps.adapter, Object.keys(caps.nativeEvents).sort()]).toEqual([
      caps.adapter,
      [...HOOK_EVENTS].sort(),
    ]);
    for (const event of HOOK_EVENTS) {
      expect(Array.isArray(caps.nativeEvents[event])).toBe(true);
    }
  }
  const rows = hookEventAdapterDispatchability();
  expect(rows.length).toBe(HOOK_ADAPTER_IDS.length * HOOK_EVENTS.length);
  // run_start / run_end never map on any adapter (ADR 0024).
  for (const row of rows) {
    if (row.event === "run_start" || row.event === "run_end") {
      expect(row.dispatchable).toBe(false);
    }
  }
  expect(
    rows.find((r) => r.adapter === "claude" && r.event === "role_start")
      ?.dispatchable,
  ).toBe(true);
  expect(
    rows.find((r) => r.adapter === "cursor" && r.event === "role_start")
      ?.dispatchable,
  ).toBe(false);
  expect(rows.find((r) => r.adapter === "opencode")?.canDeny).toBe(false);
  expect(rows.find((r) => r.adapter === "claude")?.canDeny).toBe(true);
});

test("Claude generator projects events, matchers, and policy bridge format", async () => {
  const {
    generateClaudeHooksConfig,
    renderClaudeSettingsConfig,
    assertWellFormedClaudeSettings,
  } = await import("@aguil/agents-hooks");
  const { config, skippedEvents } = generateClaudeHooksConfig({
    hooks: sampleHooks,
    policyBridge: true,
  });
  expect(skippedEvents).toEqual(["run_end"]);
  expect(config.hooks.PreToolUse?.[0].hooks[0].command).toBe(
    "'agents' policy-eval --format claude",
  );
  // The bridge is a PreToolUse hook only on Claude (ADR 0023 decision 9); the
  // user's post_tool_call handler still maps to PostToolUse.
  const postCommands = (config.hooks.PostToolUse ?? []).flatMap((group) =>
    group.hooks.map((hook) => hook.command),
  );
  expect(postCommands).not.toContain("'agents' policy-eval --format claude");
  expect(postCommands).toEqual(["prettier --write {{tool_input.file_path}}"]);
  // User pre_tool_call carries matcher as Claude's matcher field.
  const preUser = config.hooks.PreToolUse?.find(
    (group) => group.matcher === "Execute",
  );
  expect(preUser?.hooks[0].command).toBe("/h/hooks/validate-shell.sh");
  expect(preUser?.hooks[0].timeout).toBe(10);
  expect(config.hooks.Stop?.[0].hooks[0].command).toBe(
    "/h/hooks/check-coverage.sh",
  );
  assertWellFormedClaudeSettings(config);
  const rendered = renderClaudeSettingsConfig(config);
  expect(rendered.endsWith("\n")).toBe(true);
  expect(() =>
    assertWellFormedClaudeSettings({
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "" }] }] },
    }),
  ).toThrow(/non-empty string/);
});

test("Claude generator without a policy registers no bridge", async () => {
  const { generateClaudeHooksConfig } = await import("@aguil/agents-hooks");
  const { config } = generateClaudeHooksConfig({ hooks: sampleHooks });
  const commands = Object.values(config.hooks).flatMap((groups) =>
    (groups ?? []).flatMap((group) => group.hooks.map((hook) => hook.command)),
  );
  expect(commands.some((command) => command.includes("policy-eval"))).toBe(
    false,
  );
  expect(config.hooks.PostToolUse?.[0].hooks[0].command).toBe(
    "prettier --write {{tool_input.file_path}}",
  );
});

test("Claude bridge carries the workspace root in its argv (#219)", async () => {
  const { generateClaudeHooksConfig } = await import("@aguil/agents-hooks");
  const { config } = generateClaudeHooksConfig({
    hooks: {},
    policyBridge: true,
    workspaceRoot: "/work/my repo",
  });
  expect(config.hooks.PreToolUse?.[0].hooks[0].command).toBe(
    "'agents' policy-eval --format claude --workspace '/work/my repo'",
  );
});

test("Claude bridge quotes each word of an argv-prefix CLI (ADR 0023 decision 10)", async () => {
  const { generateClaudeHooksConfig } = await import("@aguil/agents-hooks");
  const { config } = generateClaudeHooksConfig({
    hooks: {},
    policyBridge: true,
    agentsCli: ["/opt/bun bin/bun", "/opt/agents/dist/index.js"],
  });
  expect(config.hooks.PreToolUse?.[0].hooks[0].command).toBe(
    "'/opt/bun bin/bun' '/opt/agents/dist/index.js' policy-eval --format claude",
  );
});

test("Claude bridge words reach the CLI unexpanded by the shell", async () => {
  const { generateClaudeHooksConfig } = await import("@aguil/agents-hooks");
  const root = "/work/$HOME/$(echo pwned)/`id`/it's \\ done";
  const { config } = generateClaudeHooksConfig({
    hooks: {},
    policyBridge: true,
    // printf stands in for the CLI and prints each argument it receives.
    agentsCli: ["printf", "%s\n"],
    workspaceRoot: root,
  });
  const command = config.hooks.PreToolUse?.[0].hooks[0].command ?? "";
  const proc = Bun.spawn({ cmd: ["sh", "-c", command], stdout: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(stdout.split("\n").slice(0, -1)).toEqual([
    "policy-eval",
    "--format",
    "claude",
    "--workspace",
    root,
  ]);
});

test("Claude applies_to scopes matchers to tool classes", async () => {
  const { generateClaudeHooksConfig } = await import("@aguil/agents-hooks");
  const shellOnly: HookHandlerSpec = {
    command: "/h/hooks/shell-only.sh",
    appliesTo: ["shell"],
  };
  const { config } = generateClaudeHooksConfig({
    hooks: { pre_tool_call: [shellOnly] },
  });
  expect(config.hooks.PreToolUse?.[0].matcher).toBe("Bash");
  expect(config.hooks.PreToolUse?.[0].hooks[0].command).toBe(
    "/h/hooks/shell-only.sh",
  );
});

test("declaring undispatchable lifecycle handlers yields named warnings (ADR 0024)", () => {
  expect(undispatchableLifecycleHookWarnings({})).toEqual([]);
  expect(undispatchableLifecycleHookWarnings(sampleHooks)).toEqual([
    "hooks.run_end: declared handler cannot fire — run-level lifecycle is the orchestrator's to dispatch; an adapter session cannot identify a run boundary (ADR 0024)",
  ]);
  const allThree: HooksSpec = {
    role_start: [{ command: "echo role_start" }],
    run_start: [{ command: "echo run_start" }],
    run_end: [{ command: "echo run_end" }],
  };
  const warnings = undispatchableLifecycleHookWarnings(allThree, "cursor");
  expect(warnings).toHaveLength(3);
  expect(warnings[0]).toContain("hooks.role_start:");
  expect(warnings[1]).toContain("hooks.run_start:");
  expect(warnings[2]).toContain("hooks.run_end:");
  // Claude maps SessionStart → role_start, so only run_* warn.
  const claudeWarnings = undispatchableLifecycleHookWarnings(
    allThree,
    "claude",
  );
  expect(claudeWarnings).toHaveLength(2);
  expect(claudeWarnings.join("\n")).not.toContain("role_start");
});

test("policyBridge false yields no bridge entries", () => {
  const { config } = generateCursorHooksConfig({
    hooks: sampleHooks,
    policyBridge: false,
  });
  expect(config.hooks.beforeShellExecution?.[0].command).toBe(
    'HOOK_MATCHER="Execute" /h/hooks/validate-shell.sh',
  );
  expect(config.hooks.afterFileEdit?.[0].command).toContain("prettier");
});

test("rendered policy bridge config is invariant across roles and policies", () => {
  const renderForRole = () =>
    renderCursorHooksConfig(
      generateCursorHooksConfig({
        hooks: sampleHooks,
        policyBridge: true,
        agentsCli: "/tools/agents",
      }).config,
    );

  const triageRoleConfig = renderForRole();
  const implementationRoleConfig = renderForRole();
  expect(triageRoleConfig).toBe(implementationRoleConfig);
});

test("applies_to scopes handlers to event classes (#71)", () => {
  const shellOnly: HookHandlerSpec = {
    command: "/h/hooks/shell-only.sh",
    matcher: "Execute",
    appliesTo: ["shell"],
  };
  const mcpAndEdit: HookHandlerSpec = {
    command: "/h/hooks/audit.sh",
    appliesTo: ["mcp", "edit"],
  };
  const unscoped: HookHandlerSpec = { command: "/h/hooks/everything.sh" };
  const { config } = generateCursorHooksConfig({
    hooks: {
      pre_tool_call: [shellOnly, mcpAndEdit, unscoped],
      post_tool_call: [mcpAndEdit],
    },
    policyBridge: true,
  });

  const commands = (event: keyof typeof config.hooks) =>
    (config.hooks[event] ?? []).map((entry) => entry.command);

  // Shell-only handler registers on beforeShellExecution but NOT on
  // beforeMCPExecution — the wasted spawn per MCP call is gone.
  expect(commands("beforeShellExecution")).toContain(
    'HOOK_MATCHER="Execute" /h/hooks/shell-only.sh',
  );
  expect(commands("beforeMCPExecution")).not.toContain(
    'HOOK_MATCHER="Execute" /h/hooks/shell-only.sh',
  );
  // Class lists select exactly their events; unscoped handlers keep the
  // register-everywhere behavior (absence must not narrow).
  expect(commands("beforeMCPExecution")).toContain("/h/hooks/audit.sh");
  expect(commands("beforeShellExecution")).not.toContain("/h/hooks/audit.sh");
  expect(commands("afterFileEdit")).toContain("/h/hooks/audit.sh");
  expect(commands("beforeShellExecution")).toContain("/h/hooks/everything.sh");
  expect(commands("beforeMCPExecution")).toContain("/h/hooks/everything.sh");
  // The policy bridge is never narrowed: still first on every tool event.
  expect(commands("beforeShellExecution")[0]).toBe('"agents" policy-eval');
  expect(commands("beforeMCPExecution")[0]).toBe('"agents" policy-eval');
  expect(commands("afterFileEdit")[0]).toBe('"agents" policy-eval');
});

test("renderCursorHooksConfig emits stable versioned JSON", () => {
  const { config } = generateCursorHooksConfig({ hooks: {} });
  const rendered = renderCursorHooksConfig(config);
  expect(JSON.parse(rendered)).toEqual({ version: 1, hooks: {} });
  expect(rendered.endsWith("\n")).toBe(true);
});
