# Release checklist

Use this when cutting a new **`@aguil/agents`** release. Tag-driven publishing,
trusted publishing setup, and tarball details live in [`BUILD.md`](../BUILD.md)
(npm tarball + **Annotated release tags**).

## Automated releases (release-please) — default path

Releases are automated with
[release-please](https://github.com/googleapis/release-please):

1. Land [Conventional Commits](https://www.conventionalcommits.org/) on
   **`main`** (`feat:` → minor, `fix:`/`perf:` → patch while pre-1.0 per
   [`release-please-config.json`](../release-please-config.json)).
2. [`.github/workflows/release-please.yml`](../.github/workflows/release-please.yml)
   maintains a **release PR** that bumps the root `package.json` version,
   updates [`CHANGELOG.md`](../CHANGELOG.md), and updates
   [`.release-please-manifest.json`](../.release-please-manifest.json).
3. Merging the release PR creates the **`vX.Y.Z`** tag and GitHub Release, then
   dispatches [`release.yml`](../.github/workflows/release.yml) (tags created
   with `GITHUB_TOKEN` do not trigger workflows on their own), which runs the
   quality gates, builds, and publishes to npm via Trusted Publishing.

Day to day there is nothing to do beyond writing conventional commit messages
and merging the release PR when you want to ship. The checklist below remains
for the **manual tag** fallback (e.g. re-publishing an existing tag or cutting a
release without release-please).

## Manual fallback: before you tag

### 1. Ship the right revision

- [ ] Release changes are merged on the branch you tag (usually **`main`**).
- [ ] The working tree at tag time matches what you intend to publish (no stray
      local edits in the canonical clone).
- [ ] Pick the next [SemVer](https://semver.org/) version (e.g. **`0.2.0`**).
      The git tag will be **`v0.2.0`**.

### 2. Version fields in git (optional bookkeeping)

**npm publish does not read committed `package.json` versions.** CI takes semver
from the pushed tag and
[`prepare-npm-publish.ts`](../scripts/prepare-npm-publish.ts) writes that into
the publish pack from
[`distribution/npm/cli-package.manifest.json`](../distribution/npm/cli-package.manifest.json)
(template stays at **`0.0.0`**).

| File                                                 | Bump on release?                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Git tag **`vX.Y.Z`**                                 | **Required** — source of truth for CI/npm                                                                          |
| Root [`package.json`](../package.json) **`version`** | **Optional** — so `agents --version` in a git checkout matches the release (dev, `./dist/agents`, `agents doctor`) |
| `packages/*`, `harnesses/*` **`version`**            | **No** — private workspace placeholders; not published                                                             |
| `distribution/npm/cli-package.manifest.json`         | **No** — overridden at pack time                                                                                   |
| `docs/skills/skills.json` **`minAgentsVersion`**     | Only when a skill needs a newer CLI floor                                                                          |

If you want local **`agents --version`** to match the tag you are about to cut,
bump **only** the root **`version`** field in the same revision you tag (or the
commit immediately before tagging):

```bash
# example: set "version": "0.2.0" in package.json, then commit
agents --version   # should print 0.2.0
```

Workspace packages can stay at **`0.0.0`**. **`agents --version`** resolves the
pack root via `docs/skills/skills.json` (see
[`packages/cli/src/skills-pack.ts`](../packages/cli/src/skills-pack.ts)).

- [ ] (Optional) Root `package.json` `version` updated to match the release.

### 3. Run local gates (matches CI + commit policy)

Same bar as
[`.agents/rules/pre-commit-checks.md`](../.agents/rules/pre-commit-checks.md)
and **`release.yml`**:

```bash
bun run lint
bun run typecheck
pre-commit run --all-files   # when .pre-commit-config.yaml is present
bun run test:ci
bun run build
```

- [ ] All of the above pass.

Optional but useful before the first tag on a machine:

```bash
bun run publish:npm:pack:test
```

- [ ] Tarball dry run succeeds (verify + build + prepare + `npm pack`).

### 4. One-time npm / CI prerequisites

Skip if already done for **`@aguil/agents`**:

- [ ] Package exists on npm (placeholder **`0.0.0`** bootstrap if needed).
- [ ] **Trusted Publishing** on npm points at this repo, workflow file
      **`release.yml`**. See [`BUILD.md`](../BUILD.md).

## Tag message (local only)

Annotation text is not committed. Either maintain a gitignored file or pass
**`--message-file`**:

```bash
cp distribution/npm/release-tag-message.template.example \
  distribution/npm/release-tag-message.local
# Edit release-tag-message.local — keep VERSION exactly once.
```

- [ ] Message file ready (`release-tag-message.local` or custom path).
- [ ] **`VERSION`** appears exactly once (after stripping leading `#` lines).

Preview:

```bash
bun run release:tag -- <semver> --dry-run
# e.g. bun run release:tag -- 0.2.0 --dry-run
```

- [ ] Dry-run annotation looks correct.

## Create and push the tag

From the **git** working tree that should own the tag (canonical clone or
**`--git-cwd`** — see Jujutsu below):

```bash
bun run release:tag -- <semver>          # creates v<semver> locally
bun run release:tag -- <semver> --push   # creates and git push origin v<semver>
```

- [ ] Tag **`v<semver>`** exists locally.
- [ ] Tag is pushed to **`origin`** (or your release remote).

Add **`--sign`** only if you use **GPG** tag signing (`git tag -s`). Commit
signing for jj/git is separate (next section).

## Jujutsu (colocated git)

Typical maintainer flow when day-to-day work uses **jj** and GitHub sees signed
git commits:

### Push the commit graph first

1. Ensure **`git.sign-on-push = true`** in jj config (see
   [`.agents/rules/pre-commit-checks.md`](../.agents/rules/pre-commit-checks.md)).
2. Sign any unsigned revisions you are about to publish:

   ```bash
   jj sign -r 'main..<bookmark>'   # adjust revset to your stack
   ```

3. Push the bookmark (exports signed commits to git, then pushes):

   ```bash
   jj git push --bookmark <bookmark>
   ```

- [ ] Tip revision on the release branch is on GitHub and signed as expected.

### Tag from the backing git tree

**`release:tag`** runs **`git tag`** in a resolved working tree. From a
**project-task** path without **`.git`**, point at the harness clone:

```bash
bun run release:tag -- <semver> --git-cwd /path/to/aguil/agents --dry-run
bun run release:tag -- <semver> --git-cwd /path/to/aguil/agents --push
```

Or:

```bash
export RELEASE_TAG_GIT_CWD=/path/to/aguil/agents
bun run release:tag -- <semver> --push
```

The tag message file path is still relative to the **agents** repo root (or use
**`--message-file`** with an absolute path).

**Alternative:** set the tag in jj, then push the git tag ref:

```bash
jj tag set v<semver> -r <revision>
git push origin v<semver>
```

- [ ] Tag points at the intended revision.
- [ ] **`git push origin v<semver>`** (or **`release:tag --push`**) completed.

Semver tags are **not** advanced by **`jj git push`** alone; push the tag ref
explicitly unless you use **`release:tag --push`**.

## After the tag

- [ ] GitHub Actions **Release** workflow started for **`v<semver>`**.
- [ ] Workflow finished green (`typecheck`, `lint`, `test:ci`, `build`,
      publish).
- [ ] [`@aguil/agents`](https://www.npmjs.com/package/@aguil/agents) shows the
      new version.
- [ ] Smoke install (optional): `npm install -g @aguil/agents@<semver>` then
      `agents --help`.
- [ ] GitHub **Releases** page exists for **`v<semver>`** (created by CI unless
      it already existed).

### Where release notes appear

| Surface               | What users see                                                                                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Git annotated tag** | Text from `release-tag-message.local` at tag time (`bun run release:tag`).                                                                                                                                                              |
| **GitHub Releases**   | Same tag text, then **`---`**, then GitHub-generated PR notes since the previous **`v*.*.*`** tag ([`scripts/create-github-release-from-tag.sh`](../scripts/create-github-release-from-tag.sh)). Skipped if the Release already exists. |
| **npm**               | `README.npm.md` + `package.json` `description` from the publish pack — not the tag message.                                                                                                                                             |

Put everything you want on the GitHub Release **above the generated PR section**
in `release-tag-message.local` (gitignored). Do not commit per-version release
notes to this repository.

If CI did not create a Release (e.g. publish ran before this automation
existed), run `bash scripts/create-github-release-from-tag.sh` locally with
`TAG_NAME` and `GITHUB_REPOSITORY` set, or
`gh release create vX.Y.Z --verify-tag --notes-file …`.

If publish fails, fix forward on **`main`**, cut a new patch tag — do not move
an already-pushed **`v*.*.*`** tag.

## Quick reference

| Step              | Command / artifact                                           |
| ----------------- | ------------------------------------------------------------ |
| Git/npm version   | tag **`vX.Y.Z`** (required); root `package.json` (optional)  |
| Local gates       | `lint`, `typecheck`, `pre-commit`, `test:ci`, `build`        |
| Tarball dry run   | `bun run publish:npm:pack:test`                              |
| Tag message       | `distribution/npm/release-tag-message.local`                 |
| Create / push tag | `bun run release:tag -- X.Y.Z [--push]`                      |
| CI publish        | push **`vX.Y.Z`** → **`release.yml`** (npm + GitHub Release) |
| jj commits        | `jj sign`, then `jj git push --bookmark …`                   |
| jj + wrong cwd    | `--git-cwd` or **`RELEASE_TAG_GIT_CWD`**                     |
