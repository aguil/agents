import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideHookGate,
  type HookGateArgs,
  parseHookGateArgv,
} from "@aguil/agents-hooks";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(repoRoot, "packages", "cli", "src", "index.ts");

function args(overrides: Partial<HookGateArgs>): HookGateArgs {
  return {
    adapter: "claude",
    event: "PreToolUse",
    classes: ["shell", "mcp", "edit"],
    command: "true",
    probe: false,
    ...overrides,
  };
}

const decide = (overrides: Partial<HookGateArgs>, payload: unknown) =>
  decideHookGate(
    args(overrides),
    typeof payload === "string" ? payload : JSON.stringify(payload),
  );

test("a whole-name match: Edit selects Edit, not NotebookEdit or an MCP tool (ADR 0028 decision 9)", () => {
  expect(decide({ matcher: "Edit" }, { tool_name: "Edit" })).toEqual({
    action: "run",
  });
  expect(decide({ matcher: "Edit" }, { tool_name: "NotebookEdit" })).toEqual({
    action: "skip",
  });
  expect(
    decide({ matcher: "Edit" }, { tool_name: "mcp__files__Edit" }),
  ).toEqual({ action: "skip" });
  expect(decide({ matcher: ".*Edit" }, { tool_name: "NotebookEdit" })).toEqual({
    action: "run",
  });
  expect(decide({ matcher: "Write|Edit" }, { tool_name: "Write" })).toEqual({
    action: "run",
  });
});

test("Bash and Shell both select shell calls on both adapters (ADR 0028 decision 3)", () => {
  for (const matcher of ["Bash", "Shell"]) {
    expect(decide({ matcher }, { tool_name: "Bash" })).toEqual({
      action: "run",
    });
    expect(
      decide(
        {
          adapter: "cursor",
          event: "beforeShellExecution",
          classes: ["shell"],
          matcher,
        },
        { command: "ls", cwd: "/w" },
      ),
    ).toEqual({ action: "run" });
  }
  expect(
    decide(
      {
        adapter: "cursor",
        event: "afterShellExecution",
        classes: ["shell"],
        matcher: "Write",
      },
      { command: "ls", output: "" },
    ),
  ).toEqual({ action: "skip" });
});

test("a named Write is distinct from Edit; afterFileEdit matches any edit name", () => {
  expect(decide({ matcher: "Edit" }, { tool_name: "Write" })).toEqual({
    action: "skip",
  });
  const cursorPre = {
    adapter: "cursor",
    event: "preToolUse",
    classes: ["edit"],
  } as const;
  expect(
    decide({ ...cursorPre, matcher: "Edit" }, { tool_name: "Write" }),
  ).toEqual({ action: "skip" });
  expect(
    decide({ ...cursorPre, matcher: "Write" }, { tool_name: "Write" }),
  ).toEqual({ action: "run" });
  // afterFileEdit names no tool, so any edit name may be the one that ran.
  for (const matcher of ["Write", "Edit", "NotebookEdit", "Delete"]) {
    expect(
      decide(
        {
          adapter: "cursor",
          event: "afterFileEdit",
          classes: ["edit"],
          matcher,
        },
        { file_path: "/w/a", edits: [] },
      ),
    ).toEqual({ action: "run" });
  }
});

test("Cursor MCP names are built as mcp__<server>__<tool> on both MCP events", () => {
  for (const event of ["beforeMCPExecution", "afterMCPExecution"]) {
    const base = { adapter: "cursor", event, classes: ["mcp"] } as const;
    const payload = { tool_name: "echo_token", mcp_server_name: "cvprobe" };
    expect(
      decide({ ...base, matcher: "mcp__cvprobe__echo_token" }, payload),
    ).toEqual({ action: "run" });
    expect(decide({ ...base, matcher: "mcp__cvprobe__.*" }, payload)).toEqual({
      action: "run",
    });
    expect(decide({ ...base, matcher: "echo_token" }, payload)).toEqual({
      action: "skip",
    });
  }
  // Claude names it so already.
  expect(
    decide({ matcher: "mcp__cvprobe__.*" }, { tool_name: "mcp__cvprobe__x" }),
  ).toEqual({ action: "run" });
});

test("a known call outside the registration's classes skips silently", () => {
  // Claude's other tools are known: a read never runs a gated handler.
  expect(decide({}, { tool_name: "Read" })).toEqual({ action: "skip" });
  expect(decide({ classes: ["shell"] }, { tool_name: "Write" })).toEqual({
    action: "skip",
  });
  // Cursor's preToolUse fires for every tool; only edits are in its scope.
  const cursorPre = {
    adapter: "cursor",
    event: "preToolUse",
    classes: ["edit"],
  } as const;
  for (const tool_name of ["Shell", "Read", "Grep", "MCP:echo_token"]) {
    expect(decide(cursorPre, { tool_name })).toEqual({ action: "skip" });
  }
  expect(decide(cursorPre, { tool_name: "Delete" })).toEqual({ action: "run" });
});

