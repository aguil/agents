# Review Contract

This document describes the stable contracts encoded in
`harnesses/code-review/src/review-contract.ts` and re-exported from
`@aguil/agents-code-review` for the CLI and other consumers.

## Reviewer roles

| Role ID       | Section label              | Description                                            |
| ------------- | -------------------------- | ------------------------------------------------------ |
| `security`    | Security                   | Security vulnerabilities, injection risks, auth issues |
| `performance` | Runtime / Performance      | Hot-path bottlenecks, memory, I/O inefficiency         |
| `quality`     | Correctness / Quality      | Logic errors, edge cases, code health                  |
| `compliance`  | Documentation / Compliance | Docs, comments, license, conventions                   |

Role IDs are stable wire keys. The canonical order for scheduling and
review-coverage summaries is `security → performance → quality → compliance`.

## Triage tiers

The triage step selects how many roles to run based on PR risk signals.

| Tier      | Roles scheduled                                                     |
| --------- | ------------------------------------------------------------------- |
| `trivial` | `quality` only                                                      |
| `lite`    | `security`, `quality`, `compliance`                                 |
| `full`    | All four roles (`security`, `performance`, `quality`, `compliance`) |

Tier is written to `result.json` under `metadata.triage` and stored in
`triage.json` in the run directory.

## Run metadata wire keys

These keys appear in `result.json → metadata` and are the stable identifiers
used by `parseCodeReviewRunMetadata`:

| Constant                                       | Wire key            | Description              |
| ---------------------------------------------- | ------------------- | ------------------------ |
| `CODE_REVIEW_RUN_METADATA_KEYS.triage`         | `"triage"`          | Selected triage tier     |
| `CODE_REVIEW_RUN_METADATA_KEYS.completedRoles` | `"completed_roles"` | Comma-separated role IDs |
| `CODE_REVIEW_RUN_METADATA_KEYS.timedOutRoles`  | `"timed_out_roles"` | Comma-separated role IDs |
| `CODE_REVIEW_RUN_METADATA_KEYS.failedRoles`    | `"failed_roles"`    | Comma-separated role IDs |

Role lists are comma-separated strings, not JSON arrays. Use
`parseMetadataRolesList` to parse them.

## Scratchpad artifact layout

Each run writes artifacts under `.agents-code-review/runs/<run-id>/` (or the
path from `--scratchpad`).

```
<run-id>/
  report.md                    Human-readable synthesized report
  result.json                  Final structured output (filtered, actionable)
  result.raw.json              Orchestration output before report filtering
  events.jsonl                 Streaming event log from each role adapter
  triage.json                  Selected review tier
  context/
    bundle.json                Context bundle (diff, PR metadata, docs)
    bundle.md                  Human-readable context bundle
  roles/
    <role>/
      <role>.request.json      Per-role execution request payload
      stdout.log               Raw subprocess stdout
      stderr.log               Raw subprocess stderr (use for debugging)
```

`agents triage` and `agents code-review post` auto-discovery also check legacy
`.review-agent/{runs,dry-run}/` trees for backward compatibility.

## Review coverage labels

Review coverage is computed from `completed_roles` relative to the roles
expected for the selected triage tier (`expectedRolesForTriageTier`). Timed-out
or failed roles reduce coverage and produce partial-coverage warnings rather
than fatal errors (unless `--strict` is set).

## `AdapterCapabilities` flags

Returned by `AgentAdapter.capabilities()`. The harness may adjust behavior based
on these flags.

| Flag               | Type      | Description                                          |
| ------------------ | --------- | ---------------------------------------------------- |
| `streaming`        | `boolean` | Adapter yields events incrementally (vs. one shot)   |
| `structuredOutput` | `boolean` | Adapter can emit structured JSON findings natively   |
| `readOnlyMode`     | `boolean` | Adapter runs in a read-only sandbox (no writes)      |
| `mcp`              | `boolean` | Adapter supports MCP tool integration                |
| `cancellation`     | `boolean` | Adapter respects `AbortSignal` for early termination |

## `AgentRunRequest` field reference

These fields are passed to every `AgentAdapter.run()` call.

| Field               | Required | Description                                                      |
| ------------------- | -------- | ---------------------------------------------------------------- |
| `runId`             | yes      | Harness run ID                                                   |
| `roleId`            | yes      | Reviewer role (`security`, `performance`, etc.)                  |
| `prompt`            | yes      | Full role prompt text                                            |
| `workspacePath`     | yes      | Resolved workspace root                                          |
| `contextBundlePath` | yes      | Absolute path to `context/bundle.json`                           |
| `scratchpadPath`    | yes      | Per-role artifact directory                                      |
| `timeoutMs`         | yes      | Milliseconds before role is cancelled                            |
| `allowedCommands`   | yes      | Allowlist hint for sandboxed adapters                            |
| `metadata`          | no       | Adapter-specific pass-through key/value pairs                    |
| `signal`            | no       | Abort signal; on abort, subprocess adapters SIGTERM then SIGKILL |
