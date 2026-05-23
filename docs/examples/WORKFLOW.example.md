---
polling:
  interval_ms: 30000
workspace:
  root: ~/agentsd_workspaces
agent:
  runtime: subprocess
  max_concurrent_agents: 5
  max_turns: 20
  max_retry_backoff_ms: 300000
execution:
  implementation:
    mode: subprocess
    adapter: fake
hooks:
  timeout_ms: 60000
feeds:
  - kind: github_issues
    repository: org/repo
    active_states:
      - open
    terminal_states:
      - closed
  - kind: github_pr_review
    include_team: true
    max_open: 5
  - kind: github_pr_feedback
workers:
  github_issue: implementation
  github_pr_review: code_review
  github_pr_feedback: pr_feedback
publish:
  code_review: off
  pr_feedback: off
---

You are working on {{ issue.identifier }}: {{ issue.title }}.

State: {{ issue.state }}
