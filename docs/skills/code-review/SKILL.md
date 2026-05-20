---
name: code-review
description: >-
  Work through GitHub PRs that request your review: list assignments, wait for
  explicit user selection of one or more PRs, run the harness per PR, review
  report.md before posting each, then agents code-review post per PR.
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

## PR selection (required before harness)

**Do not run the harness, `post`, or any review command until the operator has
explicitly chosen which pull request(s) to review** (`owner/repo#number`). One
PR or **several** is fine; listing assignments is not consent to review
anything.

**Agents must:**

1. Run **`agents code-review inbox list`** (or show the same data) and present
   the assignments to the operator.
2. **Stop and ask** which PR(s) to review—or wait for the operator to run
   **fzf** (single or **multi-select**) or name **`owner/repo#<n>`**
   (comma-separated or a clear list). Do **not** proceed on silence.
3. Treat the operator’s answer as a **closed set**: only those PRs get harness
   runs and **`post`** calls in this session. Do **not** add other inbox rows.
4. For **each** selected PR, in order (or an order the operator specifies):
   - Run **`agents code-review --pr <n> --repo owner/name`** when the anchor is
     not already that repo. **Always pass `--pr`** per run.
   - **[Review findings](#review-findings-before-post-required)** for **that**
     PR’s run ( **`report.md`** ).
   - Run **`agents code-review post --pr <n> --result <that-run/result.json>`**
     only after the operator approves **that** PR’s findings.
   - **Finish on GitHub** for that PR before moving on, unless the operator
     asked to batch harness runs first (still **per-PR** review before each
     **`post`**).

**Never:**

- Pick the first row, “most recent”, “all assignments”, or “only” PR without the
  operator naming each **`owner/repo#number`**.
- Infer PRs from cwd, HEAD, or chat context unless the operator explicitly
  listed them for this session.
- Run **`agents code-review`** before PR selection.
- Use **`post`** without **`--pr`** and **`--result`** when multiple PRs were
  reviewed in the same workspace (auto-discovery of “latest” may be the wrong
  PR).

If the operator says “review my PRs” without naming which ones, reply with the
inbox list and ask for an explicit set (one or more **`owner/repo#number`**, or
fzf multi-select) before any harness command.

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
   **`--include-team`** if needed). Present options to the operator.
