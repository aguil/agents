# Incident fixture

A deliberately broken mini-project used by the incident-triage example harness.
Do not "fix" it in this repository — the injected bug **is** the fixture.

- `src/pagination.ts` — contains an injected off-by-one bug (each page drops its
  final item)
- `check.ts` — deterministic health signal: `bun run check.ts` exits 1 while the
  bug is present, 0 once fixed (intentionally not a `*.test.ts` file so the
  repository test runner never picks it up)
- `alert.log` — static alert/support context the scout role reads

The harness chain (scout → diagnose → fix → verify) operates on a **copy** of
this directory; see `../README.md`.
