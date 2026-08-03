---
id: support-desk-missing-last-row
title: Support pattern — last row missing on every page
tags:
  - support
  - pagination
  - incident
updatedAt: 2026-07-17T22:10:00Z
---

Tickets 48211 and 48214 describe the same shape: page N looks full until a
customer counts rows, then the last record of that page is gone. It is easy to
misread as a cursor hand-off bug between pages; the synthetic check
(`list-pagination`) failing with `expected_items=5 received_items=3` is the
stronger signal that each page is short by one.
