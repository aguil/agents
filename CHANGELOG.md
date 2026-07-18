# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries from the next release onward are updated by
[release-please](https://github.com/googleapis/release-please) when the release
PR merges. See [docs/release-checklist.md](./docs/release-checklist.md).

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
