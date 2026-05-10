# Code Review Harness

Multi-agent code review harness built on the shared Bun/TypeScript runtime.

The harness runs role-specialized reviewers in parallel through an agent-agnostic execution adapter. OpenCode, Claude Code, Cursor CLI, and pi.dev can be added as adapters without changing the code-review workflow.

The current implementation includes:

- `FakeAgentAdapter` for deterministic tests and local smoke runs.
- `OpenCodeAdapter` for opt-in reviewer sessions through `opencode run --format json`.
- `ClaudeCodeAdapter` for opt-in Claude Code subprocess sessions.
- `CursorAdapter` for opt-in Cursor CLI subprocess sessions.

## Quick Start

```bash
# Deterministic smoke test (no provider/API calls)
bun run agents code-review --adapter fake

# Real review runs
bun run agents code-review --adapter opencode --model opencode/gpt-5.3-codex
bun run agents code-review --adapter claude --model claude-sonnet-4
bun run agents code-review --adapter cursor --model sonnet-4
```

## Adapter Examples

### OpenCode

```bash
bun run agents code-review --adapter opencode --model opencode/gpt-5.3-codex
bun run agents code-review --adapter opencode --model opencode/gpt-5.3-codex --variant minimal
bun run agents code-review --adapter opencode --model opencode/gpt-5.3-codex --agent code-review
bun run agents code-review --adapter opencode --model opencode/gpt-5.3-codex --no-deterministic
```

Common model IDs:

- `opencode/gpt-5.3-codex`
- `opencode/gpt-4.5`
- `opencode/claude-sonnet-4`
- `opencode/o1`

Discover models with `opencode models` (or `opencode models <provider>`).

### Claude

```bash
bun run agents code-review --adapter claude --model claude-sonnet-4
bun run agents code-review --adapter claude --model claude-opus-4
bun run agents code-review --adapter claude --model claude-haiku-4
bun run agents code-review --adapter claude --claude-args "-p,{prompt},--model,claude-sonnet-4"
```

Common model IDs:

- `claude-sonnet-4`
- `claude-opus-4`
- `claude-haiku-4`

### Cursor

```bash
bun run agents code-review --adapter cursor --model sonnet-4
bun run agents code-review --adapter cursor --model sonnet-4-thinking --cursor-mode plan
bun run agents code-review --adapter cursor --model gpt-5 --cursor "$(which agent)"
bun run agents code-review --adapter cursor --cursor-args "--print,--output-format,stream-json,--workspace,{workspace},--trust,--force,{prompt}"
# When the comma template would begin with bundled CLI-looking tokens (--strict etc.), bind with =:
bun run agents code-review --adapter cursor --cursor-args="--strict,--trust,--print"
```

Common model IDs:

- `sonnet-4`
- `sonnet-4-thinking`
- `gpt-5`
- `o1`

Discover models with `agent models`.

### Fake

```bash
bun run agents code-review --adapter fake
```

## Choosing an Adapter

- `fake`: local smoke tests and CI checks with deterministic output.
- `opencode`: multi-provider flexibility and variant pinning.
- `claude`: direct Claude Code CLI workflows.
- `cursor`: direct Cursor CLI workflows with MCP support.

## Common Workflows

Context help scopes flags to the invocation: `bun run agents` or `bun run agents --help` (overview), **`bun run agents code-review --help`**, **`… replay --help`**, **`… post --help`**.

```bash
# Local debugging and adapter smoke tests
bun run agents code-review --adapter cursor --model sonnet-4 --dry-run --log all

# Review context from a specific PR (including merged PRs)
bun run agents code-review --adapter opencode --model opencode/gpt-5.3-codex --pr 42

# Create (or replace) pending review comments on the PR
bun run agents code-review --adapter opencode --model opencode/gpt-5.3-codex --pr 42 --pending-review --no-confirm

# Replay from captured context for consistency checks
bun run agents code-review --adapter claude --model claude-sonnet-4 --context-bundle .review-agent/runs/<run-id>/context/bundle.json

# Equivalent shorthand (positional bundle path injects `--context-bundle`)
bun run agents code-review replay .review-agent/runs/<run-id>/context/bundle.json --adapter claude --model claude-sonnet-4

# Multi-pass consensus run
bun run agents code-review --adapter opencode --model opencode/gpt-5.3-codex --consensus 3

# Publish existing findings without re-running models
bun run agents code-review post --result .review-agent/runs/<run-id>/result.json
```

### Logging (`--log`)

