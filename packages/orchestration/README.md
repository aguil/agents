# Orchestration

Harness orchestration contracts and native Bun orchestration utilities.

- `HarnessOrchestrator` — fan-out roles for a single harness run
  (`NativeBunOrchestrator`).
- `Orchestrator` — deprecated alias for `HarnessOrchestrator`.

Poll-based scheduling for `agentsd` lives in `@aguil/agents-work-queue`
(`WorkQueueOrchestrator`). See ADR 0003.
