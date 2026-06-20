# JSONL Event Catalog

All structured log output is one JSON object per line on stdout. This catalog
covers events emitted by the code-review harness and by `agentsd`.

## Harness events (`agents code-review`)

| Event type       | When                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `role_started`   | Role adapter invocation begins                                                              |
| `role_completed` | Role adapter invocation finished successfully                                               |
| `role_timed_out` | Role exceeded its configured timeout                                                        |
| `role_failed`    | Role adapter exited with an error                                                           |
| `tool`           | Periodic role heartbeat: elapsed time and byte counts (for diagnosing long-running reviews) |
| `finding`        | A normalized finding emitted by a role                                                      |
| `run_completed`  | Harness finished all roles and wrote `result.json`                                          |

Heartbeat `tool` events are emitted periodically while a role is still running
so long reviews can be diagnosed without waiting for completion.

## agentsd events

| Event                            | When                                                   |
| -------------------------------- | ------------------------------------------------------ |
| `agentsd_started`                | Process boot                                           |
| `workflow_reloaded`              | `WORKFLOW.md` changed on disk (`changed_fields` array) |
| `agentsd_stopping`               | SIGINT/SIGTERM drain started                           |
| `pr_feedback_selection_required` | Interactive PR feedback selection pending              |
| `pr_feedback_selection_email`    | Email channel configured (`AGENTSD_NOTIFY_EMAIL_TO`)   |
| `pr_feedback_work_report`        | Structured playbook work report written                |
| `pr_feedback_collected`          | `pr_feedback` worker finished a pass                   |
| `code_review_artifacts_ready`    | `publish.code_review: notify` — artifact paths only    |
| `publish_decision`               | Publish gate evaluated (workers)                       |
| `implementation_stalled`         | Implementation worker stall timeout fired              |

## Log sink

Set `AGENTSD_LOG_FILE` to append all stdout JSONL to a file in addition to
terminal output. The harness does not rotate or truncate this file.