- `none` (default): minimal status output.
- `summary`: adapter progress messages and expanded review summary/finding previews (replaces former `--verbose` / `-v`).
- `commands`: adapter subprocess commands before and after execution (replaces former `--show-commands`).
- `all`: summary and commands together.

```bash
bun run agents code-review --adapter fake --dry-run --log summary
```

## Configuration files and presets

**Breaking change:** older releases allowed **`.review-agent/config.json`** inside the repo to set **`workspace`**, **`scratchpad`**, **`adapter`**, adapter host-binary paths, and **`cursorArgs`** / **`claudeArgs`** (including inside **`presets`**). Current releases **ignore those keys when they come from repo-managed JSON** — use the **user** config file (**`~/.config/...`**), **`AGENTS_CODE_REVIEW_*`**, or **CLI** instead. See the next paragraph for the exact strip list.

Merge order (**later wins**): **harness packaged defaults** (currently **`adapter: fake`** from `@aguil/agents-code-review`) → merged JSON (**user → repo**) → selected **`presets`** entry when you pass **`--preset`** → **`AGENTS_CODE_REVIEW_*`** environment variables → **explicit CLI flags**.

- **User file:** `$XDG_CONFIG_HOME/agents/code-review/config.json` (when `XDG_CONFIG_HOME` is set), otherwise `~/.config/agents/code-review/config.json`. Omit the file when unused.
- **Repo file:** `<workspace>/.review-agent/config.json`. The **`workspace`** used to locate this file is `resolve(process.cwd)` or **`--workspace`** **before** any `workspace` value from config is applied (configure one path explicitly if you rely on repo-scoped defaults while running from elsewhere).

  Repo JSON **cannot steer where / how reviewers run**. Keys **`workspace`**, **`scratchpad`**, **`adapter`**, adapter host-binary paths (**`cursor`**, **`claude`**, **`opencode`**), and argv templates (**`cursorArgs`**, **`claudeArgs`**) — including inside **`presets`** — are stripped with a **`console.warn`** when present; set paths, adapters, and subprocess argv templates only via the **user** config file above, **`AGENTS_CODE_REVIEW_*`**, or **CLI**.

Optional JSON keys use **camelCase** and mirror stable CLI knobs (omit keys you don’t care about):

- Strings (**user/config/env/CLI** for **`workspace`**, **`scratchpad`**, **`adapter`**, host paths **`opencode` / `claude` / `cursor`**, and **`claudeArgs` / `cursorArgs`** — **repo `.review-agent` JSON omits those via sanitization**, see preceding paragraph): **`workspace`**, **`scratchpad`**, **`contextBundle`**, **`result`**, **`consensus`**, **`adapter`**, **`model`**, **`variant`**, **`agent`**, **`opencode`**, **`claude`**, **`cursor`**, **`cursorMode`**, **`log`**, **`pr`**, **`postPr`**, **`reviewSummary`**.
  - **`claudeArgs`** / **`cursorArgs`**: optional string (**`--claude-args` / `--cursor-args`** use comma-splitting—tokens cannot reliably contain commas) or a JSON **array of strings** (each element is one argv token, including commas inside a token).
  - Adapter templates that recycle bundled CLI names (**`strict`**, **`dry-run`**, etc.) cannot use **`--cursor-args --strict,...`** spacing—the second token parses as code-review **`--strict`**. Prefer **`--cursor-args=--strict,...`** (same for **`--claude-args=...`**), or put the comma-joined template behind **`=`** so it stays **one argv cell**.
- Booleans: **`dryRun`**, **`postOnly`**, **`noConfirm`**, **`replacePendingReview`**, **`noDeterministic`**, **`strict`**, **`pendingReview`**, **`pure`**, **`printLogs`**.
- **`presets`**: an object mapping preset names to nested partial-option objects **without** a nested **`presets`** key. Repo preset entries **overlay** user preset entries for the same name (same rules as top-level merge).
- Unknown keys (**not** in the camelCase vocabulary above—besides **`presets`**) are **skipped** but produce a **`console.warn` when loading a JSON file**. Set **`AGENTS_CODE_REVIEW_CONFIG_STRICT`** to **`true`**, **`1`**, **`yes`**, or **`on`** before running the CLI to turn unknown keys into a **fatal error** instead.

Example **`.review-agent/config.json`** (set **`workspace`**, **`scratchpad`**, **`adapter`**, host binaries, and **`cursorArgs`** / **`claudeArgs`** in **user** config or CLI; repo JSON carries only **`model`**, presets, booleans, and similarly safe knobs):

```json
{
  "model": "opencode/gpt-5.3-codex",
  "presets": {
    "ci": {
      "dryRun": true,
      "log": "commands"
    }
  }
}
```

