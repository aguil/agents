---
name: code-review
description: >-
  Work through GitHub PRs that request your review: list assignments (you and
  optional team requests), run the code-review harness on a chosen PR, locally
  review harness findings before posting, then publish a pending GitHub review
  with agents code-review post.
---

# Code review (PR assignments → harness → post)

This playbook is for **review obligations** on GitHub: pull requests where
**you** (or a **team** you belong to) are listed as a requested reviewer.

**Scope:**

- **`agents code-review inbox`** — discover and pick assignments (`list`,
  `show`). It does **not** run reviewers or publish to GitHub.
- **`agents code-review --pr <n>`** — run the **harness**; writes
  **`result.json`** (and related artifacts) under
  **`.agents-code-review/runs/`** on your artifact anchor workspace. Uses a
  detached worktree so your main checkout stays unchanged.
- **Local human review** — you (or an agent assisting you) must review harness
  **findings** before anything is posted.
- **`agents code-review post`** — publish a **pending** PR review from stored
  **`result.json`** (inline threads + summary). **Finish review** in the GitHub
  UI (approve, request changes, or comment).

This is **not** **`agents triage`** (remediation queue from prior harness runs
on your own branches).

**Prerequisites:** [`gh`](https://cli.github.com/) installed and authenticated
(`gh auth status`). Harness and inbox GitHub commands use the same **`gh`**
login/cwd behavior.

**Agents following this skill:** Do **not** invent or override adapter or model
settings (`--adapter`, `--model`, binary paths, argv templates). Use whatever
the merged CLI resolution already applies (harness defaults, user
**`~/.config/agents/code-review/config.json`**, optional repo
**`.agents-code-review/config.json`**, **`AGENTS_CODE_REVIEW_*`**, and flags the
operator supplied). Do **not** add or drop **`--dry-run`** on your own.

## Commands (reference)

**Inbox (assignment discovery):**

```text
agents code-review inbox list [--format text|json] [--include-team] [--workspace <path>] [--repos-root <path>]
agents code-review inbox show --pr <n> [--repo owner/name] [--workspace <path>] [--repos-root <path>]
```

- **`list`:** Defaults to **`review-requested:@me`**. Add **`--include-team`**
  to merge **`team-review-requested:`** PRs for your teams (deduped by repo +
  number).
- **`show`:** PR metadata JSON (`gh pr view --json`). For the full description,
  use **`gh pr view <n> --repo …`**.

**Harness and publish:**

```text
agents code-review --pr <n> [--workspace <path>] [--repos-root <path>] [harness flags…]
agents code-review post [--pr <n>] [--result <path>] [--workspace <path>] [--review-summary triage|impact|evidence] [--no-confirm]
```

See **`agents code-review --help`** and **`agents code-review post --help`** for
adapter, logging, and posting options.

**`--repos-root`** (default **`~/dev/repos`**, or
**`AGENTS_CODE_REVIEW_REPOS_ROOT`**): with **`--repo owner/name`**, the CLI can
resolve a clone at **`repos-root/github.com/owner/repo`** or
**`repos-root/owner/repo`**.

Legacy **`inbox draft`** / **`inbox submit`** exist in the CLI but are **not**
part of this playbook (manual prose reviews). Use the harness + **`post`** flow
below.

## Suggested workflow

1. **Verify auth:** `gh auth status`
2. **List assignments:** `agents code-review inbox list` (add
   **`--include-team`** if needed). Prefer
   **[Optional: fzf picker](#optional-fzf-picker-with-pr-description-preview)**.
3. **Run harness:** `agents code-review --pr <n>` from the **artifact anchor**
   workspace (the checkout you pass as **`--workspace`**, or cwd). Artifacts
   land under **`.agents-code-review/runs/`** on that anchor—not only inside the
   detached worktree.
4. **Review findings before post:** Follow
   **[Review findings before post](#review-findings-before-post-required)**.
5. **Publish:** `agents code-review post --pr <n>` (or **`--result`** to a
   specific run) after the operator approves the findings to publish.
6. **Finish on GitHub:** Open the pending review URL and **Finish review**
   (approve, request changes, or comment).

## Review findings before post (required)

**`agents code-review post`** reads **`result.json`** only. It does **not** use
inbox draft files. The summary and inline comments come from harness
**`findings`**.

Before **`post`**, the operator (or agent assisting them) must **review what
will be published**—not a one-line chat recap.

1. **Locate the run** — latest under
   **`<workspace>/.agents-code-review/runs/code-review-*`**, or pass
   **`--result <path>`** explicitly.
2. **Read findings** — enumerate **`findings[].id`**, **`title`**, and
   **`severity`** from **`result.json`**. Skim **`report.md`** in the same run
   directory when present.
3. **Disposition** — confirm which findings should appear on the PR. For false
   positives or needed code fixes, update the branch and **re-run the harness**;
   do **not** **`post`** a stale **`result.json`**.
4. **Optional context** — **`gh pr view <n> --repo owner/repo`** alongside
   artifacts so the review sits next to the author’s description.

**Inspect findings (read-only):**

```bash
WORKSPACE=.   # artifact anchor you used for the harness run
RUN=$(ls -td "$WORKSPACE/.agents-code-review/runs/code-review-"* 2>/dev/null | head -1)
jq '.findings[] | {id, title, severity}' "$RUN/result.json"
# optional: less "$RUN/report.md"
```

**Agents:** Do **not** run **`agents code-review post`** until the operator has
been shown the **full findings list** (at minimum every **`id`** and
**`title`**). Truncated chat summaries are fine during work, not as the gate
before **`post`**.

**Posting notes:**

- There is no **`post --dry-run`**; approval is based on reading artifacts.
- **`post`** may prompt for stale PR head, local branch ahead of PR, or
  replacing an existing pending review—use **`--no-confirm`** only when the
  operator intends non-interactive publish (e.g. CI).
- **`--review-summary`** controls summary formatting (**`triage`**,
  **`impact`**, **`evidence`**; default **`impact`**).

## Optional: fzf picker with PR description preview

If **`fzf`** is installed, emit **tab-separated** rows so **`{1}`** stays
**`owner/repo#number`** for scripting and preview.

```bash
pick=$(
  agents code-review inbox list --format json \
    | jq -r '.assignments[] | [.repository + "#" + (.pullNumber | tostring), .title, .assignmentKind, .url] | @tsv' \
    | fzf \
        --delimiter=$'\t' \
        --with-nth=2,3,4 \
        --preview '
          key={1}
          repo="${key%%#*}"
          num="${key##*#}"
          GH_PAGER=cat gh pr view "$num" --repo "$repo"
        ' \
        --preview-window=right:65%:wrap
)
repo_pr=$(printf '%s' "$pick" | cut -f1)
repo="${repo_pr%%#*}"
pr="${repo_pr##*#}"

# Harness on PR head (artifact anchor = your clone or cwd)
agents code-review --pr "$pr" --workspace <anchor>

# Human reviews findings (see "Review findings before post")
RUN=$(ls -td <anchor>/.agents-code-review/runs/code-review-* 2>/dev/null | head -1)
jq '.findings[] | {id, title, severity}' "$RUN/result.json"

# After operator approval:
agents code-review post --pr "$pr" --workspace <anchor>
```

Set **`GH_PAGER=cat`** in **`fzf --preview`** so the preview pane is
non-interactive.

Without **`fzf`**, pick from **`inbox list`** text output or pass **`--pr`**
explicitly once you know the number.

## Scripts directory?

Keep **fzf** / **`jq`** snippets **in this playbook**, not under
**`docs/skills/code-review/scripts/`**.

- **`agents skills install code-review`** copies **only** **`SKILL.md`** (see
  **`agents skills --help`**).
- **Preferred evolution:** an **`agents code-review inbox pick`** (or similar)
  in **`packages/cli`** with **`--workspace`** / **`--repos-root`** wired like
  **`list`**.

## Agents

| Do                                                                          | Don't                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------- |
| After pick, run **`agents code-review --pr <n>`**                           | Stop after **`inbox list`** / **`show`** / fzf    |
| Show full **`findings`** (ids + titles) before **`post`**                   | Call **`post`** immediately after the harness     |
| Use **`inbox`** for **`list`** / **`show`** / pick only                     | Use **`inbox draft`** / **`inbox submit`**        |
| Respect **`post`** confirm prompts unless operator wants **`--no-confirm`** | Invent adapter/model/dry-run overrides            |
| Finish the review on GitHub after **`post`**                                | Treat **`post`** as final approve/request-changes |

Install this playbook: **`agents skills install code-review`** (see
**`agents skills --help`**).
