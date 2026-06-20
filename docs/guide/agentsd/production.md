# Production Profile

## Recommended settings

| Setting                      | Recommendation                                                   |
| ---------------------------- | ---------------------------------------------------------------- |
| `AGENTSD_WORKSPACE`          | Host repo path for `gh` and selection state                      |
| `AGENTSD_LOG_FILE`           | Optional path to append stdout JSONL (file sink)                 |
| `publish.*`                  | Keep **`off`** until playbook gates are configured               |
| `policy.pr_feedback.profile` | `interactive` for operator-approved PRs                          |
| `feeds[].max_concurrent`     | Cap per work-item kind (`github_issue`, `github_pr_feedback`, …) |

## Notification channels

| Channel           | How to enable                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| System desktop    | `notify-send` (Linux) or `terminal-notifier` (macOS) — auto-detected                               |
| Slack             | `SLACK_WEBHOOK_URL` + `slack_webhook` channel in WORKFLOW.md                                       |
| Email             | `AGENTSD_NOTIFY_EMAIL_TO` — emits `pr_feedback_selection_email` JSONL                              |
| Webhook           | `policy.pr_feedback.notify.webhook` in WORKFLOW.md                                                 |
| Monitor workspace | `policy.pr_feedback.notify.monitor` — writes `monitor-context.json` for a control-repo IDE session |

## JSONL event catalog

Structured logs are one JSON object per line on stdout.

| Event                            | When                                                   |
| -------------------------------- | ------------------------------------------------------ |
| `agentsd_started`                | Process boot                                           |
| `workflow_reloaded`              | `WORKFLOW.md` changed on disk (`changed_fields` array) |
| `agentsd_stopping`               | SIGINT/SIGTERM drain started                           |
| `pr_feedback_selection_required` | Interactive selection pending                          |
| `pr_feedback_selection_email`    | Email channel configured (`AGENTSD_NOTIFY_EMAIL_TO`)   |
| `pr_feedback_work_report`        | Structured playbook work report written                |
| `pr_feedback_collected`          | `pr_feedback` worker finished a pass                   |
| `code_review_artifacts_ready`    | `publish.code_review: notify` — artifact paths only    |
| `publish_decision`               | Publish gate evaluated (workers)                       |
| `implementation_stalled`         | Stall timeout fired                                    |

The full event catalog including harness-emitted events is in
[harnesses/code-review/spec/events-catalog.md](../../harnesses/code-review/spec/events-catalog.md).

## Smoke tests

```bash
bun test tests/agentsd-followup.test.ts
bun test tests/agentsd-publish-integration.test.ts
bun test tests/agentsd-reload-shutdown.test.ts
bun test tests/pr-feedback-playbook.test.ts
bun test tests/agentsd-code-review-parity.test.ts
```

Example issue feed:
[WORKFLOW.github-issues.dogfood.md](../../examples/WORKFLOW.github-issues.dogfood.md)

Smoke log:
[agentsd-github-issues-smoke.md](../../examples/agentsd-github-issues-smoke.md)

Notify receiver example:
[notify-receiver/README.md](../../examples/notify-receiver/README.md)
