# Agents Repository Instructions

This repository is a Bun/TypeScript monorepo for reusable agent harnesses.

- Put shared harness infrastructure in `packages/`.
- Put specialized harness implementations in `harnesses/`.
- Keep agent execution behind adapter interfaces so OpenCode, Claude Code, Cursor CLI, pi.dev, and future agents can be swapped without changing harness logic.
- Keep orchestration behind internal contracts so a framework such as Mastra can be introduced later without rewriting harnesses.
- Prefer deterministic code for lifecycle, logging, scratchpads, validation gates, and reporting; reserve LLM calls for review reasoning.
- Store design notes and product requirements under `docs/`.
