# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries from the next release onward are updated by
[release-please](https://github.com/googleapis/release-please) when the release
PR merges. See [docs/release-checklist.md](./docs/release-checklist.md).

## [0.4.11](https://github.com/aguil/agents/compare/v0.4.10...v0.4.11) (2026-07-21)


### Fixed

* add packaged code-review harness resolution ([bec1d9f](https://github.com/aguil/agents/commit/bec1d9f9a4b4185e68717228700c3a63340d8741))
* guard all harness install overwrites ([d542c8c](https://github.com/aguil/agents/commit/d542c8c1ae20d627f8d7c20c04d077e533c45184))
* prompt before replacing installed harness ([1dcc973](https://github.com/aguil/agents/commit/1dcc9736ea6d0df8adc15f108dbbd8a53dee2be9))
* remove PR reference from packaged harness ([e1164e0](https://github.com/aguil/agents/commit/e1164e08391bbabeedc64a5eeed268ebf2506a5c))
* satisfy Biome optional chaining lint ([46afe51](https://github.com/aguil/agents/commit/46afe51067831f2d8e5f2a6adee456c4889d14eb))

## [0.4.10](https://github.com/aguil/agents/compare/v0.4.9...v0.4.10) (2026-07-19)


### Fixed

* **mise:** add missing baseline pre-commit lock entries ([be36c03](https://github.com/aguil/agents/commit/be36c0395981f8923d41944806bd3f97e5ed5dd6))
* **mise:** pin python for pre-commit zipapp runtime ([a34b6db](https://github.com/aguil/agents/commit/a34b6db6a0706cfefe383f88b58dd701a1115e21))
* **pre-commit:** align markdown checks with mise toolchain ([c8d4b25](https://github.com/aguil/agents/commit/c8d4b25294b9bea1565e182f168da5354543af7a))
* **pre-commit:** align markdown checks with mise toolchain ([7c4bf10](https://github.com/aguil/agents/commit/7c4bf10a03af2ed25e84ed5fbb40bae6ff2a4eb8)), closes [#65](https://github.com/aguil/agents/issues/65)

## [0.4.9](https://github.com/aguil/agents/compare/v0.4.8...v0.4.9) (2026-07-19)


### Added

* CEL role enablement + triage-tier gating ([#73](https://github.com/aguil/agents/issues/73) Tier 1.2) ([9e9f21a](https://github.com/aguil/agents/commit/9e9f21a6083b43ef5a4fbad8b4ce6b0c4d289421))
* **cli:** collect harness context through declared providers ([#73](https://github.com/aguil/agents/issues/73) Tier 1.1) ([955e7b3](https://github.com/aguil/agents/commit/955e7b31439eb91eb8a1ba85db0bb9bf2a9dbb88))
* **cli:** gate roles on collected context via enablement expressions ([#73](https://github.com/aguil/agents/issues/73) Tier 1.2) ([49fcd9d](https://github.com/aguil/agents/commit/49fcd9d77ba96592321078321c27ad3786a2da64))
* **cli:** opt-in --impl config dispatch for code-review ([#73](https://github.com/aguil/agents/issues/73) Tier 5 stage 1) ([83b9d7c](https://github.com/aguil/agents/commit/83b9d7c0f760d3aabfe2a134e84fa28e41af903f))
* **cli:** render declared reporting template after harness run ([ec252b3](https://github.com/aguil/agents/commit/ec252b39e17bde1324cfeeec926a8327a6515cc4))
* **cli:** wire declared output schemas and finding pipelines into harness run ([b26e449](https://github.com/aguil/agents/commit/b26e449a3183b8d55dd07b9854976b92f57f1c1f))
* code-review as configuration — Tier 1 pass + Tier 2 differential green ([#73](https://github.com/aguil/agents/issues/73)) ([00305a9](https://github.com/aguil/agents/commit/00305a9f85c2cea3575fc6d4e3db34b7e9bcb204))
* **code-review:** config-driven runner with exact package parity ([#73](https://github.com/aguil/agents/issues/73) Tier 2) ([184ac2f](https://github.com/aguil/agents/commit/184ac2ff9dddbc8067be07a2b8ba4c1361d9a80c))
* **code-review:** declarative code-review harness definition ([#73](https://github.com/aguil/agents/issues/73) Tier 1 pass) ([c421cd5](https://github.com/aguil/agents/commit/c421cd53d92d22f0a0623352417fa7066e7d5ce3))
* **code-review:** package-vs-config differential mode in the parity referee ([#73](https://github.com/aguil/agents/issues/73) Tier 2 gate) ([d625367](https://github.com/aguil/agents/commit/d625367be3652575e0c2ad31a84060b470508190))
* **code-review:** replay-parity referee for [#73](https://github.com/aguil/agents/issues/73) Tier 2 differential testing ([f96144c](https://github.com/aguil/agents/commit/f96144c106b6d04290b0078aa714952a55db7525))
* context.providers spec section + builtin provider registry ([#73](https://github.com/aguil/agents/issues/73) Tier 1.1) ([b6bd8fd](https://github.com/aguil/agents/commit/b6bd8fd40497f56b66362c335682e410e40fd9a0))
* **context:** named builtin provider registry ([#73](https://github.com/aguil/agents/issues/73) Tier 1.1) ([a205156](https://github.com/aguil/agents/commit/a205156bb284ef1fad786ce3f90eb72e3c4648f2))
* **harness-config:** CEL role enablement with fail-closed filtering ([#73](https://github.com/aguil/agents/issues/73) Tier 1.2) ([e94080b](https://github.com/aguil/agents/commit/e94080b5df629b780f4a180bd378de875aaffb34))
* **harness-config:** context.providers section in harness.yaml ([#73](https://github.com/aguil/agents/issues/73) Tier 1.1) ([66ab000](https://github.com/aguil/agents/commit/66ab000d222866744c79e7779658818dfd12bceb))
* **harness-config:** output schemas + finding pipelines ([#73](https://github.com/aguil/agents/issues/73) Tier 1.3/1.4) ([2d8841e](https://github.com/aguil/agents/commit/2d8841e29481e62f41f74f709087ed3bd95f60b9))
* opt-in config-harness dispatch for agents code-review ([#73](https://github.com/aguil/agents/issues/73) Tier 3 + Tier 5 stage 1) ([6d17285](https://github.com/aguil/agents/commit/6d172852ee7388d89684be7904262d58323435d2))
* **orchestration:** injected outcome-schema enforcement per role ([b4d82e5](https://github.com/aguil/agents/commit/b4d82e53e51019a9a27358e302c5890b2db2d1dd))
* outcome schemas + finding pipelines ([#73](https://github.com/aguil/agents/issues/73) Tier 1.3/1.4) ([afd7fd3](https://github.com/aguil/agents/commit/afd7fd3c77568ccae7783746a6514b2b7dc21786))
* **policies:** code-review-readonly policy + Tier 4 probe suite ([#73](https://github.com/aguil/agents/issues/73)) ([244f4c6](https://github.com/aguil/agents/commit/244f4c6d6bbf2d745e1dc6c0be87b4e39e0f2e8d))
* replay-parity instrument for [#73](https://github.com/aguil/agents/issues/73) Tier 2 differential testing ([d5ab487](https://github.com/aguil/agents/commit/d5ab4871207a5bef012b83dac5b603b09df59068))
* **reporting,harness-config:** reporting.template builtin renderers ([#73](https://github.com/aguil/agents/issues/73) Tier 1.5) ([3b0e780](https://github.com/aguil/agents/commit/3b0e780aa49bda52627cc801061caaeace59d237))
* reporting.template renderers + consensus descope ([#73](https://github.com/aguil/agents/issues/73) Tier 1.5/1.6) ([4b86b64](https://github.com/aguil/agents/commit/4b86b640125e2626199cde90fe9857e3ca14c208))
* Tier 4 operational gates + cutover ADR ([#73](https://github.com/aguil/agents/issues/73)) ([28084a0](https://github.com/aguil/agents/commit/28084a0329a01bba54ff9237ba2740e1ebc24896))


### Fixed

* **code-review:** exclude timeout-derived warnings from replay status parity ([c0e0094](https://github.com/aguil/agents/commit/c0e00944a917d3c23f2fcc04e390409bb5587103))
* **code-review:** include severity and file in the finding identity key ([0a6f257](https://github.com/aguil/agents/commit/0a6f257cc711769d5ef8a5c5db434189bcdec381))
* **code-review:** reject corpus entry names that escape runs/ ([1084f8e](https://github.com/aguil/agents/commit/1084f8eaa46a47c334eb91d1ccce092a1a4940f3))
* **context:** wall-clock timeout for shell-command collection (default 60s) ([9879a56](https://github.com/aguil/agents/commit/9879a561f2ea8c9ca91bf494827a3550024fc662))


### Performance

* **code-review:** Tier 4 envelope measurement + failure-mode parity ([#73](https://github.com/aguil/agents/issues/73)) ([9399f82](https://github.com/aguil/agents/commit/9399f82e37399e2d6b1f1d42460f27b452c8e9cb))

## [0.4.8](https://github.com/aguil/agents/compare/v0.4.7...v0.4.8) (2026-07-18)


### Fixed

* de-exemplify code-review adapter prompts; reject template-echo finding ids ([#83](https://github.com/aguil/agents/issues/83)) ([a6a6a64](https://github.com/aguil/agents/commit/a6a6a642e37c6c7c212a6369b75b3264e3cac09c))
* **execution:** de-exemplify code-review adapter prompts; reject template-echo ids ([#83](https://github.com/aguil/agents/issues/83)) ([0975c95](https://github.com/aguil/agents/commit/0975c954e7cf94120680f357d0d3b863688782a9))

## [0.4.7](https://github.com/aguil/agents/compare/v0.4.6...v0.4.7) (2026-07-18)


### Added

* ReplayAgentAdapter for recorded-run replay ([#73](https://github.com/aguil/agents/issues/73) Tier 2 groundwork) ([32b7a87](https://github.com/aguil/agents/commit/32b7a871ff9ab3f9159dbf340cee2ab34cfa83f5))

## [0.4.6](https://github.com/aguil/agents/compare/v0.4.5...v0.4.6) (2026-07-18)


### Performance

* bound ShellCommandProvider stdout at the stream ([#67](https://github.com/aguil/agents/issues/67)) ([6010c2a](https://github.com/aguil/agents/commit/6010c2a44cf91377494a6d3df588a8fa38c25bbc))

## [0.4.5](https://github.com/aguil/agents/compare/v0.4.4...v0.4.5) (2026-07-18)


### Added

* **cli:** agents hooks test — synthetic-event policy probe ([047ceb3](https://github.com/aguil/agents/commit/047ceb3336d4493bda1bf34c6813122efb1f3bd1))
* **harness-config,hooks:** spec v0.2 applies_to hook event-class scoping ([9e55422](https://github.com/aguil/agents/commit/9e5542261a04b958605da7e16eefc9cee0640742))
* spec v0.2 applies_to hook scoping, bridge cost measurement, agents hooks test ([#70](https://github.com/aguil/agents/issues/70), [#71](https://github.com/aguil/agents/issues/71)) ([6b868f6](https://github.com/aguil/agents/commit/6b868f646fa9d414d07482043607e8dff9d6bfeb))


### Fixed

* **examples:** de-exemplify incident-triage prompts ([#75](https://github.com/aguil/agents/issues/75) placeholder echo) ([620baac](https://github.com/aguil/agents/commit/620baac496f67ea343f7d3c45b14236a88b87137))
* **orchestration:** dedup role outcomes by id at collection ([#75](https://github.com/aguil/agents/issues/75)) ([5aa3d0d](https://github.com/aguil/agents/commit/5aa3d0db87913a5d06386db64d1684a047fc096f))
* outcome duplication and prompt-placeholder echo from real adapters ([#75](https://github.com/aguil/agents/issues/75)) ([5bf1e83](https://github.com/aguil/agents/commit/5bf1e8396f3666e9d0e4693673633a17320600f0))


### Performance

* **policy:** measure policy-eval bridge cost at code-review scale ([#70](https://github.com/aguil/agents/issues/70)) ([14c410e](https://github.com/aguil/agents/commit/14c410e602691eefef6a7e11d75ece89921835d2))

## [0.4.4](https://github.com/aguil/agents/compare/v0.4.3...v0.4.4) (2026-07-18)


### Added

* **cli:** enforce per-role policy in all execution modes via roleEnv ([60ca345](https://github.com/aguil/agents/commit/60ca345a012b9d97e017c64beb2de5f54ede5e5f))
* env-carried per-role policy enforcement in all execution modes (ADR 0008) ([912858b](https://github.com/aguil/agents/commit/912858bd2aed38fcb8c1c76103e997a18328a8e9))
* **execution,orchestration:** per-role env threading for subprocess spawns ([cc4474a](https://github.com/aguil/agents/commit/cc4474aa9961c23b7eab75804e698d8e3b69a062))
* **hooks,policy,cli:** env-carried policy bridge; role-invariant hook config ([18e845b](https://github.com/aguil/agents/commit/18e845b239720cccbc0c1774146ca3592bb5e33e))

## [0.4.3](https://github.com/aguil/agents/compare/v0.4.2...v0.4.3) (2026-07-18)


### Added

* **cli:** add 'agents harness run' — generic config-driven harness runner ([9a2524f](https://github.com/aguil/agents/commit/9a2524f8d9c44b03daa19e683c8c7d913c5d997d))
* **core,orchestration:** collect generic outcome events from adapters ([afcb4d0](https://github.com/aguil/agents/commit/afcb4d0b21b5c23a3eda2e6d42e9f266c96c05a5))
* **examples:** incident-triage harness definition (pure configuration) ([61c00eb](https://github.com/aguil/agents/commit/61c00ebc4c1c4db2903962b49ed8f1d052fa6adc))
* **examples:** synthetic incident fixture for the triage proof harness ([c8fcb8c](https://github.com/aguil/agents/commit/c8fcb8cf74606fc8678fccb6fa4fdc759a314b16))
* **execution:** parse generic outcome envelopes from adapter output ([8ae1500](https://github.com/aguil/agents/commit/8ae15001348d36310df15cd38b03da4183fd54ec))
* **harness-config,cli:** runtime pass_check gate for chain harnesses ([070e142](https://github.com/aguil/agents/commit/070e1423a0cf39bc3df90ace56ac8785d5b2d921))
* **harness-config:** per-role policy references; reject unknown role fields ([b9ccc8a](https://github.com/aguil/agents/commit/b9ccc8a1a521793ba5514cd4c59481e32e2c1fa9))


### Fixed

* **cli,examples:** regenerate hooks every role; deny governance-surface writes ([2ca8856](https://github.com/aguil/agents/commit/2ca8856ca689dbe286ad9dd19988b49dfe66c6af))
* **cli,orchestration:** enforce each role's policy via per-role hook regeneration ([f2f1e70](https://github.com/aguil/agents/commit/f2f1e7097759b330c37d4bb0e343f4a226a3b25e))
* **cli:** fail closed when a policy cannot be enforced on the chosen adapter ([898c213](https://github.com/aguil/agents/commit/898c2135b0d73a1f1f952d4f16a4525fefd3d86a))
* **cli:** only regenerate per-role hooks for sequential execution modes ([21ddb52](https://github.com/aguil/agents/commit/21ddb522007e41f8a64427e092253dcfe4321515))
* **examples:** deny .cursor and .agents writes in the triage-fix policy ([8a19e60](https://github.com/aguil/agents/commit/8a19e609e06a9fc795e12b56a512a3de52aecd63))
* **examples:** incident-triage prompts emit outcome envelopes, not findings ([38fa078](https://github.com/aguil/agents/commit/38fa07873c0eeaee3cc549139c90242be0e277af))
* **examples:** protect the pass_check target from all roles ([e2393c5](https://github.com/aguil/agents/commit/e2393c584738ee05e38838b4a4846409e10171dd))
* **execution:** extract outcome envelopes from nested agent text ([2520d50](https://github.com/aguil/agents/commit/2520d50035caf136f337fe8ee1e6161878ca4126))
* **hooks:** quote the agents-cli token in the generated bridge command ([ad3e3cc](https://github.com/aguil/agents/commit/ad3e3ccde4b7d31f91ada3737693be851a982097))
* **orchestration:** decouple generalized-harness status from finding severity ([db55053](https://github.com/aguil/agents/commit/db55053b8eadbd0a4b0a0990ffdde7e28c2e33ea))
* **orchestration:** validation-loop convergence drives run status ([0d5b237](https://github.com/aguil/agents/commit/0d5b2376f8c6e17b2576922f4c9e72ea64b523fe))


### Performance

* **cli:** skip hook regeneration when a role's policy is unchanged ([faaee62](https://github.com/aguil/agents/commit/faaee628ff3a1341c9e682b555be096a3af63d9d))
* **execution:** scan nested envelopes in a single pass ([f9e275f](https://github.com/aguil/agents/commit/f9e275f640f689a02a906de6f1bae9b63bb63ea9))

## [0.4.2](https://github.com/aguil/agents/compare/v0.4.1...v0.4.2) (2026-07-18)


### Added

* **cli:** add policy-eval subcommand bridging hooks to the evaluator ([2e7ed4c](https://github.com/aguil/agents/commit/2e7ed4cc44cd38c5abace392831e0185331773d4))
* **harness-config:** load harness.yaml + referenced policy from .agents/ ([78b1d0c](https://github.com/aguil/agents/commit/78b1d0c96fdd05625e474c22c8570fdbcaba5400))
* **harness-config:** parse hooks section from harness.yaml ([c208a45](https://github.com/aguil/agents/commit/c208a45c8bf8d3f5a78e77243c8624b140c96bec))
* **harness-config:** parse policy confirmations for escalate flows ([674e5ba](https://github.com/aguil/agents/commit/674e5ba4314142d7b1a17541f7c4db6de589caa7))
* **hooks:** generate .cursor/hooks.json with builtin policy-eval first ([9a50b20](https://github.com/aguil/agents/commit/9a50b207f01ad72a1cb9ea78058cd5fb0524751e))
* **policy:** native policy-eval with ACS 5-verdict model ([109d82b](https://github.com/aguil/agents/commit/109d82b7aad72a748bc2207a4896df2d3aa27395))


### Fixed

* **cli:** lift nested MCP arguments into canonical policy fields ([9fb3b5d](https://github.com/aguil/agents/commit/9fb3b5d35109bf9706cc63613881158681fcac6e))
* **harness-config,hooks:** validate policy ids; quote bridge command args ([7c6d34e](https://github.com/aguil/agents/commit/7c6d34e9e92bf6dd997f9160c226ad0f5463a0c4))
* **harness-config:** apply token grammar to harnessId path segment ([433aa71](https://github.com/aguil/agents/commit/433aa7106f8910b2f172d1ee7a31788b8c2b9931))
* **hooks:** emit matchers as HOOK_MATCHER env prefix in generated commands ([5963f44](https://github.com/aguil/agents/commit/5963f44253c46139755476531b70ef106baabe63))
* **hooks:** register policy bridge on all mapped tool events ([d2c6a53](https://github.com/aguil/agents/commit/d2c6a53c31cdddcbf8dcf07a633c13bd85f981de))
* **policy,cli:** stop trusting cost state from hook stdin ([e0cde7b](https://github.com/aguil/agents/commit/e0cde7b5b8f92b72ef5b61ca68800b3aeb9a55a7))
* **policy:** normalize file paths before glob matching ([9f7d025](https://github.com/aguil/agents/commit/9f7d025879ad9cb2cdb1a71ccc759d5591bdcb78))
* **policy:** treat shell-chained commands as unlisted in allow matching ([eb3804f](https://github.com/aguil/agents/commit/eb3804fb496be642307eeede303a2d16717ef386))

## [0.4.1](https://github.com/aguil/agents/compare/v0.4.0...v0.4.1) (2026-07-18)


### Added

* **context:** generalize ContextRequest with params; add generic providers ([e2d7dee](https://github.com/aguil/agents/commit/e2d7deef308e58da270f1bf80a5a007ee570db4d))
* **core:** introduce generic HarnessOutcome with Finding as code-review subtype ([b973b67](https://github.com/aguil/agents/commit/b973b6797e18b2b751f4ec4b4ad893a1d5a34a40))
* **orchestration:** add chain and validation-loop execution modes ([65119d9](https://github.com/aguil/agents/commit/65119d91839d3a88d23d9397f0e5c859bf5690ba))
* **workers:** replace hard-coded worker kind switch with a registry ([a0da836](https://github.com/aguil/agents/commit/a0da836191596313faaa4c08a467b9aa6946efd4))


### Fixed

* **context:** bound FileGlobProvider memory and scan time ([1a5ea99](https://github.com/aguil/agents/commit/1a5ea99abf984893c72661d9413b877fc0958ab5))
* **context:** constrain file providers to the workspace root ([990613c](https://github.com/aguil/agents/commit/990613cd9fb73c7d9accc97a95546bccf06fdd9f))
* **context:** read at most maxBytes+1 instead of whole files ([5a46c3c](https://github.com/aguil/agents/commit/5a46c3cb3b2bee7262a306736992c216b7c9096e))
* **context:** resolve symlinks before workspace containment check ([c44df63](https://github.com/aguil/agents/commit/c44df63f8bfc43fd666a9e118a0c5aca65e2d33f))
* **context:** route provider PR/diff inputs through contextRequestParam ([ca27f2f](https://github.com/aguil/agents/commit/ca27f2fb3ef7cb7433bf5b2eb7d048644782a58c))
* **orchestration:** emit outcomes only for execution-configured harnesses ([95380fd](https://github.com/aguil/agents/commit/95380fd70a8c6d637b2c3f5bb81cd7c7a95a5e8e))
* **orchestration:** make chain/truncation comments self-contained ([9f1ab3d](https://github.com/aguil/agents/commit/9f1ab3ddc56389d1419a0c42833af5635fee6c33))


### Performance

* **orchestration:** truncate role output without splitting all lines ([c932291](https://github.com/aguil/agents/commit/c93229121f076a56d67d239e13d9fbd024c1f0e6))

## [0.4.0](https://github.com/aguil/agents/compare/v0.3.0...v0.4.0) (2026-07-17)


### ⚠ BREAKING CHANGES

* **release:** bun run release:tag no longer exists; cut releases by merging the release-please PR.

### Added

* **agentsd:** add long-running work-queue host ([22312a4](https://github.com/aguil/agents/commit/22312a4cadbba25169d717ad13c2dfe65cb4943b))
* **agentsd:** follow-up ship order (interactive PR selection, work-queue hardening) ([444f1e5](https://github.com/aguil/agents/commit/444f1e52d87efafb004a8a157a086f504eded813))
* **agentsd:** interactive PR selection ([#36](https://github.com/aguil/agents/issues/36)) ([f1a797f](https://github.com/aguil/agents/commit/f1a797f2b5ee18f214d9d315b559239a4fa917b5))
* **agentsd:** land Symphony-shaped work-queue platform (PR [#33](https://github.com/aguil/agents/issues/33)) ([f282362](https://github.com/aguil/agents/commit/f28236235b29b1aa6796bc0271c27bc6aa44f148))
* **agentsd:** pluggable MCP invoke via env or command ([#35](https://github.com/aguil/agents/issues/35)) ([a7438bb](https://github.com/aguil/agents/commit/a7438bb38595f956dbd94e96589f552b6b52b681))
* **agentsd:** post-[#43](https://github.com/aguil/agents/issues/43) follow-up ([#35](https://github.com/aguil/agents/issues/35)–[#40](https://github.com/aguil/agents/issues/40), [#47](https://github.com/aguil/agents/issues/47), [#48](https://github.com/aguil/agents/issues/48)) ([639ca6b](https://github.com/aguil/agents/commit/639ca6ba45cf8ed1d3f314ffbb8ad621609eba82))
* **agentsd:** post-PR [#49](https://github.com/aguil/agents/issues/49) shippable E2E ([#35](https://github.com/aguil/agents/issues/35)–[#40](https://github.com/aguil/agents/issues/40), [#51](https://github.com/aguil/agents/issues/51)) ([1f7186d](https://github.com/aguil/agents/commit/1f7186dcf50590bd83fa2947824afac164e17180))
* **agentsd:** reload changed_fields and optional AGENTSD_LOG_FILE sink ([#38](https://github.com/aguil/agents/issues/38), [#40](https://github.com/aguil/agents/issues/40)) ([f2224d6](https://github.com/aguil/agents/commit/f2224d6005f49ec76640daf312e50f3a55aac1e6))
* **agentsd:** selection ingest_reason and monitor context ([#36](https://github.com/aguil/agents/issues/36), [#40](https://github.com/aguil/agents/issues/40)) ([b4cb94e](https://github.com/aguil/agents/commit/b4cb94e0f075b89cecec842c82351d9444ae45ea))
* **cli:** add pr-feedback select ([#36](https://github.com/aguil/agents/issues/36)) ([0c2c219](https://github.com/aguil/agents/commit/0c2c21946b65494dbbd52f2bf5cc3a64796c1897))
* **code-review-post:** extract pending review publish from CLI ([6c8fea0](https://github.com/aguil/agents/commit/6c8fea0dc5afeffa017cad490ec9462f9269ad1e))
* **execution:** add AgentSessionClient and session adapter ([99c1bfa](https://github.com/aguil/agents/commit/99c1bfa4e0ba1da6947291ea08e8f40bb18b73ea))
* **execution:** JSON-RPC app_server session client ([#34](https://github.com/aguil/agents/issues/34)) ([e42c492](https://github.com/aguil/agents/commit/e42c492093e051f1d8a5feb6dedf0b8525270d32))
* **publish:** add code-review and pr-feedback publish gates ([65fe6b9](https://github.com/aguil/agents/commit/65fe6b9dab70c4f817bb979b367f95b8a7579b0f))
* **publish:** add triage counts and GitHub context for publish gates ([f023794](https://github.com/aguil/agents/commit/f0237940ba4b974ba6c846fc2b5ddab6db917340))
* **publish:** execute code-review pending post via agents CLI ([5401ae7](https://github.com/aguil/agents/commit/5401ae7e73cedfb12a941cca2fd6f8e763d96c82))
* **publish:** execute pr-feedback submit and write triage queue ([a8866ca](https://github.com/aguil/agents/commit/a8866ca85ee748d199bbebafe14941bdcd21504e))
* **publish:** selection notification channels ([#36](https://github.com/aguil/agents/issues/36), [#40](https://github.com/aguil/agents/issues/40)) ([bd2edad](https://github.com/aguil/agents/commit/bd2edad23ab5ec3ff4097eee3623a0d17d6cf274))
* **tracker:** add WorkItem model and GitHub/MCP feeds ([d8f278d](https://github.com/aguil/agents/commit/d8f278d6a2bc98b2dd4aad16eef83320ac6c502b))
* **tracker:** PR feedback ingest on review activity fingerprints ([#36](https://github.com/aguil/agents/issues/36)) ([b3487dc](https://github.com/aguil/agents/commit/b3487dcf4a70b157c96bca1c54dd15e2dc12f350))
* **work-queue:** add Symphony-shaped poll, claim, and reconcile ([f49d1a9](https://github.com/aguil/agents/commit/f49d1a92e1a5ef34277af7080ec7f51b0a429e5f))
* **work-queue:** reconcile stalled implementation workers ([2e40804](https://github.com/aguil/agents/commit/2e40804dff8e4cdbfb1a7937ef8985dc23693634))
* **workers,agentsd:** wire WORKFLOW implementation adapter to workers ([44537de](https://github.com/aguil/agents/commit/44537ded3d6177f675d55934c54d2f814edd78e9))
* **workers:** add pr-feedback fix loop after triage ([e821620](https://github.com/aguil/agents/commit/e821620b6dd792cddcebff67713143fd05ab2060))
* **workers:** code-review isolated worktree ([#39](https://github.com/aguil/agents/issues/39)) ([1f380be](https://github.com/aguil/agents/commit/1f380be6e3f9814ca81c3a383e851322ad4f3184))
* **workers:** emit code_review_artifacts_ready on notify publish ([#39](https://github.com/aguil/agents/issues/39)) ([d7a13e9](https://github.com/aguil/agents/commit/d7a13e992fe8c048009d68d25dda20fc449a505d))
* **workers:** PR feedback work report and git commit verification ([#36](https://github.com/aguil/agents/issues/36)) ([a749f05](https://github.com/aguil/agents/commit/a749f05fc3ee1bb4635dfd74b237a27f89a721e6))
* **workers:** route implementation, code-review, and pr-feedback workers ([aa641fb](https://github.com/aguil/agents/commit/aa641fb704e6cb6081246542f1c0c86d2e33d262))
* **workers:** wire publish execution and split worker modules ([a4260c5](https://github.com/aguil/agents/commit/a4260c5640a2c55f6b4794a8f7a4fe8ffaf3d2cb))
* **workflow:** add pr_feedback deny and reload diff helpers ([#36](https://github.com/aguil/agents/issues/36), [#38](https://github.com/aguil/agents/issues/38)) ([58e9b13](https://github.com/aguil/agents/commit/58e9b130c79800292165a53d413ac53350678877))
* **workflow:** add WORKFLOW.md loader, vars, and strict templates ([f1147e0](https://github.com/aguil/agents/commit/f1147e07bbbed6f514a94b5a396a0366b1580554))
* **workflow:** PR feedback policy and selection store ([#36](https://github.com/aguil/agents/issues/36)) ([4cd8a5a](https://github.com/aguil/agents/commit/4cd8a5a6057aea479945b61ec156ba7f2895157d))
* **workspace:** add per-identifier workspaces and hooks ([883278f](https://github.com/aguil/agents/commit/883278f0df792bf2aa3b9368eb4d58dae9ff4df4))


### Fixed

* **agentsd:** constrain monitor context_path to monitor workspace ([161c3e4](https://github.com/aguil/agents/commit/161c3e4281d5fb030883bc25f767087ce0cd9770))
* **agentsd:** expand tilde in monitor workspace paths ([#40](https://github.com/aguil/agents/issues/40)) ([71f1fac](https://github.com/aguil/agents/commit/71f1fac3baf6a8d0017a27532e6c943a1fbee5b3))
* **agentsd:** honor workflowPath and workspacePath in runAgentsd options ([#35](https://github.com/aguil/agents/issues/35)) ([1674705](https://github.com/aguil/agents/commit/1674705b443239e37ea6c00bc94d2e91523f16ca))
* **agentsd:** notify when pending selection set changes ([088d8e0](https://github.com/aguil/agents/commit/088d8e0e7a6d36258ac22f5c681af6331cbcb6b8))
* **agentsd:** refresh code-review adapter on workflow reload ([7bf93fb](https://github.com/aguil/agents/commit/7bf93fb69b2077fa15fc9c0d26ef64c5dc535d8c))
* **agentsd:** refresh monitor context when selection pending empties ([#40](https://github.com/aguil/agents/issues/40)) ([9b7a629](https://github.com/aguil/agents/commit/9b7a629ba27820cefc0f8d8dacdcd0e4dd794f1a))
* **agentsd:** resolve monitor workspace relative to WORKFLOW dir ([#40](https://github.com/aguil/agents/issues/40)) ([c2ae89d](https://github.com/aguil/agents/commit/c2ae89d6bcd90cb91ac58ee56e44d0be13473210))
* **agentsd:** skip unchanged monitor context file writes ([#40](https://github.com/aguil/agents/issues/40)) ([8d2456a](https://github.com/aguil/agents/commit/8d2456a679436c677f0fefb8d81a6e7ec24adb2f))
* **agentsd:** write monitor context only when selection changes ([#40](https://github.com/aguil/agents/issues/40)) ([ce87e6a](https://github.com/aguil/agents/commit/ce87e6a8217700ec309cb8596e9a914a0abbde84))
* **ci:** isolate GitHub Release job with contents write ([3954415](https://github.com/aguil/agents/commit/39544150a572f5c62a8fae5fb5bc331ed0f18633))
* **ci:** require a v*.*.* tag ref before npm publish in release.yml ([bf0d9b0](https://github.com/aguil/agents/commit/bf0d9b026696d1f568b3ec6a79b95d5514c05baf))
* **cli:** add @aguil/agents-workflow dependency for pr-feedback select ([ffb9071](https://github.com/aguil/agents/commit/ffb90714b09a0281238174e5657fcd97cec9b827))
* **docs:** bind notify receiver example to localhost ([2f5714c](https://github.com/aguil/agents/commit/2f5714c51786f140d1dfc7885f5d98acc04eb3fa))
* **execution:** abort subprocess agents when stall signal fires ([#41](https://github.com/aguil/agents/issues/41)) ([edee02c](https://github.com/aguil/agents/commit/edee02cc5c911a14f6a9901a3a56f7c7892866a9))
* **execution:** add signal and timeout fields to session client params ([b81d602](https://github.com/aguil/agents/commit/b81d602b65bdd8bff0a2b8ee25b4497e6729868c))
* **execution:** forward turn timeout and abort in legacy app-server client ([60621ca](https://github.com/aguil/agents/commit/60621cab2a2585fd4a3a6d71deed210686c67509))
* **execution:** JSON-RPC errors, turn timeout, and bounded stderr ([#34](https://github.com/aguil/agents/issues/34)) ([4bfda6a](https://github.com/aguil/agents/commit/4bfda6a707b457ffdcd863e604a941da32349ba0))
* **execution:** parse json_rpc agent.command with shell argv rules ([ea6340d](https://github.com/aguil/agents/commit/ea6340dfb0aa067933b5e59a25b5825dda2cfa40))
* **execution:** preserve workspace paths on session continueTurn ([5f9760c](https://github.com/aguil/agents/commit/5f9760cbfaaf18d288c60d2170a4f9449d0d4850))
* **execution:** remove Codex default from neutral session adapter ([65ccb6b](https://github.com/aguil/agents/commit/65ccb6b9a113f5748a3c99556f4c202b36c13b56))
* **execution:** surface JSON-RPC subprocess failures ([#34](https://github.com/aguil/agents/issues/34)) ([ea6a460](https://github.com/aguil/agents/commit/ea6a460736b3137e3a21a28e379b69d6ea53401e))
* **publish,agentsd:** selection notify, discover_only, and non-blocking poll ([3a47259](https://github.com/aguil/agents/commit/3a47259b3a8009e7f9439a71a4328f96bf755b85))
* **publish:** enforce requireApprovalBeforeSubmit on auto-submit ([99b1628](https://github.com/aguil/agents/commit/99b16289220884cb4d3074577a77ba0e05f235d9))
* **publish:** gate GitHub lookups and abort autopublish on stale PR head ([f7e809f](https://github.com/aguil/agents/commit/f7e809f858d75ef0111b2e6c65fcd72e3f7f4dbb))
* **publish:** mark pr-feedback submit errors as executed failures ([a7af506](https://github.com/aguil/agents/commit/a7af5062fcee7c06dbf6b37a6431afad608a1d95))
* **release:** fail when generate-notes API errors ([eaaf586](https://github.com/aguil/agents/commit/eaaf586e8b0d922edfefe6f597478e339e9cc7de))
* **release:** resolve previous tag from v*.*.* semver list ([e48efd5](https://github.com/aguil/agents/commit/e48efd500e945020ba44fe6ec3cb489829a2b265))
* **tracker:** cap and bound concurrency for PR feedback thread polling ([5fa8d2e](https://github.com/aguil/agents/commit/5fa8d2e3f00c22089e9ee84a37289504e805f6a9))
* **tracker:** parallelize PR feedback fetchStates reconciliation ([3c15ef8](https://github.com/aguil/agents/commit/3c15ef803a060c1e7bf5fe18d59d91528ff65441))
* **tracker:** parallelize PR feedback thread polling ([8497003](https://github.com/aguil/agents/commit/84970035d677c76c226236f16c305e72f4328f3b))
* **tracker:** re-offer unchanged PR feedback when selection retains PR ([#36](https://github.com/aguil/agents/issues/36)) ([10d5cb9](https://github.com/aguil/agents/commit/10d5cb93d1dfa3d4f839de40aedff7fff50e5987))
* **tracker:** skip no-op PR feedback ingest writes between polls ([#36](https://github.com/aguil/agents/issues/36)) ([b55e919](https://github.com/aguil/agents/commit/b55e919fa609e901613cc32f4c3a0a3bd7ab6db4))
* **tracker:** skip unchanged PR feedback ingest; schedule drain retries ([#36](https://github.com/aguil/agents/issues/36)) ([7e9eec2](https://github.com/aguil/agents/commit/7e9eec2126b14034ec4702ad7661a9c15d170b4a))
* **tracker:** target fetchStates to requested PR feedback items ([a1cd123](https://github.com/aguil/agents/commit/a1cd12358d0a6d782f390396ff8614644fbac7f9))
* **tsconfig:** align agentsd path alias with package name ([b5265d2](https://github.com/aguil/agents/commit/b5265d20a03bbad3be33b507bbf95176697a3161))
* **work-queue:** avoid stale dispatch clearing a newer running entry ([aa21a3d](https://github.com/aguil/agents/commit/aa21a3d1bd9c533542ca8721177871f678cdb30e))
* **work-queue:** close PR feedback cycle after successful worker run ([1031a1e](https://github.com/aguil/agents/commit/1031a1e98b0f7ec368e1db739a9ecd77a92a6802))
* **work-queue:** count in-flight dispatches against concurrency limit ([55d5ed2](https://github.com/aguil/agents/commit/55d5ed2329adc2078403b063fe967ece3bb31ade))
* **work-queue:** count in-flight dispatches toward per-feed caps ([ef4db30](https://github.com/aguil/agents/commit/ef4db3049c71f1cbfd86134d1f4c5089c39d823f))
* **work-queue:** do not block poll tick on long-running dispatches ([df5031e](https://github.com/aguil/agents/commit/df5031e12023ebfe660a89b4144823d04de0c9b8))
* **work-queue:** keep claim when scheduling pr-feedback drain retry ([e65f9ff](https://github.com/aguil/agents/commit/e65f9ffaa16978b58de26f200d1187a3fae3c705))
* **work-queue:** parallelize feeds and non-blocking retry dispatch ([af03f96](https://github.com/aguil/agents/commit/af03f96b0198ceb87dfb6eace21b731a4fc456b1))
* **work-queue:** parallelize retry candidate resolution ([e9ca5a0](https://github.com/aguil/agents/commit/e9ca5a0595581e8ca1690337891a60b44922e95e))
* **work-queue:** PR feedback completion, feed-scoped refresh, shutdown drain ([d846660](https://github.com/aguil/agents/commit/d846660c243af9174dbf722def25d2cf687b448a))
* **work-queue:** release succeeded items and cap retry dispatch slots ([22f975c](https://github.com/aguil/agents/commit/22f975c2324f9640a2a3e258624faa74b9d2e78a))
* **work-queue:** reload feeds and hooks on workflow definition update ([e9a62a0](https://github.com/aguil/agents/commit/e9a62a0efd5de29745849ec7be1891e2b765b84f))
* **work-queue:** reload implementation stall timeout on workflow update ([96913a4](https://github.com/aguil/agents/commit/96913a4f0c0cb8f015485eb8e5e0c687082559b2))
* **work-queue:** reuse cached work item for scheduled drain retries ([d6ededb](https://github.com/aguil/agents/commit/d6ededb4e19571bdaf49b5513079043d0d6dc714))
* **work-queue:** serialize poll loop startup ([9f3c368](https://github.com/aguil/agents/commit/9f3c3687ee5f00637468ee2a2b62ff78b46fdbae))
* **work-queue:** skip completion probe when closeWorkItem is false ([#48](https://github.com/aguil/agents/issues/48)) ([0ca47aa](https://github.com/aguil/agents/commit/0ca47aa23e962b6f42ff2bf5e72beab773d8c34b))
* **work-queue:** skip retry candidate lookup when at capacity ([e721b6a](https://github.com/aguil/agents/commit/e721b6aa2505a59dd908df33190ad3975faee028))
* **work-queue:** terminal semantics, stall cancel, and shutdown drain ([#37](https://github.com/aguil/agents/issues/37), [#41](https://github.com/aguil/agents/issues/41), [#38](https://github.com/aguil/agents/issues/38)) ([9ff807d](https://github.com/aguil/agents/commit/9ff807de3c66644774653d7202f289db9901ab4a))
* **work-queue:** use live workspace root and write work-item markers ([7cd3c0b](https://github.com/aguil/agents/commit/7cd3c0baf6566a873ee10ee70f0e74090ab77876))
* **workers:** declare work-queue dep and fail on pr-feedback submit errors ([e134b8b](https://github.com/aguil/agents/commit/e134b8bb30e04f9887a94eb3d4e7338693284dad))
* **workers:** fail when isolated code-review worktree cannot be created ([6c7d02c](https://github.com/aguil/agents/commit/6c7d02c29ec8216b774fb8d35b148170a80692f4))
* **workers:** guarantee isolated worktree cleanup on failure ([7611c3d](https://github.com/aguil/agents/commit/7611c3d08a6588b947be77d01c419998ffb322e5))
* **workers:** verify triage item id in full commit message ([#36](https://github.com/aguil/agents/issues/36)) ([0a2e50a](https://github.com/aguil/agents/commit/0a2e50ad882f5a0deea6e4f6238ef5201f1b4a4e))
* **workflow:** align codex front-matter alias with ADR 0004 ([#42](https://github.com/aguil/agents/issues/42)) ([8c6a5b5](https://github.com/aguil/agents/commit/8c6a5b51ab7150e320653ee159937b62242c6c3a))
* **workflow:** align per-feed max_concurrent keys with work-item kind ([#47](https://github.com/aguil/agents/issues/47)) ([651a70e](https://github.com/aguil/agents/commit/651a70e987ff04dcee1b4e9fdf82ea63f44427b8))
* **workflow:** drop resolved PRs from selection pending list ([2bf91f6](https://github.com/aguil/agents/commit/2bf91f6fc65304add884a637fd90dd9480ef9097))
* **workflow:** parse nested YAML state lists in WORKFLOW front matter ([d376260](https://github.com/aguil/agents/commit/d376260535e45ba086c2dfe08cf134d9ad351802))
* **workflow:** preserve shell command argv for agent.command ([b0b9edc](https://github.com/aguil/agents/commit/b0b9edc74152c7a9001a803a01982509e2e83ab9))
* **workflow:** reject selection approve for non-pending PRs ([3e07e3b](https://github.com/aguil/agents/commit/3e07e3bd6506037def455216693f6fe79145ffcf))
* **workspace:** add work-item markers for workspace-scoped terminal scan ([7105fdb](https://github.com/aguil/agents/commit/7105fdbe042a632e36f731dd44672fe03a149e18))
* **workspace:** reject identifiers that resolve to workspace root ([004f72b](https://github.com/aguil/agents/commit/004f72b32ca2fae5e8770427ee7c930e04ba1129))


### Performance

* **agentsd:** serialize log sink writes and mkdir once ([#40](https://github.com/aguil/agents/issues/40)) ([c82c5b3](https://github.com/aguil/agents/commit/c82c5b3d6291017416eb83fa1460158c89ee0cfb))
* **tracker:** cap startup PR feedback terminal probes ([f28a15b](https://github.com/aguil/agents/commit/f28a15b75dd4d8ec9d93bdb9a9e396a8b496ce94))
* **tracker:** cap startup workspace directory probes for terminal scan ([cc95ccc](https://github.com/aguil/agents/commit/cc95ccc2b9d67059048448ceb337536e49feacca))
* **tracker:** parallelize PR feedback terminal startup scan ([5d606bd](https://github.com/aguil/agents/commit/5d606bd361cecf51f3430c3161f7433d5edeb898))
* **tracker:** scope PR feedback terminal fetch to marked workspaces ([54f5123](https://github.com/aguil/agents/commit/54f5123981d6e3a35ac4f023f407b7beced84c4e))
* **tracker:** tick-scoped PR feedback document read cache ([#51](https://github.com/aguil/agents/issues/51)) ([0b04a71](https://github.com/aguil/agents/commit/0b04a71670ecb320c83ff3189f231f7253bda488))
* **work-queue,tracker:** completion refresh skip and capped terminal scan ([f49411b](https://github.com/aguil/agents/commit/f49411b70ff7909a95858797485808f78882ce21))
* **work-queue:** O(1) per-kind running counts for feed caps ([4ff872a](https://github.com/aguil/agents/commit/4ff872a4aaa627cd78925e69ce9a3ccf5063dc96))


### Changed

* **orchestration:** add HarnessOrchestrator and WorkQueueOrchestrator aliases ([6ae3688](https://github.com/aguil/agents/commit/6ae36888ab817dee68dbc600fd9a66c46690dc2f))


### Miscellaneous

* **release:** drop manual annotated-tag release path ([d088f0a](https://github.com/aguil/agents/commit/d088f0a3a53804c0f3e7849c0c7682691d4d165d))

## 0.3.0 and earlier

Releases up to and including
[v0.3.0](https://github.com/aguil/agents/releases/tag/v0.3.0) were tagged
manually; see the [GitHub Releases](https://github.com/aguil/agents/releases)
page for their notes.
