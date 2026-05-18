# Checks before committing

Provider-agnostic policy for this repository. Any automated or human contributor
should follow this before creating a VCS commit.

Before committing (including amend when your workflow allows it):

1. Run **`bun run lint`** — must pass.
2. Run **`bun run typecheck`** — must pass.
3. Run **`pre-commit run --all-files`** when `.pre-commit-config.yaml` is
   present — must pass.

Fix any failures first; do not commit with failing checks. If a check is
unavailable in the environment, say so explicitly instead of skipping silently.