```bash
bun run agents code-review --preset ci
```

### Environment (`AGENTS_CODE_REVIEW_*`)

| Variable | Maps to |
|----------|---------|
| `AGENTS_CODE_REVIEW_CONFIG_STRICT` | When true/1/yes/on, unknown JSON keys in config files are errors (default: warn only) |
| `AGENTS_CODE_REVIEW_WORKSPACE` | `--workspace` |
| `AGENTS_CODE_REVIEW_SCRATCHPAD` | `--scratchpad` |
| `AGENTS_CODE_REVIEW_CONTEXT_BUNDLE` | `--context-bundle` |
| `AGENTS_CODE_REVIEW_RESULT` | `--result` |
| `AGENTS_CODE_REVIEW_CONSENSUS` | `--consensus` |
| `AGENTS_CODE_REVIEW_ADAPTER` | `--adapter` |
| `AGENTS_CODE_REVIEW_MODEL` | `--model` |
| `AGENTS_CODE_REVIEW_VARIANT` | `--variant` |
| `AGENTS_CODE_REVIEW_AGENT` | `--agent` |
| `AGENTS_CODE_REVIEW_OPENCODE` | `--opencode` |
| `AGENTS_CODE_REVIEW_CLAUDE` | `--claude` |
| `AGENTS_CODE_REVIEW_CLAUDE_ARGS` | `--claude-args` |
| `AGENTS_CODE_REVIEW_CURSOR` | `--cursor` |
| `AGENTS_CODE_REVIEW_CURSOR_ARGS` | `--cursor-args` |
| `AGENTS_CODE_REVIEW_CURSOR_MODE` | `--cursor-mode` |
| `AGENTS_CODE_REVIEW_LOG` | `--log` |
| `AGENTS_CODE_REVIEW_PR` | `--pr` |
| `AGENTS_CODE_REVIEW_POST_PR` | `--post-pr` |
| `AGENTS_CODE_REVIEW_REVIEW_SUMMARY` | `--review-summary` |
| `AGENTS_CODE_REVIEW_DRY_RUN` | `--dry-run` (`true`/`false`/`1`/`0`/`yes`/`no`) |
| `AGENTS_CODE_REVIEW_POST_ONLY` | Enables post-only mode on the default `code-review` command (omit when using `code-review post`) |
| `AGENTS_CODE_REVIEW_NO_CONFIRM` | `--no-confirm` |
| `AGENTS_CODE_REVIEW_REPLACE_PENDING_REVIEW` | `--replace-pending-review` |
| `AGENTS_CODE_REVIEW_NO_DETERMINISTIC` | `--no-deterministic` |
| `AGENTS_CODE_REVIEW_STRICT` | `--strict` |
| `AGENTS_CODE_REVIEW_PENDING_REVIEW` | `--pending-review` |
| `AGENTS_CODE_REVIEW_PURE` | `--pure` |
| `AGENTS_CODE_REVIEW_PRINT_LOGS` | `--print-logs` |

## Troubleshooting

```bash
# Verify adapter executables are installed and callable
which opencode && opencode --version
which claude && claude --version
which agent && agent --version

# Inspect raw adapter output for failures/timeouts
cat .review-agent/runs/<run-id>/roles/<role>/stderr.log
cat .review-agent/runs/<run-id>/roles/<role>/stdout.log

# Re-run with command/event visibility
bun run agents code-review --adapter cursor --model sonnet-4 --dry-run --log all
```

For Cursor custom templates, keep `--trust` in `--cursor-args` for non-interactive runs.
When using `--dry-run`, inspect artifacts under `.review-agent/dry-run/<run-id>/`.

## Human-In-The-Loop Workflow

1. Run the harness from your branch.
2. Read the CLI output path and open `report.md`.
3. Inspect `result.json` for status and normalized findings.
4. Apply fixes or document why a finding is not actionable.
5. Re-run until status/findings match your release bar.
6. Add the final summary to your PR manually.

Current HITL boundaries:

- The harness does not post PR comments unless `--pending-review` is enabled.
- The harness does not block merges by itself.
- Humans decide which findings to act on.
- Role timeouts are treated as partial coverage warnings, not fatal harness errors.

Strict mode:

- `--strict` changes timeout and role-error behavior to fail-fast.
- In strict mode, any role timeout or role error produces overall `error` status.

Pending review mode:

- `--pending-review` creates an unsubmitted GitHub review on the target PR.
- If you already have an existing pending review on that PR:
  - In interactive runs, the CLI prompts before replacing it.
  - In non-interactive runs, pass `--replace-pending-review` to opt in to replacement.
