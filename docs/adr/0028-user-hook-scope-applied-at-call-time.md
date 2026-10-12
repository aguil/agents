# ADR 0028: `agents` applies a user hook's `matcher` and `applies_to` at call time, on every adapter

**Status:** Proposed

**Status history:**

- 2026-10-12 — Proposed.

**Context:** A tool-call handler in `harness.yaml` scopes itself in two ways:
`matcher`, a regex over tool names (spec v0.1), and `applies_to`, a list of
event classes `shell`, `mcp` and `edit` (spec v0.2, ADR 0009 decision 1). ADR
0023 made `agents` generate hook configuration for Claude Code as well as
Cursor, and the two generators read those fields differently. The result is that
the adapter, not the author, decides whether a declared hook runs.

**On Claude Code, `matcher` overrides `applies_to` (#235).** The Claude
generator (`packages/hooks/src/claude.ts`, `matcherFor`) copies an explicit
`matcher` into Claude Code's native `matcher` field and drops `applies_to`. A
handler declaring `{matcher: ".*", applies_to: [shell]}` registers on every
tool, edits, reads and MCP calls included. ADR 0009 decision 1 says generation
registers an `applies_to`-scoped handler only on events of those classes; on
Claude Code it does not.

**`matcher` filters nothing on Cursor either (#220).** `matcher` is documented
as a "Regex over tool names (e.g. "Execute", "Create|Edit")"
(`packages/harness-config/src/index.ts`). Cursor's hook schema has no matcher
field, so the Cursor generator prefixes the handler's command with
`HOOK_MATCHER=<regex>` and leaves filtering to the handler, on the stated
assumption that hook payloads carry the tool name. On Claude Code the same regex
is matched against Claude's tool names, so `matcher: "Execute"` never fires
there. The `triage-demo` test fixture has exactly that handler.

Measured on 2026-10-12 on `cursor-agent 2026.10.01-14929f9` and Claude Code
`2.1.296`, headless, one trial per cell, with stub hooks logging their stdin:

| Call  | Cursor: specific events                                     | Cursor: `preToolUse` / `postToolUse` | Claude Code: `PreToolUse` / `PostToolUse` |
| ----- | ----------------------------------------------------------- | ------------------------------------ | ----------------------------------------- |
| shell | `beforeShellExecution`, `afterShellExecution`: no tool name | `Shell`                              | `Bash`                                    |
| edit  | `afterFileEdit`: no tool name                               | `Write`                              | `Write`                                   |
| read  | `beforeReadFile`: no tool name                              | `Read`                               | `Read`                                    |
| MCP   | `beforeMCPExecution`, `afterMCPExecution`: bare tool name   | `MCP:<tool>`                         | `mcp__<server>__<tool>`                   |

So the Cursor events user handlers run on today, `beforeShellExecution`,
`beforeMCPExecution` and `afterFileEdit`, carry no tool name except the MCP one.
A handler given `HOOK_MATCHER` there has nothing to test it against, and no
payload on either CLI carries `"Execute"`. A command prefixed
`HOOK_MATCHER='<regex>'` did reach its handler byte for byte on Cursor
`beforeShellExecution`, Cursor `preToolUse` and Claude Code `PreToolUse`. Cursor
fired `preToolUse` about 120 ms before `beforeShellExecution` for the same call,
and before `beforeMCPExecution` too. The edit names Claude Code documents,
`Edit` and `NotebookEdit`, and Cursor's in-place edit tool were not observed.

**A third gap neither issue names.** ADR 0006 §4 maps `pre_tool_call` to
`beforeShellExecution` and `beforeMCPExecution`, and `post_tool_call` to
`afterFileEdit`. Claude Code maps both canonical events to every class through
`PreToolUse` and `PostToolUse`. So on Cursor a `pre_tool_call` handler with
`applies_to: [edit]`, or a `post_tool_call` handler with `[shell]` or `[mcp]`,
registers on nothing, and the same handler runs on Claude Code. Cursor has no
pre-edit event of its own. It does fire `afterShellExecution` and
`afterMCPExecution` headless, which `agents` does not map.

**What a hook that says nothing does.** Measured on 2026-10-12, one trial per
cell. On Claude Code `2.1.296`, under the default permission mode, a
`PreToolUse` hook that exited 0 and printed nothing left an edit refused, as
with no hook; a hook printing an explicit allow let it through. That is the
behaviour recorded in ADR 0023's context: an allow lifts the headless permission
default. A `PostToolUse` hook that exited 0 and printed nothing was recorded as
`outcome: "success"`. On `cursor-agent 2026.10.01-14929f9`, every edit and shell
call ran to completion under a `preToolUse` or `afterShellExecution` hook
printing nothing, `{}` or an allow. The run's scorer did not score those Cursor
rows, because its extractor misread this Cursor version's tool-call records, so
the Cursor half is a reading of the raw streams, not a scored result. A
user-level Cursor hooks file was present in every cell.

**What one more process costs.** Starting the `agents` CLI and having it exit
took 77 ms at p50 more than `/bin/true` when the binary was called directly, and
107 ms through `mise exec` with pinned versions, on 2026-10-12 with
`agents 0.8.11`. ADR 0009 decision 2 accepted the policy bridge's 48.5 ms p50,
on the premise that read and search calls do not map to hooks.

**Decision:**

1. **A user tool-call hook runs behind a gate that `agents` provides.** Every
   generated hook for a harness-declared `pre_tool_call` or `post_tool_call`
   handler, on every adapter, runs `agents hook-gate` instead of the handler's
   command. The gate decides whether this call is in the handler's scope and,
   only if it is, runs the handler. Authors write no filtering. The handler's
   `matcher` and `applies_to` mean the same on every adapter, because one
   program applies them from one table. A `HOOK_MATCHER` variable is still set
   for the handler, quoted as a POSIX single-quoted word, so handlers that read
   it keep working; it is informational, and a handler need not test it.

2. **The gate's contract.** The generated command is

   ```text
   <agents> hook-gate --adapter <cursor|claude> --event <native event>
     --classes <class>[,<class>…] [--matcher '<regex>'] -- '<handler command>'
   ```

   with every value a POSIX single-quoted word. `--classes` is the class set the
   generator gave this registration: the classes the native event carries,
   intersected with the handler's `applies_to`, or all of them when it declares
   none. The gate reads the hook payload from stdin, and:
   - takes the call's class and tool name from decision 3's table;
   - runs the handler when the class is in `--classes` and, if `--matcher` is
     given, the tool name matches it as an unanchored JavaScript regular
     expression, the same reading the field has had;
   - runs it as `/bin/sh -c '<handler command>'`, with the payload on stdin
     unchanged and the handler's environment plus `HOOK_MATCHER`, and passes the
     handler's stdout, stderr and exit status through unchanged, so a handler's
     deny still denies, including Claude Code's exit-2 block, which reads
     stderr;
   - otherwise skips (decision 4).

   A tool name the table cannot place in any class is reported, as one line on
   stderr naming it, and skipped; it is never treated as a match, and never
   silently. An invalid `matcher` regex is a configuration error: the harness
   loader rejects it when the harness loads, so the gate never meets one.

3. **Where the class and the tool name come from.** One table in
   `packages/hooks/src/adapter-table.ts` gives, per adapter and native event,
   the event's classes and the payload field holding the tool name:

   | Adapter     | Native event                                  | Classes          | Tool name                                                                     |
   | ----------- | --------------------------------------------- | ---------------- | ----------------------------------------------------------------------------- |
   | Cursor      | `beforeShellExecution`, `afterShellExecution` | shell            | none carried: tested as `Shell`                                               |
   | Cursor      | `beforeMCPExecution`, `afterMCPExecution`     | mcp              | `tool_name`, bare                                                             |
   | Cursor      | `afterFileEdit`                               | edit             | none carried: tested as `Write`                                               |
   | Cursor      | `preToolUse`                                  | edit             | `tool_name`; `Write` and `Edit` are edit, any other skips                     |
   | Claude Code | `PreToolUse`, `PostToolUse`                   | shell, mcp, edit | `tool_name`: `Bash` shell, `Write`, `Edit`, `NotebookEdit` edit, `mcp__*` mcp |

   Where an event carries no tool name, the gate tests `matcher` against the
   name Cursor's generic events give that class, as measured, `Shell` or
   `Write`. That keeps a regex meaning the same on a Cursor specific event and
   on a generic one. Names the table lists but no measurement has observed
   (`Edit`, `NotebookEdit`, Cursor's `Edit`) are recorded as documented, not
   measured, and a new measurement replaces them.

4. **A gate that skips says nothing.** It exits 0 with no stdout and no stderr,
   on every adapter and event. It never prints an allow: on Claude Code an
   explicit allow lifts the headless permission default, so a gate that answered
   allow for calls it had skipped would widen what a run may do whenever no
   policy is declared. On `PostToolUse` a pre-call-shaped answer is recorded as
   a failed hook (ADR 0023 decision 9), and an empty one is not. On Cursor the
   measurement above is unscored; the implementing change confirms the skip on a
   live `cursor-agent` before it merges.

5. **On Cursor, user hooks gain three events, and the bridge none.**
   `pre_tool_call` handlers register on `beforeShellExecution` (shell),
   `beforeMCPExecution` (mcp) and `preToolUse` (edit). `post_tool_call` handlers
   register on `afterShellExecution` (shell), `afterMCPExecution` (mcp) and
   `afterFileEdit` (edit). Each registration carries only the classes of its
   event, so no call reaches a handler twice and `preToolUse` passes a handler
   only edits. The policy bridge's events are unchanged.

   The three added events, `preToolUse`, `afterShellExecution` and
   `afterMCPExecution`, are written only for `cursor-agent` versions measured to
   fire them, an exact list starting with `2026.10.01-14929f9`, never "this
   version or later". An event the installed CLI does not know silently stops
   every other hook in the workspace, the bridge included (#239). On another
   version they are withheld, `harness run` warns, and the withheld events are
   recorded in `undeliverable_hooks` as ADR 0024 records an inert event.
   `harness run` reads the `cursor-agent` version whenever a harness declares a
   user tool-call hook, not only when it declares a policy.

6. **On Claude Code, the native matcher is the class matcher.** A handler's
   Claude Code `matcher` is always the projection of its `applies_to`, as ADR
   0009 decision 1 says; its own `matcher` reaches the gate instead. This ends
   ADR 0023 decision 1's pass-through of `matcher` into Claude Code's settings.
   The bridge stays first and on `PreToolUse` only (ADR 0023 decision 9).

7. **The gate names the CLI that generated it, and is probed before any role
   runs.** On Claude Code the gate is invoked as the running CLI's Bun
   executable and entry script, as absolute paths, as ADR 0023 decision 10 does
   for the bridge. On Cursor the generated file keeps `agents` on the hook's
   `PATH`, as the bridge does. Before any role runs, `harness run` invokes one
   generated gate command with a payload outside its classes, as the adapter
   would. Exit 0 with no output passes. Anything else fails the run, because an
   `agents` too old to know `hook-gate` would leave every gated hook silently
   inert, the failure #220 reports.

8. **The load warning (#220).** When a harness loads for an adapter, each
   tool-call handler that sets `matcher` is checked against the tool names that
   adapter carries for the classes it registers on, from decision 3's table,
   shell and edit only. MCP names are left out: they are an open set named by
   the MCP server, which ADR 0009 decision 1 declined to interpret. If the regex
   matches none of those names and the handler registers on shell or edit,
   `harness run` warns, naming the handler, the adapter and `applies_to`.
   `matcher: "Execute"` warns on both adapters.

9. **The cost is accepted, and bounded by scope.** A gated hook adds one
   `agents` process per invocation: measured at 77 ms p50 called directly and
   107 ms through `mise exec`, 1.6 to 2.2 times the bridge's figure in ADR 0009
   decision 2. A gate runs only on its registration's events. The specific
   events fire only for their class. `preToolUse` fires for every tool call, so
   a pre-edit handler on Cursor costs a process on every call, reads included.
   Only harnesses that declare their own tool-call hooks pay any of it. Should
   that matter, the shape of the fix is the one ADR 0009 decision 2 names, a
   purpose-built minimal entry point, not a return to handler-side filtering.

10. **Supersession and exceptions.** This ADR:
    - supersedes ADR 0006 §4's Cursor mapping in part, adding `preToolUse`,
      `afterShellExecution` and `afterMCPExecution` for user hooks;
    - is an exception to ADR 0006 §3 and ADR 0009 decision 1, which put the
      bridge first on every mapped tool event: the three added Cursor events
      carry user hooks and no bridge. On `preToolUse` a pre-edit user hook runs
      with no bridge before it, because Cursor's bridge has no pre-edit event to
      run on; it enforces edits on `afterFileEdit`, as before. A user hook can
      still only tighten: a policy deny stands whatever it returns;
    - supersedes ADR 0023 decision 1 in part, ending the pass-through of
      `matcher` into Claude Code's settings;
    - extends ADR 0024's undeliverable-event record to Cursor's withheld
      user-hook events.

**Consequences:**

- A handler's scope means the same on Cursor and Claude Code, and a declared
  hook runs on the same calls on both, except where an event is withheld on an
  unmeasured `cursor-agent`, which the run records.
- Existing Cursor handlers keep their events and payload shapes. An unscoped
  handler gains Cursor's pre-edit calls and its post-call shell and MCP calls,
  which it already had on Claude Code.
- Every harness-declared tool-call hook pays one `agents` process per
  invocation, and on Cursor a pre-edit hook pays it on every tool call.
- A handler that relied on `HOOK_MATCHER` to filter keeps working; the filtering
  is now done before it runs.
- `matcher`'s documentation names each adapter's tool names instead of
  `Execute`.

**References:**

- #220, #235, #239
- ADR 0006 (§3, §4), ADR 0009 (decisions 1 and 2), ADR 0023 (decisions 1, 9 and
  10), ADR 0024
- `packages/hooks/src/claude.ts`, `packages/hooks/src/index.ts`,
  `packages/hooks/src/adapter-table.ts`, `packages/cli/src/harness-run-main.ts`
