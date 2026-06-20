# agents pr-feedback

Manage PR review thread feedback: collect unresolved threads, respond to them,
and optionally post replies back to GitHub.

## Subcommands

### `collect` — export unresolved review threads

Fetches all unresolved inline review threads on a pull request and writes a
`feedback.json` (scope A document) to disk.

```bash
agents pr-feedback collect --pr <n> --repo <owner/name>
```

**Options:**

| Option                | Description                                                   |
| --------------------- | ------------------------------------------------------------- |
| `--pr <n>`            | Pull request number (required)                                |
| `--repo <owner/name>` | Repository (default: `gh repo view` in `--workspace`)         |
| `--workspace <path>`  | Workspace for `gh` (default: cwd)                             |
| `--repos-root <path>` | Clone root when resolving `--repo` (default: `~/dev/repos`)   |
| `--output <dir>`      | Output directory (default: `.agents-pr-feedback/<repo>-<n>/`) |

Output files:

```
.agents-pr-feedback/<owner>-<repo>-<n>/
  feedback.json        PrFeedbackDocumentV1 — unresolved thread list
```

Collected feedback files are mode `0600` and the containing directory is `0700`.
`.agents-pr-feedback/` is gitignored.

---

### `submit` — post approved replies to GitHub

Reads an operator-authored `pr-feedback-responses/v1` JSON document and posts
the thread replies to GitHub. This is a write operation — review the draft
before running.

```bash
agents pr-feedback submit --draft <path>
```

**Options:**

| Option                | Description                                                                  |
| --------------------- | ---------------------------------------------------------------------------- |
| `--draft <path>`      | `pr-feedback-responses/v1` JSON document (required)                          |
| `--feedback <path>`   | `feedback.json` from `collect` (default: sibling of `--draft` or `--output`) |
| `--pr <n>`            | Validate that the draft's PR number matches                                  |
| `--repo <owner/name>` | Validate that the draft's repository matches                                 |
| `--dry-run`           | Print replies to stdout without posting to GitHub                            |
| `--workspace <path>`  | Workspace for `gh` (default: cwd)                                            |

---

### `select` — approve or dismiss PRs for agentsd

Interactive selection of PRs queued for `agentsd` pr-feedback processing. Only
operator-approved PRs are dispatched for the fix worker.

```bash
agents pr-feedback select [--approve <id>] [--dismiss <id>] [--revoke <id>] [--list]
```

**Options:**

| Option                | Description                                            |
| --------------------- | ------------------------------------------------------ |
| `--list`              | Print current selection state                          |
| `--approve <id>`      | Mark a PR selection as approved                        |
| `--dismiss <id>`      | Dismiss a PR from the selection queue                  |
| `--revoke <id>`       | Revoke a previous approval                             |
| `--selection-id <id>` | Target a specific selection document (default: active) |
| `--workspace <path>`  | Workspace path (default: cwd)                          |

## Typical workflow

The
[pr-feedback-response skill](../../docs/skills/pr-feedback-response/SKILL.md)
describes the full operator playbook. The high-level steps:

```bash
# 1. Collect threads from your PR
agents pr-feedback collect --pr 42 --repo org/repo

# 2. Run triage on collected feedback
agents triage --from pr-feedback \
  --result .agents-pr-feedback/org-repo-42/feedback.json

# 3. Review, write, and approve a responses draft

# 4. Post approved replies
agents pr-feedback submit --draft ./responses.json \
  --feedback .agents-pr-feedback/org-repo-42/feedback.json
```

## Related

- [triage.md](triage.md) — `agents triage --from pr-feedback`
- [agentsd/pr-feedback.md](agentsd/pr-feedback.md) — automated pr-feedback via
  `agentsd`
- [skills/pr-feedback-response](../../docs/skills/pr-feedback-response/SKILL.md)
  — full operator playbook
