# agents doctor and agents skills

Utility commands for verifying the installation and managing portable skill
playbooks.

---

## agents doctor

Verifies that the running `agents` CLI semver satisfies the `minAgentsVersion`
constraint for each bundled skill in `docs/skills/skills.json`.

```bash
agents doctor
```

Exits `0` when all skills are compatible with the installed CLI version. Exits
non-zero when any skill requires a newer version.

**Environment:**

| Variable     | Description                                                                       |
| ------------ | --------------------------------------------------------------------------------- |
| `AGENTS_CLI` | Path to the `agents` launcher for the version probe (default: `agents` on `PATH`) |

Use `agents doctor` after upgrading the CLI or after adding a new skill to
confirm compatibility before use.

---

## agents skills

Manage portable agent skill playbooks from `docs/skills/`.

### Subcommands

#### `list`

Print the skills manifest (`docs/skills/skills.json`):

```bash
agents skills list
```

#### `install [skill-id]`

Copy one or all skill `SKILL.md` files into `~/.agents/skills/<id>/`:

```bash
# Install all manifest skills
agents skills install

# Install a single skill by ID
agents skills install pr-feedback-response

# Preview what would be installed without writing
agents skills install --dry-run
```

Canonical skill playbooks live under `docs/skills/<id>/` in the `aguil/agents`
repository. After installation they are available at
`~/.agents/skills/<id>/SKILL.md`.

### Skill compatibility

Run `agents doctor` after `agents skills install` to confirm that the installed
CLI version meets each skill's `minAgentsVersion` requirement.

## Related

- [install.md](install.md) — installing the `agents` CLI
- [docs/skills/](../../docs/skills/) — canonical skill playbooks in this
  repository
