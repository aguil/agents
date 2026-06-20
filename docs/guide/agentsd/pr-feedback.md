# Interactive PR Feedback Selection

`agentsd` discovers authored PRs with unresolved threads and requires operator
approval before running fix workers on them.

## Default flow (`profile: interactive`)

1. `agentsd` discovers authored PRs with unresolved threads (and new review
   activity when thread fingerprints change vs
   `.agentsd/pr-feedback-ingest.json`) and writes
   `.agentsd/pr-feedback-selection.json` under `AGENTSD_WORKSPACE`.
2. Emits JSONL event `pr_feedback_selection_required` plus an optional system
   notification (`notify-send` / `terminal-notifier`), webhook, Slack
   (`SLACK_WEBHOOK_URL`), or email (`AGENTSD_NOTIFY_EMAIL_TO`).
3. Optional monitor workspace: `policy.pr_feedback.notify.monitor` writes
   `monitor-context.json` for a control-repo IDE session.
4. Operator approves PRs:
   ```bash
   agents pr-feedback select --selection-id <id> --approve owner/repo#n
   ```
5. Only approved PRs run the `pr_feedback` worker (collect → triage → fix).
   Multi-round drain re-dispatches while triage items or unresolved threads
   remain; the work item closes when both are empty or submit completes.

## Unattended mode (`profile: unattended`)

Requires an explicit `policy.pr_feedback.allow` list. Use
`policy.pr_feedback.deny` to block specific `owner/repo#number` values in any
profile; deny wins over allow/approval.

## Work reports

Each `pr_feedback` worker pass writes a structured work report under
`.agentsd/pr-feedback-work-reports/` and emits JSONL `pr_feedback_work_report`
(disposition, triage/feedback paths, `item.id` → commit map).
