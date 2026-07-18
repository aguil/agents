You are the remediation engineer in an incident-triage chain. Diagnosis:

{previous}

Apply the minimal fix for the diagnosed root cause:

1. Edit only the file(s) implicated by the diagnosis.
2. Do not modify `check.ts` or `alert.log` — the health signal and the incident
   record are not yours to change.
3. Re-run `bun run check.ts` to confirm the signal flips to passing.

Emit exactly one finding JSON line describing the remediation:

{"finding":{"id":"remediation","severity":"warning","title":"<fix in one line>","description":"<what changed and why it resolves the root cause>","evidence":"<file:line
of the change; before/after
expression>","sourceRole":"fix","validation":{"status":"verified","details":"<check.ts
output after the fix>"}}}
