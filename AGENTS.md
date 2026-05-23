# Agents Repository Instructions

This repository is a Bun/TypeScript monorepo for reusable agent harnesses.

- Put shared harness infrastructure in `packages/`.
- Put specialized harness implementations in `harnesses/`.
- Keep agent execution behind adapter interfaces so OpenCode, Claude Code,
  Cursor CLI, pi.dev, and future agents can be swapped without changing harness
  logic.
- Keep harness orchestration behind `HarnessOrchestrator`; poll-based scheduling
  for `agentsd` uses `WorkQueueOrchestrator` (ADR 0003). Mastra remains
  optional.
- Code-review reviewer roles, triage-to-role scheduling, metadata field names,
  and review-coverage labels are defined in
  [`harnesses/code-review/src/review-contract.ts`](harnesses/code-review/src/review-contract.ts)
  and re-exported from `@aguil/agents-code-review` for the CLI and other
  consumers.
- Human **PR review assignment** workflows (GitHub first) live in
  [`packages/code-review-inbox`](packages/code-review-inbox) and are exposed as
  **`agents code-review inbox`** (separate from harness runs and
  `agents triage`). **`inbox list`** (and **`list --include-team`**) are
  reviewer assignments; **`inbox list-mine`** lists open PRs you **authored**
  for the [`pr-feedback-response`](docs/skills/pr-feedback-response/SKILL.md)
  playbook only.
- Prefer deterministic code for lifecycle, logging, scratchpads, validation
  gates, and reporting; reserve LLM calls for review reasoning.
- Conventional commits: use `!` after the scope in the title when the change is
  breaking (for example `feat(cli)!:`), and spell out specifics in the body or a
  `BREAKING CHANGE:` footer when useful.
- Before any commit: **`bun run lint`**, **`bun run typecheck`**, and
  **`pre-commit run --all-files`** must all pass; fix failures first. Canonical
  wording:
  [`.agents/rules/pre-commit-checks.md`](.agents/rules/pre-commit-checks.md).
  Cursor loads **`AGENTS.md`** (and optionally `.cursor/rules/*.mdc`); it does
  not auto-discover `.agents/`—keep the one-line requirement here so IDE agents
  still see it.
- With **Jujutsu**, keep **`git.sign-on-push = true`** in jj config and use
  **`jj sign`** on any still-unsigned revisions before **`jj git push`** so
  published commits stay signed (details in the same `.agents` doc).
- Store design notes and product requirements under `docs/`. Maintainer release
  steps: [`docs/release-checklist.md`](docs/release-checklist.md).
- Store portable Agent Skills playbooks under `docs/skills/`; verify semver with
  **`agents doctor`**, install with **`agents skills install`** (see
  `agents doctor --help` / `agents skills --help`).
