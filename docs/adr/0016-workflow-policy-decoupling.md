# ADR 0016: decouple `WorkflowDefinition` from harness policy configs, but not into `.agents/policies/`

**Status:** Accepted

**Status history:**

- 2026-07-26 — Proposed.
- 2026-07-26 — Accepted: merged in #141. Clause 7's deferred implementation is
  tracked by #144.

**Context:** `WorkflowDefinition` — the parsed form of an agentsd `WORKFLOW.md`
front matter block — carries two harness-specific fields:

```
packages/workflow/src/types.ts:62  readonly prFeedbackPolicy: PrFeedbackPolicyConfig;
packages/workflow/src/types.ts:63  readonly codeReviewPolicy: CodeReviewPolicyConfig;
```

This is the last place in the repository where adding a harness means editing a
core type. Issue #135 asks whether to finish the extraction that was originally
intended — move the configs into `.agents/policies/*.yaml`, reference them by
ID, and re-home the two fields as harness-contributed extensions under a
`x.harness` key — or accept the coupling and record why.

Looking at what is actually there changes the question. Four findings.

**The intended destination holds a different kind of thing.**
`.agents/policies/*.yaml` files conform to `PolicySpec`
(`packages/harness-config/src/index.ts:40-55`): capability governance, with
`capabilities.filesystem/exec/network` allow and deny lists, `limits.cost_usd`
and `limits.timeout_ms`, and `confirmations.requiredFor`. Every file in the
directory has that shape — `.agents/policies/code-review-readonly.yaml` and the
example harness's `triage-readonly.yaml` and `triage-fix.yaml`. What the two
`WorkflowDefinition` fields hold is unrelated: `PrFeedbackPolicyConfig`
(`packages/workflow/src/pr-feedback-policy.ts:8-18`) is a `profile` of
`interactive | unattended | discover_only`, PR-identifier allow and deny lists,
notification channels, a webhook URL, monitor paths, and an approval flag;
`CodeReviewPolicyConfig` (`packages/workflow/src/code-review-policy.ts:1-4`) is
two booleans, `useWorktree` and `publishWithFindings`. The word "policy" is
doing two jobs. One is "what is this agent permitted to do", enforced by the
evaluator and the hook bridge. The other is "how should this workflow behave".
Filing the second under the first would either overload `PolicySpec` with fields
the evaluator ignores, or put a second incompatible schema behind the same
loader and directory — and the existing filenames already read as capability
policies, so a `pr-feedback-unattended.yaml` sitting beside
`code-review-readonly.yaml` invites exactly the wrong inference.

**The extension mechanism does not exist, and one is not needed.** No
`x.harness` key, `x.`-prefixed extension convention, or extension record appears
anywhere in the loader or the workflow types. ADR 0012 descoped the nearest
thing, `extensions.post_run`. So "re-home them under `x.harness`" is not a move;
it is designing and building a mechanism first. But `WorkflowDefinition` already
has an untyped bag: `config` (`packages/workflow/src/types.ts:55`) holds the raw
front matter. The parsers that produce both policy objects
(`parsePrFeedbackPolicy`, `parseCodeReviewPolicy`) already run against exactly
that data at `packages/workflow/src/load-workflow.ts:106-107`. Anything a
consumer needs is reachable today without a new spec surface.

**The coupling is moderate and concentrated.** Roughly eight to ten production
sites name the two properties, across four packages. `prFeedbackPolicy` is read
by `packages/agentsd/src/pr-feedback-selection.ts:26` (the substantial consumer
— deny filtering, profile gates, cooldown, notification, approval),
`packages/agentsd/src/index.ts:68` for the deny list it forwards to
`createWorkFeeds`, `packages/agentsd/src/index.ts:163` for a startup log line,
and `packages/workers/src/pr-feedback-worker.ts:50`. `codeReviewPolicy` is read
by `packages/workers/src/code-review-worker.ts:52` for `useWorktree` and by
`packages/workflow/src/workflow-reload-diff.ts:39-48`, which compares both by
JSON equality to label reload diffs. This is not a spiderweb; the cost of
extraction is not call-site count.

**One consumer is a genuine entanglement.**
`codeReviewPolicy.publishWithFindings` does not stay in the harness layer: at
load time it is folded into publish configuration, where
`packages/workflow/src/load-workflow.ts:226-228` uses it to set
`publish.codeReview.requireEmptyTriage`. That inversion has to go somewhere
deliberate. It is the only part of this change that is not mechanical rewiring,
and it is the part most likely to be broken silently, because nothing about the
resulting publish behavior announces which knob set it.

**Decision:**

1. **The coupling is removed, not accepted.** `prFeedbackPolicy` and
   `codeReviewPolicy` come off `WorkflowDefinition`. The goal it serves — adding
   a harness touches no core type — is worth the moderate cost established
   above, and this is the last obstacle to it.

