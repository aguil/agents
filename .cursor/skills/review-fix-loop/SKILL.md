---
name: review-fix-loop
description: >-
  Manual-testing playbook for `agents code-review` / `agents triage`,
  focused fixes, one commit per actionable finding, and local gates before push.
  Completion uses a repeating work-report layout (gates, result.json findings,
  triage items, disposition, commits) and empty triage items as the downstream
  consumer bar — merged-config-only code-review; no fabricated adapter overrides.
---

# Review / fix loop (manual testing playbook)

Use this playbook for exercising this repo’s agent harnesses and keeping changes honest before you push.

**Agents following this skill:** Do **not** invent or override adapter or model settings (`--adapter`, `--model`, binary paths, argv templates). Use whatever the merged CLI resolution already applies: harness defaults, then user **`~/.config/agents/code-review/config.json`**, optional copied **`review-agent.config.example.json`** → **`.review-agent/config.json`** (repo‑allowed knobs only), **`AGENTS_CODE_REVIEW_*`**, and explicit flags **only if the user supplied them**. **Do **not** add **`--dry-run`** (or drop it) on your own**—mirror whatever the operator specified for this session (normal **`runs/`** output vs **`--dry-run`** scratch). Mirrors real operator workflow; see `harnesses/code-review/README.md` (merge order).

## Goal

Run the repository's documented verification gates before you treat the tree as trusted. Then run the repository's configured review harness, ingest the findings into a triage queue, fix the actionable items one at a time, and repeat until the queue is empty or the remaining items are explicitly documented.

Produce the downstream queue with **`agents triage --from code-review --workspace .`**, pointing at **`result.json`** (**`--result …`** when you are not relying on workspace default discovery). **You are done when **`items`** in that triage envelope is empty.**

Verify in **`triage-queue.json`** under **`.agents-triage/<producerShort>-<hash12>/`**, a scratch **`--output`**, or **`--stdout --format json`** (same **`items`** field everywhere). **`agents code-review`** persists **`findings`** in **`result.json`**; ingest copies them into triage **`items`** (typically 1:1) that you drain via fixes or explicitly sign off in notes.

## Reporting work done

Use **one repeatable shape** for status updates (PR replies, Cursor session wrap-ups, checkpoints). Prefer **facts from artifacts** over paraphrase.

1. **Gates:** **`bun run check`** — pass/fail · **`bun test`** — pass/fail (note scope if not full suite).
2. **Code-review:** Exact command/recording (replay path if replay); note whether **`--dry-run`** was used; **`runId`** from **`result.json`** (or CLI summary line); absolute path to **`result.json`**; **`findings.length`**; enumerate producer findings — at minimum each **`finding.id`** and **`finding.title`** (add **`severity`** if useful). Optionally paste or point to **`report.md`** under the same run directory.
3. **Triage:** Absolute path to **`triage-queue.json`** (and slug dir or **`--stdout`** ingest); **`items.length`**. When **`items.length > 0`**, line up **`items[].id`** + **`items[].title`** with the **`findings`** list (`items` mirror ingested findings for this producer).
4. **Disposition:** **`items.length === 0`** on the **final** pipeline, **or** for every **`item`/finding left**, state **`false_positive`**, **`accepted_risk`** (+ ADR/issue), or **`deferred`** (+ ticket) in the same report.
5. **Commits:** For each **code** remediation, **`finding.id`** (or duplicate set) → **revision/bookmark/git SHA** mapping.

Intermediate checkpoints (baseline, mid-fix) should still cite **§2–3** (**`findings.length`**, **`items.length`**, paths) even if §4–5 is “in progress.”

## What “the loop” is

