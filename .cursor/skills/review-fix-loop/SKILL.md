---
name: review-fix-loop
description: >-
  Manual-testing playbook for the agents monorepo: code-review / agents triage,
  focused fixes, one commit per actionable finding, and local gates before push.
  Completion uses a repeating work-report layout (gates, result.json findings,
  triage items, disposition, commits) and empty triage items as the downstream
  consumer bar — merged-config-only code-review; no fabricated adapter overrides.
---

# Review / fix loop (manual testing playbook)

Use this playbook for exercising this repo’s agent harnesses and keeping changes honest before you push.

**Agents following this skill:** Do **not** invent or override adapter or model settings (`--adapter`, `--model`, binary paths, argv templates). Use whatever the merged CLI resolution already applies: harness defaults, then user **`~/.config/agents/code-review/config.json`**, optional copied **`review-agent.config.example.json`** → **`.review-agent/config.json`** (repo‑allowed knobs only), **`AGENTS_CODE_REVIEW_*`**, and explicit flags **only if the user supplied them**. Mirrors real operator workflow; see `harnesses/code-review/README.md` (merge order).

## Goal

Run **`bun run check`** and **`bun test`** (or tighter subsets only when the checkout’s docs permit) before you treat the repo as trusted. Run **`bun run agents code-review`** (typically **`--workspace . --dry-run`**, merged adapter/model from config) so the harness writes **`result.json`**.

Produce the downstream queue with **`bun run agents triage --from code-review --workspace .`**, pointing at **`result.json`** (**`--result …`** when you are not relying on workspace default discovery). **You are done when **`items`** in that triage envelope is empty.**

Verify in **`triage-queue.json`** under **`.agents-triage/<producerShort>-<hash12>/`**, a scratch **`--output`**, or **`--stdout --format json`** (same **`items`** field everywhere). **`agents code-review`** persists **`findings`** in **`result.json`**; ingest copies them into triage **`items`** (typically 1:1) that you drain via fixes or explicitly sign off in notes.

## Reporting work done

Use **one repeatable shape** for status updates (PR replies, Cursor session wrap-ups, checkpoints). Prefer **facts from artifacts** over paraphrase.

1. **Gates:** **`bun run check`** — pass/fail · **`bun test`** — pass/fail (note scope if not full suite).
2. **Code-review:** Exact command/recording (replay path if replay); **`runId`** from **`result.json`** (or CLI summary line); absolute path to **`result.json`**; **`findings.length`**; enumerate producer findings — at minimum each **`finding.id`** and **`finding.title`** (add **`severity`** if useful). Optionally paste or point to **`report.md`** under the same run directory.
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

- [Bun](https://bun.sh/) matching `packageManager` in root `package.json`.
- Shell at this monorepo root (the directory containing the root `package.json`).
- From the root, the CLI entrypoint is `bun run agents …` (runs `packages/cli/src/index.ts`).

## Commands you will actually use

### Help

```bash
bun run agents --help
bun run agents code-review --help
bun run agents triage --help
```

### Run or replay code review

Adapter, model, and launch flags come from merged config and env — **omit** them here unless you are reproducing a user-provided command verbatim.

Typical **dry run** (writes under `.review-agent/dry-run/`; still uses your configured adapter unless you change config):

```bash
bun run agents code-review --workspace . --dry-run
```

Replay when you already have a context bundle:

```bash
bun run agents code-review replay /path/to/context.json --workspace .
```

**Final upstream pass:** mirror the invocation you used earlier in the loop (typically **`--dry-run`**, same workspace, merged config) unless you are deliberately reproducing a user-supplied command—so regressions tie to commits, not flag drift.

Harness-focused documentation: `harnesses/code-review/README.md`.

### Build a triage queue from a stored `result.json`

After a run, the harness writes **`result.json`** under **`<workspace>/.review-agent/dry-run/…`** (dry run) or **`<workspace>/.review-agent/runs/…`**. Review **`findings`** live in that JSON. Ingest into a **source-neutral** triage envelope (JSON + TOON by default):

```bash
bun run agents triage --from code-review --workspace .
```

Optional explicit artifact:

```bash
bun run agents triage --from code-review --workspace . --result .review-agent/runs/<run-id>/result.json
```

**Work-queue surface:** Interactive workflows dequeue from the **`items`** field in **`triage-queue.json`** (or **`--stdout --format json`**). Treat **`items.length === 0`** as the acceptance bar—not **`result.json`** alone.

**Default output directory:** `<workspace>/.agents-triage/<producerShort>-<fingerprint12>/` with `triage-queue.json` and `triage-queue.toon`.

**Explicit output directory** (no extra slug segment under it):

```bash
bun run agents triage --from code-review --workspace . --output ./tmp-triage-queue --format both
```

**Stdout only** (must narrow format):

```bash
bun run agents triage --from code-review --workspace . --stdout --format json
```

### Repo gates (fix / verify)

```bash
bun run typecheck
bun run lint
bun run lint:fix    # when Biome only complains about formatting/organizeImports
bun test
bun run check       # typecheck + lint
```

CI-shaped test run (when you want closer parity to `publish:npm:verify`):

```bash
bun run test:ci
```

## One commit per actionable finding (required)

When you **change** the repo in response to a review finding (production code, tests, or harness behavior—not merely closing a false positive in your notes), treat that finding as a unit of work:

- **Exactly one commit** should contain the changes that address **one** such finding. Do not mix fixes for multiple findings in the same commit. Commits remediate **`code-review` producer findings**; the recomputed triage **`items`** list only goes empty afterward when those producer rows were fixed or explicitly documented.
- If you skip a finding (false positive, out of scope, ticket filed), **no commit** is required for it; document the reason in the PR or your notes.
- If two findings collapse to the **same** minimal fix (true duplicate), one commit is allowed; state both finding identifiers in the commit body so reviewers can see the mapping.
- Use a message that makes the mapping obvious (conventional commits as in repo `AGENTS.md` when applicable), for example scope + short fix plus the finding `id` or title in the body.
- Version control particulars (`jj`, `git`, bookmarks, describe flags) follow the **checkout’s** `AGENTS.md` and your usual workflow; the rule above is independent of tooling.

## A tight manual loop (checklist)

- [ ] **Baseline:** `bun run check && bun test` green on your branch; note pass/fail in your **work report §1**.
- [ ] **Review:** run `code-review` (or replay) with a realistic workspace **using merged config** (no skill-invented `--adapter` / `--model`); capture **`runId`**, **`result.json`** path, and full **`findings`** list (**`id`**, **`title`**, **`severity`**) → **§2**.
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

- **Code-review automation:** Agents executing this loop must **not** inject their own adapter or model defaults (e.g. `fake`). Only honor merged config/env and CLI flags the user actually passed.
- **`agents triage` phase 1** only supports `--from code-review` in this snapshot; other producers would be future work. (Legacy: `agents triage ingest …` is accepted but unnecessary.)
- **`--stdout`** requires `--format json` or `--format toon` (dual file writes are the default when `--format` is omitted).
- **Path-based fingerprint:** the default output slug hashes the **normalized absolute path** to `result.json`, so moving the file changes the slug directory.
- **Workspace rules:** this directory is a project workspace in some setups; if you are inside a per-task checkout, also read that checkout’s `AGENTS.md` when present.
