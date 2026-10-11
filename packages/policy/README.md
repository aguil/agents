# @aguil/agents-policy

Native policy evaluator for the layered policy-enforcement architecture (ADR
0005 follow-up): `.agents/policies/*.yaml` are the enforcement source of truth;
this evaluator runs **before** user hooks at each intervention point, and user
hooks can tighten but never override a policy deny.

- **5-verdict model:** `allow | warn | deny | escalate | transform`
- **Composition:** `composeVerdicts` orders deny > escalate > transform > warn >
  allow
- **Fail closed:** `evaluatePolicy` never throws; internal errors return `deny`
  with the reserved `policy-runtime-error` reason
- **Confirmations:** `exec.unknown` and `filesystem.write` categories return
  `escalate`, which the policy-eval bridge maps to hook `permission: "ask"`.
  That only stops the tool call when the Cursor adapter is **not** passing
  `--force` (ADR 0020). With `--force`, Cursor collapses `ask` into allow while
  still honouring `deny` — so confirmation categories are inert under a forced
  run. The safe default is force off plus `--sandbox enabled`.
- **Hook adapter:** `createPolicyEvalHandler` speaks the hook JSON contract so
  the runtime can register it as the first handler per event
- **Compound commands:** an `exec.allow` entry matches one simple command. A
  command with a pipe, chain, substitution or redirection outside quotes, or
  with an unbalanced quote, is unlisted however it starts; the same characters
  inside quotes are an argument (`tokenizeShellCommand`). So is a command whose
  reading could differ from bash's: one with a comment (`#` starting an unquoted
  word), `$'…'` quoting, or a `${…}` holding a quote, backslash, `$` or
  backtick. Deny entries match by prefix, as before.
- **Denials name the rule:** a verdict's `rule` is the entry that matched or the
  entry that was missing, never the full command, and the policy-eval bridge
  tells the agent `Blocked by policy <id> (<reason>): <rule>`

Rego/ACS engines are intentionally out of scope here; this package is the
default `engine: native` path.
