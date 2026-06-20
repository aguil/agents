# Environment Variables

| Variable                   | Effect                                                                  |
| -------------------------- | ----------------------------------------------------------------------- |
| `AGENTSD_PUBLISH=disabled` | Force all publish modes off regardless of WORKFLOW.md                   |
| `AGENTSD_WORKSPACE`        | Host repo path for `gh` / harness context (default: cwd)                |
| `AGENTSD_LOG_FILE`         | Optional path to append stdout JSONL (file sink)                        |
| `AGENTSD_MCP_HANDLER`      | Module path exporting `mcpInvoke` (with `agentsd --with-mcp`)           |
| `AGENTSD_MCP_COMMAND`      | Shell command: JSON request on stdin, JSON response on last stdout line |
| `AGENTSD_NOTIFY_EMAIL_TO`  | When set, selection notify emits `pr_feedback_selection_email` JSONL    |
| `SLACK_WEBHOOK_URL`        | When set, selection notifications are posted to this Slack webhook      |
