---
id: pagination-off-by-one
title: Listing pagination drops the last row of every page
context: auto
tags:
  - incident
  - pagination
updatedAt: 2026-07-17T22:30:00Z
---

When `paginate()` builds a page it uses `cursor + pageSize - 1` as the end
index. Every page therefore silently omits its final item, which matches the
support-desk reports in `alert.log` (export shows 4 of 5; synthetic check
expects 5 and receives 3 across two pages).

The fix is the inclusive end `cursor + pageSize`. Prefer confirming with
`bun run check.ts` after the change — that is the harness pass gate.
