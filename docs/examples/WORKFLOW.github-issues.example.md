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
