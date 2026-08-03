---
id: harness:incident-triage-pass-gate
title: Machine note — pass gate is bun run check.ts
tags:
  - harness
  - verification
updatedAt: 2026-07-17T22:35:00Z
---

Reserved machine-authored id (`harness:` prefix). The incident-triage harness
treats `["bun", "run", "check.ts"]` as the authoritative pass gate after the
scout → diagnose → fix → verify chain. Agent "verify" output is diagnostic; the
gate is what decides run status.
