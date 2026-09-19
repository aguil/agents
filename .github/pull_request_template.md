## Summary

<!-- What changed and why. -->

## Checklist

- [ ] Commit headers follow Conventional Commits
      ([`.agents/rules/conventional-commits.md`](https://github.com/aguil/agents/blob/main/.agents/rules/conventional-commits.md)).
- [ ] Breaking changes use `type(scope)!:` (never `type!(scope):`) and include a
      `BREAKING CHANGE:` footer in the commit body.
- [ ] Every commit in this PR has a valid header. This repo merges with merge
      commits, not squash — not only the PR title.
- [ ] The PR title is plain language, not a conventional header. A conventional
      title lists the change twice in the release notes
      ([PR titles](https://github.com/aguil/agents/blob/main/.agents/rules/conventional-commits.md#pr-titles)).
- [ ] **`bun run lint`**, **`bun run typecheck`**, and
      **`mise exec --locked -- pre-commit run --all-files`** all pass.
