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

## Signing (Jujutsu / colocated git)

Commits that reach GitHub **must** be cryptographically signed (this repo uses
Jujutsu with SSH signing via 1Password / `op-ssh-sign`).

1. In jj user or workspace config, set **`git.sign-on-push = true`** so
   **`jj git push`** signs exported git commits before they leave your machine
   (requires `[signing]` / `signing.backend` already configured).
2. If any revision in the stack is still unsigned before a push, run
   **`jj sign -r 'main..<bookmark>'`** (adjust the revset to the commits you are
   about to publish), then push.

Do not push a bookmark whose tip you know is unsigned when signing is expected.
