---
name: pr-feedback-response
description: >-
  Drain unresolved inline PR review threads on your open PRs: list-mine,
  collect, agents triage --from pr-feedback, one commit per item, draft replies,
  agents pr-feedback submit after operator approval.
---

# PR feedback response (author → reply)

Use this playbook when **you authored** open pull requests and need to address
**human inline review threads** (scope A: unresolved `reviewThreads` only).

**Not in scope:** harness self-review ([`self-review-checks`](../self-review-checks/SKILL.md)),
reviewer assignments ([`code-review`](../code-review/SKILL.md)), issue comments,
or CI (babysit / ci-triage skills).

**Agents following this skill:** Do **not** invent harness `--adapter` / `--model`
settings. This workflow uses **`agents code-review inbox`**, **`agents
pr-feedback`**, and **`agents triage`** only.

## Goal

**Primary outcome:** every actionable unresolved review thread on selected PRs
is fixed (one commit per item when code changes), replied to on GitHub, and the
final **`agents triage --from pr-feedback`** ingest reports **`items.length ===
0`** (or explicit disposition in your work report).

## Pipeline

1. **`agents code-review inbox list-mine`** — discover open PRs you authored.
2. **Operator selects** explicit `owner/repo#<n>` set (same rule as
   [code-review PR selection](../code-review/SKILL.md#pr-selection-required-before-harness)).
3. Per PR: **`agents pr-feedback collect --pr <n> [--repo owner/name]`** →
   `.agents-pr-feedback/<slug>/feedback.json`.
4. **`agents triage --from pr-feedback --result <feedback.json> --workspace
   <anchor>`** → `.agents-triage/pr-feedback-<hash>/triage-queue.json`.
5. For each **`items[]`** entry needing code: fix → **one commit** (cite
   `item.id` in message).
6. Draft replies → **`pr-feedback-responses/v1`** JSON → operator approves full
   list → **`agents pr-feedback submit --draft <path>`**.
7. Re-**collect** + re-**triage** until **`items.length === 0`** or documented
   exits.

## Reporting work done

Mirror [self-review-checks reporting](../self-review-checks/SKILL.md#reporting-work-done):

1. **Gates** — repo verification (README, `AGENTS.md`, etc.).
2. **PR feedback** — `feedback.json` path; `items.length`; each `id` + `title`.
3. **Triage** — `triage-queue.json` path; `items.length`; map to feedback ids.
4. **Disposition** — empty queue or `false_positive` / `accepted_risk` /
   `deferred` per remainder.
5. **Commits** — `item.id` → SHA; reply-only items noted separately.

## Commands

```text
agents code-review inbox list-mine [--format text|json] [--workspace <path>] [--repos-root <path>]
agents pr-feedback collect --pr <n> [--repo owner/name] [--workspace <path>] [--output <dir>]
agents triage --from pr-feedback --result <feedback.json> [--workspace <path>] [--output <dir>]
agents pr-feedback submit --draft <responses.json> [--pr <n>] [--repo owner/name] [--workspace <path>] [--dry-run]
```

**Never commit** `.agents-pr-feedback/` or `.agents-triage/` (local artifacts).

## PR selection (required)

After **`list-mine`**, present PRs and **wait** for the operator to name each
`owner/repo#number`. Do not auto-pick the first row or “all open PRs” unless
explicitly requested.

## One commit per actionable item

When a thread requires a **code or test change**, use **exactly one commit** per
`item.id`. Map `item.id` in the commit body. Reply-only dispositions need no
commit.

## Draft responses before submit (required)

Before **`agents pr-feedback submit`**, show the operator every **`itemId`** and
**`body`** from the responses draft. Truncated chat summaries are not sufficient.

**`submit`** does not approve the PR or resolve threads by default.

## Repeat until done

Round cap and no-churn rules from
[self-review-checks](../self-review-checks/SKILL.md#stopping-endless-churn) apply
to **`items`** fingerprints across collect/triage cycles.

## Related playbooks

- **Self-review (harness):** [`self-review-checks`](../self-review-checks/SKILL.md)
- **Reviewer obligations:** [`code-review`](../code-review/SKILL.md)
- **Merge-ready loop:** babysit skill (comments + CI)
- **Actions red:** ci-triage skill

Install: **`agents skills install pr-feedback-response`**
