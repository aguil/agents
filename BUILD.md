# Build Guide

Use the local build when you want a fast launcher for running reviews from another terminal or host checkout.

## Build

```bash
bun run build
```

This runs three steps:

1. `prebuild`: embeds role prompts into `harnesses/code-review/src/embedded-prompts.ts`
2. `build`: bundles the CLI to `dist/index.js` with `--target=bun`
3. `postbuild`: creates the executable Bun launcher at `dist/agents`

## Run

```bash
./dist/agents --help
./dist/agents code-review --adapter fake
```

You can also invoke it from another repository:

```bash
/path/to/aguil/agents/dist/agents code-review --workspace /path/to/work/repo --adapter opencode --model opencode/gpt-5.3-codex
```

## Notes

- `dist/` is gitignored and must be built per checkout/host.
- Missing embedded prompts fail fast because the harness imports the generated module directly.
- Dev runs (`bun run agents ...`) still work without a build and continue using prompt files from `harnesses/code-review/prompts/`.

## npm tarball (maintainers)

The repository keeps the workspace root `package.json` **private** while still supporting a **thin, publishable tarball** that only ships `dist/` + `README.npm.md` + `LICENSE`. The helper script copies the built bundle and merges metadata from `distribution/npm/cli-package.manifest.json`.

```bash
bun run publish:npm:verify
bun run build
bun run scripts/prepare-npm-publish.ts -- --version "$(git describe --tags --abbrev=0 | sed 's/^v//')" # or any semver string
npm pack ./.npm-publish-pack
npm publish ./.npm-publish-pack --access public
```

For a local dry run that mirrors CI as closely as practical (verify + build + prepare + `npm pack`):

```bash
bun run publish:npm:pack:test
```

The generated folder `.npm-publish-pack/` is gitignored.

### Initial registry bootstrap (placeholder `0.0.0`)

Once per package name, publish the tiny placeholder under [`distribution/npm/placeholder-publish/`](distribution/npm/placeholder-publish/) so **`@aguil/agents`** exists before you attach **Trusted Publishing** on npmjs.com or cut the first real tag.

```bash
cd distribution/npm/placeholder-publish
npm pack
npm publish --access public
```

Use **`npm login`** (scoped user with **`@aguil`** publish rights) beforehand. **`0.0.0`** deliberately exits with **`agents`** stderr so nobody mistakes it for a real install.

Immediately after npm accepts the publish:

1. On npm **`@aguil/agents`** → settings, add **GitHub Actions** trusted publisher (**`release.yml`**, **`aguil/agents`** repo) per [Trusted publishing](https://docs.npmjs.com/trusted-publishers).

2. Merge CI that runs **`.github/workflows/release.yml`** on **`v*.*.*`**, then push **`v0.1.0`** (or bump if **`0.0.0`** is already wrong).

### CI: Trusted Publishing (no long-lived npm token)

Tag-driven publishing runs in **`.github/workflows/release.yml`** when you push a **`v*.*.*`** tag. It uses **Trusted Publishing** ([npm docs](https://docs.npmjs.com/trusted-publishers)): GitHub Actions obtains an **OIDC** token (`id-token: write`), and **`npm publish`** (npm CLI **≥ 11.5.1**, via **Node ≥ 22.14** in the workflow) exchanges it for a short-lived publish credential.

On [npmjs.com](https://www.npmjs.com/), open **`@aguil/agents`** → **Package settings** → **Trusted publishers** (or equivalent) and add **GitHub Actions** with:

- **Repository** matching this GitHub repo (the published package **`repository.url`** in [`distribution/npm/cli-package.manifest.json`](distribution/npm/cli-package.manifest.json) must match that repo).

- **Workflow file name** **`release.yml`** (filename only; case-sensitive).

You do **not** need a **`NPM_TOKEN`** secret for CI publishes once this is wired. Local/manual **`npm publish`** from your laptop still uses **`npm login`** or a granular token—not OIDC.

### Annotated release tags

Publishing on tag runs **GitHub Actions only** ([`.github/workflows/release.yml`](.github/workflows/release.yml)); this workflow does **not** create a GitHub Release. Annotation text is **not** stored in git: copy the committed [**`distribution/npm/release-tag-message.template.example`**](distribution/npm/release-tag-message.template.example) to **`distribution/npm/release-tag-message.local`** (gitignored), edit your release notes there, and keep the literal token **`VERSION`** exactly once (leading **`#`** lines are stripped before substitution). Alternatively pass **`--message-file`** to point at any UTF-8 file with the same contract.

```bash
cp distribution/npm/release-tag-message.template.example distribution/npm/release-tag-message.local
# edit release-tag-message.local, then:

bun run release:tag -- 0.1.0
bun run release:tag -- 0.1.0 --push
```

With an explicit message file (path is relative to repo root if not absolute):

```bash
bun run release:tag -- 0.1.0 --message-file path/to/message.txt
```

Add **`--dry-run`** to print the annotation and commands without calling **`git`**. Add **`--sign`** to use **`git tag -s`** instead of **`git tag -a`** (requires a working GPG signing setup).

**Project-task workspaces** (see repository **`AGENTS.md`**) often have **no** **`.git`** at the project path. If the tree has Jujutsu metadata whose **`.jj/repo`** entry is a **pointer file** (linked workspace) or a **directory** (colocated), **`release:tag`** walks up from **`cwd`** and from the package root to resolve the backing **git** working tree automatically. If that fails, pass **`--git-cwd /path/to/aguil/agents`** or set **`RELEASE_TAG_GIT_CWD`**. The tag message file stays repo-root–relative to the harness checkout (or use **`--message-file`**).

If you use **jj** with colocated **git**, tags are normal git objects — **`release:tag`** runs **`git tag`** in the resolved working tree (and use your usual **`jj git`** flow to push **bookmarks**; semver tags are still pushed with **`git push origin vX.Y.Z`** unless you only use **`jj tag set`** and **`git push`** for the tag ref).
