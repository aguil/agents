# Build Guide (Maintainers)

Developer install and local build steps are in
[`docs/guide/install.md`](docs/guide/install.md).

This file covers the npm publishing pipeline, annotated release tags, and
Jujutsu-specific git interop.

## Automated releases (release-please)

The default release path is automated by
[release-please](https://github.com/googleapis/release-please):
[`.github/workflows/release-please.yml`](.github/workflows/release-please.yml)
maintains a release PR from Conventional Commits on `main` (version bump +
[`CHANGELOG.md`](CHANGELOG.md), configured in
[`release-please-config.json`](release-please-config.json)). Merging that PR
creates the `vX.Y.Z` tag and GitHub Release, then dispatches
[`release.yml`](.github/workflows/release.yml) to publish to npm (tags created
with `GITHUB_TOKEN` do not trigger workflows on their own, so the dispatch is
explicit). The sections below describe the underlying tarball/publish mechanics
and the manual-tag fallback.

## npm tarball

The workspace root `package.json` is **private**. A thin publishable tarball
ships only `dist/` + `README.npm.md` + `LICENSE`. The helper script copies the
built bundle and merges metadata from
`distribution/npm/cli-package.manifest.json`. Published semver comes from the
**git tag** in CI, not from committed `package.json` fields; optionally bump
root `version` for local `agents --version` — see
[`docs/release-checklist.md`](docs/release-checklist.md#2-version-fields-in-git-optional-bookkeeping).

```bash
bun run publish:npm:verify
bun run build
bun run scripts/prepare-npm-publish.ts -- --version "$(git describe --tags --abbrev=0 | sed 's/^v//')"
npm pack ./.npm-publish-pack
npm publish ./.npm-publish-pack --access public
```

For a local dry run that mirrors CI (verify + build + prepare + `npm pack`):

```bash
bun run publish:npm:pack:test
```

The generated folder `.npm-publish-pack/` is gitignored.

### Initial registry bootstrap (placeholder `0.0.0`)

Once per package name, publish the tiny placeholder under
[`distribution/npm/placeholder-publish/`](distribution/npm/placeholder-publish/)
so **`@aguil/agents`** exists before you attach Trusted Publishing or cut the
first real tag.

```bash
cd distribution/npm/placeholder-publish
npm pack
npm publish --access public
```

Use **`npm login`** (scoped user with **`@aguil`** publish rights) beforehand.
`0.0.0` deliberately exits with `agents` stderr so nobody mistakes it for a real
install.

Immediately after npm accepts the publish:

1. On npm **`@aguil/agents`** → settings, add **GitHub Actions** trusted
   publisher (**`release.yml`**, **`aguil/agents`** repo) per
   [Trusted publishing](https://docs.npmjs.com/trusted-publishers).
2. Merge CI that runs **`.github/workflows/release.yml`** on **`v*.*.*`**, then
   push **`v0.1.0`** (or bump if `0.0.0` is already wrong).

## CI: Trusted Publishing (no long-lived npm token)

Tag-driven publishing runs in **`.github/workflows/release.yml`** when you push
a **`v*.*.*`** tag. It uses Trusted Publishing
([npm docs](https://docs.npmjs.com/trusted-publishers)): GitHub Actions obtains
an OIDC token (`id-token: write`), and `npm publish` (npm CLI **≥ 11.5.1**, via
Node **≥ 22.14** in the workflow) exchanges it for a short-lived publish
credential.

On [npmjs.com](https://www.npmjs.com/), open **`@aguil/agents`** → **Package
settings** → **Trusted publishers** and add **GitHub Actions** with:

- **Repository** matching this GitHub repo (the published package
  `repository.url` in
  [`distribution/npm/cli-package.manifest.json`](distribution/npm/cli-package.manifest.json)
  must match that repo).
- **Workflow file name** `release.yml` (filename only; case-sensitive).

You do not need a `NPM_TOKEN` secret for CI publishes once this is wired. Local
or manual `npm publish` from your laptop still uses `npm login` or a granular
token.

## Annotated release tags (manual fallback)

Use this path only when bypassing release-please (e.g. re-cutting a release by
hand). Publishing on tag runs GitHub Actions: npm publish, then a **GitHub
Release** whose body starts with the annotated tag message and appends
auto-generated PR notes since the previous `v*.*.*` tag (idempotent if the
Release already exists). Annotation text is **not** stored in git.

Copy the committed
[`distribution/npm/release-tag-message.template.example`](distribution/npm/release-tag-message.template.example)
to `distribution/npm/release-tag-message.local` (gitignored), edit your release
notes there, and keep the literal token `VERSION` exactly once (leading `#`
lines are stripped before substitution).

```bash
cp distribution/npm/release-tag-message.template.example \
   distribution/npm/release-tag-message.local
# edit release-tag-message.local, then:

bun run release:tag -- 0.1.0
bun run release:tag -- 0.1.0 --push
```

With an explicit message file:

```bash
bun run release:tag -- 0.1.0 --message-file path/to/message.txt
```

Add `--dry-run` to print the annotation and commands without calling `git`. Add
`--sign` to use `git tag -s` instead of `git tag -a` (requires GPG signing).

**Project-task workspaces** often have no `.git` at the project path. If the
tree has Jujutsu metadata, `release:tag` walks up from `cwd` and from the
package root to resolve the backing git working tree automatically. If that
fails, pass `--git-cwd /path/to/aguil/agents` or set `RELEASE_TAG_GIT_CWD`.

If you use **jj** with colocated **git**, tags are normal git objects —
`release:tag` runs `git tag` in the resolved working tree. Push bookmarks
(signed commits) with `jj git push` first; semver tags still need
`git push origin vX.Y.Z` (or `release:tag --push`).

Step-by-step:
[`docs/release-checklist.md`](docs/release-checklist.md#jujutsu-colocated-git).

## Pre-release checklist

Before creating `vX.Y.Z`, walk through
[`docs/release-checklist.md`](docs/release-checklist.md) (local gates, tag
message prep, jj bookmark + tag push, and post-publish verification).
