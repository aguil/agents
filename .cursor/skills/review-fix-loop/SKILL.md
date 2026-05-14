---
name: review-fix-loop
description: >-
  Manual-testing playbook for the agents monorepo: code-review / agents triage,
  focused fixes, one commit per actionable finding, and local gates before push.
  Runs must use the operator's merged code-review config — do not substitute a
  bundled adapter or model in examples or automation.
---

# Review / fix loop (manual testing playbook)

Use this playbook for exercising this repo’s agent harnesses and keeping changes honest before you push.

**Agents following this skill:** Do **not** invent or override adapter or model settings (`--adapter`, `--model`, binary paths, argv templates). Use whatever the merged CLI resolution already applies: harness defaults, then user **`~/.config/agents/code-review/config.json`**, optional copied **`review-agent.config.example.json`** → **`.review-agent/config.json`** (repo‑allowed knobs only), **`AGENTS_CODE_REVIEW_*`**, and explicit flags **only if the user supplied them**. Mirrors real operator workflow; see `harnesses/code-review/README.md` (merge order).

## What “the loop” is

1. Run an automated review (or replay) and capture artifacts.
2. Normalize what needs attention into a stable queue you can scan or diff.
3. For **each** review finding that actually needs a code or test change, implement the fix and **record it as its own commit** (never batch unrelated findings into one commit).
4. Re-run the same gates the repo expects (`typecheck`, `lint`, `test`) after each fix or before pushing.
5. Repeat until the review surface is clean and CI would be boring.

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

Harness-focused documentation: `harnesses/code-review/README.md`.

### Build a triage queue from a stored `result.json`

After a run, the harness writes under `<workspace>/.review-agent/runs/…/result.json`. Ingest that into a **source-neutral** triage envelope (JSON + TOON by default):

```bash
bun run agents triage --from code-review --workspace .
```

Optional explicit artifact:

```bash
bun run agents triage --from code-review --workspace . --result .review-agent/runs/<run-id>/result.json
```

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

- **Exactly one commit** should contain the changes that address **one** such finding. Do not mix fixes for multiple findings in the same commit.
- If you skip a finding (false positive, out of scope, ticket filed), **no commit** is required for it; document the reason in the PR or your notes.
- If two findings collapse to the **same** minimal fix (true duplicate), one commit is allowed; state both finding identifiers in the commit body so reviewers can see the mapping.
- Use a message that makes the mapping obvious (conventional commits as in repo `AGENTS.md` when applicable), for example scope + short fix plus the finding `id` or title in the body.
- Version control particulars (`jj`, `git`, bookmarks, describe flags) follow the **checkout’s** `AGENTS.md` and your usual workflow; the rule above is independent of tooling.

## A tight manual loop (checklist)

- [ ] **Baseline:** `bun run check && bun test` green on your branch.
- [ ] **Review:** run `code-review` (or replay) with a realistic workspace **using merged config** (no skill-invented `--adapter` / `--model`); note `result.json` path.
- [ ] **Triage:** `agents triage` into `.agents-triage/...` or a scratch `--output` dir; skim `triage-queue.json` (or TOON if you prefer dense logs).
- [ ] **Fix:** address findings one at a time; **each** fix that touches the tree gets **its own commit** (see [One commit per actionable finding](#one-commit-per-actionable-finding-required)); keep each diff minimal.
- [ ] **Verify:** `bun run check && bun test` again; rerun review if the change is large or touches harness contracts.
- [ ] **Optional PR hygiene:** if this work is on GitHub, use your normal PR workflow (`gh pr checks`, comment threads, etc.).

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

## Suggested “done for this round”

- `bun run check` and `bun test` pass.
- Review artifacts either show no actionable items, or each remaining item is tracked with an explicit reason (false positive, accepted risk, follow-up issue).
- Where you implemented fixes: **each** addressed finding maps to **one** dedicated commit (or one commit explicitly listing duplicate finding ids in its body).
- If you ingested triage output, you can delete `.agents-triage/` test directories when finished; they are regenerable.
