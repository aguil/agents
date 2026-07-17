# Build Guide (Maintainers)

Developer install and local build steps are in
[`docs/guide/install.md`](docs/guide/install.md).

This file covers the npm publishing pipeline and the release automation.

## Automated releases (release-please)

Releases are automated by
[release-please](https://github.com/googleapis/release-please):
[`.github/workflows/release-please.yml`](.github/workflows/release-please.yml)
maintains a release PR from Conventional Commits on `main` (version bump +
[`CHANGELOG.md`](CHANGELOG.md), configured in
[`release-please-config.json`](release-please-config.json)). Merging that PR
creates the `vX.Y.Z` tag and GitHub Release, then dispatches
[`release.yml`](.github/workflows/release.yml) to publish to npm (tags created
with `GITHUB_TOKEN` do not trigger workflows on their own, so the dispatch is
explicit). `release.yml` refuses non-tag refs and non-SemVer tag names, and
skips publish when the version is already on npm, so retries
(`gh workflow run release.yml --ref vX.Y.Z`) are safe.

Step-by-step: [`docs/release-checklist.md`](docs/release-checklist.md). The
sections below describe the underlying tarball/publish mechanics.

## npm tarball

The workspace root `package.json` is **private**. A thin publishable tarball
ships only `dist/` + `README.npm.md` + `LICENSE`. The helper script copies the
built bundle and merges metadata from
`distribution/npm/cli-package.manifest.json`. Published semver comes from the
**git tag** in CI, not from committed `package.json` fields; the root `version`
is kept in sync by the release-please release PR.

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
   merge the first release-please release PR to cut the first real version.

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

## Release tags

Tags are created by release-please when a release PR merges; do not create or
move `v*.*.*` tags by hand. If a publish needs a retry, re-dispatch the workflow
against the existing tag (`gh workflow run release.yml --ref vX.Y.Z`). See
[`docs/release-checklist.md`](docs/release-checklist.md) for the merge checklist
and recovery steps.
