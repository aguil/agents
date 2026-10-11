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
  backtick.
- **Deny reads a command generously, allow strictly (ADR 0026):** deny entries
  are checked against every simple command in the string, a substitution's or a
  subshell's contents included, so `cat a; rm b` and `echo "$(rm x)"` meet
  `deny: [rm]`. The program is found past `NAME=value` assignments and compared
  by its last path component (`/bin/rm x`). A deny entry's subcommand is found
  behind options (`git -C /tmp push` meets `deny: [git push]`), and its options
  anywhere, inside a cluster too (`sed -ni` meets `deny: [sed -i]`). No table of
  options is used, so an option's value can be taken for a subcommand and deny:
  that over-denial is accepted. Allow entries are a word prefix on the command
  as written: `git --no-pager log` and `FOO=1 git log` are unlisted under
  `allow: [git log]`, and a quoted program matches (`'rg' x`).

Rego/ACS engines are intentionally out of scope here; this package is the
default `engine: native` path.
