# ADR 0026: exec rules match the resolved program and subcommand, and a command's arguments meet `filesystem.deny`

**Status:** Proposed

**Status history:**

- 2026-10-10 — Proposed.

**Context:** ADR 0006 §2 set how an exec rule matches a command: "equality or
`rule + " "` prefix, nothing fuzzier", so deny `rm` blocks `rm -rf` but not
`rmdir`. `commandMatchesRule` in `packages/policy/src/index.ts` still does
exactly that, for allow and deny alike, against the raw command string. Two
consequences have been reported, and both make a policy promise more than it
enforces.

**An option ahead of the subcommand hides it from the deny list (#196).** Under
`allow: [git -C]` and `deny: [git push]`, `git -C /tmp push origin main`
evaluates to `allow`. The string does not start with `git push`, so the deny
rule never fires, and the allow rule matches by prefix. `git -C <path>` is the
natural entry to add when a role must read a sibling checkout, and nothing tells
the author it retires the deny list for that program. The same issue shows that
allowlisting an interpreter or a command runner (`sh`, `bash`, `python3 -c`,
`env`, `xargs`, `find -exec`, `git -c alias.x=…`) admits every command the deny
list names, behind it, and nothing in the schema or the documentation warns of
it.

**A path the policy denies to file tools is open to an allowed shell read
(#104).** Filesystem rules see only a file tool's `file_path`, `path` or
`notebook_path`. A shell command's arguments never reach them, so under
`filesystem.deny: [.env]` and `exec.allow: [cat]`, `cat .env` is allowed.
`tests/policy-probes.test.ts` pins this as a known gap. The cost runs both ways.
A role that does not read its policy gets the file. A role that does read it
declines work the policy does not actually prevent: in one reported run, a role
refused to plan a measurement because the brief needed `.git/FETCH_HEAD`, which
its policy denied to file reads, while any `cat` would have read it.

A third issue sets the ground this ADR builds on. #237 reported allowed reads
denied because a `|`, `;`, `<` or `>` inside a quoted argument tripped the
whole-string chaining pattern. Its fix replaces that pattern with a quote-aware
tokenizer: it splits a command shell-style, honouring single quotes, double
quotes and backslash escapes, yields the words the shell would pass, and reports
the operators found outside quotes. `$(…)` and backticks count outside single
quotes, including inside double quotes, and an unbalanced quote is a parse
failure that denies. With words available, rules no longer need to match
characters.

String matching has a ceiling no parser removes. It cannot see what a script
file does, what a `-c` payload runs once quoting and expansion have been
applied, or which path a glob or variable becomes at run time. The answer to
those is enforcement below the command line, an OS sandbox, which #104 and #196
both name and which is a much larger change. This ADR does not attempt it. It
makes text matching as faithful to what the policy says as text matching can be,
and makes the policy say where it stops.

Two principles follow from that ceiling and shape every decision below.

- **Deny reads a command generously; allow reads it strictly.** Where the text
  is ambiguous, a deny rule takes every reading under which it could apply, and
  an allow rule takes only the literal one. The failure mode is then
  over-denial, which a role sees and an author can fix, never a silent pass.
- **What cannot be enforced is reported, not implied.** A policy entry that
  voids the deny list is flagged when the policy loads, and the policy package
  documents what matching cannot see.

**Decision:**

1. **Exec rules match words, not characters.** A command is split by the
   quote-aware tokenizer into simple commands at the control operators it finds
   outside quotes (`|`, `||`, `&&`, `;`, `&` and newline), a substitution's
   contents forming simple commands of their own. A redirection stays with the
   simple command it redirects. A rule is split into words the same way. Deny
   rules are checked against every simple command in the string, so
   `cat a; rm -rf b` meets `deny: [rm]`. Allow rules are checked as today
   against the command as a whole: a command with an operator outside quotes, a
   redirection included, never matches an allow rule, so it is unlisted, and an
   unbalanced quote denies.

2. **Resolving the program.** In each simple command, words of the form
   `NAME=value` ahead of the first other word are environment assignments, and
   the next word is the program.
   - For deny, assignments are skipped, and the program is compared by its last
     path component: deny `rm` matches `rm`, `/bin/rm` and `./rm`.
   - For allow, the first word must equal the rule's program as the rule writes
     it. A command that starts with an assignment, or names the program by a
     different path, matches no allow rule. `LD_PRELOAD=x cat` and a workspace
     script named `./git` are therefore unlisted under `allow: [cat, git log]`.

3. **Resolving the subcommand for deny.** A deny rule's words after the program
   are matched against the command's words after the program, level by level.
   - A rule word that does not start with `-` is a subcommand. Its candidates
     are found by scanning the command's words in order, skipping words that
     start with `-`. A non-option word is a candidate; if the word before it was
     an option without an attached value (`-C`, `--git-dir`), the candidate may
     be that option's value, so the scan continues; otherwise it stops. The rule
     word matches if any candidate equals it, and the rule's next word is
     resolved the same way from the word after that candidate. So
     `git -C /tmp push origin` and `git --no-pager push` meet
     `deny: [git push]`, `jj -R ../x git push` meets `deny: [jj git push]`, and
     `git log --grep push` does not meet `deny: [git push]`.
   - A rule word that starts with `-` is an option. It matches if the command
     carries it anywhere after the program: as the same word, as `--name=value`
     for a long option, or, for a single-letter option, inside a cluster of
     single-letter options. `deny: [sed -i]` meets `sed -n -i f` and
     `sed -ni f`.
   - No table of any program's options is used. A word that is in fact an
     option's value can be taken for a subcommand: `git -C push status`, where
     `push` is a directory, meets `deny: [git push]`. That is over-denial, and
     accepted.

4. **Allow matching keeps its reach.** An allow rule matches a command whose
   words begin with the rule's words, compared whole: the word-boundary prefix
   of ADR 0006 §2, now on the tokenizer's words. Allow does not resolve
   subcommands, so `git --no-pager log` is unlisted under `allow: [git log]`.
   Deny is still evaluated first and still wins, which is what closes #196's
   row: under `allow: [git -C]` and `deny: [git push]`,
   `git -C /tmp push origin main` is denied by decision 3 before the allow rule
   is consulted. The one widening is that a quoted program now matches, since
   `'rg' x` runs `rg` exactly as `rg x` does.

5. **A command's arguments meet `filesystem.deny`.** When a policy has
   `capabilities.filesystem.deny` and the exec rules do not deny a command,
   every word after the program in each of its simple commands, and the value of
   every `--name=value` word, is checked against those globs. Each is
   canonicalized as a file tool's path is (`canonicalizeCandidatePath`: `.` and
   `..` collapsed, separators normalized). A match denies the command with the
   `filesystem-denied` reason, naming the glob that matched.
   - A redirection's target, the word after `<`, `>`, `>>`, `<>` or `>|` or a
     numbered form such as `2>`, is checked as an argument of the command it
     redirects, so `cat < .env` is denied under `deny: [.env]` whether or not
     the policy has an allow list. `<<` and `<<<` take a delimiter or a string,
     not a path, and are not checked.
   - `filesystem.allow` is not applied to arguments. Most arguments are not
     paths, and an allow list of paths would deny every search pattern.
   - Where the bridge knows the workspace, an absolute argument inside it is
     made workspace-relative first, as file-tool paths already are on Claude
     Code. An argument that is absolute outside the workspace, or that escapes
     it, cannot be classified by workspace-relative globs and is not denied by
     this check, unlike a file tool's path. Denying every absolute word would
     deny reads such as `ls /tmp` that the exec rules allow, and the argument
     may not be a path at all.
   - Over-denial is accepted here as in decision 3: under `deny: [.env]`,
     `rg -n .env src` is denied, because its pattern reads as the path `.env`.
     The author's remedies are a narrower glob or a different pattern.

6. **Allowlisting an interpreter or command runner warns when the policy
   loads.** The warning names the policy, the entry, and the deny rules the
   entry voids: every `exec.deny` rule, and `filesystem.deny` for reads. It is
   printed by `agents harness run` and by `agents hooks test`, as ADR 0024's
   undispatchable-hook warnings are, and like them it is a warning, not a load
   failure (ADR 0024 §3): a write-capable policy can need an interpreter, and a
   policy that loads today keeps loading. Two classes of entry warn:
   - **Interpreters:** `sh`, `bash`, `zsh`, `python`, `python3`, `node`, `bun`,
     `deno`, `perl`, `ruby` and `git`, when every word after the program is an
     option or could be an option's value, read as decision 3 reads a command: a
     word right after an option with no attached value may be that value.
     `bash`, `python3 -c`, `git`, `git -C` and `git -C /tmp` warn, since each
     admits a payload or alias that runs anything, and so do `python3 -W ignore`
     and `python3 -m pytest`, where the word after the option is taken as its
     value. `bun test` and `git log` do not. An entry that names a script, such
     as `bash script.sh`, does not warn: the script is a file in the repository
     its author can read, and a warning on every interpreter entry would also
     flag `bun test`. Decision 7 names what a script runs as opaque.
   - **Command runners:** `env`, `xargs`, `sudo` and `find`, whatever follows,
     since their arguments are a command or, for `find`, an `-exec` action.

   The list lives in the policy package. Adding a name only adds warnings;
   removing one hides a voided deny list, and needs the same review as a change
   to this decision.

7. **What matching cannot promise is documented.** The policy package's README
   states that exec and argument matching cannot see:
   - a payload behind `-c`, `-e` or an equivalent, or what a script file runs;
   - paths and programs built at run time: globs, variables, and the output of a
     substitution;
   - a path inside another syntax, such as `HEAD:.env` or a URL;
   - a path reached through a symbolic link named by a relative path, which is
     classified by its name, not its target;
   - with no `exec.allow` list, anything run behind an interpreter or runner:
     such a policy's deny list reaches only commands that name the program
     directly or through options.

   A shipped policy whose description states a limit this ADR removes is
   corrected with the implementation.

8. **Supersession.** This ADR supersedes ADR 0006 §2's first enforcement bullet,
   "Exec rules match on word boundaries: deny `rm` blocks `rm -rf` but not
   `rmdir`; equality or `rule + " "` prefix, nothing fuzzier", for deny rules,
   and restates it for allow rules on words (decision 4). The rest of ADR 0006
   §2 stands: the five-verdict model, deny over allow, a non-empty allow list
   denying unlisted commands, cost budgets, and confirmation categories. When
   this ADR is accepted, ADR 0006's status becomes
   `Partially superseded by ADR 0026`.

**Alternatives considered:**

- **Reject a policy that allowlists an interpreter** (#196 option A). It catches
  the mistake when the policy is written, but a write-capable role can need an
  interpreter on purpose, and rejection breaks a policy that does so knowingly.
  A warning tells the author the same thing without breaking it (decision 6).
- **Document the prefix gap and keep prefix matching** (#196 option B). It
  leaves `git -C … push` allowed under `deny: [git push]`, a gap that resolving
  the subcommand closes cheaply once the command is tokenized.
- **Re-evaluate a `-c` payload against the same rules** (#196 option C).
  Quoting, expansion, `eval` and script files defeat it, so a deny list that
  reached into payloads would read as a guarantee it cannot keep. Decision 6
  flags the entry instead, and decision 7 says why.
- **Make the argument check opt-in**, through a per-policy declaration (#104
  option B). Every existing policy would keep saying a path is denied while an
  allowed `cat` reads it. A policy that denies `.env` should deny `cat .env`
  without its author having to know about a second switch, and the check's
  failure mode, over-denial, is the safe one.
- **A table of each program's options**, to tell an option's value from a
  subcommand exactly. It would avoid decision 3's over-denials, but every
  program needs an entry, and a program without one would fall back to some rule
  anyway. The candidate scan fails toward over-denial for every program,
  including ones nobody has listed.
- **OS-level enforcement** (#104 option C, #196 option D). It is the only
  approach that sees what a command does rather than what it says, and it is a
  much larger change. Nothing here precludes it.

**Consequences:**

- #196's `git -C` row and #104's rows deny. The probe in
  `tests/policy-probes.test.ts` that pins `cat .env` and `rg secret .env` as
  allowed becomes a test that they are denied, naming the glob.
- What a policy allows changes in three ways, all but one narrowing. Commands
  that reach a denied program behind options or a path are denied. Allowed
  commands naming a denied path are denied. A chained command with a denied
  segment is denied outright, where under
  `confirmations.requiredFor: [exec.unknown]` it escalated before. The one
  widening is the quoted program of decision 4.
- Some legitimate commands are denied: a pattern that reads as a denied path, an
  option value that reads as a denied subcommand. The denial names the rule, so
  the role can see why and the author can narrow it.
- No policy shipped in `.agents/policies/`, `examples/` or `tests/fixtures/`
  allowlists an entry decision 6 warns on, so none warns. A policy outside this
  repository that allowlists `sh` on purpose loads with a warning.
- `code-review-readonly`'s description, which names the #104 gap as a known
  shared limit, is corrected when the argument check ships.
- A policy with no `exec.allow` list is unchanged in kind: its deny list stops
  only commands that name the denied program, now also behind options and paths.
  Decision 7 says so; a warning for that shape is not part of this ADR.
- This ADR records decisions only. The implementation lands separately, against
  #196 and #104, and depends on #237's tokenizer.
