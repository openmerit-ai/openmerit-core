# Website FAQ maintenance

The public FAQ lives in `site/index.html`. Its answers describe implemented behavior verified against main and the published package, including known limitations. Appearance differences between npm 0.1.6 and the hosted/source interface are identified separately in the terminal guide.

## Current factual review — 14 October 2026

Reviewed main against the published `openmerit@0.1.6` artifact and the hosted dashboard/demo. Stable installation includes `openmerit dash`; Pi is optional for the separate comparison workflow. The homepage now introduces the standalone terminal and links the demo guide, which distinguishes fictional hosted samples from the recorded player retained in main.

Updated background scheduling, durable pause, challenger-budget accounting, and terminal data-handling claims. The macOS LaunchAgent requires confirmed persistent execution and infrastructure permission, a logged-in user, and headless Pi authentication. Pause gates automatic work but does not cancel active intents or disable explicit commands. Budget admission and result validation use reported challenger costs; they are not provider billing controls. The terminal indexes supported source/configuration declarations, reads existing application evidence, and retains selected metadata in memory. It does not invoke the coordinator, make inference calls, or mutate model configuration.

Removed obsolete 0.1.5 comparisons and preview release chronology from current public guides. Retained uncertainty, incomplete coverage, supervised-validation limits, and npm-versus-hosted appearance disclosure. The following dated entries are historical records, not the current release contract. The docs and website were subsequently published on 14 October; npm was not changed. See the [publication record](site-publication-2026-10-14.md). Direct root-configuration deployments still require production-source reconciliation.

## Historical reviews

Last factual review: 2026-09-23, against npm `openmerit@0.1.5`, the Pi 0.87 adapter, and the current source. The FAQ contains 13 questions. The earlier audit reproduced a task-triggered assessment while `/openmerit status` reported paused and confirmed the same dispatch path in the published package.

Source review on 2026-09-27: unreleased post-build target detection, harness-inferred user-confirmed metric sampling plans, incumbent and comparison handoffs, setup-time model leads, deterministic core baseline-window checks, macOS Pi LaunchAgent provisioning, and durable pause are under development. The homepage intentionally continues to describe published npm `openmerit@0.1.5`; update it only when a release containing those changes is published and verified.

The experimental `npm run demo` sandbox is a repository-local live-provider demonstration, not a released package workflow. Its end-to-end result and tiny pilot sample do not change the homepage's shipping-behavior or reliability claims.

## Sources to review when behavior changes

| FAQ anchor | Claims to verify | Primary sources |
| --- | --- | --- |
| `faq-agent` | Harness responsibility; limits of result validation | `packages/pi/src/index.ts` (`privateIntentMessage`), `packages/core/src/index.ts` (`interpretIntentResult`), `docs/architecture.md` |
| `faq-harnesses` | Implemented adapters; supported Pi versions | `packages/`, root `package.json` peer dependencies, `docs/adapter-guide.md` |
| `faq-evaluations` | Interactive setup; task-specific instrumentation | Pi `session_start`, core `establish_evals` outcome and observability validation, `docs/getting-started.md` |
| `faq-comparisons` | User objectives; candidate tradeoffs; no promised savings | Core `verifyFrontierSnapshot`, `docs/pareto-spec.md` |
| `faq-evidence` | Required samples; unresolved candidates; evidence trust | Core feasibility and frontier verification, `docs/metrics-and-evidence.md`, `docs/security.md` |
| `faq-approval` | Opt-in automation; zero-capable graduation threshold; post-swap evaluation | Core `nextImprovementAction`, `packages/protocol/src/schemas.ts` (`SupervisedGraduationPolicySchema`), Pi `approve` command |
| `faq-regressions` | Post-swap regression handling; conditional rollback | Core `interpretIntentResult` and `nextImprovementAction`, `docs/lifecycle.md` |
| `faq-background` | CLI lifetime; authorized macOS LaunchAgent; other-platform gaps; product-validation limits | Pi `PI_HARNESS_DESCRIPTOR`, core `buildAutomationPlan`, `docs/automation.md` |
| `faq-pause` | Which automatic dispatches stop; restart behavior; active work | Pi `reportAutomationSignal`, `createInitialUiState`, completion handler and `pause` command; `docs/operations.md` |
| `faq-data` | Project files; Pi session entries; harness/provider data flows | `packages/core/src/store.ts`, Pi `appendEntry` and `privateIntentMessage`, `docs/security.md` |
| `faq-cost` | License; npm availability; provider and infrastructure costs | `LICENSE`, published npm metadata, harness execution path |
| `faq-budget` | Reported challenger ledger, admission/result checks, separate costs, no independent provider-billing cutoff | Core `createOpenMeritIntent`, budget consumers across `packages/` |
| `faq-readiness` | Implemented, tested, and product-validated behavior | `docs/testing.md`, `docs/roadmap.md`, actual product-trial evidence |

