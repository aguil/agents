# Environment Variables

All `AGENTS_CODE_REVIEW_*` variables map directly to CLI flags unless noted.
Boolean variables accept `true` / `false` / `1` / `0` / `yes` / `no`.

| Variable                                    | Maps to                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `AGENTS_CODE_REVIEW_CONFIG_STRICT`          | When `true`/`1`/`yes`/`on`, unknown JSON keys in config files are errors (default: warn only)    |
| `AGENTS_CODE_REVIEW_WORKSPACE`              | `--workspace`                                                                                    |
| `AGENTS_CODE_REVIEW_REPOS_ROOT`             | `--repos-root` (clone lookup root for bare `owner/repo` workspaces)                              |
| `AGENTS_CODE_REVIEW_SCRATCHPAD`             | `--scratchpad`                                                                                   |
| `AGENTS_CODE_REVIEW_CONTEXT_BUNDLE`         | `--context-bundle`                                                                               |
| `AGENTS_CODE_REVIEW_RESULT`                 | `--result`                                                                                       |
| `AGENTS_CODE_REVIEW_CONSENSUS`              | `--consensus`                                                                                    |
| `AGENTS_CODE_REVIEW_ADAPTER`                | `--adapter`                                                                                      |
| `AGENTS_CODE_REVIEW_MODEL`                  | `--model`                                                                                        |
| `AGENTS_CODE_REVIEW_VARIANT`                | `--variant`                                                                                      |
| `AGENTS_CODE_REVIEW_AGENT`                  | `--agent`                                                                                        |
| `AGENTS_CODE_REVIEW_OPENCODE`               | `--opencode`                                                                                     |
| `AGENTS_CODE_REVIEW_CLAUDE`                 | `--claude`                                                                                       |
| `AGENTS_CODE_REVIEW_CLAUDE_ARGS`            | `--claude-args`                                                                                  |
| `AGENTS_CODE_REVIEW_CURSOR`                 | `--cursor`                                                                                       |
| `AGENTS_CODE_REVIEW_CURSOR_ARGS`            | `--cursor-args`                                                                                  |
| `AGENTS_CODE_REVIEW_CURSOR_MODE`            | `--cursor-mode`                                                                                  |
| `AGENTS_CODE_REVIEW_LOG`                    | `--log`                                                                                          |
| `AGENTS_CODE_REVIEW_PR`                     | `--pr`                                                                                           |
| `AGENTS_CODE_REVIEW_POST_PR`                | `--post-pr`                                                                                      |
| `AGENTS_CODE_REVIEW_REVIEW_SUMMARY`         | `--review-summary`                                                                               |
| `AGENTS_CODE_REVIEW_DRY_RUN`                | `--dry-run`                                                                                      |
| `AGENTS_CODE_REVIEW_POST_ONLY`              | Enables post-only mode on the default `code-review` command (omit when using `code-review post`) |
| `AGENTS_CODE_REVIEW_NO_CONFIRM`             | `--no-confirm`                                                                                   |
| `AGENTS_CODE_REVIEW_REPLACE_PENDING_REVIEW` | `--replace-pending-review`                                                                       |
| `AGENTS_CODE_REVIEW_NO_DETERMINISTIC`       | `--no-deterministic`                                                                             |
| `AGENTS_CODE_REVIEW_STRICT`                 | `--strict`                                                                                       |
| `AGENTS_CODE_REVIEW_PENDING_REVIEW`         | `--pending-review`                                                                               |
| `AGENTS_CODE_REVIEW_PURE`                   | `--pure`                                                                                         |
| `AGENTS_CODE_REVIEW_PRINT_LOGS`             | `--print-logs`                                                                                   |
