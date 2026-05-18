# Agents Repository Instructions

This repository is a Bun/TypeScript monorepo for reusable agent harnesses.

- Put shared harness infrastructure in `packages/`.
- Put specialized harness implementations in `harnesses/`.
- Keep agent execution behind adapter interfaces so OpenCode, Claude Code,
  Cursor CLI, pi.dev, and future agents can be swapped without changing harness
  logic.
- Keep orchestration behind internal contracts so a framework such as Mastra can
  be introduced later without rewriting harnesses.
- Code-review reviewer roles, triage-to-role scheduling, metadata field names,
  and review-coverage labels are defined in
  [`harnesses/code-review/src/review-contract.ts`](harnesses/code-review/src/review-contract.ts)
  and re-exported from `@aguil/agents-code-review` for the CLI and other
  consumers.
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
- Store design notes and product requirements under `docs/`.
- Store portable Agent Skills playbooks under `docs/skills/`; verify semver with
  **`agents doctor`**, install with **`agents skills install`** (see
  `agents doctor --help` / `agents skills --help`).