- Use `--pr <number>` to collect review context/diff from that PR (including merged PRs) and, with `--pending-review`, to post the pending review to the same PR by default. Omit `--pr` to auto-discover the current branch PR for posting only. PR lookups use the repo from `--workspace` and auto-resolve jj workspace pointers to canonical colocated repos for `git`/`gh` commands.
- Use `--post-pr <number>` to post to a different PR than `--pr` (rare); with **`agents code-review post`** (or `AGENTS_CODE_REVIEW_POST_ONLY` on the default command), **`--post-pr`** overrides **`--pr`** when both are set.
- `--no-confirm` skips interactive stale-review confirmation prompts (recommended for CI).
- Use `--review-summary <triage|impact|evidence>` to choose the review body format (`impact` is the default).
- Only anchorable findings (`file` + `line`) are posted as inline comments.
- Before posting, the CLI checks if the PR head moved since context collection; stale postings require confirmation unless `--no-confirm` is set.

## Post command (`agents code-review post`)

- **`bun run agents code-review post`** publishes findings from an existing **`result.json`** without rerunning the review model.
- By default it auto-discovers the latest **`.review-agent/runs/<run-id>/result.json`** in the workspace.
- Pass **`--result <path>`** to choose a specific result artifact.
- Post requires **`pr_number`** and **`pr_reviewed_head_sha`** metadata in the stored result (produce them by running the review with **`--pr`** on a PR-backed context). Override the posting PR with **`--pr`** or **`--post-pr`**.
- **`agents code-review post`** keeps reviews pending (unsubmitted), same as **`--pending-review`** on a full run.
- Post does not mutate the selected **`result.json`**.

Alternatively, **`AGENTS_CODE_REVIEW_POST_ONLY`** runs the default **`agents code-review`** command in post-only mode (without the **`post`** subcommand).

## Consistency and replay mode:

- `--context-bundle <path>` reuses a prior context bundle instead of collecting live PR/diff context again.
- **`agents code-review replay`** is equivalent: optional bundle path immediately after **`replay`** is turned into **`--context-bundle`**; you must still pass **`--context-bundle`** explicitly if you skip the positional.
- Replay mode is useful for comparing model behavior with stable input.
- `result.json` metadata includes `vcs_mode`, `context_source`, and `context_fingerprint` for run-to-run comparison.
- `--consensus <n>` runs `n` review passes and keeps only findings that recur in every pass.
- Consensus values must be positive integers (`n >= 1`).

Deterministic mode:

- Deterministic mode is enabled by default and emits deterministic metadata in `result.json`.
- For OpenCode, deterministic defaults enable `--pure`; use `--variant <id>` to pin a provider-specific effort profile.
- For Claude, deterministic defaults are conservative and do not add extra CLI args unless you explicitly pass `--claude-args`.
- For Cursor, deterministic defaults use `--print --output-format stream-json --trust --force` and rely on Cursor's default `agent` mode.
- Cursor non-interactive runs require a trusted workspace. If you override `--cursor-args`, keep `--trust` in the template.
- Use `--no-deterministic` to opt out.
- Determinism remains best-effort because seed/temperature/top-p controls are not currently surfaced by this harness CLI.

## Review Summary Examples

- `triage`: use when the author needs immediate prioritization. This format emphasizes near-term actions with "Fix Now" and "Follow-up" sections so work can be sequenced quickly.

  ```bash
  bun run agents code-review --adapter opencode --model opencode/gpt-5.3-codex --pending-review --pr 1 --review-summary triage
  ```

  ```markdown
  ## At a Glance
  ## Fix Now
  ## Follow-up
  ```

- `impact` (default): use when the PR crosses subsystem boundaries or multiple reviewers. Grouping by impact area (security, runtime/performance, correctness/quality, docs/compliance) helps route issues to the right owners.

  ```bash
  bun run agents code-review --adapter opencode --model opencode/gpt-5.3-codex --pending-review --pr 1 --review-summary impact
  ```

  ```markdown
  ## Impact Summary
  ### Security
  ### Runtime / Performance
  ### Correctness / Quality
  ### Documentation / Compliance
  ```

- `evidence`: use when the author needs deeper rationale before acting. The "Why / Evidence / Fix" format is best for contentious findings, subtle behavior changes, or fixes that require tradeoff discussion.

  ```bash
  bun run agents code-review --adapter opencode --model opencode/gpt-5.3-codex --pending-review --pr 1 --review-summary evidence
  ```

  ```markdown
  ## Why / Evidence / Fix
  ### Finding 1: <title>
  - Why: ...
  - Evidence: ...
  - Suggested fix: ...
  ```

