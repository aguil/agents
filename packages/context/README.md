# Context

Context collection for diffs, repository conventions, documentation, and
declarative knowledge notes.

## Builtin providers

Resolved by `resolveContextProvider(use, params)` (ADR 0010). Unknown names,
unknown params, and wrong types throw at resolution.

| `use`                | Role                                                                       |
| -------------------- | -------------------------------------------------------------------------- |
| `git-diff`           | Repository diff for the run                                                |
| `pr-metadata`        | Pull request metadata via `gh`                                             |
| `pr-referenced-docs` | Docs linked from the PR body                                               |
| `agents-md`          | Workspace `AGENTS.md`                                                      |
| `static-file`        | One workspace-relative file                                                |
| `shell-command`      | Captured command stdout                                                    |
| `file-glob`          | Globbed workspace files                                                    |
| `knowledge`          | Auto-inject notes with `context: auto` from `.agents/knowledge` (ADR 0022) |
| `knowledge-search`   | Tag search over the same store (`tags`, `limit`, `provenance`)             |

### Knowledge providers (ADR 0022)

Notes are Markdown under `.agents/knowledge/**/*.md` (flat or per-id
directories). Frontmatter fields the reader uses: `id` (required), `context`
(`auto` \| `search-only`, default `search-only`), `tags`, `title`, `updatedAt`.
Unknown fields are tolerated.

`knowledge` params: `path`, `max_notes` (default 10), `max_bytes` (default
50000, aggregate). Overflow is deterministic (`updatedAt` desc, `id` asc) and
recorded in the bundle; it does not fail the run.

`knowledge-search` params: `tags` (AND, case-insensitive), `limit` (default 5),
`provenance` (`any` \| `machine` \| `human`), `machine_id_prefix` (default
`harness:`), `path`, `max_bytes`.
