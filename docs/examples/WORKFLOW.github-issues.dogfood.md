---
polling:
  interval_ms: 30000
workspace:
  root: ~/agentsd_workspaces
agent:
  runtime: subprocess
  max_concurrent_agents: 2
execution:
  implementation:
    mode: subprocess
    adapter: fake
feeds:
  - kind: github_issues
    repository: aguil/agents
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

Copy this file to `WORKFLOW.md` in the host repo (`aguil/agents` or your target
repo), set `AGENTSD_WORKSPACE` to that checkout, and run `bun run agentsd`.

See [agentsd-github-issues-smoke.md](agentsd-github-issues-smoke.md) for a
recorded smoke run checklist and expected JSONL events.
