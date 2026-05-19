---
name: code-review
description: >-
  Work through GitHub pull requests that request your review: list assignments
  (you by default, optional team requests), inspect diffs, author a local review
  draft JSON, surface the full PR description when picking a PR (e.g. fzf
  preview), print your review summary and findings in full for a final human
  check, then submit one PR at a time with agents code-review inbox.
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
agents code-review inbox list [--format text|json] [--include-team] [--workspace <path>] [--repos-root <path>]
agents code-review inbox show --pr <n> [--repo owner/name] [--workspace <path>] [--repos-root <path>]
agents code-review inbox draft --pr <n> [--repo owner/name] [--output <path>] [--workspace <path>] [--repos-root <path>]
agents code-review inbox submit --draft <path> [--workspace <path>] [--repos-root <path>]
```

- **`list`:** Defaults to PRs with **`review-requested:@me`**. Add
  **`--include-team`** to merge PRs matching **`team-review-requested:`** for
  each of your teams (deduped by repo + number).
- **`show`:** Prints **`gh pr view --json`** for the chosen PR (metadata and
  review requests). For the author’s **full description body**, run
  **`gh pr view <n> --repo …`** (plain or **`--json body,title`**).
- **`draft`:** Writes a **draft JSON** template (schema
  `https://aguil.dev/schemas/agents/code-review-inbox-draft/v1`). Edit
  **`body`** and **`event`** (`comment` \| `approve` \| `request_changes`)
  locally before submit.
- **`submit`:** Reads the draft file and runs **`gh pr review`** for **one PR**
  per invocation.

Omit **`--repo`** when your current repository is the same as the PR’s base
(inferred via `gh repo view`). With **`--repo owner/name`** (or on **`submit`**,
from **`draft.repository`**), the CLI can locate your checkout under
**`--repos-root`** (default **`~/dev/repos`**, or
**`AGENTS_CODE_REVIEW_REPOS_ROOT`**): try **`repos-root/github.com/owner/repo`**
then **`repos-root/owner/repo`**.

## Suggested workflow

1. **Verify auth:** `gh auth status`
2. **List work:** `agents code-review inbox list` (add `--include-team` if you
   want team-requested PRs in the same pass). Prefer
   **[Optional: fzf picker](#optional-fzf-picker-with-pr-description-preview)**
   when choosing a PR so the description stays visible.
3. **Inspect:** `agents code-review inbox show --pr <n>` and/or `gh pr diff <n>`
   (and **`gh pr view <n>`** when you want the full PR body in the terminal).
4. **Draft locally:**
   `agents code-review inbox draft --pr <n> --output ./review.json` then edit
   **`body`** with your **complete** review summary and findings (what readers
   on GitHub will see).
5. **Final human review:** Follow
   **[Final human review before submit](#final-human-review-before-submit)**—print
   the draft and confirm wording before posting.
6. **Submit:** `agents code-review inbox submit --draft ./review.json`

## Final human review before submit

GitHub posts your **`draft.body`** verbatim. Before **`inbox submit`**, the
operator (or agent assisting them) should **read the exact text** that will go
public—not a shortened recap.

**Print the draft review (event + full findings body):**

```bash
jq -r '
  "========== GitHub review draft (not submitted yet) ==========",
  "",
  "Repository: \(.repository)#\(.pullNumber)",
  "Event:      \(.event)",
  "",
  "--- Body (full text posted to the PR) ---",
  "",
  .body,
  ""
' ./review.json
```

- Use **`event: approve`** only after you are comfortable approving with **no**
  review comment text (GitHub allows an empty body for approve); for
  **`comment`** or **`request_changes`**, ensure **`body`** reflects every
  finding you intend to publish—nothing should be “implicit” or omitted from
  this preview.
- Optionally recap PR context in the same terminal session so the review sits
  beside the author’s description:

```bash
gh pr view <n> --repo owner/repo
```

Use **`GH_PAGER=cat`** (or **`PAGER=cat`**) if your pager would otherwise
swallow output inside scripts or nested shells.

**Agents following this skill:** Do **not** call **`inbox submit`** until the
operator has been offered this **full-text** draft output (and, when helpful,
the PR description). Truncated summaries are fine for _chat_, not as the last
step before submit.

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
# repo_pr is owner/repo#<n> — split for draft/show:
repo="${repo_pr%%#*}"
pr="${repo_pr##*#}"
```

The **`--preview`** pane runs **`gh pr view`**, which includes the PR **title**
and **body** (full description) in a scrollable preview box while you move the
selection—set **`GH_PAGER=cat`** so the preview is non-interactive.

If you omit **`fzf`**, run **`gh pr view <n> --repo owner/repo`** after choosing
a row from the default **text** `list` output, or pass **`--pr`** explicitly
once you know the number.

## Scripts directory?

**Today:** keep the **fzf** / **`jq`** snippets **in this playbook**, not in a
companion **`scripts/`** tree under **`docs/skills/code-review/`**.

- **`agents skills install code-review`** copies **only** **`SKILL.md`** into
  **`~/.agents/skills/code-review/`** (see the CLI implementation). Auxiliary
  **`scripts/*.sh`** next to `SKILL.md` would **not** be installed, so most
  users would never see them unless they symlink/copy the whole skill directory
  by hand.
- Shipping shell beside the skill without updating the installer splits the
  “single portable file” story and invites stale forked copies when the JSON
  shape or **`gh`** flags change.
- **Preferred evolution:** add an **`agents code-review inbox …`** interactive
  picker (or **`pick`**) in **`packages/cli`**, with **`--workspace`** /
  **`--repos-root`** wired the same as **`list`** / **`draft`**, plus tests—then
  this skill links to one supported command instead of a brittle bash bundle.
- **If** you still want repo-local helpers for yourself, keep them outside this
  skill tree (dotfiles, **`~/bin`**), or symlink an entire checkout directory
  into your skills root **knowing** `skills install` will not refresh those
  files.

## Agents

- Prefer **`agents code-review inbox`** for stable **`list --format json`**
  output over ad-hoc `gh` search strings when automating.
- Offer **`gh pr view`** (or **fzf `--preview`**) when picking among assignments
  so the PR description is visible; emit the **full draft body** before
  **`submit`** (see sections above).
- Do **not** confuse this inbox flow with **full `agents code-review` harness
  reviewer runs** or **`agents triage`** remediation queues. Here **`--pr`**
  only selects which pull request to show, draft, or submit via **`gh`**. **Full
  harness** **`agents code-review --pr <n>`** is different: it fetches the PR
  head into a detached worktree under **`.agents-code-review/worktrees/`** so
  the harness does not switch your main checkout (artifacts stay on
  **`--workspace`**).

Install this playbook: **`agents skills install code-review`** (see
**`agents skills --help`**).