## Review during releases and website updates

1. Check the current published npm version and compare its behavior with the answers above. Keep unreleased behavior clearly labeled; update version-specific caveats only when the relevant release is available.
2. Review affected answers whenever adapters, setup, evidence checks, approval, rollback, scheduling, pause, storage, budget handling, or readiness change. Read implementation and meaningful test evidence before strengthening a claim.
3. Keep the linked operational documentation consistent. In particular, a pause fix needs coverage for task signals, measurement signals, session-start signals, lifecycle follow-ups, and restart behavior before the FAQ can promise a complete pause.
4. Check the expanded disclosures at desktop and narrow mobile widths, including keyboard operation, links, and JavaScript-disabled reading. Verify the served FAQ after publishing.
5. Record the reviewed version, date, and any remaining limits here.

## Wording boundaries

- Separate issuing a request from the harness successfully executing it.
- Distinguish structured-result and comparison validation from independent proof that evidence is authentic.
- Describe a budget as a harness constraint until metering and spending cutoffs exist.
- Describe verification as post-swap evaluation, not a guarantee that a change is safe before it is applied.
- Claim local storage only for the relevant OpenMerit files; account for Pi session history and configured external systems.
- Keep ordinary coding checkpoints distinct from task-specific product measurements.

## Inference Terminal — unreleased source, 7 October 2026

Reviewed the homepage evidence, background, data, cost, and readiness claims against the new terminal. It reads existing project metadata and loopback runtime inventory on a bounded interval and samples whole-machine CPU/memory. It makes no inference calls, routes no traffic, runs no evaluations, and stops collecting when its CLI exits. Sample data is labeled and separate. Credential-variable detection reveals provider names only; it never uses credentials for provider calls.

Deployments, reported path hops, shared pools, additional hosts, sites, and racks come from explicit configuration or bounded exports. Source timestamps determine freshness. Agent/task names come only from recorded metadata; source code alone does not establish execution. Full local hostnames are system-reported. Missing identities and readings remain explicit. No network discovery, model verification, routing enforcement, available-headroom guarantee, or per-agent resource attribution is implied.

Top navigation, shared dropdowns, model/service images, path colors, chart interactions, and denser source rows change presentation only. Images and animation libraries are bundled locally. This remains an unreleased command; published package behavior and homepage FAQ claims are unchanged. No homepage wording changes are needed before release.

## Hosted terminal sample — 7 October 2026

The separate `dash.openmerit.site` preview serves generated fictional data and terminal assets only. It has no collector, filesystem access, provider credentials, inference endpoint, upload path, or connection to a visitor's local environment. Public access is by link; noindex is a search-engine request, not authentication. The root site's FAQ and published npm claims remain unchanged. The deployment uses its own Worker and exact custom domain, and does not redeploy the main site or its demo/memo services.

The hosted preview’s dedicated sharing card and `Inference Terminal by OpenMerit` title change presentation only. Its social description still identifies the environment as fictional; homepage FAQ and package claims are unchanged.

## Inference service identity — unreleased source, 8 October 2026

Baseten and Cerebras credential-name detection joins Groq and the existing services. Known HTTPS endpoint overrides identify configuration independently of SDK vendor; unknown overrides suppress credential-name attribution. Only inherited variables are checked, and no credential values or raw URLs reach the snapshot. No cloud calls, account access, source-code scanning, `.env` loading, or physical hardware inference is introduced. Model creators, deployment modes, and accelerator vendor/kind come from explicit metadata. Configured services remain distinct from observed requests. The hosted sample uses fictional examples; package and homepage claims remain unchanged.

## Services inventory — unreleased source, 8 October 2026

