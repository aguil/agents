# PRD: Autonomous Code Review Harness

This harness reduces code-review wait time by running a specialized,
deterministic, multi-agent review workflow. It biases toward approval,
suppresses nitpicks, and reports only critical or warning findings with concrete
evidence and validation.

## Core requirements

| Requirement                                                                           | Status                                     |
| ------------------------------------------------------------------------------------- | ------------------------------------------ |
| Risk-tier PRs into trivial, lite, and full review modes                               | Shipped                                    |
| Fetch context beyond the diff (AGENTS.md, docs, dependency maps, MCP sources)         | Partial — AGENTS.md and docs; MCP deferred |
| Require validation evidence before findings are included in the final report          | Shipped                                    |
| Track durable scratchpad artifacts so interrupted runs can be resumed                 | Shipped                                    |
| Use generic CLI tooling and agent-agnostic adapters (not bespoke per-agent protocols) | Shipped                                    |

## Success criteria

| Criterion                                                                                              | Status                                                        |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Run a local review in under five minutes for normal PR-sized diffs                                     | Met                                                           |
| Produce a single Markdown report from normalized findings                                              | Met                                                           |
| Keep unverified findings out of the final actionable report                                            | Met                                                           |
| Make OpenCode, Claude Code, Cursor CLI, pi.dev, and future agents swappable through execution adapters | Met — `opencode`, `claude`, `cursor`, `fake` adapters shipped |
| Keep real agent execution opt-in; deterministic local tests use the fake adapter                       | Met                                                           |

## Scope boundaries

**In scope:**

- Multi-role parallel review (security, performance, quality, compliance)
- Risk-based triage selecting which roles run
- Agent-agnostic adapter contract (subprocess and app-server runtimes)
- Structured JSONL event log, `result.json` schema, `report.md` synthesis
- GitHub PR context ingestion (title, body, diff, referenced docs)
- Pending-review posting to GitHub (human-triggered)
- Consensus mode (multi-pass intersection filtering)
- Replay mode (stable context bundle for reproducibility)

**Explicitly out of scope:**

- Automatic PR merge blocking
- Bespoke per-provider protocols (adapters normalize to the same contract)
- CrewAI or other external orchestration frameworks (native Bun orchestration
  owns role fan-out)
- Linear or non-GitHub issue tracker integrations at the harness layer

## Related

- [architecture.md](architecture.md) — implementation design
- [spec/review-contract.md](spec/review-contract.md) — roles, tiers, wire keys
- [spec/result-schema.md](spec/result-schema.md) — `result.json` field spec
- [ADR 0003](../../adr/0003-agentsd-dual-runtime.md) — dual-runtime decision
