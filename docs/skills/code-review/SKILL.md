---
name: code-review
description: >-
  Work through GitHub pull requests that request your review: list assignments
  (you by default, optional team requests), inspect diffs, author a local review
  draft JSON, then submit one PR at a time with agents code-review inbox.
  Optional fzf for interactive selection when available.
---

# Code review (PR assignment inbox)

This playbook is for **human review obligations** on GitHub: PRs where **you**
(or a **team** you belong to) are listed as a requested reviewer. It is **not**
automated harness output, **`agents triage`**, or `result.json` findings.

**Prerequisites:** [`gh`](https://cli.github.com/) installed and authenticated
(`gh auth status`). The CLI uses the same **`gh`** cwd/login behavior as other
`agents code-review` GitHub commands.

## Commands (reference)

```text
agents code-review inbox list [--format text|json] [--include-team] [--workspace <path>]
agents code-review inbox show --pr <n> [--repo owner/name] [--workspace <path>]
agents code-review inbox draft --pr <n> [--repo owner/name] [--output <path>] [--workspace <path>]
agents code-review inbox submit --draft <path> [--workspace <path>]
```

- **`list`:** Defaults to PRs with **`review-requested:@me`**. Add
  **`--include-team`** to merge PRs matching **`team-review-requested:`** for
  each of your teams (deduped by repo + number).
- **`show`:** Prints **`gh pr view --json`** for the chosen PR (metadata and
  review requests).
- **`draft`:** Writes a **draft JSON** template (schema
  `https://aguil.dev/schemas/agents/code-review-inbox-draft/v1`). Edit
  **`body`** and **`event`** (`comment` \| `approve` \| `request_changes`)
  locally before submit.
- **`submit`:** Reads the draft file and runs **`gh pr review`** for **one PR**
  per invocation.

Omit **`--repo`** when your current repository is the same as the PR’s base
(inferred via `gh repo view`).

## Suggested workflow

1. **Verify auth:** `gh auth status`
2. **List work:** `agents code-review inbox list` (add `--include-team` if you
   want team-requested PRs in the same pass).
3. **Inspect:** `agents code-review inbox show --pr <n>` and/or
   `gh pr diff <n>`.
4. **Draft locally:**
   `agents code-review inbox draft --pr <n> --output ./review.json` then edit
   the file.
5. **Submit:** `agents code-review inbox submit --draft ./review.json`

## Optional: fzf picker

If **`fzf`** is installed, pipe **one human-readable field per line** into it,
then parse the selection:

```bash
agents code-review inbox list --format json \
  | jq -r '.assignments[] | "\(.repository)#\(.pullNumber)\t\(.title)\t\(.assignmentKind)\t\(.url)"' \
  | fzf
```

The first column is **`owner/repo#number`**, which you can split for **`show`**
and **`draft`**. If **`fzf`** is missing, use the default **text** `list` output
(tab-separated) or pass **`--pr`** explicitly.

## Agents

- Prefer **`agents code-review inbox`** for stable **`list --format json`**
  output over ad-hoc `gh` search strings when automating.
- Do **not** confuse this inbox flow with **full `agents code-review` harness
  reviewer runs** or **`agents triage`** remediation queues.

Install this playbook: **`agents skills install code-review`** (see
**`agents skills --help`**).