Reviewed the new Services view against evidence, background, data, and readiness claims. It reorganizes existing metadata into a service inventory and a secondary environment map. Model creators alone never establish service connections; registry roles are subordinate to explicit roles. Selected-window service counts are nonadditive and configured-only entries remain distinct from activity. Recognized endpoint hostnames can now appear as evidence; deployment identifiers, URL paths, queries, and credential values remain excluded. Collection stays passive. This does not release the CLI or change the homepage FAQ's published-package claims.

## Automatic terminal discovery — unreleased source, 8 October 2026

Reviewed data, evidence, approval, background, and readiness claims. The terminal now checks four fixed project declaration files and bounded known loopback API candidates automatically. SDK presence never establishes usage. Optional Pi session-format-3 metadata needs explicit CLI consent saved outside the repository and tied to canonical project/source paths; session files containing conversation text are parsed only after consent, and only usage metadata is retained. Revocation clears it on the next poll. Activity exports, Pi history, and audit summaries use precedence rather than additive totals. There are no cloud usage calls or general filesystem/process scans. This supersedes the earlier source-only note that `.env` and home history were never read. Published-package behavior, hosted-sample isolation, and homepage claims remain unchanged; no FAQ wording change is needed before release.


## Native-history request counts — unreleased source, 8 October 2026

Reviewed evidence and readiness claims after the dedicated Linux VM run. Overview and model request counts now recognize approved Pi history and retained requests from partially covered sources. Collection and permissions are unchanged. The real run is bounded local-model test evidence, not a claim of universal discovery or production readiness. Published-package and homepage FAQ claims remain unchanged.


## Pi connection names — unreleased source, 9 October 2026

Reviewed evidence and data claims. Pi's existing assistant-message provider ID now supplies its recorded connection name; classification uses the existing unambiguous inventory/runtime matcher. Generic serving-provider fields still do not establish routes, and physical deployments, hidden hops, timing, and agent names remain uninferred. No additional files, credentials, inference calls, or permissions are introduced. Published-package and homepage FAQ claims remain unchanged.


## Environment map coverage — unreleased source, 9 October 2026

Reviewed evidence and readiness claims. The map now selects representatives around every recorded entry connection in the selected window or agent scope. It no longer drops connections behind workload or model layout caps. Larger maps scroll, and represented request/workload coverage remains explicit. This changes presentation only; no inference, discovery, permission, billing, or published-package behavior changes. Homepage FAQ wording is unchanged.


## Complete environment map — unreleased source, 9 October 2026

The map no longer selects representative workloads or models. It groups all retained activity by identical recorded entry connections and lets users expand every member. Request counts and relationships stay complete in collapsed and expanded views. Compact stacks preserve the original map scale and show a real member name with a count of remaining members. Model nodes display reported services and explicitly matched deployment information; absent deployment identities are explained in inspectors. No source scanning, inferred topology, new permissions, or inference calls are introduced. Homepage FAQ claims about the published package remain unchanged.


## Optional graph component experiment — unreleased source, 9 October 2026

The `map=flow` URL flag enables a separately bundled React Flow + ELK renderer over the same retained metadata. The existing map remains the default, with immediate return through Original map. Search and member highlighting change presentation only; grouping, request totals, source collection, permissions, and sample/live separation are unchanged. This is an opt-in experiment, not a claim of production scale or released package behavior. Homepage FAQ wording remains unchanged.


## Existing activity audit — unreleased source, 9 October 2026

Reviewed homepage evidence, data, background, approval, and readiness claims against automatic bounded project JSONL readers and multi-source reconciliation. The terminal now reads supported existing request logs inside the selected project and combines their metadata with approved native Pi usage and explicit feeds. Shared recorded identities prevent double counting; unresolved overlaps and conflicting measurements are disclosed. Pi's bounded file selection increases to 128 sessions; permission scope and revocation are unchanged. No inference calls, provider account ingestion, arbitrary process/database scanning, or framework-wide automatic support is implied. Published package and homepage FAQ claims remain unchanged. VM acceptance evidence is recorded in the internal terminal notes only after the run succeeds.


## Application-only terminal scope — unreleased source, 9 October 2026

Reviewed evidence, data, approval, and readiness claims. The terminal now excludes coding-harness usage: the Pi history reader, saved-grant lookup, and access prompts are removed. Prior history-related entries in this audit are historical and superseded. Application agents, jobs, evaluations, supported request logs, and OpenMerit product-task evidence remain in scope. Explicit development-scoped records are rejected, but unmarked request data cannot be classified by purpose automatically. Runtime inventories and whole-machine measurements remain shared infrastructure evidence, not project-exclusive usage. Published package and homepage FAQ wording remain unchanged; the terminal is still unreleased.


