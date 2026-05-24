# agentsd selection notify receiver (example)

Minimal HTTP receiver for `policy.pr_feedback.notify.webhook_url`. POSTs from
`agentsd` use the `pr_feedback_selection_required` payload shape.

Run locally:

```bash
bun run docs/examples/notify-receiver/server.ts
```

Point `WORKFLOW.md` at `http://127.0.0.1:18765/selection` and approve PRs with:

```bash
agents pr-feedback select --selection-id <id> --approve owner/repo#n
```
