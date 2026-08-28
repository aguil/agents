# Model routing

Provider-agnostic guidance for this repository and for repositories that run
harnesses defined here. Any automated or human contributor should follow this
when choosing, configuring, or recommending a model for harness work.

This repository defines the harness and documents the convention. A target
repository (one that runs a harness against its own code) holds the actual
routing preferences, using the mechanisms below.

## What the harness does and does not enforce

The harness supports exactly **one adapter and one model per run**, shared by
every role. Role definitions (`harness.yaml`, `.agents/agents/<id>/agent.md`)
have a closed key surface with no `model` or `adapter` field, and adding one is
rejected by validation. There is no per-role enforcement; anything role-shaped
below is a **preference**, honored where a tool or an LLM is in a position to
honor it.

## Routing layers, strongest first

1. **Harness run configuration** — enforced, global per run. The code-review
   CLI's `--model` flag, `AGENTS_CODE_REVIEW_MODEL`, or the `model` key in user
   or repo `.agents-code-review/config.json`. When set, the adapter passes
   `--model` to the spawned tool and overrides everything below.
2. **Workspace-native tool settings** — enforced by the spawned tool, not by the
   harness. Adapters spawn with the workspace as the working directory, so the
   target repo's own tool config applies whenever the harness does not pass
   `--model` (always true for `agents harness run`, which sets no model):
   - Claude Code: `model` in `.claude/settings.json`; per-agent-type `model:`
     frontmatter in `.claude/agents/*.md`.
   - opencode: model and per-agent models in its own config file.
3. **Advisory preferences** — this rule and its counterpart in the target repo.
   Read by LLM contributors as prompt context. They cannot change the model the
   current session runs on, but they steer every choice an agent makes: which
   model to pass when launching subagents, which model to write into generated
   config, which model to recommend to a human.

Do not present a layer-3 preference as a guarantee. If a task requires that a
specific role provably runs on a specific model, say that the harness cannot
enforce it today and route through layer 1 or 2 instead.

## Declaring preferences in a target repository

A target repo states its routing preference in its own
`.agents/rules/model-routing.md` (mirrored under `.claude/` for tools that read
that tree), as a table of role-or-task to preferred model:

```markdown
| Role / task            | Preferred model     | Fallback        |
| ---------------------- | ------------------- | --------------- |
| code-review (all)      | <strongest model>   | <default model> |
| implementation         | <default model>     | —               |
| mechanical / bulk edit | <inexpensive model> | <default model> |
```

Keep model identifiers exact (the string the tool accepts, e.g. a full model id
or a provider/model pair), and prefer naming a tier ("strongest available",
"inexpensive") plus the current concrete id, so the table survives model
releases with a one-line edit.

LLM contributors in that repo should honor the table whenever they control a
model choice — subagent launches, generated settings files, harness invocation
commands they compose — and should surface, not silently ignore, a conflict
between the table and an explicit user instruction.

## In this repository

When working on the harness itself, apply the same discipline: any generated
example config, docs snippet, or test fixture that names a model should use a
current, real model identifier, and changes to how model or adapter values flow
(CLI flags, adapter options, spawn argv) must update this rule if they change
which layer wins.
