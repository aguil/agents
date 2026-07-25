# Conventional commit headers

Provider-agnostic policy for this repository. Any automated or human contributor
should follow this for every commit that lands on `main`.

## Header grammar

```
type(scope)!: subject
```

- **`type`** — one of the recognized commit types (see below).
- **`(scope)`** — optional scope in parentheses.
- **`!`** — when the change is breaking, place `!` immediately before `:`, never
  after `type` and before `(scope)`.
- **`: subject`** — short imperative summary.

Valid without scope: `type!: subject` (for example `feat!: drop legacy API`).

## Valid vs invalid breaking headers

| Valid                             | Invalid                           |
| --------------------------------- | --------------------------------- |
| `feat(cli)!: subject`             | `feat!(cli): subject`             |
| `refactor(code-review)!: subject` | `refactor!(code-review): subject` |

The rule: **`type(scope)!:`** — the bang goes after the closing `)` and before
the `:`.

## Why it matters

release-please uses `@conventional-commits/parser`. An invalid breaking header
causes a parse error; release-please then **drops that commit entirely** from
versioning and the changelog — even when the commit body contains a
`BREAKING CHANGE:` footer.

This happened in practice: [PR #117](https://github.com/aguil/agents/pull/117)
used the invalid form, so release-please opened a patch release (0.4.12) instead
of the minor (0.5.0) it should have been;
[PR #118](https://github.com/aguil/agents/pull/118) corrected the release PR
manually.

## Recognized types

[`release-please-config.json`](../../release-please-config.json)
`changelog-sections` is the source of truth. Types that appear in the changelog:

- **feat** (Added)
- **fix** (Fixed)
- **perf** (Performance)
- **refactor** (Changed)
- **revert** (Reverted)

Hidden from the changelog but valid: **docs**, **chore**, **test**, **ci**.

## Version impact while pre-1.0

With `bump-minor-pre-major` and `bump-patch-for-minor-pre-major` in
[`release-please-config.json`](../../release-please-config.json):

- **Breaking change** (`!` in header) → **minor** bump (for example `0.4.x` →
  `0.5.0`).
- **`feat:`** → **patch** bump.
- **`fix:`** / **`perf:`** → **patch** bump.

## `BREAKING CHANGE:` footer

Use a `BREAKING CHANGE:` footer in the body to describe the break for the
changelog. It cannot rescue a commit whose header fails to parse.

The Conventional Commits spec treats the footer as a breaking indicator in its
own right, so a footer without `!` is well-formed and release-please versions it
correctly. This repository requires the `!` anyway: the header is what reviewers
and `git log` show. Write both.

## What CI enforces

The `commit-headers` job rejects headers that fail to parse — the `#117` failure
mode. It cannot tell that a change is breaking, so it cannot require `!` on a
commit that omits it, whether or not a footer is present. That half of the rule
is convention, upheld in review.

## Every commit on a PR

This repository allows merge commits (default merge method is MERGE, not
squash). Every commit that lands on `main` must have a valid header — not only
the PR title.

## Check locally

Verify a single revision's description before pushing:

```bash
mise exec --locked -- cog verify "$(jj log --no-graph -r @ -T description)"
```

`cog verify` reads a message from the command line, so it works in a jj
workspace with no colocated git directory. cocogitto is pinned in
[`mise.toml`](../../mise.toml).

CI runs `cog check --ignore-merge-commits` over every commit a pull request adds
(see
[`.github/workflows/commit-headers.yml`](../../.github/workflows/commit-headers.yml)).
