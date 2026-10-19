import { expect, test } from "bun:test";
import {
  HOOK_EVENTS,
  type HookEvent,
  type HookHandlerSpec,
  type HooksSpec,
} from "@aguil/agents-harness-config";
import {
  ADAPTER_HOOK_CAPABILITIES,
  allEnforceableProbeEventNames,
  CURSOR_READ_HOOK_VERSIONS,
  CURSOR_USER_HOOK_EVENT_VERSIONS,
  cursorHookEventDispatchability,
  cursorReadHookWithheldWarning,
  cursorSupportsReadHook,
  cursorSupportsUserHookEvents,
  cursorUserHookEventsWithheldWarning,
  generateClaudeHooksConfig,
  generateCursorHooksConfig,
  HOOK_ADAPTER_IDS,
  hookEventAdapterDispatchability,
  LIFECYCLE_HOOK_EVENTS,
  renderCursorHooksConfig,
  undeliverableLifecycleHookEvents,
  undispatchableLifecycleHookWarnings,
  unmatchableMatcherWarnings,
} from "@aguil/agents-hooks";

/**
 * The command ADR 0028 decision 2 generates for one gated registration,
 * spelled out so a change to the generator's quoting fails here.
 */
function gated(
  cli: string,
  adapter: string,
  event: string,
  classes: string,
  command: string,
  matcher?: string,
): string {
  return (
    `${cli} hook-gate --adapter '${adapter}' --event '${event}' --classes '${classes}'` +
    (matcher === undefined ? "" : ` --matcher '${matcher}'`) +
    ` -- '${command}'`
  );
}

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
  // The user hook comes after the bridge, behind the gate, which applies its
  // matcher (ADR 0028 decision 1).
  expect(shell[1].command).toBe(
    gated(
      "'agents'",
      "cursor",
      "beforeShellExecution",
      "shell",
      "/h/hooks/validate-shell.sh",
      "Execute",
    ),
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
  expect(fileEdit[1].command).toBe(
    gated(
      "'agents'",
      "cursor",
      "afterFileEdit",
      "edit",
      "prettier --write {{tool_input.file_path}}",
    ),
  );
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
  // Lifecycle handlers are not gated (ADR 0028 decision 1).
  expect(config.hooks.stop?.[0].command).toBe("/h/hooks/check-coverage.sh");
  // Fixture artifact: sampleHooks declares only run_end among the unmapped
  // events, so skippedEvents is ["run_end"] here. The dispatchability contract
  // below is what pins the full surface (ADR 0024 §4) — do not treat this
  // equality as the contract.
  expect(skippedEvents).toEqual(["run_end"]);
  // No policy → no bridge entries; an unscoped pre_tool_call handler is
  // gated on each Cursor pre-call event with that event's class.
  expect(config.hooks.beforeShellExecution?.[0].command).toBe(
    gated(
      "'agents'",
      "cursor",
      "beforeShellExecution",
      "shell",
      "/h/hooks/validate-shell.sh",
      "Execute",
    ),
  );
  expect(config.hooks.beforeMCPExecution?.[0].command).toBe(
    gated(
      "'agents'",
      "cursor",
      "beforeMCPExecution",
      "mcp",
      "/h/hooks/validate-shell.sh",
      "Execute",
    ),
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

  // Every lifecycle event but role_stop stays undispatchable on Cursor until
  // orchestrator dispatch (run_*) or an adapter mapping (role_start) lands —
  // never by projecting a session-end onto a run boundary.
  expect([...LIFECYCLE_HOOK_EVENTS]).toEqual([
    "role_start",
    "role_stop",
    "run_start",
    "run_end",
  ]);
  for (const event of LIFECYCLE_HOOK_EVENTS) {
    expect(expectedDispatchable[event]).toBe(event === "role_stop");
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
  expect(postCommands).toEqual([
    gated(
      "'agents'",
      "claude",
      "PostToolUse",
      "shell,mcp,edit",
      "prettier --write {{tool_input.file_path}}",
    ),
  ]);
  // The handler's own matcher goes to the gate, never to Claude's matcher
  // field, which is the class projection (ADR 0028 decision 6).
  expect(
    config.hooks.PreToolUse?.some((group) => group.matcher === "Execute"),
  ).toBe(false);
  const preUser = config.hooks.PreToolUse?.[1];
  expect(preUser?.matcher).toBe("Bash|mcp__.*|Edit|Write|NotebookEdit");
  expect(preUser?.hooks[0].command).toBe(
    gated(
      "'agents'",
      "claude",
      "PreToolUse",
      "shell,mcp,edit",
      "/h/hooks/validate-shell.sh",
      "Execute",
    ),
  );
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
    gated(
      "'agents'",
      "claude",
      "PostToolUse",
      "shell,mcp,edit",
      "prettier --write {{tool_input.file_path}}",
    ),
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
    gated(
      "'agents'",
      "claude",
      "PreToolUse",
      "shell",
      "/h/hooks/shell-only.sh",
    ),
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

test("undeliverable lifecycle events are the ones the warnings name (ADR 0024)", () => {
  const allThree: HooksSpec = {
    role_start: [{ command: "echo role_start" }],
    run_start: [{ command: "echo run_start" }],
    run_end: [{ command: "echo run_end" }],
  };
  expect(undeliverableLifecycleHookEvents({})).toEqual([]);
  expect(undeliverableLifecycleHookEvents(allThree, "cursor")).toEqual([
    "role_start",
    "run_start",
    "run_end",
  ]);
  expect(undeliverableLifecycleHookEvents(allThree, "claude")).toEqual([
    "run_start",
    "run_end",
  ]);
  // role_stop is undeliverable only where no generator maps it.
  const withStop: HooksSpec = {
    ...allThree,
    role_stop: [{ command: "echo role_stop" }],
  };
  expect(undeliverableLifecycleHookEvents(withStop, "cursor")).not.toContain(
    "role_stop",
  );
  expect(undeliverableLifecycleHookEvents(withStop, "claude")).not.toContain(
    "role_stop",
  );
  expect(undeliverableLifecycleHookEvents(withStop, "opencode")).toEqual([
    "role_start",
    "role_stop",
    "run_start",
    "run_end",
  ]);
  for (const adapter of ["cursor", "claude", "opencode"]) {
    expect(
      undispatchableLifecycleHookWarnings(withStop, adapter).map(
        (warning) => /^hooks\.(\w+):/.exec(warning)?.[1],
      ),
    ).toEqual([...undeliverableLifecycleHookEvents(withStop, adapter)]);
  }
});

test("policyBridge false yields no bridge entries", () => {
  const { config } = generateCursorHooksConfig({
    hooks: sampleHooks,
    policyBridge: false,
  });
  expect(config.hooks.beforeShellExecution?.[0].command).toBe(
    gated(
      "'agents'",
      "cursor",
      "beforeShellExecution",
      "shell",
      "/h/hooks/validate-shell.sh",
      "Execute",
    ),
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
    userHookEvents: true,
  });

  const commands = (event: keyof typeof config.hooks) =>
    (config.hooks[event] ?? []).map((entry) => entry.command);
  const g = (event: string, classes: string, command: string, m?: string) =>
    gated("'agents'", "cursor", event, classes, command, m);

  // Shell-only handler registers on beforeShellExecution but NOT on
  // beforeMCPExecution — the wasted spawn per MCP call is gone.
  expect(commands("beforeShellExecution")).toEqual([
    '"agents" policy-eval',
    g("beforeShellExecution", "shell", "/h/hooks/shell-only.sh", "Execute"),
    g("beforeShellExecution", "shell", "/h/hooks/everything.sh"),
  ]);
  // Class lists select exactly their events; unscoped handlers register on
  // every class (absence must not narrow).
  expect(commands("beforeMCPExecution")).toEqual([
    '"agents" policy-eval',
    g("beforeMCPExecution", "mcp", "/h/hooks/audit.sh"),
    g("beforeMCPExecution", "mcp", "/h/hooks/everything.sh"),
  ]);
  // Pre-edit is preToolUse, with no bridge before it (ADR 0028 decision 5).
  expect(commands("preToolUse")).toEqual([
    g("preToolUse", "edit", "/h/hooks/audit.sh"),
    g("preToolUse", "edit", "/h/hooks/everything.sh"),
  ]);
  expect(commands("afterFileEdit")).toEqual([
    '"agents" policy-eval',
    g("afterFileEdit", "edit", "/h/hooks/audit.sh"),
  ]);
  expect(commands("afterMCPExecution")).toEqual([
    g("afterMCPExecution", "mcp", "/h/hooks/audit.sh"),
  ]);
  // No post_tool_call handler takes shell, so the event is not written.
  expect(config.hooks).not.toHaveProperty("afterShellExecution");
});

test("renderCursorHooksConfig emits stable versioned JSON", () => {
  const { config } = generateCursorHooksConfig({ hooks: {} });
  const rendered = renderCursorHooksConfig(config);
  expect(JSON.parse(rendered)).toEqual({ version: 1, hooks: {} });
  expect(rendered.endsWith("\n")).toBe(true);
});

test("beforeReadFile carries the policy bridge alone, never a user handler (#198, JC-10)", () => {
  const hooks: HooksSpec = {
    ...sampleHooks,
    pre_tool_call: [
      { command: "/h/hooks/any-tool.sh" },
      { command: "/h/hooks/shell-only.sh", appliesTo: ["shell"] },
    ],
  };
  const { config } = generateCursorHooksConfig({
    hooks,
    policyBridge: true,
    readHook: true,
  });
  expect(config.hooks.beforeReadFile).toEqual([
    { command: '"agents" policy-eval' },
  ]);
  // The same user handlers still reach the shell event.
  expect(
    (config.hooks.beforeShellExecution ?? []).map((entry) => entry.command),
  ).toEqual([
    '"agents" policy-eval',
    gated(
      "'agents'",
      "cursor",
      "beforeShellExecution",
      "shell",
      "/h/hooks/any-tool.sh",
    ),
    gated(
      "'agents'",
      "cursor",
      "beforeShellExecution",
      "shell",
      "/h/hooks/shell-only.sh",
    ),
  ]);
});

test("beforeReadFile is registered only when asked for, and only with the bridge (#198)", () => {
  for (const options of [
    { policyBridge: true },
    { policyBridge: true, readHook: false },
    { policyBridge: false, readHook: true },
  ]) {
    const { config } = generateCursorHooksConfig({
      hooks: sampleHooks,
      ...options,
    });
    expect(config.hooks).not.toHaveProperty("beforeReadFile");
  }
});

test("the Cursor bridge is given the workspace, single-quoted (#198, JC-8)", () => {
  const { config } = generateCursorHooksConfig({
    hooks: {},
    policyBridge: true,
    workspaceRoot: "/w/it's $(here)",
    readHook: true,
  });
  const expected = `"agents" policy-eval --workspace '/w/it'\\''s $(here)'`;
  expect(config.hooks.beforeShellExecution?.[0]?.command).toBe(expected);
  expect(config.hooks.beforeReadFile?.[0]?.command).toBe(expected);
});

test("only measured cursor-agent versions support beforeReadFile (#198, JC-12, #285)", () => {
  expect(CURSOR_READ_HOOK_VERSIONS).toEqual([
    "2026.10.01-14929f9",
    "2026.10.16-e3cb207",
  ]);
  expect(cursorSupportsReadHook("2026.10.01-14929f9")).toBe(true);
  expect(cursorSupportsReadHook("2026.10.01-14929f9\n")).toBe(true);
  expect(cursorSupportsReadHook("2026.10.16-e3cb207")).toBe(true);
  // A later or earlier build is not supported until it is measured.
  expect(cursorSupportsReadHook("2026.10.02-0000000")).toBe(false);
  expect(cursorSupportsReadHook("2026.09.30-14929f9")).toBe(false);
  expect(cursorSupportsReadHook("")).toBe(false);
  expect(cursorReadHookWithheldWarning("")).toContain(
    "the installed cursor-agent's version could not be read",
  );
  expect(cursorReadHookWithheldWarning("2026.10.02-0000000")).toBe(
    "hooks: beforeReadFile withheld — cursor-agent 2026.10.02-0000000 is not a version " +
      "measured to support it (supported: 2026.10.01-14929f9, 2026.10.16-e3cb207), so " +
      "Cursor's native file reads are not checked against filesystem rules in this run",
  );
});

test("only measured cursor-agent versions get ADR 0028's user-hook events (#239, #285)", () => {
  expect(CURSOR_USER_HOOK_EVENT_VERSIONS).toEqual([
    "2026.10.01-14929f9",
    "2026.10.16-e3cb207",
  ]);
  expect(cursorSupportsUserHookEvents("2026.10.01-14929f9\n")).toBe(true);
  expect(cursorSupportsUserHookEvents("2026.10.16-e3cb207")).toBe(true);
  expect(cursorSupportsUserHookEvents("2026.10.02-0000000")).toBe(false);
  expect(cursorSupportsUserHookEvents("")).toBe(false);
  expect(
    cursorUserHookEventsWithheldWarning("2026.10.02-0000000", [
      "preToolUse",
      "afterShellExecution",
    ]),
  ).toBe(
    "hooks: preToolUse, afterShellExecution withheld — cursor-agent 2026.10.02-0000000 " +
      "is not a version measured to fire them (supported: 2026.10.01-14929f9, 2026.10.16-e3cb207), so the " +
      "harness's tool-call hooks do not run on those events' calls in this run (ADR 0028)",
  );
});

test("Cursor's added user-hook events are written only when asked for, else withheld (ADR 0028 decision 5)", () => {
  const hooks: HooksSpec = {
    pre_tool_call: [{ command: "/h/pre.sh" }],
    post_tool_call: [{ command: "/h/post.sh" }],
  };
  const added = [
    "preToolUse",
    "afterShellExecution",
    "afterMCPExecution",
  ] as const;
  const withheld = generateCursorHooksConfig({ hooks, policyBridge: true });
  for (const event of added) {
    expect(withheld.config.hooks).not.toHaveProperty(event);
  }
  expect(withheld.withheldEvents).toEqual(added);
  // The events every Cursor handler had before are unchanged.
  expect(Object.keys(withheld.config.hooks)).toEqual([
    "beforeShellExecution",
    "beforeMCPExecution",
    "afterFileEdit",
  ]);

  const written = generateCursorHooksConfig({
    hooks,
    policyBridge: true,
    userHookEvents: true,
  });
  expect(written.withheldEvents).toEqual([]);
  for (const [event, classes, command] of [
    ["preToolUse", "edit", "/h/pre.sh"],
    ["afterShellExecution", "shell", "/h/post.sh"],
    ["afterMCPExecution", "mcp", "/h/post.sh"],
  ] as const) {
    // A user hook alone: the bridge is never written on these (decision 5).
    expect(written.config.hooks[event]).toEqual([
      { command: gated("'agents'", "cursor", event, classes, command) },
    ]);
  }
});

test("an event is withheld only when a declared handler would register on it", () => {
  const { withheldEvents, config } = generateCursorHooksConfig({
    hooks: {
      pre_tool_call: [{ command: "/h/shell.sh", appliesTo: ["shell"] }],
      post_tool_call: [{ command: "/h/edit.sh", appliesTo: ["edit"] }],
    },
  });
  expect(withheldEvents).toEqual([]);
  expect(Object.keys(config.hooks)).toEqual([
    "beforeShellExecution",
    "afterFileEdit",
  ]);
});

test("an empty class intersection registers nothing (ADR 0028 decision 2)", () => {
  // pre-edit has one Cursor event, so an edit-only pre_tool_call handler
  // registers there and nowhere else.
  const { config } = generateCursorHooksConfig({
    hooks: { pre_tool_call: [{ command: "/h/edit.sh", appliesTo: ["edit"] }] },
    userHookEvents: true,
  });
  expect(Object.keys(config.hooks)).toEqual(["preToolUse"]);
  const claude = generateClaudeHooksConfig({
    hooks: { pre_tool_call: [{ command: "/h/mcp.sh", appliesTo: ["mcp"] }] },
  });
  expect(claude.config.hooks.PreToolUse).toEqual([
    {
      matcher: "mcp__.*",
      hooks: [
        {
          type: "command",
          command: gated(
            "'agents'",
            "claude",
            "PreToolUse",
            "mcp",
            "/h/mcp.sh",
          ),
        },
      ],
    },
  ]);
});

test("the policy probe vocabulary leaves out the user-hook events (ADR 0028 decision 3)", () => {
  const names = allEnforceableProbeEventNames();
  for (const event of ["beforeShellExecution", "afterFileEdit", "PreToolUse"]) {
    expect(names.has(event)).toBe(true);
  }
  for (const event of [
    "preToolUse",
    "afterShellExecution",
    "afterMCPExecution",
  ]) {
    expect(names.has(event)).toBe(false);
  }
});

test("Claude registers an unscoped handler on the three classes, not every tool (ADR 0028 decision 6)", () => {
  const { config } = generateClaudeHooksConfig({
    hooks: {
      pre_tool_call: [
        { command: "/h/any.sh" },
        // #235: both fields, and applies_to still decides the native matcher.
        { command: "/h/both.sh", matcher: ".*", appliesTo: ["shell"] },
      ],
    },
    policyBridge: true,
  });
  expect(config.hooks.PreToolUse?.map((group) => group.matcher)).toEqual([
    undefined,
    "Bash|mcp__.*|Edit|Write|NotebookEdit",
    "Bash",
  ]);
  expect(config.hooks.PreToolUse?.[2]?.hooks[0]?.command).toBe(
    gated("'agents'", "claude", "PreToolUse", "shell", "/h/both.sh", ".*"),
  );
});

test("gate values reach the agents CLI unexpanded by the shell, on both adapters (ADR 0028 decision 2, JC-5)", async () => {
  const handler = 'echo "$HOME" $(id) `id` it\'s';
  const matcher = "it's|$(echo x)|`id`";
  const hooks: HooksSpec = { pre_tool_call: [{ command: handler, matcher }] };
  const cursor = generateCursorHooksConfig({
    hooks,
    // printf stands in for the CLI and prints each argument it receives.
    agentsCli: "printf",
  });
  const claude = generateClaudeHooksConfig({
    hooks,
    agentsCli: ["printf", "%s\n"],
  });
  const run = async (command: string) => {
    const proc = Bun.spawn({ cmd: ["sh", "-c", command], stdout: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    return stdout;
  };
  expect(
    await run(
      `${config(cursor).beforeShellExecution?.[0]?.command ?? ""}`.replace(
        "'printf' hook-gate",
        "'printf' '%s\n' hook-gate",
      ),
    ),
  ).toBe(
    [
      "hook-gate",
      "--adapter",
      "cursor",
      "--event",
      "beforeShellExecution",
      "--classes",
      "shell",
      "--matcher",
      matcher,
      "--",
      handler,
      "",
    ].join("\n"),
  );
  expect(
    await run(claude.config.hooks.PreToolUse?.[0]?.hooks[0]?.command ?? ""),
  ).toBe(
    [
      "hook-gate",
      "--adapter",
      "claude",
      "--event",
      "PreToolUse",
      "--classes",
      "shell,mcp,edit",
      "--matcher",
      matcher,
      "--",
      handler,
      "",
    ].join("\n"),
  );
});

function config(generated: { readonly config: { readonly hooks: object } }) {
  return generated.config.hooks as Record<
    string,
    ReadonlyArray<{ readonly command: string }> | undefined
  >;
}

test("each distinct gate command is offered once for the start-up probe (ADR 0028 decision 7)", () => {
  const hooks: HooksSpec = {
    pre_tool_call: [{ command: "/h/a.sh", appliesTo: ["shell"] }],
    post_tool_call: [{ command: "/h/b.sh", matcher: "Write" }],
  };
  const claude = generateClaudeHooksConfig({ hooks, agentsCli: ["/b", "/e"] });
  expect(claude.gateProbes).toEqual([
    "'/b' '/e' hook-gate --probe --adapter 'claude' --event 'PreToolUse' --classes 'shell' -- '/h/a.sh'",
    "'/b' '/e' hook-gate --probe --adapter 'claude' --event 'PostToolUse' --classes 'shell,mcp,edit' --matcher 'Write' -- '/h/b.sh'",
  ]);
  const cursor = generateCursorHooksConfig({ hooks, userHookEvents: true });
  expect(cursor.gateProbes).toHaveLength(4);
  expect(
    cursor.gateProbes.every((probe) =>
      probe.startsWith("'agents' hook-gate --probe "),
    ),
  ).toBe(true);
  // Withheld events are not probed: nothing would run them.
  expect(generateCursorHooksConfig({ hooks }).gateProbes).toHaveLength(2);
});

test("lifecycle handlers are not gated; their matcher is single-quoted (ADR 0028 decision 1, JC-5)", () => {
  const { config } = generateCursorHooksConfig({
    hooks: { role_stop: [{ command: "/h/stop.sh", matcher: "$(x)" }] },
  });
  expect(config.hooks.stop).toEqual([
    { command: "HOOK_MATCHER='$(x)' /h/stop.sh" },
  ]);
});

test("every native tool-call event has a row in the gate's table (ADR 0028 decision 3)", () => {
  for (const caps of ADAPTER_HOOK_CAPABILITIES) {
    const natives = [
      ...caps.nativeEvents.pre_tool_call,
      ...caps.nativeEvents.post_tool_call,
    ];
    expect([caps.adapter, Object.keys(caps.toolEvents).sort()]).toEqual([
      caps.adapter,
      [...new Set(natives)].sort(),
    ]);
  }
  const cursor = ADAPTER_HOOK_CAPABILITIES.find((c) => c.adapter === "cursor");
  expect(
    Object.entries(cursor?.toolEvents ?? {})
      .filter(([, row]) => row.userHooksOnly === true)
      .map(([event]) => event)
      .sort(),
  ).toEqual(["afterMCPExecution", "afterShellExecution", "preToolUse"]);
});

test("a matcher that matches no shell or edit name warns, naming the handler, adapter and applies_to (ADR 0028 decision 8, #220)", () => {
  const hooks: HooksSpec = {
    pre_tool_call: [
      { command: "/h/a.sh", matcher: "Execute" },
      { command: "/h/b.sh", matcher: "Execute", appliesTo: ["shell"] },
      // MCP names are an open set: an mcp-only handler is not checked.
      { command: "/h/c.sh", matcher: "Execute", appliesTo: ["mcp"] },
      // Names that match, whole, on every adapter.
      { command: "/h/d.sh", matcher: "Bash" },
      { command: "/h/e.sh", matcher: "Shell|Write", appliesTo: ["shell"] },
      { command: "/h/f.sh", appliesTo: ["edit"] },
    ],
    post_tool_call: [
      // Edit matches part of NotebookEdit, but not whole, and Read is no
      // edit name.
      { command: "/h/g.sh", matcher: "Notebook|Read", appliesTo: ["edit"] },
      { command: "/h/h.sh", matcher: ".*Edit", appliesTo: ["edit"] },
    ],
    role_stop: [{ command: "/h/stop.sh", matcher: "Execute" }],
  };
  for (const adapter of ["cursor", "claude"]) {
    expect(unmatchableMatcherWarnings(hooks, adapter)).toEqual([
      `hooks.pre_tool_call[0]: matcher "Execute" matches no shell or edit tool name on adapter ${adapter} ` +
        "(shell: Bash, Shell; edit: Write, Edit, NotebookEdit, Delete) with no applies_to (every class), " +
        "so it never runs on a shell or edit call, and runs only on MCP calls whose " +
        "mcp__<server>__<tool> name it matches (ADR 0028)",
      `hooks.pre_tool_call[1]: matcher "Execute" matches no shell tool name on adapter ${adapter} ` +
        "(shell: Bash, Shell) with applies_to [shell], so it never runs (ADR 0028)",
      `hooks.post_tool_call[0]: matcher "Notebook|Read" matches no edit tool name on adapter ${adapter} ` +
        "(edit: Write, Edit, NotebookEdit, Delete) with applies_to [edit], so it never runs (ADR 0028)",
    ]);
  }
  // No generator, no gate: nothing to say.
  expect(unmatchableMatcherWarnings(hooks, "opencode")).toEqual([]);
  expect(unmatchableMatcherWarnings({})).toEqual([]);
});