## Terminal test installation — preview, 9 October 2026

Reviewed setup, background, data, and readiness claims. A prebuilt test package on the existing sample domain supports a single global npm install, followed by `openmerit dash` in the selected application directory. The CLI opens the default desktop browser, keeps a printed URL for headless sessions, and falls back to a free loopback port only when no explicit port was requested. Collection scope, file access, and consent boundaries are unchanged. This does not publish or change the stable npm release; homepage FAQ claims remain about the published package. Platform URL-handler code is tested separately from actual desktop acceptance, and preview verification must not be presented as broad production readiness.


## npm terminal preview delivery — published, 9 October 2026

The terminal prerelease is published in the existing `openmerit` npm package as `0.1.6-preview.0` under the `preview` tag. Registry metadata and integrity match the tested package; `latest` remains `0.1.5`. Registry-install acceptance is recorded in the terminal preview deployment record. The compiled package retains core/protocol/Pi exports and uses an explicit dist-directory allowlist so a sample-site build cannot accidentally add hosted assets or a nested installer archive. The standalone domain-hosted packaging path is removed from the source build. This changes delivery only: collection behavior, browser launch, consent, and application scope remain unchanged. Homepage stable-package claims are unchanged.


## Historical terminal activity — published preview, 9 October 2026

Reviewed retention, source coverage, and readiness claims. Published `0.1.6-preview.1` removes the 24-hour age cutoff and offers 7d, 30d, and default All time with earliest/latest retained request dates. Existing byte, file, and record caps remain; All time describes available evidence, never a guaranteed project-lifetime archive. It neither queries provider accounts nor adds persistent collection. Registry metadata and integrity match the tested artifact, and a direct npm installation passed the existing-application and dormant-log acceptance checks in the isolated VM. The `preview` tag now resolves `0.1.6-preview.1`; `latest` remains `0.1.5`. Homepage stable-package claims remain unchanged.


## Project-linked runtime inventory — unreleased source, 9 October 2026

Reviewed application scope, data access, automatic discovery, and compute claims. The source correction removes unconditional Ollama and standard-port probes. A project declaration or explicit terminal configuration must identify the local endpoint before inventory is requested; installed SDKs, inherited shell endpoints, and historical runtime names alone do not establish it. Once linked, the runtime’s available models remain shared inventory, with usage separately sourced from request records. Local compute omits this machine unless an endpoint or explicit deployment links it; declared hardware exports remain supported. The legacy machine snapshot is labeled whole-machine context. npm `0.1.6-preview.1` still has the previous automatic probes until another preview is published. Homepage stable-package claims are unchanged.

### Evidence integrity corrections — unreleased source, 9 October 2026

Reviewed project scope, usage accuracy, passive collection, hardware placement, and completeness claims. The terminal now ignores inherited shell services, requires explicit host links for endpoint placement, retains task summaries separately from all request metrics, preserves unknown status/currency/cost basis, discloses inventory count limits with partial coverage and omitted counts, and distinguishes missing request evidence from a measured zero. These corrections are source-only until another preview is published; npm `0.1.6-preview.1` retains the earlier behavior. Main-site FAQ claims describe the stable package and remain unchanged. No deployment or npm publication is implied by verification.


## Evidence corrections — published preview.2, 9 October 2026

Published `0.1.6-preview.2` with the project-scope and evidence-integrity corrections above; this supersedes the earlier source-only status of those corrections. The release guide and changelog describe this version explicitly; earlier previews retain their documented behavior. The existing VM acceptance preserved 240 original request records and all 125 original project files; two separate, real local Ollama calls were picked up from an application log during passive refresh. A project without declarations exposed no runtime inventory, while an explicit host link matched the VM hostname and Ollama residency response. Registry metadata and artifact integrity were verified, and a direct npm update in the VM retained all 242 current requests and 126 project files across passive refresh. The `preview` tag resolves `0.1.6-preview.2`. The stable `latest` channel and homepage FAQ remain about `0.1.5`; no homepage wording or website deployment is needed for this preview release.


## Terminal review corrections — unreleased source, 10 October 2026

