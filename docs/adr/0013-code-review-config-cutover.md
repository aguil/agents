# ADR 0013: replace the code-review package path with the config-declared harness (flagged cutover)

**Status:** Proposed (accepted = #73 arc complete; default flip is a separate,
later decision) **Context:** #73 tracks replacing the build-time
`harnesses/code-review` package behind `agents code-review` with a
`harness.yaml`-configured harness. The tier gates defined there are now
evidenced:

- **Tier 1 (capability)** — `.agents/harnesses/code-review/harness.yaml`
  expresses the package's behavior with zero new TypeScript beyond registered
  builtins: `context.providers` (ADR 0010), CEL tier gating (ADR 0011),
  `output.schemas` + finding pipelines (#99), `reporting.template` with the
  byte-identical renderer, and the consensus descope (ADR 0012).
- **Tier 2 (behavioral parity)** — the replay corpus referee (74 recorded
  entries; private corpus repo) in differential mode: **74/74 exact match** on
  deterministic fields (finding identity incl. canonical fingerprint, tier
  selection, status). The recorded-baseline mode holds at 65 match / 9
  adjudicated / 0 unadjudicated (ledger in the corpus repo). The differential
  caught and fixed one real divergence before landing (findings-blind
  pre-combine status composition).
- **Tier 3 (contracts)** — `report.md` renders through the same function
  reference; `result.json`, `events.jsonl`, run layout, and the discovery
  pointer come from the same shared helpers; the CLI surface (worktree
  isolation, `--strict`, `--dry-run`, `--log`, posting, exit codes) is unchanged
  because both implementations return `CodeReviewRunResult`; `agentsd`'s
  `code_review` worker dispatches through the registry with identical work-item
  semantics (#102).
- **Tier 4 (operational)** — policy probe suite (the PR #69 injection/traversal
  classes) proves the expressible enforcement (`code-review-readonly` policy) is
  equal-or-stronger than the incumbent prompt-hint + readOnlyMode model;
  per-hook bridge cost accepted with measurement (ADR 0009); perf envelope
  measured on the corpus (`docs/perf/config-harness-envelope.md`, +10% bound);
  failure-mode parity (partial-role failure, timeout, strict mode) pinned by
  deterministic differential tests.

**Decision:**

1. **The config-declared harness is the replacement path** for
   `agents code-review`, cut over in stages (#73 Tier 5):
   - **Stage 1 — opt-in (shipped, #102):** `--impl config` /
     `AGENTS_CODE_REVIEW_IMPL=config` / user-config `impl`. Repo JSON cannot
     select the path (steering deny list).
   - **Stage 2 — shadow:** operator runs day-to-day reviews with `impl=config`;
     the corpus referee (baseline + differential) is the regression gate for
     every change touching either pipeline; new recordings accumulate from
     config-path runs.
   - **Stage 3 — default flip:** `impl` defaults to `config` in a minor release;
     `--impl package` remains the rollback for one release; the docs/skills
     migration (#92) lands in the same window.
   - **Stage 4 — package-path removal:** `runCodeReview`'s orchestration glue is
     deleted; shared helpers it exports (status composition, tier parsing,
     discovery pointer, vcs defaults) move to their consumers or a shared
     module; the corpus converts to the golden regression suite for the
     surviving pipeline.
2. **Consensus stays descoped** (ADR 0012). The `--consensus > 1` guard on the
   config path holds through the flip; removal of consensus with the package
   path at stage 4 is the default outcome unless a consumer appears.
3. **Prompt files remain the package's own** (`harnesses/code-review/prompts/`)
   until stage 4, when they move under the harness directory — single source at
   every stage, no drift window.

**Consequences:**

- Stages 2–4 are operator decisions gated on real-usage confidence, not on
  further engineering; the arc's engineering deliverables end at stage 1 + this
  ADR.
- Every future pipeline change must keep the corpus referee green (baseline
  adjudications + differential exact-match) until stage 4 converts it to a
  single-pipeline golden suite.
- The `code-review-readonly` policy is expressible but not yet enforced in the
  code-review dispatch (hook enforcement is `agents harness run` machinery);
  wiring enforcement into review runs is future work that the probe suite
  de-risks but this ADR does not schedule.
