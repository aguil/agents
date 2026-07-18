# @aguil/agents-policy

Native policy evaluator for the layered policy-enforcement architecture (ADR
0005 follow-up): AGENTS-1 policy files are the enforcement source of truth; this
evaluator runs **before** user hooks at each intervention point, and user hooks
can tighten but never override a policy deny.

- **5-verdict model:** `allow | warn | deny | escalate | transform`
- **Composition:** `composeVerdicts` orders deny > escalate > transform > warn >
  allow
- **Fail closed:** `evaluatePolicy` never throws; internal errors return `deny`
  with the reserved `policy-runtime-error` reason
- **Confirmations:** `exec.unknown` and `filesystem.write` categories route to
  `escalate` (approval path) instead of hard deny
- **Hook adapter:** `createPolicyEvalHandler` speaks the hook JSON contract so
  the runtime can register it as the first handler per event

Rego/ACS engines are intentionally out of scope here; this package is the
default `engine: native` path.
