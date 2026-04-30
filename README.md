# Agents

Reusable Bun/TypeScript harnesses for running specialized coding-agent workflows.

The repository starts with shared infrastructure boundaries and is intentionally light on implementation. Specialized harnesses, such as code review, should build on the shared packages instead of embedding process execution, context collection, reporting, or telemetry logic directly.

## Layout

```text
agents/
  docs/             Architecture notes, ADRs, and harness-specific planning.
  harnesses/        Specialized workflows built from shared packages.
  packages/         Shared contracts and runtime infrastructure.
```

## Principles

- Bun/TypeScript is the default runtime and implementation language.
- Harnesses are agent-agnostic and call execution adapters through typed contracts.
- OpenCode can be the first adapter, but it should not become the architecture.
- Native orchestration comes first; framework-backed orchestration can be added later behind the same contracts.
- Review outputs should be structured, resumable, and biased toward high-signal findings.