3. **Operator selects PR(s)** — explicit set only: one or more
   **`owner/repo#<n>`**, confirmed rows, or
   **[fzf](#optional-fzf-picker-with-pr-description-preview)** (including
   **multi-select**). See
   **[PR selection](#pr-selection-required-before-harness)**.
4. **Per selected PR** (repeat for each; use that repo’s artifact anchor):
   1. **Harness:** `agents code-review --pr <n> --repo owner/name`
   2. **Review findings:**
      **[Review findings before post](#review-findings-before-post-required)**
      for this PR’s **`report.md`** / run directory
   3. **Publish:** `agents code-review post --pr <n> --result <run>/result.json`
      after operator approval for **this** PR
   4. **Finish on GitHub** for this PR (unless operator deferred finish until
      later)

## Review findings before post (required)

**`agents code-review post`** reads **`result.json`** only. It does **not** use
inbox draft files. The summary and inline comments come from harness
**`findings`**.

Before **`post`**, the operator (or agent assisting them) must **review what
will be published**—not a one-line chat recap.

1. **Locate the run** for **this PR** — the directory created by that PR’s
   harness invocation, or pass **`--result <path>`** on **`post`**. When
   multiple PRs were reviewed, do **not** assume “latest” under the anchor; tie
   **`post`** to the matching **`result.json`**.
2. **Read findings** — open **`report.md`** in the run directory (path printed
   by the harness, or **`reportPath`** in **`result.json`**) for the full
   formatted report. Use **`jq`** on **`result.json`** only for a compact
   id/title/severity checklist if helpful.
3. **Disposition** — confirm which findings should appear on the PR. For false
   positives or needed code fixes, update the branch and **re-run the harness**;
   do **not** **`post`** a stale **`result.json`**.
4. **Optional context** — **`gh pr view <n> --repo owner/repo`** alongside
   artifacts so the review sits next to the author’s description.

**Inspect findings (read-only):**

```bash
WORKSPACE=.   # artifact anchor you used for the harness run
RUN=$(ls -td "$WORKSPACE/.agents-code-review/runs/code-review-"* 2>/dev/null | head -1)
less "$RUN/report.md"
# optional compact checklist:
jq '.findings[] | {id, title, severity}' "$RUN/result.json"
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

**Interactive pick:** **`fzf`** is for the **operator** to choose PR(s). Agents
must **not** run **`fzf`** non-interactively or substitute list rows. After
**`list`**, the operator runs the snippet (single or **multi**), or names
**`owner/repo#<n>`** (one or several)—then you may run the harness **only for
those PRs**.

**Single PR** — default **`fzf`** (one row). **Multiple PRs** — add
**`--multi`** (and optionally **`--bind 'ctrl-a:select-all+accept'`**).
Tab-separated output still uses **`{1}`** = **`owner/repo#number`** per line.

```bash
# Single PR: omit --multi. Multiple PRs: add --multi to fzf.
picks=$(
  agents code-review inbox list --format json \
    | jq -r '.assignments[] | [.repository + "#" + (.pullNumber | tostring), .title, .assignmentKind, .url] | @tsv' \
    | fzf --multi \
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

# Only after the operator selected in fzf — loop each line (do not run from agent alone):
while IFS= read -r line; do
  [ -z "$line" ] && continue
  key=$(printf '%s' "$line" | cut -f1)
  repo="${key%%#*}"
  pr="${key##*#}"
  anchor=<clone-or-anchor-for-this-repo>

  agents code-review --pr "$pr" --repo "$repo" --workspace "$anchor"
  RUN=$(ls -td "$anchor/.agents-code-review/runs/code-review-"* 2>/dev/null | head -1)
  less "$RUN/report.md"
  # Operator approves this PR's findings, then:
  agents code-review post --pr "$pr" --result "$RUN/result.json" --workspace "$anchor"
done <<< "$picks"
```

Set **`GH_PAGER=cat`** in **`fzf --preview`** so the preview pane is
non-interactive.

Without **`fzf`**, show **`inbox list`** and ask which **`owner/repo#<n>`** to
review (one or more)—do not assume rows.

## Scripts directory?

Keep **fzf** / **`jq`** snippets **in this playbook**, not under
**`docs/skills/code-review/scripts/`**.

- **`agents skills install code-review`** copies **only** **`SKILL.md`** (see
  **`agents skills --help`**).
- **Preferred evolution:** an **`agents code-review inbox pick`** (or similar)
  in **`packages/cli`** with **`--workspace`** / **`--repos-root`** wired like
  **`list`**.

## Agents

| Do                                                                                    | Don't                                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **`list`**, then **wait for explicit PR set** (one or many)                           | Run harness after **`list`** without operator-named PR(s)           |
| Process **only** PRs the operator selected; **per PR**: harness → review → **`post`** | Review “all” inbox rows or add PRs they did not name                |
| Run **`agents code-review --pr <n>`** per selected PR                                 | Omit **`--pr`** or auto-pick from cwd/HEAD/list order               |
| Show **`report.md`** before **`post`** for **that** PR                                | Call **`post`** right after harness or use wrong **`--result`**     |
| **`post --pr <n> --result <run>/result.json>`** matching the harness run              | **`post`** without **`--result`** when multiple PRs share an anchor |
| Use **`inbox`** for **`list`** / **`show`** only                                      | Use **`inbox draft`** / **`inbox submit`**                          |
| Respect **`post`** confirm prompts unless operator wants **`--no-confirm`**           | Invent adapter/model/dry-run overrides                              |
| Finish on GitHub per PR after **`post`** (unless operator defers)                     | Treat **`post`** as final approve/request-changes                   |

Install this playbook: **`agents skills install code-review`** (see
**`agents skills --help`**).