## PR Context Discovery

- The harness auto-discovers the related PR for the current branch with `gh pr view`.
- If `--pr <number>` is provided, the harness fetches PR metadata/diff from that PR directly.
- It reads PR title and description/body into review context.
- The review diff is built from the PR base branch patch (`<base>...HEAD`), not untracked `.review-agent` artifacts.
- It extracts docs/links referenced in the PR description.
- It auto-fetches referenced docs only when they match the tracked remote's host and org.
- If PR discovery or doc fetching fails, review continues with non-fatal context warnings.

## Expected Output

Each run writes artifacts under `.review-agent/runs/<run-id>/` unless `--scratchpad` overrides it.

Core artifacts:

- `report.md`: synthesized human-readable report.
- `result.json`: final structured output used by downstream tooling.
- `result.raw.json`: orchestration output before report filtering.
- `events.jsonl`: streaming event log from each role adapter.
- `triage.json`: selected review tier (`trivial`, `lite`, `full`).
- `context/bundle.json` and `context/bundle.md`: collected context presented to reviewers.
- `context/bundle.*` includes PR metadata and referenced documentation fetch results.
- `roles/<role>/<role>.request.json`: per-role execution request payload.
- `roles/<role>/stdout.log` and `roles/<role>/stderr.log`: raw subprocess output for timeout/failure debugging.

`result.json` shape:

- `status`: `passed`, `warnings`, `failed`, or `error`
- `findings`: deduped, actionable findings (verified only)
- Actionable findings additionally require substantive validation details (not just a bare assertion).
- Finding dedupe uses a canonical fingerprint (role + location + normalized semantic signature) to reduce rewording churn across runs.
- `artifacts`: paths generated by the run
- `metadata`: adapter and triage metadata
- `metadata.timed_out_roles`: comma-separated roles that timed out
- `metadata.failed_roles`: comma-separated roles that failed
- `metadata.completed_roles`: comma-separated roles that completed
- `metadata.strict_mode`: `true` when strict mode is enabled
- `metadata.vcs_mode`: detected workspace mode (`jj`, `git`, or `unknown`)
- `metadata.context_source`: `live` (collected) or `replay` (`--context-bundle`)
- `metadata.context_fingerprint`: short hash for context-equivalence checks
- `metadata.consensus_runs`: number of passes requested
- `metadata.consensus_mode`: `off` or `intersection`
- `metadata.consensus_dropped_findings`: count filtered by consensus
- `metadata.deterministic_mode`: `true` when deterministic profile is enabled
- `metadata.opencode_*` / `metadata.claude_*`: adapter-specific model/runtime settings and detected executable version
- `metadata.pr_number`: PR number when the run used PR-backed context (`--pr`)
- `metadata.pr_reviewed_head_sha`: PR head SHA captured during context collection
- `metadata.pr_reviewed_at`: ISO-8601 timestamp when PR patch context was collected
- `metadata.pr_posting_head_sha`: PR head SHA seen immediately before posting (`--pending-review`)
- `metadata.pr_head_diverged`: `true` if posting happened after PR head changed
- `reportPath` and `contextBundlePath`

## Rate Limiting

- A full `--pr` + `--pending-review` flow usually performs around 7-8 GitHub API requests.
- Check quota with `gh api rate_limit` if you encounter `403`/`429` responses.
- The CLI does not currently implement automatic rate-limit retries/backoff.

## Known Limitations

- Windows interactive prompt support is currently unavailable; use `--no-confirm`.

`events.jsonl` also includes periodic role heartbeat events (`type: tool`) with elapsed time and byte counts so long-running reviews can be diagnosed while still running.

## CLI Exit Code

- `0` when status is `passed`, `warnings`, or `failed`
- `1` when status is `error` (for example: adapter spawn failure or fatal orchestration error)

## PR Comment Template

Use this template when posting manual HITL review output to a pull request:

```markdown
## Code Review Harness (HITL)

- Run ID: `<run-id>`
- Adapter: `<fake|opencode|claude|cursor>`
- Triage Tier: `<trivial|lite|full>`
- Status: `<passed|warnings|failed|error>`

### Findings
- `<severity>` `<title>` (`<file>:<line>`)
  - Evidence: `<short evidence>`
  - Validation: `<status> - <details>`

### Human Decision
- [ ] Addressed in this PR
- [ ] Deferred with rationale
- [ ] Not actionable (explain why)

### Notes
- `<any extra reviewer context>`
```
