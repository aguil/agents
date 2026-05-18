# ADR 0002: Accepted risk — pathname-based triage and harness I/O (no openat chain)

**Status:** Accepted  
**Date:** 2026-05-14  
**Scope:** `packages/triage` ingest of `result.json`, triage output writes
(`write-outputs.ts`), the code-review harness pointer writer
(`writeLatestCodeReviewDiscoveryPointer` in `harnesses/code-review`), and
related path validation helpers.

## Context

Triage validates workspace-relative paths with `realpath` / prefix checks, then
performs I/O using string paths (`readUtf8FileNoFollow`,
`writeUtf8FileNoFollow`). Those helpers use `O_NOFOLLOW` on the **leaf** file so
the final component cannot be a symlink, but they do **not** retain a directory
file descriptor across the validation → open boundary.

The harness updates `.code-review-latest-result` via a temp file and `rename(2)`
on an absolute pathname under `.agents-code-review/runs` or `dry-run`, with the same
ancestor-swap concern.

A hostile or buggy concurrent actor that can flip **ancestor** directories to
symlinks between validation and open could, in theory, redirect reads or writes
outside the intended workspace tree. Eliminating that race on POSIX generally
requires an **`openat`-style** walk from a trusted directory fd (or equivalent),
not pathname reopens alone.

## Decision

For this monorepo’s **operator-controlled review workspaces** (local dev, CI
sandboxes, and similar environments where the tree is not adversarially mutated
during a single `agents triage` or `agents code-review` invocation), we
**accept** this residual TOCTOU class and **do not** require an `openat`
implementation in the triage package or harness pointer writer today.

## Consequences

- Security reviewers may continue to flag “pathname after validation” patterns;
  disposition is **accepted risk** under this ADR unless the deployment model
  changes (for example, triage over a directory writable by mutually untrusted
  peers).
- If a future consumer needs a stricter threat model, implement bounded `openat`
  (or platform-specific) resolution from a workspace-root fd and thread handles
  through reads/writes; that is **explicit follow-up work**, not implied by
  current APIs.

## Related

- Latest `result.json` discovery (`discover-code-review-result.ts`) **merges**
  the harness pointer with a concurrent scan of every `code-review-*` directory
  so the returned path is always the mtime+tie winner (no stale pointer). That
  correctness guarantee costs **O(n)** `lstat` calls when run directories exist;
  set `AGENTS_CODE_REVIEW_DISCOVER_FULL_SCAN=1` to ignore the pointer when
  repairing a corrupted tree.