Reviewed homepage evidence, data, background, and readiness claims against the log continuity, request outcome, multi-host residency, and model-detail coverage corrections. Collection remains passive and project-local. Bounded checkpoint verification adds up to 8 KiB of reads per cached JSONL file per poll and retains hashes, not another raw-content cache. It does not guarantee detection of every in-place edit to a large file; the terminal guide states the sampled-region limitation. Conflict reporting preserves source precedence, residency still requires fresh exported evidence, and missing usage stays unavailable. These fixes are source-only; npm `0.1.6-preview.2`, the hosted sample, and stable-package homepage claims remain unchanged. No FAQ wording change is needed.


## Hugging Face endpoint discovery — unreleased source, 10 October 2026

Reviewed evidence, data, background, and readiness claims. Selected-project endpoint declarations can identify Hugging Face dedicated endpoints and its inference router separately. Generic Hub credentials, SDK presence, downloaded models, and inherited shell settings do not establish inference use. Dedicated endpoint subdomains and URL paths/queries are excluded from the snapshot. Detection makes no remote requests or account-history calls and creates no request, model, hardware, or deployment measurements. Recorded names retain their original attribution. The official service mark is bundled locally. These changes are source-only; npm `0.1.6-preview.2`, the VM installation, the hosted sample, and stable homepage claims are unchanged. No FAQ wording change is needed.

## Expanded endpoint discovery — unreleased source, 10 October 2026

Reviewed evidence, data, background, and readiness claims for the shared 39-service endpoint registry. Only selected-project literal declarations are indexed; provider-specific credential names establish configuration, and general cloud credentials or SDK dependencies alone do not establish inference. Endpoint overrides suppress SDK-vendor fallback. Dedicated resource labels and all path/query/fragment data are excluded from snapshots. The service inventory uses the same identity registry, while explicit roles, reported paths, model creators, and actual request metadata remain authoritative. The change adds no cloud calls, account history access, source-code execution, or guessed usage. Custom domains and unlisted forms remain coverage gaps. This is unreleased source work; npm preview.2 and homepage published-behavior wording remain unchanged.


## Endpoint coverage release preparation — 10 October 2026

Prepared `0.1.6-preview.3` to include the three source-only changes above. The public terminal guide now describes this version explicitly, while registry publication remains pending verification. The latest source build passed 47 focused Linux tests in the isolated VM, preserved all 242 saved requests, 41 agent IDs, and 122 task IDs across passive refresh, and left all 126 project files unchanged. Separate endpoint fixtures did not enter the real dashboard. No new inference calls were made. Stable `latest` and homepage FAQ wording remain about `0.1.5`; neither the main site nor hosted sample is deployed by this package release.


## Endpoint coverage — published preview.3, 10 October 2026

Published `0.1.6-preview.3` and verified its npm integrity and `preview` dist-tag, superseding the source-only and release-preparation status above. Direct registry installation on the VM retained all 242 requests, 41 agent IDs, 122 task IDs, and 126 unchanged application files through passive refresh. Endpoint fixtures remained separate from actual history; no inference calls were made. Stable `latest` remains `0.1.5`; no homepage FAQ wording or site deployment changed.


## Repository index — unreleased source, 10 October 2026

Reviewed data handling, evidence, background collection, and readiness claims. The terminal now reads bounded Python/JS/TS and structured configuration syntax within the selected project, including nested dotenv declarations. No code execution, cloud calls, or network probes are added by the index. Local snapshots expose narrow identifiers and relative file/line evidence; a separate opt-in diagnostics command outputs counts only. Declarations, examples, candidates, aliases, and unresolved references remain distinct from actual application usage. Existing activity adapters and runtime-probe authorization remain unchanged. The guide explicitly marks this as unreleased source; npm preview.3 and the stable-package homepage FAQ keep their published scope. No main-site or hosted-sample deployment is implied by local verification.


## Repository index release preparation — 10 October 2026

Prepared `0.1.6-preview.4` to deliver repository indexing and counts-only diagnostics through the existing npm preview channel. The public guide identifies the minimum version and retains the boundaries on static references, recorded usage, supported syntax, and bounded scans. Registry publication and registry-install verification are pending. The VM source-build acceptance retained the existing 242 records; a separate real HF smoke workload added three successful requests and one credit-related failure. Its provider and route metadata were explicitly logged by the test application, not reconstructed from network traffic. Stable-package homepage FAQ claims remain unchanged; no website deployment is included.


## Repository index — published preview.4, 10 October 2026

