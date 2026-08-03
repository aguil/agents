# Incident-triage example harness

The proof harness from ADR 0005: a scout → diagnose → fix → verify chain
expressed **entirely as configuration** — no build-time TypeScript. It
demonstrates that a new harness needs only `.agents/` artifacts on top of the
shared loader (`@aguil/agents-harness-config`), policy evaluator
(`@aguil/agents-policy`), and orchestrator (`@aguil/agents-orchestration`).

## Layout

- `.agents/` — self-contained agents directory for this example
  - `harnesses/incident-triage/harness.yaml` — roles, chain order, policy refs,
    and context providers
  - `harnesses/incident-triage/prompts/*.md` — one prompt per role
  - `policies/triage-readonly.yaml` — scout/diagnose/verify containment
  - `policies/triage-fix.yaml` — fix-role policy (writes allowed, health signal
    and incident record deny-listed, unknown commands escalate)
- `fixture/` — the synthetic incident (injected bug, `check.ts` health signal,
  static `alert.log`, and `.agents/knowledge/` notes the providers read); see
  `fixture/README.md`

## Knowledge notes

Providers read `.agents/knowledge` **from the workspace** (ADR 0022), so the
notes ship inside `fixture/` and travel with
`cp -r …/fixture /tmp/incident-run`. The harness declares two builtin context
providers:

| Provider           | What it does here                                                          |
| ------------------ | -------------------------------------------------------------------------- |
| `knowledge`        | Injects notes with `context: auto` — today that is `pagination-off-by-one` |
| `knowledge-search` | Returns notes tagged both `incident` and `pagination` (AND match)          |

Three notes ship under `fixture/.agents/knowledge/`:

- `pagination-off-by-one` — `context: auto`; injected into every run
- `support-desk-missing-last-row` — search-only; found by the tag query
- `harness:incident-triage-pass-gate` — machine-prefixed id; filterable with
  `provenance: machine` on `knowledge-search` (not selected by the default tag
  query, which requires both `incident` and `pagination`)

Automatic injection stays off until both the harness declares `use: knowledge`
and a note opts in with `context: auto`. Search results are explicitly requested
and do not require `context: auto`.

## Running it

Always run against a **copy** of the fixture — the injected bug is the fixture:

```bash
cp -r examples/incident-triage/fixture /tmp/incident-run
bun run agents harness run incident-triage \
  --agents-dir examples/incident-triage/.agents \
  --workspace /tmp/incident-run
```

The chain passes when `bun run check.ts` exits 0 in the workspace after the fix
role's remediation. The headless CI proof for this example lives in
`tests/incident-triage-e2e.test.ts` and uses a scripted adapter; this directory
is the human-runnable counterpart with a real agent.

This is a **reference example**, not a supported harness. The gates for
promoting config-driven harnesses to production surfaces are tracked in issue
#73.