test("a call the gate cannot read is reported and runs the handler (ADR 0028 decision 2)", () => {
  expect(decide({}, "not json")).toEqual({
    action: "report",
    report:
      "agents hook-gate: claude PreToolUse: stdin is not a JSON object, so the handler runs unfiltered (ADR 0028)",
  });
  expect(decide({}, { tool_input: {} })).toEqual({
    action: "report",
    report:
      'agents hook-gate: claude PreToolUse: the payload has no "tool_name", so the handler runs unfiltered (ADR 0028)',
  });
  expect(decide({}, { tool_name: "Teleport" })).toEqual({
    action: "report",
    report:
      'agents hook-gate: claude PreToolUse: tool "Teleport" is in no class the gate knows, so the handler runs unfiltered (ADR 0028)',
  });
  expect(
    decide(
      { adapter: "cursor", event: "beforeMCPExecution", classes: ["mcp"] },
      { tool_name: "echo_token" },
    ),
  ).toEqual({
    action: "report",
    report:
      'agents hook-gate: cursor beforeMCPExecution: the payload has no "mcp_server_name", so the handler runs unfiltered (ADR 0028)',
  });
});

test("hook-gate's argv is checked against the adapter table", () => {
  const ok = parseHookGateArgv([
    "--adapter",
    "cursor",
    "--event",
    "preToolUse",
    "--classes",
    "edit",
    "--matcher",
    "Write",
    "--",
    "x y",
  ]);
  expect(ok).toEqual({
    adapter: "cursor",
    event: "preToolUse",
    classes: ["edit"],
    matcher: "Write",
    command: "x y",
    probe: false,
  });
  const base = ["--adapter", "cursor", "--event", "preToolUse"];
  expect(parseHookGateArgv([...base, "--classes", "shell", "--", "x"])).toBe(
    "hook-gate: cursor preToolUse carries no shell calls",
  );
  expect(
    parseHookGateArgv([
      "--adapter",
      "cursor",
      "--event",
      "beforeReadFile",
      "--classes",
      "edit",
      "--",
      "x",
    ]),
  ).toBe('hook-gate: "beforeReadFile" is not a cursor tool-call event');
  expect(
    parseHookGateArgv([
      ...base,
      "--classes",
      "edit",
      "--matcher",
      "(",
      "--",
      "x",
    ]),
  ).toContain("hook-gate: --matcher is not a valid regular expression");
  expect(parseHookGateArgv([...base, "--classes", "edit"])).toBe(
    "hook-gate: missing -- <handler command>",
  );
  expect(
    parseHookGateArgv([...base, "--classes", "edit", "--", "a", "b"]),
  ).toBe("hook-gate: expected exactly one handler command after --");
});

async function gate(
  argv: readonly string[],
  stdin: string | "open",
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, entry, "hook-gate", ...argv],
    stdin: stdin === "open" ? "pipe" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOOK_MATCHER: "" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

const claudeShell = [
  "--adapter",
  "claude",
  "--event",
  "PreToolUse",
  "--classes",
  "shell",
  "--matcher",
  "Bash",
  "--",
];

test("an in-scope call runs the handler under /bin/sh -c with stdin, stdout, stderr and exit passed through", async () => {
  const payload = `${JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } })}\n`;
  const handler =
    'printf "%s|%s|" "$0" "$HOOK_MATCHER"; cat; echo to-stderr >&2; exit 7';
  const result = await gate([...claudeShell, handler], payload);
  expect(result).toEqual({
    stdout: `/bin/sh|Bash|${payload}`,
    stderr: "to-stderr\n",
    exitCode: 7,
  });
});

test("a handler's Claude Code exit-2 block passes through with its stderr", async () => {
  const result = await gate(
    [...claudeShell, "echo 'blocked: no rm' >&2; exit 2"],
    JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm x" } }),
  );
  expect(result).toEqual({
    stdout: "",
    stderr: "blocked: no rm\n",
    exitCode: 2,
  });
});

test("a skipped call exits 0 with no output and runs nothing (ADR 0028 decision 4)", async () => {
  // A shell-only registration, no matcher: edits and reads are out of scope.
  for (const tool_name of ["Write", "Edit", "Read"]) {
    const result = await gate(
      [...claudeShell.slice(0, -3), "--", "echo ran; exit 9"],
      JSON.stringify({ tool_name }),
    );
    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  }
  // An unmatched name skips too.
  const unmatched = await gate(
    [
      "--adapter",
      "claude",
      "--event",
      "PreToolUse",
      "--classes",
      "edit",
      "--matcher",
      "Edit",
      "--",
      "echo ran",
    ],
    JSON.stringify({ tool_name: "Write" }),
  );
  expect(unmatched).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("an unreadable call writes one stderr line, then runs the handler", async () => {
  const result = await gate([...claudeShell, "cat; echo; exit 3"], "{oops");
  expect(result.exitCode).toBe(3);
  expect(result.stdout).toBe("{oops\n");
  expect(result.stderr.split("\n").filter((line) => line !== "")).toEqual([
    "agents hook-gate: claude PreToolUse: stdin is not a JSON object, so the handler runs unfiltered (ADR 0028)",
  ]);
});

test("--probe exits 0 silently without reading stdin or running the handler (ADR 0028 decision 7)", async () => {
  // stdin stays open: a gate that read it would hang until the test timed out.
  const result = await gate(
    ["--probe", ...claudeShell, "echo ran; exit 9"],
    "open",
  );
  expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  const bad = await gate(
    [
      "--probe",
      "--adapter",
      "claude",
      "--event",
      "PreToolUse",
      "--classes",
      "shell",
      "--matcher",
      "a)|(b",
      "--",
      "true",
    ],
    "open",
  );
  expect(bad.exitCode).toBe(1);
  expect(bad.stderr).toContain(
    "hook-gate: --matcher is not a valid regular expression",
  );
}, 15_000);