Published and verified `0.1.6-preview.4`, superseding the unreleased/preparation status above. The npm package integrity matches the tested archive and `preview` points to this version. Direct registry installation and the restarted VM dashboard preserve all 246 real request records and 128 application files across passive refresh, with counts-only diagnostics and package-export checks passing. The release acceptance makes no inference calls; the separate earlier HF test supplied its provider/route identifiers explicitly. Static declarations remain distinct from actual usage. Stable `latest` is still `0.1.5`; homepage FAQ wording and site deployments are unchanged.


## Phased repository indexing — unreleased source, 10 October 2026

Reviewed startup, background collection, data handling, coverage and readiness claims. The source build opens the local dashboard before initial collection and indexes declarations in a dedicated worker. Repository-wide coverage limits become continuing batch budgets; per-file and parser protections remain, along with a worker memory ceiling. Fingerprints and sanitized parser metadata live only in process memory; no project files or persistent source cache are created. Rechecks start 60 seconds after a completed pass, while request/runtime collection keeps its existing interval and limits. Progress and failures remain explicit. The guide separates this unreleased behavior from published preview.4. No homepage FAQ wording, npm publication, or site deployment is implied.


## Phased indexing release preparation — 10 October 2026

Prepared `0.1.6-preview.5` for the existing npm preview channel. The source build passed all 281 verification tests. A separate 5,001-file synthetic repository on the four-core, 4 GiB VM exposed 25,001 references: URL ready in 43 ms, first declarations at about 1 second, full index at 4.1 seconds. An edit/deletion pass reused 4,998 files, read about 9 KiB, and completed in 1.27 seconds. These are fixture measurements, not a universal performance guarantee. The private VM source build preserved all 246 real request records and all 128 application files through passive refresh. Registry publication and installation verification are pending. The guide identifies behavior by minimum version; stable `latest`, homepage FAQ claims, and site deployments are unchanged.


## Phased repository indexing — published preview.5, 10 October 2026

Published and verified `0.1.6-preview.5`, superseding the unreleased/preparation status above. The npm integrity matches the tested archive and `preview` points to this version; stable `latest` remains `0.1.5`. A direct `npm install -g openmerit@preview` on the VM succeeded, and the persistent dashboard now runs that global registry package instead of the temporary source-build override. All 246 real records and 128 application files remain unchanged across passive refresh. Counts-only diagnostics, full JSON output, package exports, and all 61 packaged code/asset/metadata file hashes passed; served browser assets match the release. No inference calls were made. The existing activity/runtime limits and static-declaration evidence boundaries remain documented. Homepage FAQ wording and site deployments are unchanged.


## Hosted sample synchronization — 10 October 2026

Deployed the fictional sample at `dash.openmerit.site` with the preview.5 browser assets and current sample generator. The public data disclosure and sample-only API boundary remain intact; repository scanning, local runtime collection, and phased indexing do not run on visitors' environments. Historical range controls describe the available sample records, not a complete project-lifetime archive. The main-site FAQ and deployment remain unchanged. Live assets, sample counts, read-only API behavior, and desktop/mobile browser checks passed; see [the sample deployment record](site-terminal-preview.md).

## Hosted enterprise comparison — 10 October 2026

Reviewed evidence, pricing and readiness claims. The hosted comparison uses fictional workload volumes and published token rates, clearly labels model assignments as illustrative, and makes no measured quality or latency claim. Unknown costs remain unknown. No changes to local collection, consent, routing, evaluations, billing or the published npm preview are implied. The main homepage FAQ requires no change.


## Insurance comparison evidence and preferences — 10 October 2026

Reviewed the hosted demo's quality, price, privacy and model-selection claims. Replacements now require the selected public benchmark screen and a cost or paired-latency improvement. Publisher point estimates are distinct from application evaluations; missing evidence retains the baseline. Preference conflicts remain visible, including unresolved open-weight baselines under the closed-only option. ZDR is endpoint/account-specific and developer origin is separate from residency. Fictional insurance names and fixed token volumes remain explicit. No local discovery, runtime routing, evaluation-engine, npm or homepage FAQ behavior changes. Deployment verification is recorded separately.


## Expanded comparison selection — 10 October 2026

