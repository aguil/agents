# agentsd `github_issues` smoke run (dogfood)

Recorded checklist for [#35](https://github.com/aguil/agents/issues/35)
real-repo dogfood using
[`WORKFLOW.github-issues.dogfood.md`](WORKFLOW.github-issues.dogfood.md).

## Setup

1. Copy `docs/examples/WORKFLOW.github-issues.dogfood.md` to `WORKFLOW.md` in
   the host repo checkout.
2. Set `repository:` to an repo you can read with `gh` (example:
   `aguil/agents`).
3. Set `workspace.root` to a writable path (example: `~/agentsd_workspaces`).
4. Export `AGENTSD_WORKSPACE` to the host repo path.
5. Keep `execution.implementation.adapter: fake` for a no-network smoke run.

## Run

```bash
export AGENTSD_WORKSPACE="$PWD"
bun run agentsd
```

## Expected JSONL (one poll tick)

| Event                   | Check                                                            |
| ----------------------- | ---------------------------------------------------------------- |
| `agentsd_started`       | `feeds` includes `github_issues`                                 |
| `implementation_worker` | Dispatched once for an open issue (when feed returns candidates) |
| Workspace layout        | `workspace.root/<issue-id>/.agents-work-item.json` exists        |

## Optional file sink

Set `AGENTSD_LOG_FILE=~/agentsd.jsonl` to mirror stdout JSONL to a file (see
[#40](https://github.com/aguil/agents/issues/40)).

## Notes

- Keep `publish.*: off` until playbook gates are configured.
- MCP dogfood uses `bun run agentsd --with-mcp` with `AGENTSD_MCP_HANDLER` or
  `AGENTSD_MCP_COMMAND` (see `docs/agentsd.md`).
