# Configuration

## Merge order

Later sources win:

1. **Harness packaged defaults** (currently `adapter: fake` from
   `@aguil/agents-code-review`)
2. **User config file** (see path below)
3. **Repo config file** (`.agents-code-review/config.json` in workspace)
4. **`--preset <name>`** entry (when passed)
5. **`AGENTS_CODE_REVIEW_*` environment variables**
6. **Explicit CLI flags**

## Config file locations

**User file** (controls adapter paths and subprocess argv):

```
$XDG_CONFIG_HOME/agents/code-review/config.json
# or if XDG_CONFIG_HOME is unset:
~/.config/agents/code-review/config.json
```

**Repo file** (model, presets, boolean flags; no adapter paths):

```
<workspace>/.agents-code-review/config.json
```

> **Breaking change:** older releases read `.review-agent/config.json`. Current
> releases use `.agents-code-review/config.json`.

## Repo JSON restrictions

Repo-managed JSON **cannot steer where or how reviewers run**. The following
keys are stripped with a `console.warn` when present in the repo file:
`workspace`, `reposRoot`, `scratchpad`, `adapter`, `impl` (execution-path
selection), adapter host-binary paths (`cursor`, `claude`, `opencode`), and argv
templates (`cursorArgs`, `claudeArgs`) — including inside `presets`. Set these
only via the user config file, `AGENTS_CODE_REVIEW_*` env vars, or CLI flags.

Set `AGENTS_CODE_REVIEW_CONFIG_STRICT=true` to make unknown keys a fatal error
instead of a warning.

## Config key vocabulary

All keys use **camelCase**. Omit any key you don't need.

**Strings** (user config / env / CLI only for the first group):

| Key             | CLI flag           | Notes                                    |
| --------------- | ------------------ | ---------------------------------------- |
| `workspace`     | `--workspace`      | User/CLI only                            |
| `reposRoot`     | `--repos-root`     | Clone lookup root; user/CLI only         |
| `scratchpad`    | `--scratchpad`     | User/CLI only                            |
| `adapter`       | `--adapter`        | User/CLI only                            |
| `opencode`      | `--opencode`       | OpenCode binary path; user/CLI only      |
| `claude`        | `--claude`         | Claude binary path; user/CLI only        |
| `claudeArgs`    | `--claude-args`    | Comma-split or JSON array; user/CLI only |
| `cursor`        | `--cursor`         | Cursor binary path; user/CLI only        |
| `cursorArgs`    | `--cursor-args`    | Comma-split or JSON array; user/CLI only |
| `cursorMode`    | `--cursor-mode`    | User/CLI only                            |
| `contextBundle` | `--context-bundle` |                                          |
| `result`        | `--result`         |                                          |
| `consensus`     | `--consensus`      |                                          |
| `model`         | `--model`          |                                          |
| `variant`       | `--variant`        |                                          |
| `agent`         | `--agent`          |                                          |
| `log`           | `--log`            | `none` / `summary` / `commands` / `all`  |
| `pr`            | `--pr`             |                                          |
| `postPr`        | `--post-pr`        |                                          |
| `reviewSummary` | `--review-summary` | `triage` / `impact` / `evidence`         |
| `agentsDir`     | `--agents-dir`     | `--impl config` override; env/CLI only   |
| `impl`          | `--impl`           | `package` / `config`; user/CLI only      |

**Booleans:**

| Key                    | CLI flag                             |
| ---------------------- | ------------------------------------ |
| `dryRun`               | `--dry-run`                          |
| `postOnly`             | (see `AGENTS_CODE_REVIEW_POST_ONLY`) |
| `noConfirm`            | `--no-confirm`                       |
| `replacePendingReview` | `--replace-pending-review`           |
| `noDeterministic`      | `--no-deterministic`                 |
| `strict`               | `--strict`                           |
| `pendingReview`        | `--pending-review`                   |
| `pure`                 | `--pure`                             |
| `printLogs`            | `--print-logs`                       |

**`presets`:** object mapping preset names to partial option objects (no nested
`presets` key). Repo preset entries overlay user preset entries for the same
name.

Unknown keys are skipped with a warning. Set
`AGENTS_CODE_REVIEW_CONFIG_STRICT=true` to treat unknown keys as a fatal error.

## `--claude-args` / `--cursor-args` format

Both accept a comma-split string or a JSON array of strings. When the template
starts with tokens that look like bundled CLI flags (`--strict`, `--dry-run`,
etc.), use the `=` binding form to keep the template in one argv cell:

```bash
--cursor-args="--strict,--trust,--print"
--claude-args="--verbose,--model,claude-sonnet-4"
```

## Example repo config

```json
{
  "model": "opencode/gpt-5.3-codex",
  "presets": {
    "ci": {
      "dryRun": true,
      "log": "commands"
    }
  }
}
```

```bash
bun run agents code-review --preset ci
```

## Logging (`--log`)

| Value            | Output                                                         |
| ---------------- | -------------------------------------------------------------- |
| `none` (default) | Minimal status                                                 |
| `summary`        | Adapter progress, expanded review summary and finding previews |
| `commands`       | Adapter subprocess commands before and after execution         |
| `all`            | Summary and commands combined                                  |

```bash
bun run agents code-review --adapter fake --dry-run --log summary
```

## Config-declared harness (`--impl config`)

`agents code-review --impl config` runs the declarative `harness.yaml`-backed
implementation instead of the packaged TypeScript implementation. The config
runner resolves the code-review harness definition in this order:

1. `<workspace>/.agents/harnesses/code-review/`
2. `~/.agents/harnesses/code-review/`
3. the `.agents/` tree shipped inside the installed `@aguil/agents` package

The selected layer is recorded in `result.json` metadata as
`config_harness_source` and printed in summary logs:

```bash
agents code-review --impl config --adapter fake --dry-run --log summary
# Config harness source: package (.../.agents)
```

Install the packaged harness into your user-global `.agents` tree when you want
one copy to customize or audit across repositories:

```bash
agents harness install code-review
agents code-review --impl config --workspace /path/to/repo
```

The install command writes `~/.agents/harnesses/code-review/`, the
`code-review-readonly` policy, and a package-version marker. Later config runs
report version drift between that global install and the running CLI package.

For a one-off run, bypass layered lookup with an explicit `.agents` directory:

```bash
agents code-review --impl config \
  --agents-dir /path/to/.agents \
  --workspace /path/to/repo
```

The matching environment variable is `AGENTS_CODE_REVIEW_AGENTS_DIR`. Like
`impl`, `agentsDir` is intentionally ignored from repo JSON so a checkout cannot
redirect the harness definition used to review itself.
