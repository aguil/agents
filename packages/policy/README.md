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
- **Interpreters and runners warn at load:** an `exec.allow` entry naming `sh`,
  `bash`, `zsh`, `python`, `python3`, `node`, `bun`, `deno`, `perl`, `ruby` or
  `git` with nothing after it but options and their values (`bash`,
  `python3 -c`, `git -C /tmp`), or naming `env`, `xargs`, `sudo` or `find`, can
  run anything, so the deny lists do not hold behind it. `policyLoadWarnings`
  names each one, and `agents harness run` and `agents hooks test` print it; the
  policy still loads. `bash script.sh` and `bun test` name what runs and do not
  warn.
- **A command's arguments meet `filesystem.deny` (ADR 0026):** every word after
  the program, the value of a `--name=value` word, and the file a redirection
  names are checked against the deny globs, canonicalized as a file tool's path
  is, so `cat .env`, `rg --file=.env x` and `cat < .env` deny under
  `deny: [.env]`, naming the glob. It runs on every command the exec rules do
  not deny, so an unlisted `cat .env` denies rather than asking for approval.
  `filesystem.allow` is not applied, since most arguments are not paths, and a
  pattern that reads as a denied path denies (`rg -n .env src`). An absolute
  argument inside the workspace is made relative first where the caller passes
  `relativizeWorkspacePath` (the policy-eval bridge does, from `--workspace`);
  one outside the workspace, or escaping it, is not checked, unlike a file
  tool's path, so `ls /tmp` stays allowed.

### What matching cannot see

Exec and argument matching read a command's text, so these stay out of reach
(ADR 0026 decision 7). Holding against them needs enforcement below the command
line, such as an OS sandbox.

- A payload behind `-c`, `-e` or an equivalent, and what a script file runs:
  `bash -c 'rm x'` under `allow: [bash]` is allowed, which is why such an entry
  warns at load.
- Paths and programs built at run time: globs (`cat .en*`), variables
  (`cat $F`), and the output of a substitution (`cat $(echo .env)`).
- A path inside another syntax, such as `git show HEAD:.env` or a URL.
- A path reached through a symbolic link named by a relative path: it is
  classified by its name, not its target.
- Arguments outside the workspace, absolute or escaping it, and, where the
  caller does not pass the workspace, every absolute argument.
- With no `exec.allow` list, anything run behind an interpreter or runner: such
  a policy's deny list reaches only commands that name the program directly or
  through options and paths.
- **Denials name the rule:** a verdict's `rule` is the entry that matched or the
  entry that was missing, never the full command, and the policy-eval bridge
  tells the agent `Blocked by policy <id> (<reason>): <rule>`

Rego/ACS engines are intentionally out of scope here; this package is the
default `engine: native` path.
