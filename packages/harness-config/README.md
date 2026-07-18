# @aguil/agents-harness-config

Loads harness definitions from a `.agents/` directory into the orchestration
types.

Phase 1 scope (deliberately minimal):

- Single-file resolution: `harnesses/<id>/harness.yaml` plus a `policy: <id>`
  reference resolved to `policies/<id>.yaml`. No scopes, profiles, user
  overlays, or CLI-flag merging yet (that is the full AGENTS-1 resolution
  algorithm, planned for a later phase).
- `manifest.yaml` is read only for `enabled.harnesses`.
- Policy files are parsed and carried through for the policy-eval layer; this
  package does not enforce them.