Reviewed the hosted preference behavior against the public guide. The dated catalog searches 25 offers across six configured services and distinguishes model identity from endpoint pricing and ZDR. A hard no-open-weights conflict blocks the complete After plan and its projected cost. Soft biases can produce identical selections; the UI exposes matches and equality with Default instead of implying arbitrary changes. Benchmarks remain public screening signals, not measured application-quality or endpoint-latency evidence. The main homepage FAQ and published npm behavior require no changes.


### Incomplete comparison plans — 10 October 2026

Reviewed hosted comparison claims after replacing the whole-plan block with a visible partial plan. The closed-weight requirement remains enforced per assignment: unresolved workflows have no After assignment or usage. Qualifying workloads remain inspectable, their subset coverage is disclosed, and complete-plan savings remain unavailable. No local collection, real routing, npm or homepage FAQ claims change.


## Hosted preference comparison expansion — source, 10 October 2026

Reviewed homepage FAQ claims against the expanded fictional comparison. The new application workloads, benchmark cohorts, fixed token profiles and preference-dependent costs affect only the hosted demonstration. They do not establish live model-routing performance, production discovery coverage or a new npm release. Existing public FAQ claims remain unchanged; detailed assumptions and limits are maintained in `inference-terminal.md`.


## Preference overrides — source, 10 October 2026

Reviewed comparison, evidence, approval and regression claims. This change is confined to the fictional hosted comparison: a selected preference may override benchmark and efficiency criteria, with explicit exceptions and truthful prices. It never weakens the live evaluation engine, routing approvals, endpoint compatibility or source collection. No real inference or insurance decision is made. The main homepage FAQ and published npm release remain unchanged. Hosted publication and verification are recorded separately.


## Comparison visual hierarchy — source, 10 October 2026

Reviewed the hosted comparison's presentation. The leading dark panel makes stage controls, fixed token costs and their modeled difference more prominent while keeping override disclosures and evidence visible. Selection and pricing rules are unchanged. No homepage FAQ, npm or live routing claim changes.


## Primary domain migration — preparation, 12 October 2026

The `.ai` migration changes hostnames and mail configuration, not product behavior or readiness. Existing homepage FAQ claims remain unchanged. The protected memo, OTP limits, reader data, and interactive demo must be preserved from the deployed Worker because this checkout lacks parts of the current production source. See [migration operations and verification](site-domain-migration.md) for cutover status; DNS preparation alone does not establish successful publication or email delivery.

## Automatic light and dark appearance — unreleased source, 14 October 2026

Reviewed homepage FAQ claims against the appearance-only change. Device-driven colors affect website reading surfaces, demos, and the Inference Terminal, including charts and overlays. They add no saved theme preference, inference calls, collection, routing, permissions, or billing behavior. No FAQ wording change is required. The terminal guide separates the unreleased source appearance from published preview.5. Website/npm publication is not implied by local builds; the main-app source divergence and integration boundary are recorded in [theme maintenance](site-themes.md).

## Scout — unreleased branch preview, 14 October 2026

Reviewed evidence, comparisons, data, background checks, cost, and readiness claims. Scout adds a separate prompt-only shortlist API and `/scout/` page; it does not change Pi approvals, evaluations, automatic swaps, terminal collection, or the published npm package. Its preview guide explains fixed ranking defaults, source/configuration differences, old visual evidence, missing speed, HTTP-only vision source transport, token-price assumptions, in-memory prompt handling, and hourly refresh lifetime. The homepage gains a navigation link; existing FAQ answers continue describing the terminal and Pi workflow and need no behavioral rewrite. Local checks do not establish a hosted deployment or state-of-the-art recommendation quality.

## Scout launch preparation — 14 October 2026

Reviewed freshness, real-data, privacy, price, speed and recommendation claims against the five-source importer and prompt-only API/MCP tool. The guide now documents independent source recovery, archived measurements, OmniDocBench's actual table version, uncertainty adjustment, and the limits of phrase matching. The page starts with a real empty input. Scout is a separate beta and does not establish SOTA task accuracy. No Pi/npm approval, budget or routing behavior changes. Hosted publication is verified separately.

## Scout publication — 14 October 2026

Scout's page, JSON API and MCP tool are now hosted, with an hourly Worker trigger and independently refreshed real public sources. The homepage navigation and generated documentation were published while preserving the deployed main application. Existing FAQ answers still describe the terminal/Pi workflow; no edits to those behavior claims were required. Publication and verification boundaries are recorded in [the Scout launch record](site-scout.md).
