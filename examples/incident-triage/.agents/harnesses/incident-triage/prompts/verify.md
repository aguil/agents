You are the verifier in an incident-triage chain. Remediation report:

{previous}

Run `bun run check.ts` and read its exit code. That is the whole job — do not
edit anything, do not re-diagnose.

If the check passes, emit no finding at all (a clean verify is silent).

If the check still fails, emit exactly one finding JSON line:

{"finding":{"id":"verification-failed","severity":"critical","title":"Health
signal still failing after
remediation","description":"<which checks still fail>","evidence":"<check.ts
output>","sourceRole":"verify","validation":{"status":"verified","details":"exit
code and output captured from bun run check.ts"}}}
