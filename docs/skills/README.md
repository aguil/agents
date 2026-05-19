# Agent playbooks (skills)

Portable Markdown playbooks for workflows that use the **`agents`** CLI (for
example `agents code-review` and `agents triage`). They follow the
[Agent Skills](https://agentskills.io/) layout (`SKILL.md` per skill directory)
so they can be copied or symlinked into tool-specific skill roots.

**Install scope:** **`agents skills install <id>`** copies **`SKILL.md` only**
into **`~/.agents/skills/<id>/`**. Extra files under **`docs/skills/<id>/`**
(e.g. **`scripts/`**) are **not** installed unless you extend the CLI or symlink
the whole directory yourself—keep portable snippets in **`SKILL.md`**, or add a
first-class CLI command for interactive workflows.

| Playbook                           | Directory                                                  |
| ---------------------------------- | ---------------------------------------------------------- |
| Self-review checks (draft → ready) | [self-review-checks/SKILL.md](self-review-checks/SKILL.md) |
| Code review (PR assignment inbox)  | [code-review/SKILL.md](code-review/SKILL.md)               |

**Check CLI vs playbooks:** **`agents doctor`** (see
**`agents doctor --help`**). **Install (supported path):** from a checkout or
after `npm install -g @aguil/agents`, run **`agents skills install`** (all
manifest skills) or **`agents skills install <id>`** (see
**`agents skills --help`**). Manifest: [skills.json](skills.json).

For where hosts load skills from, see vendor docs (paths are on the operator’s
machine or workspace): [Cursor Agent Skills](https://cursor.com/docs/skills),
[Claude Code skills](https://docs.anthropic.com/en/docs/claude-code/skills),
[OpenCode config](https://open-code.ai/en/docs/config).
