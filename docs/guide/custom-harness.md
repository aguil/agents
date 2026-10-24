# Custom harnesses

A harness is a task pipeline declared entirely in configuration: YAML and
Markdown under an `.agents/` directory, loaded and executed by the shared
packages with no harness-specific TypeScript. The packaged code-review harness
is one such document. This page covers writing your own and running it with
`agents harness run`.

> **Status.** Config-declared harnesses other than code-review are not yet
> promoted for production use. The gates for that promotion are tracked in issue
> #73. `agents harness run` is the supported way to execute one today.

The reference example is
[examples/incident-triage/](../../examples/incident-triage/README.md): a
four-role chain with two policies and knowledge providers, runnable against a
copied fixture.

## The `.agents/` layout

```
.agents/
  manifest.yaml                  # specVersion + enabled harness ids
  harnesses/<id>/harness.yaml    # the harness document
  harnesses/<id>/prompts/*.md    # prompt files (convention, via prompt_path)
  policies/<id>.yaml             # capability policies
  agents/<id>/agent.md           # shared role files, referenced by ref:
  schemas/                       # published JSON Schemas (normative)
```

`agents harness run <id>` loads `harnesses/<id>/harness.yaml` directly. It does
not consult `manifest.yaml`; the manifest declares enablement for tooling that
reads it, and its `specVersion` is validated against the same accepted set when
it is read.

## The harness document

Minimal document:

```yaml
spec_version: "0.4"
kind: harness

harness:
  id: my-harness

roles:
  scout:
    description: Investigate the workspace and report what matters
    prompt_path: prompts/scout.md
```

`spec_version` is advisory. The loader validates the token (`"0.1"` through
`"0.4"`) and never branches on it, because every increment so far is additive in
format (ADR 0015 §4). New documents should declare the current version, `"0.4"`.
`harness.id` must equal the containing directory name. `harness.description` is
documentation only; the loader does not read it.

Unknown keys are rejected at every level of the document, with the error naming
the keys that would have been accepted. A misspelled `polciy:` fails at load
instead of silently doing nothing. The normative description of the format is
the published schema,
[.agents/schemas/harness.schema.json](../../.agents/schemas/harness.schema.json)
(ADR 0015 §2). This page explains semantics; it does not restate every key.

### Roles

| Key                     | Notes                                                                |
| ----------------------- | -------------------------------------------------------------------- |
| `description`           | Required unless supplied by a `ref:` role file                       |
| `prompt`                | Inline prompt. Mutually exclusive with `prompt_path`                 |
| `prompt_path`           | Prompt file, absolute or relative to the harness directory           |
| `timeout_ms`            | Role timeout. Default 600000                                         |
| `enabled`               | CEL expression deciding whether the role runs. Absent means always   |
| `allowed_commands`      | Overrides the harness-level `default_allowed_commands` for this role |
| `required_capabilities` | Adapter capabilities the role needs, e.g. `readOnlyMode`             |
| `policy`                | Policy id for this role, overriding the harness default              |
| `ref`                   | Pull the role from a shared role file (see below)                    |

