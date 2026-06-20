# agentsd

> **Note:** This file is an index. Full documentation has been split by
> audience.

## User guide

| Doc                                                          | Contents                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------- |
| [guide/agentsd/README.md](guide/agentsd/README.md)           | How to run, WORKFLOW.md structure, feeds and workers             |
| [guide/agentsd/pr-feedback.md](guide/agentsd/pr-feedback.md) | Interactive PR feedback selection                                |
| [guide/agentsd/environment.md](guide/agentsd/environment.md) | `AGENTSD_*` env vars                                             |
| [guide/agentsd/production.md](guide/agentsd/production.md)   | Production profile, notifications, log sink, JSONL event catalog |

## Internal

| Doc                                                                                          | Contents                                                                  |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [agentsd/architecture.md](agentsd/architecture.md)                                           | Symphony-pattern mapping, worker lifecycle, trust posture, package layout |
| [adr/0003-agentsd-dual-runtime.md](adr/0003-agentsd-dual-runtime.md)                         | Dual-runtime decision (`HarnessOrchestrator` vs `WorkQueueOrchestrator`)  |
| [adr/0004-implementation-runtime-providers.md](adr/0004-implementation-runtime-providers.md) | Provider-agnostic `implementation` runtime                                |
