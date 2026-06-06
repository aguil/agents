---
polling:
  interval_ms: 30000
workspace:
  root: ~/agentsd_workspaces
agent:
  runtime: subprocess
  max_concurrent_agents: 3
execution:
  implementation:
    mode: subprocess
    adapter: fake
feeds:
  - kind: github_issues
    repository: org/repo
    active_states:
      - open
    terminal_states:
      - closed
workers:
  github_issue: implementation
publish:
  code_review: off
  pr_feedback: off
---

You are working on {{ issue.identifier }}: {{ issue.title }}.

## Smoke checklist (`github_issues` dogfood)

1. Copy this file to `WORKFLOW.md` in a repo with `gh` auth; set `repository`
   and `workspace.root`.
2. Set `AGENTSD_WORKSPACE` to that repo; run `bun run agentsd` (or
   `bun run agentsd --with-mcp` when using MCP).
3. Confirm JSONL `agentsd_started` lists `github_issues` in `feeds`.
4. After one poll tick, confirm a workspace under `workspace.root` for the issue
   identifier with `.agents-work-item.json`.
5. With `execution.implementation.adapter: fake`, confirm one implementation
   dispatch completes without retry churn.
6. Keep `publish.*: off` until playbook gates are configured.