The enablement environment binds exactly one name: `tier`, taken from a `triage`
context artifact. The `git-diff` builtin emits one, so
`enabled: tier != "trivial"` works out of the box, and any provider that
produces an artifact with id `triage` and a bare tier as content can bind it.
Nothing else is bound. Frontmatter, file names and provider parameters are all
out of reach, and an expression naming an unbound name aborts the run rather
than skipping the role. Until the environment grows, conditional behavior beyond
`tier` belongs in prompts, steered by a context artifact (see "Parameterizing a
run" below). Evaluation failures abort the run; roles disabled by their
expressions are listed on stderr.

### Shared role files

`ref: <id>` pulls a role from `.agents/agents/<id>/agent.md`. The file is YAML
frontmatter plus a Markdown body; the body is the prompt, and the frontmatter
accepts any role key except `ref`, `prompt` and `prompt_path`. Sibling keys on
the referencing entry override the frontmatter, so the harness always wins where
it states an opinion. Files load by reference only: an unreferenced role file is
never read and cannot break an unrelated harness.

### Execution

Absent `execution` means the runtime default: all enabled roles run in parallel,
and finding severity drives run status.

| Mode              | Keys                                                     | Behavior                                           |
| ----------------- | -------------------------------------------------------- | -------------------------------------------------- |
| `parallel`        |                                                          | Explicit form of the default                       |
| `chain`           | `order`, `pass_check`                                    | Sequential; the first failure stops the chain      |
| `validation-loop` | `implementation_roles`, `validation_roles`, `max_rounds` | Alternate until validation passes or the round cap |

`order` entries must name declared roles. `max_rounds` defaults to 1.

`pass_check` is an argv run in the workspace after the chain completes; exit 0
means the run passed. It is the authoritative success gate. When it is present,
or when the mode is `validation-loop`, run status is gate-owned: finding
severity no longer drives it (ADR 0021). Declare a gate only when the command
genuinely decides success, and see the policy section below for protecting the
gate from the roles it judges.

### Context providers

`context.providers` is a list of `{use: <name>, ...params}` entries, collected
once before any role runs and written to the run scratchpad as
`context/bundle.json`, with a rendered `context/bundle.md` alongside. Builtin
provider names:

| Provider             | Contents                                                   |
| -------------------- | ---------------------------------------------------------- |
| `git-diff`           | Workspace diff; emits the `triage` tier artifact           |
| `pr-metadata`        | Pull request metadata                                      |
| `pr-referenced-docs` | Docs the PR references                                     |
| `agents-md`          | AGENTS.md instructions                                     |
| `static-file`        | One file by `path` (relative to the workspace or absolute) |
| `shell-command`      | Output of `cmd` run in the workspace                       |
| `file-glob`          | Files matching a glob under the workspace                  |
| `knowledge`          | Notes opted in with `context: auto`                        |
| `knowledge-search`   | Notes matching a tag query                                 |

The first four take no parameters. The rest take provider parameters such as
`id`, `path`, `cmd`, `max_bytes` or `tags`. Keys other than `use` are validated
by the provider registry, which rejects unknown parameter keys; an unknown
provider name or bad parameters aborts the run before any role starts. The
knowledge providers read `.agents/knowledge` from the workspace, not from the
harness's own `.agents` tree (ADR 0022), so notes travel with the project under
review.

Failure behavior is uneven across providers, and the difference matters. A
resolution failure (unknown name, bad parameters) or a missing `static-file`
marked `required: true` aborts the run before any role starts. A `shell-command`
whose command fails instead yields an artifact carrying the error text, and the
run continues: context is advisory, not a gate. Without `required: true`, a
missing `static-file` emits nothing at all. The consequence worth remembering:
when a provider fails soft, the run can still pass, because a `pass_check` gate
that sees no changes exits 0. Check the recorded outcomes, not just the exit
code.

### Knowledge providers

The two knowledge providers read a store of Markdown notes from the workspace:
`.agents/knowledge` by default, overridable per declaration with `path`, always
confined to the workspace. Both layouts work: flat `<root>/*.md` files, or a
directory per note (`<root>/<id>/<id>.md`) so note-local assets can sit beside
the note. Discovery is a recursive Markdown scan, and a note's identifier comes
from its frontmatter rather than its filename, so moving a file never renames a
note. The full contract is ADR 0022; what follows is the working summary. A
small real store ships with the incident-triage example under
`fixture/.agents/knowledge/`.

A note is Markdown with YAML frontmatter:

```yaml
---
id: pagination-off-by-one
context: auto # auto | search-only (default)
tags: [incident, pagination]
title: Optional title (defaults to the id)
updatedAt: 2026-09-01
---
The note body.
```

The reader uses `id` (required), `context`, `tags`, `title` and `updatedAt`, and
carries fields it does not know without complaint. The write path will add
reserved provenance fields to exactly these documents, so rejecting unknown
fields now would make that addition a breaking change. An identifier starting
`_meta:` is reserved for the providers' own report artifacts. Malformed notes
(unparseable, missing id, duplicate id, unusable field value) are skipped and
reported, never fatal; an absent or empty store yields no artifacts, so
declaring a provider before any note exists is safe.

**`knowledge`: automatic injection.** Injecting a note into the context every
role sees needs two opt-ins: the harness declares the provider, and the note
carries `context: auto`. Injection is bounded unconditionally: `max_notes`
(default 10) and `max_bytes` (default 50000, aggregate across admitted notes).
When more notes are eligible than the budget admits, admission walks a total
order: `updatedAt` descending, then `id` ascending, with notes lacking
`updatedAt` sorted last. A note that does not fit in the remaining budget is
truncated into it and admitted, so the admitted set is always a prefix of the
ranking and the highest-ranked note is never the one dropped. Overflow is
recorded in the bundle as a `<provider>:_meta:admission` artifact naming the
admitted and omitted identifiers and the bound that was reached, and skipped
notes are reported as `<provider>:_meta:skipped`. Neither is a run failure: a
run must not start failing because the store grew (ADR 0017 clause 7).

**`knowledge-search`: explicit retrieval.** Returns notes carrying every listed
tag (AND match, case-insensitive). Params: `tags` (required), `limit` (default
5), `provenance` (`any`, `machine` or `human`), `machine_id_prefix` (default
`harness:`), plus `path` and `max_bytes`. Search honors the byte bound but not
the note-count bound, and does not require `context: auto`: a search result was
explicitly asked for. There is no free-text or embedding search. Retrieval
quality rests on tags, which is deliberate: ADR 0017 chose to surface an
inadequate store as a search problem rather than hide it by injecting
everything.

**Machine-authored notes.** Identifiers beginning with the machine prefix
(default `harness:`) mark notes a run wrote. The reader treats a prefixed
identifier as machine-authored for the `provenance` filter. Enforcing the
namespace, rejecting a machine note that lacks the prefix, belongs to the write
path.

**Write-back is not built.** ADR 0017 governs how a run may write notes (staged
notes with runtime-stamped provenance, human promotion, the reserved machine
namespace), but the write path was designed around a `run_end` hook that cannot
fire, and it remains unimplemented. The landing lifecycle stack (ADRs 0023 and
0024, PRs [#175](https://github.com/aguil/agents/pull/175) through
[#178](https://github.com/aguil/agents/pull/178)) settles the direction:
run-level lifecycle events are the orchestrator's to dispatch rather than an
adapter's to report (ADR 0024), which closes the "map a session event onto
`run_end`" route for good, and declaring a `role_start` / `run_start` /
`run_end` handler now warns at run setup instead of silently never running. Do
not declare a `run_end` handler expecting write-back. When the capability lands
it will be runtime-owned, per ADR 0017 clause 2, and the maintained
[blockers note](../design/knowledge-write-back-blockers.md) tracks what remains.

Notes are workspace-sourced text entering every agent's context window, the same
trust class as the AGENTS.md instructions the `agents-md` provider injects. A
hostile workspace can shape agent context through them. Nothing executable
attaches to a note, and no path escapes the workspace.

### Parameterizing a run

The runtime has no parameter surface: no harness argument, no per-run config
file. The working idiom is an environment variable on the invocation, surfaced
to the roles through a `shell-command` provider:

```yaml
- use: shell-command
  id: scope
  cmd: ["sh", "-c", 'echo "${DOC_REVIEW_SCOPE:-all}"']
  title: Review scope — a directory to restrict the round to, or "all"
```

```bash
DOC_REVIEW_SCOPE=project/agents agents harness run doc-review \
  --agents-dir .agents --workspace .
```

The artifact lands in the context bundle and the prompts read it. Because role
enablement binds only `tier`, this is also how conditional behavior is expressed
today: the provider makes the value visible, and the prompts act on it.

### Output schemas and finding pipelines

`output.schemas` maps outcome kinds to validation. The `finding` kind accepts
`builtin:finding` or an explicit record; other kinds take a record of `required`
outcome fields and `data_required` data fields. Declared schemas validate every
role outcome; run with `--strict` to make violations fatal.

`filtering.findings: [builtin:actionable]` classifies findings rather than
removing them: anything not `validation.status: verified` with at least one
`validation.evidence` item is marked unsubstantiated. Unsubstantiated findings
are still published, but they are excluded from run status and from the triage
queue, and the run summary prints how many were set aside (ADR 0019).

`deduplication.findings: [builtin:fingerprint]` collapses duplicate findings
before status and reporting.

### Reporting

`reporting.template` selects the renderer for `report.md` in the run scratchpad:
`builtin:code-review-markdown` or `builtin:outcomes-markdown`. The report
consumes findings after filtering and deduplication, matching what status
counted. Declare nothing and no `report.md` is written; findings and outcomes
then live only in the result JSON.

### Hooks

`hooks.<event>` holds a list of command handlers. Events: `pre_tool_call`,
`post_tool_call`, `role_start`, `role_stop`, `run_start`, `run_end`. Only
`pre_tool_call`, `post_tool_call` and `role_stop` currently reach an adapter;
handlers on the other events are accepted and never run.

Handlers are commands only. `prompt:` and `http:` handler types are declared in
the schema precisely so that using one produces an "unsupported handler type"
error instead of a misspelling report. `applies_to: [shell, mcp, edit]` scopes a
handler to event classes and is valid only on tool-call events. In the command
string, `$HARNESS_DIR` expands to the harness directory. `matcher` is a regular
expression over tool names; `timeout_s` bounds the handler.

## Policies

A top-level `policy: <id>` sets the harness default, resolved against
`.agents/policies/<id>.yaml`; a role's own `policy` overrides it. A policy
file's `id`, when present, must equal its file name.

```yaml
id: triage-readonly
capabilities:
  filesystem:
    allow: ["**"]
    deny: [".env", "**/secrets/**", ".cursor/**", ".agents/**", "check.ts"]
  exec:
    allow: ["rg", "cat", "bun run check.ts"]
    deny: ["rm", "git push", "curl"]
  network:
    deny: ["*"]
limits:
  timeout_ms: 300000
```

Deny takes precedence over allow within each capability class, and an absent
class is unconstrained. `confirmations.requiredFor` (categories `exec.unknown`,
`filesystem.write`) routes matching actions to human approval instead of a hard
verdict.

Enforcement has a boundary, and it is narrower than the file suggests. The
generated hook set covers exactly three adapter events: shell commands
(`beforeShellExecution`), MCP calls (`beforeMCPExecution`) and edits
(`afterFileEdit`). There is no read event, so `filesystem` rules gate edits but
not reads: a role can read a denied path, and only its prompt says it should not
(issue #198). Exec matching is a word-boundary prefix match on the command
string with no correlation against `filesystem` globs, so `cat` of a denied file
under an allowlisted `cat` is not blocked either (issue #104). Shell control
operators (`&&`, `|`, `;`, substitution) downgrade an allow match to unlisted,
because a matched prefix proves nothing about the rest of the string. A role
that must not write at all should say so through
`required_capabilities: [readOnlyMode]`, with the policy as a second layer
rather than the only one.

One pattern is worth copying from the example above. When a chain ends in a
`pass_check`, deny every role write access to the gate target (`check.ts` here).
A role that can rewrite the command that judges it can fake a pass. For roles
that are read-only by declared capability, the adapter blocks writes outright
and the deny entry is the second layer; either way, the protection should be a
mechanism, not an instruction in a prompt.

## Running a harness

```
agents harness run <id> --agents-dir <dir> --workspace <path>
                        [--adapter cursor|claude|opencode|fake]
                        [--model <model>] [--models role=model,...]
                        [--agents-cli <cmd>] [--strict]
                        [--allow-unenforced-policy]
                        [--force-tool-calls]
```

| Flag                        | Notes                                                             |
| --------------------------- | ----------------------------------------------------------------- |
| `--agents-dir <dir>`        | Required. Directory containing `harnesses/` (and `policies/`)     |
| `--workspace <path>`        | Required. Workspace the harness operates on                       |
| `--adapter <name>`          | `cursor` (default), `claude`, `opencode`, `fake`                  |
| `--model <model>`           | Model for every role; default is the adapter CLI's own            |
| `--models role=model,...`   | Per-role overrides by harness role id; beats `--model`            |
| `--agents-cli <cmd>`        | `agents` CLI used by generated hooks (default: `agents`)          |
| `--strict`                  | Fail the run on schema or enablement violations                   |
| `--allow-unenforced-policy` | Permit adapters that cannot enforce a declared policy (see below) |
| `--force-tool-calls`        | Pass Cursor `--force` (see below)                                 |

Model routing for `harness run` is flags only: there is no environment variable
and no config file, unlike the layered configuration of `agents code-review`.
Two constraints follow from the `role=model,...` form. The value is split on
commas, so a model spelling that itself contains commas (parameterized forms
such as `gpt-5.6-sol[context=1m,reasoning=high]`) cannot appear in `--models`;
put the shared model in `--model` and only the exceptions in `--models`, since a
role entry beats `--model`. And one run has one adapter, so roles cannot be
split across providers.

A run proceeds in order: load and validate the document, set up enforcement,
collect the context bundle, evaluate role enablement, execute the roles, apply
the finding pipelines, render the report. Artifacts land in
`<workspace>/.agents-harness/runs/<runId>/`: `context/bundle.json` with a
rendered `bundle.md`, per-role logs under `roles/<role>/`, the raw result as
`result.raw.json`, and `report.md` when a reporting template is declared. The
process exits 0 exactly when the final status is `passed`.

The result metadata records the execution mode, the completed, failed and timed
out roles, strict mode, and the Cursor approval posture. It does not record the
model. If run-to-run comparability matters, pin models where the invocation
lives (a task runner, a script), because the run record cannot tell you
afterwards which model produced a finding.

### Policy enforcement

Enforcement is generated Cursor hook configuration. The runner writes
`.cursor/hooks.json` in the workspace atomically and rewrites it before each
role as tamper repair; the per-role policy id travels in the role's subprocess
environment, so concurrent runs cannot cross-contaminate (ADR 0008).

Hook generation is Cursor-only in v1. With any other adapter, a harness that
declares a policy fails closed:

```
harness run: harness declares a policy but adapter "claude" cannot enforce it ...
```

`--allow-unenforced-policy` overrides that refusal and runs with no policy
enforcement at all, with a warning on stderr. Treat it as a development flag,
not an operating posture.

`--force-tool-calls` passes Cursor `--force`: tool calls auto-allow unless
denied, hook `ask` verdicts collapse into allow, and `confirmations.requiredFor`
escalation is defeated. The default posture (sandbox enabled, force off) is the
recommended one; see ADR 0020.

## Trust model

`agents harness run` executes whatever the given `--agents-dir` declares.
`pass_check` argv, hook commands and `shell-command` context providers all run
on your host with your credentials. Point `--agents-dir` only at trees you
trust.

This differs from `agents code-review`, which resolves its harness through
layered lookup (workspace, then `~/.agents`, then the packaged tree) and refuses
`execution` blocks, `shell-command` providers, `hooks` and `policy` from the
workspace layer, because for `--pr` that layer is the PR author's worktree. See
[code-review/configuration.md](code-review/configuration.md#config-declared-harness)
for that path.

To customize the packaged code-review harness itself, install one user-global
copy and edit it there:

```bash
agents harness install code-review
```

The installer writes `~/.agents/harnesses/code-review/`, the
`code-review-readonly` policy and a package-version marker, prompting before it
replaces existing files. Later runs report version drift between the install and
the running CLI package.

## Testing a harness

Iterate with the fake adapter, which runs the full pipeline without spawning an
agent CLI:

```bash
agents harness run my-harness \
  --agents-dir .agents \
  --workspace /tmp/fixture-workspace \
  --adapter fake --strict
```

Load-time errors name the offending key and the keys accepted at that level, so
schema fixes are quick. For a headless CI proof, script the adapter; the
incident-triage end-to-end test
([tests/incident-triage-e2e.test.ts](../../tests/incident-triage-e2e.test.ts))
is the working pattern.

For repeated use, wrap the canonical invocation in a task runner or script so
the command run locally is the command CI would run, passing scope environment
variables through and appending extra flags after `--`. The wrapper is also the
natural home for the model pins described above.

## Reference

- [harness.schema.json](../../.agents/schemas/harness.schema.json),
  [policy.schema.json](../../.agents/schemas/policy.schema.json),
  [manifest.schema.json](../../.agents/schemas/manifest.schema.json): the
  normative format descriptions
- [examples/incident-triage/](../../examples/incident-triage/README.md): the
  reference custom harness
- [../harnesses/README.md](../harnesses/README.md): checklist for adding a
  first-class harness to this repository
- ADRs [0005](../adr/0005-harness-generalization-phase-0.md),
  [0006](../adr/0006-harness-governance-phase-1.md),
  [0009](../adr/0009-spec-v0.2-hook-scoping-and-bridge-cost.md),
  [0015](../adr/0015-project-local-harness-spec.md),
  [0017](../adr/0017-knowledge-governance.md),
  [0018](../adr/0018-harness-schema-and-spec-0-3.md),
  [0019](../adr/0019-structured-finding-evidence.md),
  [0020](../adr/0020-cursor-force-opt-in-and-sandbox-default.md),
  [0021](../adr/0021-gate-owned-run-status.md),
  [0022](../adr/0022-knowledge-read-path.md)
