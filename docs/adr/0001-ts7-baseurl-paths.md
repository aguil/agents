# ADR 0001: Track `baseUrl` + `paths` before TypeScript 7

**Status:** Accepted (tracking item; work not done yet)  
**Context:** TypeScript 6.0 deprecates `compilerOptions.baseUrl` (TS5101); it will stop functioning in TypeScript 7. This monorepo uses `baseUrl` + `paths` in the root [`tsconfig.json`](../../tsconfig.json) for `@aguil/agents-*` workspace aliases.

**Current mitigation (TS 6):** `compilerOptions.ignoreDeprecations` is set to `"6.0"` so `tsc --noEmit` can run while `baseUrl` remains. This flag is **not** supported in TS 7; it must be removed as part of upgrading to 7.

**Planned work (before TS 7):**

- Migrate off `baseUrl` following [TypeScript 6 migration guidance](https://aka.ms/ts6).
- Prefer an automated pass with [ts5to6](https://github.com/andrewbranch/ts5to6) (or equivalent) to rewrite `paths` and drop `baseUrl`, then remove `ignoreDeprecations`.
- Re-run `tsc --noEmit`, `biome check`, and `bun test` after the change.

**Success criteria:** Root `tsconfig.json` has no `baseUrl`, no `"ignoreDeprecations": "6.0"`, and path aliases still resolve for packages, harnesses, scripts, and tests.
