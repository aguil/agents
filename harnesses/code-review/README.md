# Code Review Harness

Multi-agent code review harness built on the shared Bun/TypeScript runtime.

The harness runs role-specialized reviewers in parallel through an agent-agnostic execution adapter. OpenCode, Claude Code, Cursor CLI, and pi.dev can be added as adapters without changing the code-review workflow.

The first implementation includes:

- `FakeAgentAdapter` for deterministic tests and local smoke runs.
- `OpenCodeAdapter` for real opt-in reviewer sessions through `opencode run --format json`.
- `ClaudeCodeAdapter` for opt-in Claude Code subprocess sessions.

Run locally with:

```bash
bun run agents run code-review --adapter fake
bun run agents run code-review --adapter opencode --model <provider/model>
bun run agents run code-review --adapter claude --model <model>
bun run agents run code-review --adapter claude --model <model> --strict
bun run agents run code-review --adapter opencode --model opencode/gpt-5.3-codex --pending-review
bun run agents run code-review --adapter opencode --model opencode/gpt-5.3-codex --pending-review --review-summary impact
bun run agents run code-review --adapter opencode --model opencode/gpt-5.3-codex --review-pr 1
bun run agents run code-review --adapter opencode --model opencode/gpt-5.3-codex --context-bundle .review-agent/runs/<run-id>/context/bundle.json
bun run agents run code-review --adapter opencode --model opencode/gpt-5.3-codex --consensus 3
bun run agents run code-review --adapter opencode --model opencode/gpt-5.3-codex --variant minimal
bun run agents run code-review --adapter claude --model <model>
bun run agents run code-review --adapter opencode --model opencode/gpt-5.3-codex --no-deterministic
```

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

- `--pending-review` deletes existing pending reviews authored by the current user on the target PR, then creates a fresh unsubmitted review.
- Use `--pr <number>` to target a specific PR, otherwise the current branch PR is auto-discovered.
- Use `--review-pr <number>` to collect review context/diff from a specific PR (including merged PRs).
- Use `--review-summary <triage|impact|evidence>` to choose the review body format (`impact` is the default).
- Only anchorable findings (`file` + `line`) are posted as inline comments.

Consistency and replay mode:

- `--context-bundle <path>` reuses a prior context bundle instead of collecting live PR/diff context again.
- Replay mode is useful for comparing model behavior with stable input.
- `result.json` metadata includes `vcs_mode`, `context_source`, and `context_fingerprint` for run-to-run comparison.
- `--consensus <n>` runs `n` review passes and keeps only findings that recur in every pass.
- Consensus values must be positive integers (`n >= 1`).

Deterministic mode:

- Deterministic mode is enabled by default and emits deterministic metadata in `result.json`.
- For OpenCode, deterministic defaults enable `--pure`; use `--variant <id>` to pin a provider-specific effort profile.
- For Claude, deterministic defaults are conservative and do not add extra CLI args unless you explicitly pass `--claude-args`.
- Use `--no-deterministic` to opt out.
- Determinism remains best-effort because seed/temperature/top-p controls are not currently surfaced by this harness CLI.

Review summary examples:

- `triage`: use when the author needs immediate prioritization. This format emphasizes near-term actions with "Fix Now" and "Follow-up" sections so work can be sequenced quickly.

  ```bash
  bun run agents run code-review --adapter opencode --model opencode/gpt-5.3-codex --pending-review --pr 1 --review-summary triage
  ```

  ```markdown
  ## At a Glance
  ## Fix Now
  ## Follow-up
  ```

- `impact` (default): use when the PR crosses subsystem boundaries or multiple reviewers. Grouping by impact area (security, runtime/performance, correctness/quality, docs/compliance) helps route issues to the right owners.

  ```bash
  bun run agents run code-review --adapter opencode --model opencode/gpt-5.3-codex --pending-review --pr 1 --review-summary impact
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
  bun run agents run code-review --adapter opencode --model opencode/gpt-5.3-codex --pending-review --pr 1 --review-summary evidence
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
- If `--review-pr <number>` is provided, the harness fetches PR metadata/diff from that PR directly.
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
- `reportPath` and `contextBundlePath`

`events.jsonl` also includes periodic role heartbeat events (`type: tool`) with elapsed time and byte counts so long-running reviews can be diagnosed while still running.

CLI exit code:

- `0` when status is `passed`, `warnings`, or `failed`
- `1` when status is `error` (for example: adapter spawn failure or fatal orchestration error)

## PR Comment Template

Use this template when posting manual HITL review output to a pull request:

```markdown
## Code Review Harness (HITL)

- Run ID: `<run-id>`
- Adapter: `<fake|opencode|claude>`
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
