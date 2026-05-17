# Agent playbooks (skills)

Portable Markdown playbooks for workflows that use the **`agents`** CLI (for example `agents code-review` and `agents triage`). They follow the [Agent Skills](https://agentskills.io/) layout (`SKILL.md` per skill directory) so they can be copied or symlinked into tool-specific skill roots.

| Playbook | Directory |
| --- | --- |
| Review / fix loop | [review-fix-loop/SKILL.md](review-fix-loop/SKILL.md) |

**Install (supported path):** from a checkout or after `npm install -g @aguil/agents`, run **`agents skills install <id>`** (see **`agents skills --help`**). Manifest: [skills.json](skills.json).

For host-specific locations (Cursor, Claude Code, OpenCode), see [plans/skills-and-agents-packaging.md](../plans/skills-and-agents-packaging.md).