2. **`.agents/policies/` is rejected as the destination.** That directory holds
   capability policy conforming to `PolicySpec`, evaluated by `packages/policy`
   and enforced through the hook bridge. Workflow behavioral configuration is a
   different kind of object with no evaluator, no verdicts, and no enforcement
   path, and it is not filed there. This clause is a prohibition on the
   destination, not on the extraction.

3. **No `x.harness` extension mechanism is introduced.**
   `WorkflowDefinition.config` is already the untyped passthrough of front
   matter, and both parsers already read from it. Adding a second, parallel
   extension surface would create two ways to express the same thing.

4. **Each harness owns its own configuration parsing.** A harness that needs
   workflow configuration reads it from `definition.config` and parses it with a
   parser that lives in that harness's own package, not in `packages/workflow`.
   `parsePrFeedbackPolicy` and `parseCodeReviewPolicy` move to the packages that
   consume them, along with their types and the `WORKFLOW.md` keys they read.
   The authoring surface — `policy.pr_feedback` and `policy.code_review` in
   front matter — is unchanged, so no existing `WORKFLOW.md` needs editing.

5. **The `publishWithFindings` fold moves with its consumer and stays
   explicit.** Deriving `publish.codeReview.requireEmptyTriage` from a
   code-review knob at workflow-load time is the one behavior that cannot be
   mechanically relocated. It moves to the code-review path along with the rest
   of the config, and the implementing change must include a test that pins the
   resulting publish behavior, so an accidental default change is caught rather
   than shipped.

6. **"Policy" is disambiguated in naming from here on.** `PolicySpec` and
   `.agents/policies/` keep the term for capability governance. Harness
   behavioral configuration uses a different word in new type names, file names
   and documentation. Existing names are not renamed by this ADR; the rule
   applies to what is written next, including the types relocated under clause 4
   if the implementing change chooses to rename them.

7. **This lands in a later pass, not this one.** The pass that produced this ADR
   is decisions plus two loader items, and the work under clauses 1 and 4 is a
   focused change to agentsd and worker wiring with no dependency on either. A
   follow-up issue tracks it, blocked on nothing. Until it lands, the coupling
   stands as described here — a known, sized, and scheduled debt rather than an
   open question.

**Consequences:**

- Issue #135's framing is partly answered in the negative. The original intent
  named a destination and a mechanism; both are rejected, for reasons that only
  became visible on inspecting what `.agents/policies/` actually contains. The
  outcome it wanted — no core-type edit per harness — is preserved, reached by a
  cheaper route.
- Clause 4 makes `packages/workflow` smaller and more general: it parses the
  workflow envelope and hands the harness-specific remainder through as
  `config`. That is the boundary the package's name implies and does not
  currently hold.
- Type safety at the `WorkflowDefinition` boundary is traded for locality. Today
  a malformed `policy.pr_feedback` block fails at workflow load for every
  workflow; afterwards it fails when the consuming harness parses it. The
  parsers are unchanged and still validate, so nothing becomes unvalidated — but
  the failure moves later and becomes per-harness. For an unattended daemon that
  is a real regression in feedback timing, and the implementing change should
  parse eagerly at startup for enabled harnesses rather than lazily at first
  use.
- `packages/workflow/src/workflow-reload-diff.ts:39-48` currently labels reload
  diffs `policy.pr_feedback` and `policy.code_review` by comparing the typed
  fields. With the fields gone it must compare the corresponding `config`
  subtrees instead. The labels can be preserved; this is called out because it
  is the one site where the change is not a simple redirect and where losing the
  label would silently degrade an operator-facing signal.
- `defaultPrFeedbackPolicy`
  (`packages/workflow/src/pr-feedback-policy.ts:20-33`) is exported from the
  package barrel and has no in-repo consumer. Moving it between packages is a
  breaking change for any external consumer, so the implementing change is a
  breaking commit under the conventional-commits rule in
  `.agents/rules/conventional-commits.md`.
- ADR 0013 is untouched. Its cutover concerned the code-review execution path;
  these fields are agentsd workflow configuration, and the two were never the
  same coupling despite both being described as code-review policy.
- Clause 6 accepts a period of inconsistency: the repository will contain both
  the old naming and the new. That is preferable to a rename sweep across
  `PolicySpec`, the `.agents/policies/` directory, and the CLI surface, which
  would be a large breaking change bought for clarity alone.

**References:**

- ADR 0012 — the `extensions.post_run` descope, which is why no extension
  mechanism exists to re-home these fields into.
- ADR 0013 — the code-review config cutover, distinct from this coupling.
- ADR 0014 — ADRs are standalone; the reason this ADR inlines rather than cites.
- ADR 0015 — the harness spec is project-local; the schema is its normative
  description. Clause 2 here keeps workflow configuration outside that spec
  surface.
- Issue #135 (this decision).
