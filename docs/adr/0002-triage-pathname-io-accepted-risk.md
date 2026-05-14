# ADR 0002: Accepted risk — pathname-based triage I/O (no openat chain)

**Status:** Accepted  
**Date:** 2026-05-14  
**Scope:** `packages/triage` ingest of `result.json` and triage output writes (`write-outputs.ts`), plus related path validation helpers.

## Context

Triage validates workspace-relative paths with `realpath` / prefix checks, then performs I/O using string paths (`readUtf8FileNoFollow`, `writeUtf8FileNoFollow`). Those helpers use `O_NOFOLLOW` on the **leaf** file so the final component cannot be a symlink, but they do **not** retain a directory file descriptor across the validation → open boundary.

A hostile or buggy concurrent actor that can flip **ancestor** directories to symlinks between validation and open could, in theory, redirect reads or writes outside the intended workspace tree. Eliminating that race on POSIX generally requires an **`openat`-style** walk from a trusted directory fd (or equivalent), not pathname reopens alone.

## Decision

For this monorepo’s **operator-controlled review workspaces** (local dev, CI sandboxes, and similar environments where the tree is not adversarially mutated during a single `agents triage` invocation), we **accept** this residual TOCTOU class and **do not** require an `openat` implementation in the triage package today.

## Consequences

- Security reviewers may continue to flag “pathname after validation” patterns; disposition is **accepted risk** under this ADR unless the deployment model changes (for example, triage over a directory writable by mutually untrusted peers).
- If a future consumer needs a stricter threat model, implement bounded `openat` (or platform-specific) resolution from a workspace-root fd and thread handles through reads/writes; that is **explicit follow-up work**, not implied by current APIs.

## Related

- Pointer-based latest `result.json` discovery (`harnesses/code-review` + `discover-code-review-result.ts`) writes `.code-review-latest-result` after each harness run; discovery **merges** that pointer with a concurrent scan of `code-review-*` directories so the returned path is always the mtime+tie winner. Set `AGENTS_CODE_REVIEW_DISCOVER_FULL_SCAN=1` to ignore the pointer when repairing a corrupted tree. The scan is **O(n)** in the number of stored runs when run directories exist.
