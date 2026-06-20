# Workflows

## Human-in-the-loop (HITL)

1. Run the harness from your branch.
2. Open `report.md` from the CLI output path.
3. Inspect `result.json` for status and normalized findings.
4. Apply fixes or document why a finding is not actionable.
5. Re-run until status and findings match your release bar.
6. Add the final summary to your PR manually.

HITL boundaries:

- The harness does not post PR comments unless `--pending-review` is enabled.
- The harness does not block merges by itself.
- Humans decide which findings to act on.
- Role timeouts are partial coverage warnings, not fatal harness errors.

### Strict mode

`--strict` changes timeout and role-error behavior to fail-fast. Any role
timeout or role error produces overall `error` status.

### PR comment template

Use this when posting manual HITL output to a pull request:

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

## Pending review mode (`--pending-review`)

Creates an unsubmitted GitHub review on the target PR.

- When the PR diff has at least one mappable hunk, the summary is posted as the
  **first** inline review thread and the review-level `body` is left empty, so
  finishing the review in the GitHub web UI does not overwrite the summary.
- If nothing in the diff can be anchored (for example no `patch` hunks), the
  summary remains on the review `body` only.
- Only anchorable findings (`file` + `line`) are posted as inline comments.
- If an existing pending review is on the PR: interactive runs prompt before
  replacing it; non-interactive runs require `--replace-pending-review`.
- Before posting, the CLI checks if the PR head moved since context collection;
  stale postings require confirmation unless `--no-confirm` is set.
- Use `--review-summary <triage|impact|evidence>` to choose the review body
  format (`impact` is the default).

### PR targeting

- `--pr <number>` — collect context/diff from that PR and post the review to it.
- `--post-pr <number>` — post to a different PR than `--pr` (rare).
- Omit `--pr` — auto-discover the current branch PR (posting only).

PR lookups use the repo from `--workspace` and auto-resolve jj workspace
pointers to canonical colocated repos for `git`/`gh` commands.

### Review summary formats

**`triage`** — prioritization-first; "Fix Now" and "Follow-up" sections.

```bash
bun run agents code-review --adapter opencode --model opencode/gpt-5.3-codex \
  --pending-review --pr 1 --review-summary triage
```

```markdown
## At a Glance

## Fix Now

## Follow-up
```

**`impact`** (default) — groups findings by impact area; useful when a PR
crosses subsystem boundaries.

```bash
bun run agents code-review --adapter opencode --model opencode/gpt-5.3-codex \
  --pending-review --pr 1 --review-summary impact
```

```markdown
## Impact Summary

### Security

### Runtime / Performance

### Correctness / Quality

### Documentation / Compliance
```

**`evidence`** — "Why / Evidence / Fix" per finding; best for contentious or
subtle changes requiring tradeoff discussion.

```bash
bun run agents code-review --adapter opencode --model opencode/gpt-5.3-codex \
  --pending-review --pr 1 --review-summary evidence
```

```markdown
## Why / Evidence / Fix

### Finding 1: <title>

- Why: ...
- Evidence: ...
- Suggested fix: ...
```

## Post command (`agents code-review post`)

Publishes findings from an existing `result.json` without rerunning the review
model.

```bash
# Auto-discover latest result in workspace
bun run agents code-review post

# Choose a specific result artifact
bun run agents code-review post --result .agents-code-review/runs/<run-id>/result.json
```

Resolution order for PR to post to:

1. `pr_number` stored in the result (captured during context collection)
2. `--post-pr` / `--pr` CLI flag
3. `gh pr view` on the workspace (same as a full run)

`post` keeps reviews pending (unsubmitted) and does not mutate the selected
`result.json`.

`AGENTS_CODE_REVIEW_POST_ONLY=true` runs the default `agents code-review`
command in post-only mode without the `post` subcommand.

## Replay and consistency mode

Reuse a prior context bundle to compare model behavior on stable input:

```bash
# Explicit flag
bun run agents code-review \
  --adapter claude --model claude-sonnet-4 \
  --context-bundle .agents-code-review/runs/<run-id>/context/bundle.json

# Shorthand (positional bundle path after "replay" becomes --context-bundle)
bun run agents code-review replay \
  .agents-code-review/runs/<run-id>/context/bundle.json \
  --adapter claude --model claude-sonnet-4
```

`result.json` includes `vcs_mode`, `context_source`, and `context_fingerprint`
for run-to-run comparison.

## Consensus mode (`--consensus <n>`)

Runs `n` review passes and keeps only findings that recur in every pass. Values
must be positive integers (`n >= 1`).

```bash
bun run agents code-review --adapter opencode --model opencode/gpt-5.3-codex --consensus 3
```

## PR context discovery

- Without `--pr`: the harness uses the workspace tree as-is (no extra worktree).
- With `--pr <number>`: files are reviewed from a **detached git worktree**
  checked out at the PR head under `.agents-code-review/worktrees/`, leaving
  your main checkout's branch and working tree untouched. Requires `git` at the
  resolved workspace and a fetchable `origin` ref for `pull/<pr>/head`.
- Reads PR title and description/body into review context.
- Extracts and auto-fetches docs linked in the PR description when they match
  the tracked remote's host and org.
- Context warnings are non-fatal; review continues if PR discovery or doc
  fetching fails.

## Rate limiting

A full `--pr` + `--pending-review` flow performs around 7–8 GitHub API requests.

```bash
gh api rate_limit   # check current quota
```

The CLI does not implement automatic rate-limit retries or backoff.

## CLI exit codes

| Code | Meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| `0`  | Status is `passed`, `warnings`, or `failed`                            |
| `1`  | Status is `error` (adapter spawn failure or fatal orchestration error) |

## Removed commands

### `agents run code-review` (removed)

The `agents run code-review` subcommand was removed. Use `agents code-review`
directly:

```bash
# Before (removed)
agents run code-review --adapter cursor

# After
agents code-review --adapter cursor
```

All flags and options are identical. Update any scripts or CI steps that used
the old form.
