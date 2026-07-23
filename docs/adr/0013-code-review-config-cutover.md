# ADR 0013: replace the code-review package path with the config-declared harness (flagged cutover)

**Status:** Accepted — stage 4 complete: `runCodeReview` imperative orchestration
removed; CLI, workers, and replay referee use the config-declared harness only.

**Context:** #73 tracks replacing the build-time `harnesses/code-review` package
behind `agents code-review` with a `harness.yaml`-configured harness. The tier
gates defined there are now evidenced:

- **Tier 1 (capability)** — `.agents/harnesses/code-review/harness.yaml`
  expresses the package's behavior with zero new TypeScript beyond registered
  builtins: `context.providers` (ADR 0010), CEL tier gating (ADR 0011),
  `output.schemas` + finding pipelines (#99), `reporting.template` with the
  byte-identical renderer, and the consensus descope (ADR 0012).
- **Tier 2 (behavioral parity)** — the replay corpus referee (74 recorded
  entries; private corpus repo) replayed config-path runs against recorded
  baselines: **65 match / 9 adjudicated / 0 unadjudicated** (ledger in the
  corpus repo). Differential mode (imperative vs config) was the stage 2–3
  regression gate and is retired with the package path; the corpus is now the
  golden suite for the surviving config pipeline.
- **Tier 3 (contracts)** — `report.md` renders through the same function
  reference; `result.json`, `events.jsonl`, run layout, and the discovery
  pointer come from the same shared helpers; the CLI surface (worktree
  isolation, `--strict`, `--dry-run`, `--log`, posting, exit codes) is unchanged
  because the config runner returns `CodeReviewRunResult`; `agentsd`'s
  `code_review` worker dispatches through the registry with identical work-item
  semantics (#102).
- **Tier 4 (operational)** — policy probe suite (the PR #69 injection/traversal
  classes) proves the expressible enforcement (`code-review-readonly` policy) is
  equal-or-stronger than the incumbent prompt-hint + readOnlyMode model;
  per-hook bridge cost accepted with measurement (ADR 0009); perf envelope
  measured on the corpus for the config pipeline only
  (`docs/perf/config-harness-envelope.md`; regenerate via
  `scripts/config-harness-envelope.ts`); failure-mode parity (partial-role
  failure, timeout, strict mode) pinned by deterministic replay tests.

**Decision:**

1. **The config-declared harness is the only `agents code-review` path** (#73
   Tier 5), shipped in stages:
   - **Stage 1 — opt-in (shipped, #102):** `--impl config` /
     `AGENTS_CODE_REVIEW_IMPL=config` / user-config `impl`. Repo JSON could not
     select the path (steering deny list).
   - **Stage 2 — shadow:** operators ran day-to-day reviews with `impl=config`;
     the corpus referee (baseline + differential) was the regression gate for
     changes touching either pipeline.
   - **Stage 3 — default flip:** `impl` defaulted to `config`; `--impl package`
     remained rollback for one release; docs/skills migration (#92) landed in the
     same window.
   - **Stage 4 — package-path removal (complete):** `runCodeReview` orchestration
     deleted; `--impl` and `AGENTS_CODE_REVIEW_IMPL` removed; shared helpers
     (status composition, tier parsing, discovery pointer, vcs defaults) remain
     on consumers; replay parity and perf envelope target the config pipeline
     only.
2. **Consensus stays descoped** (ADR 0012). `--consensus > 1` is rejected on the
   config path; consensus left with the removed package path.
3. **Prompt files** remain under `harnesses/code-review/prompts/` referenced from
   the harness directory — single source, no drift window.

**Consequences:**

- Stage 4 is complete; further pipeline work keeps the corpus referee green
  (recorded-baseline adjudications + config replay).
- Harness resolution prefers `workspace/.agents` when present; PR reviews
  therefore execute the harness material from the checkout under review unless
  the operator pins a trust anchor with `--agents-dir` /
  `AGENTS_CODE_REVIEW_AGENTS_DIR` (see code-review configuration guide). This
  is intentional for dogfooding and repo-local harness iteration; untrusted PR
  review flows should pin agents dir explicitly.
- The `code-review-readonly` policy is expressible but not yet enforced in the
  code-review dispatch (hook enforcement is `agents harness run` machinery);
  wiring enforcement into review runs is future work that the probe suite
  de-risks but this ADR does not schedule.
