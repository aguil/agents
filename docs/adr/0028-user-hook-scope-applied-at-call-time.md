# ADR 0028: `agents` applies a user hook's `matcher` and `applies_to` at call time, on Cursor and Claude Code

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
Claude Code it does not. A handler with neither field gets no native matcher, so
on Claude Code it runs on every tool, reads, searches and web fetches included,
while on Cursor it runs only on the shell, MCP and edit events ADR 0006 §4 maps.

**`matcher` filters nothing on Cursor either (#220).** `matcher` is documented
as a "Regex over tool names (e.g. "Execute", "Create|Edit")"
(`packages/harness-config/src/index.ts`). Cursor's hook schema has no matcher
field, so the Cursor generator prefixes the handler's command with
`HOOK_MATCHER=<regex>` and leaves filtering to the handler, on the stated
assumption that hook payloads carry the tool name. On Claude Code the same regex
goes to Claude Code's own matcher, which filters Claude's tool names, so
`matcher: "Execute"` never fires there. The `triage-demo` test fixture has
exactly that handler.

Measured on 2026-10-12 on `cursor-agent 2026.10.01-14929f9` and Claude Code
`2.1.296`, headless, one trial per cell, with stub hooks logging their stdin:

| Call  | Cursor: specific events                                                      | Cursor: `preToolUse` / `postToolUse` | Claude Code: `PreToolUse` / `PostToolUse` |
| ----- | ---------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------- |
| shell | `beforeShellExecution`, `afterShellExecution`: no tool name                  | `Shell`                              | `Bash`                                    |
| edit  | `afterFileEdit`: no tool name                                                | `Write` (and `Read`, see below)      | `Write`                                   |
| read  | `beforeReadFile`: no tool name                                               | `Read`                               | `Read`                                    |
| MCP   | `beforeMCPExecution`, `afterMCPExecution`: bare tool name, `mcp_server_name` | `MCP:<tool>`                         | `mcp__<server>__<tool>`                   |

So the Cursor events user handlers run on today, `beforeShellExecution`,
`beforeMCPExecution` and `afterFileEdit`, carry no tool name except the MCP one.
A handler given `HOOK_MATCHER` there has nothing to test it against, and no
payload on either CLI carries `"Execute"`. A command prefixed
`HOOK_MATCHER='<regex>'` did reach its handler byte for byte on Cursor
`beforeShellExecution`, Cursor `preToolUse` and Claude Code `PreToolUse`. In the
hook logs of one shell call, Cursor's `preToolUse` stub logged about 120 ms
before its `beforeShellExecution` stub, and its `preToolUse` stub logged before
`beforeMCPExecution` for one MCP call. For each edit, Cursor fired `preToolUse`
twice, for a `Read` of the file and then the `Write`. The Cursor MCP rows come
from a call Cursor rejected before it ran. Every edit observed created a new
file; the name of an in-place edit tool, on Cursor, and Claude Code's documented
`Edit` and `NotebookEdit`, were not observed. Neither were the names of Cursor's
other tools that reach `preToolUse`, such as its search and delete tools.

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
behaviour ADR 0023's context records: an allow lifts the headless permission
default. A `PostToolUse` hook that exited 0 and printed nothing was recorded as
`outcome: "success"`. On `cursor-agent 2026.10.01-14929f9`, every edit and shell
call ran to completion under a `preToolUse` or `afterShellExecution` hook
printing nothing, `{}` or an allow. The measurement's scorer left those Cursor
rows unscored; its extractor recorded every call as not made although the
streams show each one completed, so the Cursor half is a reading of the raw
streams, not a scored result. A user-level Cursor hooks file was present in
every cell and registers a `preToolUse` hook that prints nothing, so no Cursor
cell was free of an empty `preToolUse` hook. The empty skip on
`afterMCPExecution`, and on the specific events user hooks use today, was not
measured.

**What one more process costs.** Starting the `agents` CLI and having it exit
(`agents --version`) took 77 ms at p50 more than `/bin/true` when the binary was
called directly, and 107 ms through `mise exec` with pinned versions, on
2026-10-12 with `agents 0.8.11`. ADR 0009 decision 2 accepted the policy bridge
at 48.5 ms p50, an absolute time for `bun run … policy-eval` including its
policy parse, on the premise that read and search calls do not map to hooks. The
two are different measurements: one is a difference over `/bin/true`, the other
an absolute time, and the gate as Claude Code would run it, a Bun executable and
an entry script, was not timed.

**Decision:**

1. **A user tool-call hook runs behind a gate that `agents` provides.** Every
   generated hook for a harness-declared `pre_tool_call` or `post_tool_call`
   handler, on Cursor and on Claude Code, runs `agents hook-gate` instead of the
   handler's command. The gate decides whether this call is in the handler's
   scope and, only if it is, runs the handler. Authors write no filtering. The
   handler's `matcher` and `applies_to` mean the same on both adapters, because
   one program applies them, from one table, against one set of names per class
   (decision 3). A `HOOK_MATCHER` variable is set for the handler, as the Cursor
   generator sets it today and, newly, on Claude Code; it is informational, and
   a handler need not test it. Lifecycle events (`role_start`, `role_stop`,
   `run_start`, `run_end`) are not gated, and OpenCode, which `agents` generates
   no hooks for, is not affected.

2. **The gate's contract.** The generated command is

   ```text
   <agents> hook-gate --adapter <cursor|claude> --event <native event>
     --classes <class>[,<class>…] [--matcher '<regex>'] -- '<handler command>'
   ```

   with every value a POSIX single-quoted word. `--classes` is the class set the
   generator gave this registration: the classes the native event carries,
   intersected with the handler's `applies_to`, or all of them when it declares
   none. An empty intersection registers nothing, as the Claude generator does
   today. The gate reads the hook payload from stdin, takes the call's class and
   tool name from decision 3's table, and then:
   - **runs the handler** when the class is in `--classes` and, if `--matcher`
     is given, the tool name matches it (decision 9). It runs it as
     `/bin/sh -c '<handler command>'`, with the payload on stdin unchanged and
     the handler's environment plus `HOOK_MATCHER`, and passes the handler's
     stdout, stderr and exit status through unchanged, so a handler's deny still
     denies, including Claude Code's exit-2 block, which reads stderr;
   - **skips silently** (decision 4) when the call's class is known and outside
     `--classes`, or its name does not match `--matcher`;
   - **runs the handler and reports** when it cannot tell: when stdin does not
     parse as the adapter's payload, or a tool name the table expects is
     missing, or the name is one no row of the table knows. It writes one line
     to stderr naming what it could not read, then runs the handler as above.
     Failing open to the handler is the behaviour a user hook has today, when
     every call on its event reaches it; failing closed would silently drop the
     hook, the failure #220 reports.

   `hook-gate --probe`, with the same arguments, parses them, checks that
   `--matcher` compiles, and exits 0 with no output, without reading stdin or
   running the handler (decision 7).

   The adapter's own per-hook `timeout` bounds the gate and the handler
   together, as it bounds the handler today; the gate sets no timeout of its
   own, and when the adapter ends the hook, it ends both.

3. **Where the class and the tool name come from.** One table in
   `packages/hooks/src/adapter-table.ts` gives, per adapter and native event,
   the event's classes and where the tool name is. Every call is then tested
   against one set of names per class, the same on both adapters:

   | Class | Names a call is tested against                                   |
   | ----- | ---------------------------------------------------------------- |
   | shell | `Bash`, `Shell`                                                  |
   | edit  | `Write`, `Edit`, `NotebookEdit`, `Delete`                        |
   | mcp   | `mcp__<server>__<tool>`, built from the payload on both adapters |

   A call whose payload names its tool is tested against that name, and a shell
   call against both shell names, since the two adapters name the same tool
   differently. A call whose payload names no tool, on Cursor's shell events and
   `afterFileEdit`, matches when the regex matches any name in its class's set,
   because the event does not say which tool ran. So `matcher: Bash` and
   `matcher: Shell` both select shell calls on both adapters, `matcher: Write`
   still tells a `Write` from an `Edit` where the payload names it, and an edit
   matcher runs after any Cursor edit rather than never. Per event:

   | Adapter     | Native event                                  | Classes          | Tool name                                                                                                   |
   | ----------- | --------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- |
   | Cursor      | `beforeShellExecution`, `afterShellExecution` | shell            | none carried; the class's names                                                                             |
   | Cursor      | `beforeMCPExecution`, `afterMCPExecution`     | mcp              | `mcp__<mcp_server_name>__<tool_name>`                                                                       |
   | Cursor      | `afterFileEdit`                               | edit             | none carried; the class's names                                                                             |
   | Cursor      | `preToolUse`                                  | edit             | `tool_name`; edit names are edit; Cursor's other tool names are known and skip                              |
   | Claude Code | `PreToolUse`, `PostToolUse`                   | shell, mcp, edit | `tool_name`; `Bash` shell, edit names edit, `mcp__*` mcp; Claude Code's other tool names are known and skip |

   "Other tool names" are the names each CLI's tools carry in hook payloads. The
   implementing change records Cursor's complete list from the installed
   `cursor-agent` and Claude Code's from its documentation, before it merges, as
   known and skipped; a name in neither list falls under decision 2's report.
   `Delete` counts as an edit because it changes a file. Names in these tables
   that no measurement has observed (`Edit`, `NotebookEdit`, `Delete`, Cursor's
   in-place edit tool) are documented, not measured; the implementing change
   records Cursor's in-place edit name from a live run and corrects the tables
   if it differs.

   The table marks `preToolUse`, `afterShellExecution` and `afterMCPExecution`
   as user-hook events on Cursor, a field of their own. The Cursor generator's
   bridge loop, which today writes the bridge onto every event the canonical
   mapping names, skips them, and so do the functions that build the policy
   evaluator's probe vocabulary for `agents hooks test`.

4. **A gate that skips says nothing.** On a silent skip it exits 0 with no
   stdout and no stderr, on every adapter and event. It never prints an allow:
   on Claude Code an explicit allow lifts the headless permission default, so a
   gate that answered allow for calls it had skipped would widen what a run may
   do whenever no policy is declared. On `PostToolUse` a pre-call-shaped answer
   is recorded as a failed hook (ADR 0023 decision 9), and an empty one is not.
   On Cursor the measurement above is unscored and did not cover
   `afterMCPExecution` or the specific events; the implementing change confirms
   the empty skip on a live `cursor-agent` on every event decision 5 gates,
   before it merges.

5. **On Cursor, user hooks gain three events, and the bridge none.**
   `pre_tool_call` handlers register on `beforeShellExecution` (shell),
   `beforeMCPExecution` (mcp) and `preToolUse` (edit). `post_tool_call` handlers
   register on `afterShellExecution` (shell), `afterMCPExecution` (mcp) and
   `afterFileEdit` (edit). Each registration carries only the classes of its
   event, so no call reaches a handler twice. The policy bridge's events are
   unchanged.

   The three added events are written only for `cursor-agent` versions measured
   to fire them, an exact list starting with `2026.10.01-14929f9`, never "this
   version or later". An event the installed CLI does not know silently stops
   every other hook in the workspace, the bridge included (#239). On another
   version they are withheld, `harness run` warns, and the withheld events are
   recorded in `undeliverable_hooks` as ADR 0024 records an inert event.
   `harness run` reads the `cursor-agent` version whenever a harness declares a
   user tool-call hook, not only when it declares a policy.

6. **On Claude Code, the native matcher is the class matcher.** A handler's
   Claude Code `matcher` is always the projection of its `applies_to`, as ADR
   0009 decision 1 says; its own `matcher` reaches the gate instead. A handler
   with no `applies_to` registers on the three classes, as on Cursor, not on
   every tool: ADR 0009 decision 1 reads absence as "all classes". The bridge
   stays first, and on `PreToolUse` only (ADR 0023 decision 9).

7. **The gate names the CLI that generated it, and is probed before any role
   runs.** On Claude Code the gate is invoked as the running CLI's Bun
   executable and entry script, as absolute paths, as ADR 0023 decision 10 does
   for the bridge. On Cursor the generated file keeps `agents` on the hook's
   `PATH`, as the bridge does. Before any role runs, `harness run` invokes each
   distinct generated gate command once with `--probe` added, as `sh -c` from
   the workspace, as the existing bridge probe does. Exit 0 with no output
   passes. Anything else fails the run, because an `agents` too old to know
   `hook-gate`, or a `matcher` that does not compile, would leave every gated
   hook inert, the failure #220 reports. The probe proves the command parses; it
   does not prove the adapter resolves the same `agents` from its own
   environment, nor a handler's behaviour.

8. **The load warning (#220).** When a harness loads for an adapter, each
   tool-call handler that sets `matcher` is checked against decision 3's names
   for the shell and edit classes it registers on. MCP names are an open set
   named by the MCP server, which ADR 0009 decision 1 declined to interpret, so
   they are not enumerated. If the regex matches none of those shell and edit
   names, `harness run` warns, naming the handler, the adapter and `applies_to`;
   when the handler also registers on mcp, the warning adds that it will run
   only on MCP calls whose `mcp__<server>__<tool>` name matches. A handler whose
   only class is mcp is not checked. `matcher: "Execute"` warns on both
   adapters. A `matcher` that is not a valid regular expression is rejected when
   the harness loads. That is new: the loader does not compile `matcher` today,
   and such a handler loaded and never matched.

9. **Regex reading.** A `matcher` is a JavaScript regular expression that must
   match the whole tool name, as if written `^(?:<matcher>)$`. Claude Code's
   native matcher treats a plain word as an exact tool name; a whole-name match
   keeps that reading for words, so `Edit` does not also match `NotebookEdit` or
   an MCP tool containing "Edit", and an alternation such as `Write|Edit` still
   means either name.

10. **The cost is accepted, and bounded by scope.** A gated hook adds one
    `agents` process per invocation: measured at 77 ms p50 over `/bin/true`
    called directly and 107 ms through `mise exec`, against the bridge's 48.5 ms
    absolute in ADR 0009 decision 2, which are not like for like (Context). A
    gate runs only on its registration's events. The specific events fire only
    for their class. `preToolUse` fires for every tool call, and twice for a
    Cursor edit, so a pre-edit handler on Cursor costs a process on every call,
    reads and searches included, though it skips them silently. Only harnesses
    that declare their own tool-call hooks pay any of it. Should it matter, the
    shape of the fix is the one ADR 0009 decision 2 names, a purpose-built
    minimal entry point, not a return to handler-side filtering.

11. **Supersession, exceptions and the spec.** This ADR:
    - supersedes ADR 0006 §4's Cursor mapping in part, adding `preToolUse`,
      `afterShellExecution` and `afterMCPExecution` for user hooks;
    - is an exception to ADR 0006 §3 and ADR 0009 decision 1, which put the
      bridge first on every mapped tool event, and to ADR 0023 decision 9's
      "Cursor keeps the bridge on every mapped tool event, unchanged": the three
      added Cursor events carry user hooks and no bridge. On `preToolUse` a
      pre-edit user hook runs with no bridge before it, because Cursor's bridge
      has no pre-edit event to run on; it enforces edits on `afterFileEdit`, as
      before. A user hook can still only tighten: a policy deny stands whatever
      it returns;
    - ends the Claude generator's pass-through of a handler's `matcher` into
      Claude Code's settings (`packages/hooks/src/claude.ts`), behaviour ADR
      0023 left in place when it said the authoring surface, events, matchers
      and `applies_to`, was untouched;
    - extends ADR 0024's undeliverable-event record to Cursor's withheld
      user-hook events;
    - makes **no `spec_version` increment**. The fields and their syntax are
      unchanged; what changes is that `matcher` and `applies_to` now do on both
      adapters what the spec says they do. The two stricter readings, a
      whole-name match and a load failure for an invalid regex, apply to every
      spec version, because a harness written for any version meant the same by
      them, and the consequences below say what changes for it.

**Consequences:**

- A handler's scope means the same on Cursor and Claude Code, and a declared
  hook runs on the same calls on both, except where an event is withheld on an
  unmeasured `cursor-agent`, which the run records.
- Existing Cursor handlers keep their current events and payload shapes there.
  An unscoped handler gains Cursor's pre-edit calls, through `preToolUse`, and
  its post-call shell and MCP calls, through `afterShellExecution` and
  `afterMCPExecution`, which it already had on Claude Code. Those are payloads
  and response shapes a Cursor handler has not seen before.
- **On Claude Code, a handler loses calls it has today.** An unscoped handler,
  or one whose `matcher` named a tool outside shell, edit and MCP, such as
  `Read`, `Grep`, `WebFetch` or `Task`, ran on those calls; under decision 6 it
  does not. The load warning names a `matcher` that can now match nothing, and
  the release notes say so.
- A `matcher` holding an invalid regular expression now fails the harness load.
- A regex that relied on matching part of a tool name, such as `Edit` for
  `NotebookEdit`, must say so: `.*Edit`.
- Every harness-declared tool-call hook pays one `agents` process per
  invocation, and on Cursor a pre-edit hook pays it on every tool call.
- A handler that relied on `HOOK_MATCHER` to filter keeps working; the filtering
  is now done before it runs.
- `matcher`'s documentation names each class's tool names instead of `Execute`.

**References:**

- #220, #235, #239
- ADR 0006 (§3, §4), ADR 0009 (decisions 1 and 2), ADR 0023 (decisions 9 and 10,
  and its statement that the authoring surface is untouched), ADR 0024
- `packages/hooks/src/claude.ts`, `packages/hooks/src/index.ts`,
  `packages/hooks/src/adapter-table.ts`, `packages/cli/src/harness-run-main.ts`,
  `packages/cli/src/hooks-test-main.ts`, `packages/harness-config/src/index.ts`