1. Run an automated review (or replay) and capture artifacts.
2. Normalize what needs attention into a stable queue you can scan or diff.
3. For **each** review finding that actually needs a code or test change, implement the fix and **record it as its own commit** (never batch unrelated findings into one commit).
4. Re-run the same gates the repo expects (`typecheck`, `lint`, `test`) after each fix or before pushing.
5. Repeat until a final **code-review → triage ingest** pass yields **`items: []`** on the envelope and your gates stay green, then finalize [Reporting work done](#reporting-work-done) **§§1–5** from that pipeline.

## Prerequisites

- Shell at the repository root.
- The repository's documented build, test, lint, and review commands.
- Whatever review harness/configuration the repository already uses; do not invent adapter, model, or dry-run defaults.

## Commands you will actually use

### Repo verification gates

Run the repository's documented verification commands in the order that best matches the checkout's guidance. Typical examples include:

- typecheck / compile
- lint / formatting
- unit tests
- a combined `check` or CI-shaped verification command if the repo defines one

If the repository has a narrower, documented scope for the touched files, use that for the first pass, then run the broader gate before considering the work complete.

### Run or replay code review

Use the repository's configured review harness or review command if one exists. Follow the merged configuration and any workspace-local docs; do not invent adapter, model, or dry-run defaults. Use `--strict` for code-review runs unless the user explicitly provided a different invocation, and include `--log summary` so review runs produce concise diagnostics/observability output.

Capture the review artifact path and the resulting findings list, then ingest those findings into the repository's triage queue surface.

### Build a triage queue from review output

Ingest the review output into the triage queue format the repository expects. Use the queue's `items` field as the work surface and treat `items.length === 0` as the acceptance bar.

Never commit `.review-agent/` contents. Treat `.review-agent/` as disposable review output only; if it becomes tracked or appears in a branch diff, remove it from the tree before committing or pushing.

## One commit per actionable finding (required)

When you **change** the repo in response to a review finding (production code, tests, or harness behavior—not merely closing a false positive in your notes), treat that finding as a unit of work:

- **Exactly one commit** should contain the changes that address **one** such finding. Do not mix fixes for multiple findings in the same commit. Commits remediate **`code-review` producer findings**; the recomputed triage **`items`** list only goes empty afterward when those producer rows were fixed or explicitly documented.
- If you skip a finding (false positive, out of scope, ticket filed), **no commit** is required for it; document the reason in the PR or your notes.
- If two findings collapse to the **same** minimal fix (true duplicate), one commit is allowed; state both finding identifiers in the commit body so reviewers can see the mapping.
- Use a message that makes the mapping obvious (conventional commits as in repo `AGENTS.md` when applicable), and when rewriting or refining a fix commit message include the finding `id` or title, what is being addressed, how it is being addressed, and the full text of the finding in the body.
- Version control particulars (`jj`, `git`, bookmarks, describe flags) follow the **checkout’s** `AGENTS.md` and your usual workflow; the rule above is independent of tooling.

## A tight manual loop (checklist)

- [ ] **Baseline:** `bun run check && bun test` green on your branch; note pass/fail in your **work report §1**.
- [ ] **Review:** run `agents code-review` (or replay) with a realistic workspace **using merged config** (no skill-invented `--adapter` / `--model`); capture **`runId`**, **`result.json`** path, and full **`findings`** list (**`id`**, **`title`**, **`severity`**) → **§2**.
- [ ] **Triage:** `agents triage` into `.agents-triage/...` or a scratch **`--output`** dir; capture **`triage-queue.json`** path and **`items.length`** (**`items`** should mirror **`findings`**) → **§3**.
- [ ] **Fix:** address **`findings`** / **`items`** one at a time; **each** fix that touches the tree gets **its own commit** (see [One commit per actionable finding](#one-commit-per-actionable-finding-required)); keep each diff minimal; extend **§5** after each remediation commit.
- [ ] **Verify gates:** `bun run check && bun test` again after fixes; refresh **§1**; rerun **`agents code-review`** when edits are broad or touch harness contracts.
- [ ] **Final pipeline:** rerun **`agents code-review`** then **`agents triage --from code-review`** (add **`--result …`** when not using workspace default **`result.json`**); record fresh **§2** (**`findings`**) + **§3** (**`items`**); **`items.length === 0`** on final ingest — read **`items`** from **`.agents-triage/<slug>/triage-queue.json`**, scratch **`--output`**, or parse **`items`** from **`--stdout --format json`** the same way.
- [ ] **Closed-out report:** finalize **§4** (done or documented exits); confirm **§5** covers every code change vs **`finding.id`** (or duplicated ids in one commit body).
- [ ] **Safeguards:** [Stopping endless loops](#stopping-endless-loops-agent--human-safeguards) — round cap / no item churn / documented exits validated; if stopping early, §2–§4 still reflects residual **`findings`** / **`items`**.
- [ ] **Optional PR hygiene:** if this work is on GitHub, use your normal PR workflow (`gh pr checks`, comment threads, etc.).

## Stopping endless loops (agent + human safeguards)

Agents and humans chasing noisy LLM output can spin; cap the churn explicitly.

- **Round cap:** Bound full **review + triage ingest** pipelines per session (recommended **three**: baseline → fix pass → final squeeze **after substantive commits**). If **`items`** is still non-empty, stop and escalate to a human unless they extend budget.
- **No-churn:** Compare serialized **`items`** fingerprints across runs (**`id`**, severity, stable title hash — whatever you routinely diff). Stop if **`items`** is **unchanged** after new commits (**oscillation**).
- **Diminishing returns:** Two consecutive full pipelines (**`agents code-review` + `agents triage`**) where **`items.length`** is the same or non-decreasing **without** rationale tied to substantive new commits ⇒ stop with a concise delta for human triage outside the loop.
- **Scope freeze:** Declare the bounded change surface beforehand; forbid drive‑by refactors enlarging reviewer context.
- **Document exits:** Any remaining **`items`** require categorized human notes (false positive / accepted risk / deferred with link)—not silent loop continuation.
- **Time/token budget:** If wall‑clock exceeds a human-declared ceiling, halt with a snapshot of residual **`findings`** / **`items`** (ids + titles) and the **`result.json`** plus **`triage-queue.json`** paths — same **§2–§3** shape as [Reporting work done](#reporting-work-done).

## Suggested “done for this round”

Compose the **five-part work report** from [Reporting work done](#reporting-work-done):

- §1 Gates green — **`bun run check`** and **`bun test`** (unless your checkout deliberately scoped narrower tests—say so).
- §2 Final **`result.json`** with **`findings`** enumerated — if **`findings.length === 0`**, say so explicitly; otherwise list **`id` + title** (and note **`report.md`** path when handy).
- §3 Final **`triage-queue.json`** (or stdout ingest) — **`items.length === 0`** is the automation bar; **`items`** should match **`findings`** on fresh ingest for this producer.
- §4 **Disposition** — **`items`/findings drained by code**, or each remainder tagged **`false_positive`**, **`accepted_risk`** (ADR/issue link), **`deferred`** (ticket)—in the report text, not only in stray chat.
- §5 **Commit map** — every remediated **`finding.id`** ties to exactly one scoped commit (or one commit listing paired duplicate **`id`** values).

Artifacts (`.agents-triage/…`) are disposable after you excerpt paths and counts into the report.

## Optional Cursor skills (if you use them)

These live outside this repo; open the `SKILL.md` when you want a structured workflow instead of ad-hoc clicking.

| Situation                                                 | Skill path                                            |
| --------------------------------------------------------- | ----------------------------------------------------- |
| Keep a PR merge-ready (comments, conflicts, CI loop)      | `/home/jasona/.cursor/skills-cursor/babysit/SKILL.md` |
| Triage a red GitHub Actions check with logs → local repro | `/home/jasona/.agents/skills/ci-triage/SKILL.md`      |

## Gotchas worth remembering

- **Code-review automation:** Agents executing this loop must **not** inject their own adapter or model defaults (e.g. `fake`). Only honor merged config/env and CLI flags the user actually passed—including **never silently adding **`--dry-run`**;** use **`agents code-review --workspace …`** as instructed.
- **`agents triage` phase 1** only supports `--from code-review` in this snapshot; other producers would be future work. (Legacy: `agents triage ingest …` is accepted but unnecessary.)
- **`--stdout`** requires `--format json` or `--format toon` (dual file writes are the default when `--format` is omitted).
- **Path-based fingerprint:** the default output slug hashes the **normalized absolute path** to `result.json`, so moving the file changes the slug directory.
- **Review artifacts:** `.review-agent/` is local-only output. Never commit it; delete it before finalizing a branch if it shows up in the working tree or diff.
- **Workspace rules:** this directory is a project workspace in some setups; if you are inside a per-task checkout, also read that checkout’s `AGENTS.md` when present.
