# User Guide

Practical documentation for running and configuring `agents` workflows.

## Installation

- [install.md](install.md) — local build, npm install, running from another
  checkout

## Code review (`agents code-review`)

| Doc                                                              | Contents                                      |
| ---------------------------------------------------------------- | --------------------------------------------- |
| [code-review/README.md](code-review/README.md)                   | Quick start and adapter selection             |
| [code-review/adapters.md](code-review/adapters.md)               | Adapter examples and model IDs                |
| [code-review/configuration.md](code-review/configuration.md)     | Config files, merge order, presets            |
| [code-review/environment.md](code-review/environment.md)         | `AGENTS_CODE_REVIEW_*` env vars               |
| [code-review/workflows.md](code-review/workflows.md)             | HITL, pending review, post, replay, consensus |
| [code-review/troubleshooting.md](code-review/troubleshooting.md) | Debugging failures, known limitations         |

## `agentsd` daemon

| Doc                                              | Contents                                             |
| ------------------------------------------------ | ---------------------------------------------------- |
| [agentsd/README.md](agentsd/README.md)           | How to run, WORKFLOW.md structure, feeds and workers |
| [agentsd/pr-feedback.md](agentsd/pr-feedback.md) | Interactive PR feedback selection                    |
| [agentsd/environment.md](agentsd/environment.md) | `AGENTSD_*` env vars                                 |
| [agentsd/production.md](agentsd/production.md)   | Production profile, notifications, log sink          |

## Agent playbooks (skills)

Portable skill playbooks for `agents code-review`, `agents triage`, and related
workflows live under [`../skills/`](../skills/README.md). Install with
`agents skills install`.
