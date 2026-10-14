# Scout publication — 14 October 2026

Scout's beta is published at `https://openmerit.ai/scout/`. It accepts real prompts through the page, `POST /scout/api/recommend`, and the remote Streamable HTTP MCP endpoint `/scout/mcp`. The MCP tool is `scout_models`. This is separate from the npm package and Inference Terminal; no npm release was made.

## Launch services

- Scout Worker: `openmerit-scout`, version `b2e1028c-76e3-4dbe-84e3-99e3bc4030d7`.
- Domain router: `openmerit-domains`, version `ed1d3c26-5c81-4c7c-aabf-f1b35b0149f5`. Only `/scout` and `/scout/*` use the new service.
- Main website: `openmerit-site`, version `338e4337-7d37-48d8-b64b-ec980ab9fe71`, publishes the homepage navigation link and generated documentation. Its application modules, bindings, storage, containers, and asset-routing settings were preserved from the deployed version.
- Dashboard service is unchanged.

The Scout Worker has one SQLite Durable Object, a bundled real-data snapshot, static assets, and a cron at `7 * * * *` UTC. Its production bootstrap refreshed all five sources successfully at `2026-10-14T15:42:58.432Z`. The resulting snapshot survived the following Worker deployment. A local scheduled-event invocation also refreshed and persisted the index. The cron was registered during deployment; the first production cron tick was not awaited for this publication record.

At that successful collection, the index contained 137 benchmark series, 101 with results matched to available models, 211 evidence-backed models, and 3,838 aggregated measurements. These counts are live metadata, not a permanent coverage promise. Data is real, but old/undated evidence remains labelled. The beta does not establish SOTA task-selection quality; see the maintained [Scout guide](scout.md) for ranking, scope and data limits.

## Verification

The repository verification passed before publication. Focused checks additionally cover source outage recovery, new document results, catalogue removals, English task phrases, text-only extraction, frozen-clock handling, MCP validation, and routing isolation. A real MCP SDK client (version 1.32.1, installed only in a temporary verification directory) initialized, discovered the tool, and called it against both the Worker URL and the public domain.

Live API checks returned five distinct candidates for invoice extraction, coding, research, support writing, long-document summaries and text extraction. Observed Worker-URL round trips were approximately 170–460 ms across six requests; one browser request through the public domain took 173 ms. These are samples from this environment, not latency guarantees. Cloudflare's clock does not advance during synchronous computation, so unavailable server ranking time is `null`, never reported as a measured zero.

Browser checks exercised typed prompts, Enter submission, examples, evidence expansion, the capability index, agent connection details, unsupported tasks, and copy feedback. Desktop and a 433 CSS-pixel viewport rendered without horizontal overflow; physical mobile hardware was not tested. Main-site navigation, documentation search assets, legacy redirects, memo gating and the demo/dashboard routes were checked after publication. No OTP email or paid inference session was started.

## Publication boundaries and rollback

Do not deploy the older root `wrangler.jsonc` as a shortcut. The main application source still diverges from production; see [the earlier publication record](site-publication-2026-10-14.md). This launch downloaded the active main-site modules and changed only public assets. Existing interactive-demo scripts/styles, memo access script and shared styles were checked against live assets before activation.

The prior main-site version was `62ac686b-2895-4263-8e55-053119d2eb27`; the prior domain-router version was `7e5cbee3-1c26-4cb8-afd6-07b6a092ee31`. They remain rollback references. Reverting the domain router removes the Scout public route; the separate Worker can remain deployed during investigation.

Private operational snapshots, metadata, publication scripts and deployment responses are under `/private/tmp/openmerit-scout-publication-20261014/`. Do not commit credential-bearing operational metadata. Scout source and configuration live on `codex/scout`. The guide is labelled Hosted beta and links to its published Markdown; GitHub main-branch source/edit links are omitted for Scout until that guide is merged to main. Future Scout-only application deployments use `wrangler.scout.jsonc`; documentation changes must also publish the generated main-site docs through the preserved-application workflow.

## Comparison table — published 14 October 2026

The results now use a native HTML table with reusable table styles, following the [shadcn Table composition](https://ui.shadcn.com/docs/components/base/table) within the site's existing HTML/CSS/JavaScript stack. This adds no browser framework or table library. Ranking and API/MCP contracts are unchanged.

| Before | After | Why |
| --- | --- | --- |
| Separate grid headers and expandable cards | Semantic column headers, row headers and aligned numeric cells | Keep comparisons aligned and expose table structure to assistive technology |
| Repeated labels beneath each metric | Units in the column headings | Reduce visual noise while preserving price and speed context |
| Provider names alone | 27 locally bundled provider favicons with text fallback | Recognize labs without third-party image lookups |
| Mobile cards | Horizontal table scrolling with a sticky model column | Preserve comparable columns on narrow screens |
| Entire row as disclosure | Named Evidence buttons with expanded state and associated detail rows | Make the evidence action explicit and keyboard accessible |

The favicon registry matches explicit catalogue namespaces, not arbitrary provider strings. Origins and hashes are recorded in `scout/provider-assets.json`; several publisher SVG favicons were rasterized to PNG. Unknown namespaces or failed images retain a text initial. Model labels remain visible beside decorative icons. Loading states retain the previous table height, and scroll guidance appears only when the table actually overflows.

Published Scout Worker version `bb0fc221-b9dd-4e42-8d27-3b5fec7b5d02` and main-site documentation version `9c557935-f896-4ad1-95f6-473794b36433`. The domain router is unchanged. The main-site update changed documentation assets only and preserved application modules, bindings, storage, containers and routing. Operational snapshots are in `/private/tmp/openmerit-scout-table-publication-20261014/`. Previous Scout and main versions in the launch section remain rollback references.

`npm run verify` passed all 330 tests; focused Scout checks passed again after the final presentation adjustments. Browser checks covered real coding/invoice searches, an unsupported task, Enter/Space evidence toggles, copying a model ID, loaded provider images, and narrow layouts down to 320 CSS pixels without page overflow. Expanded evidence remains readable at the viewport width even when the table is scrolled. Live desktop and 433 CSS-pixel checks passed with no browser errors; physical mobile hardware was not tested. All 34 updated page, style, script, guide and icon assets matched the live domain byte-for-byte. The production index remained healthy at its successful `2026-10-14T16:07:59.287Z` hourly refresh.

## Decisions, tool calling and memory — published 14 October 2026

Scout Worker `e80dca5a-64e7-443d-8216-5d5e781596a5` now uses one server-side OpenAI Decisions request for prompt interpretation across the page, JSON API and MCP tool. The existing environment key was installed as the Scout Worker's `OPENAI_API_KEY` secret; no key is shipped to browsers. Main-site documentation version `d637a04e-3d5c-4990-a296-6429ec1efb62` publishes the guide and data-handling changes. The domain router is unchanged. The main application modules were captured and verified byte-for-byte unchanged; bindings, storage, containers and routing were preserved.

The production interpreter fixes the tested incidental-tool/fictional-agent and unrequested-JSON false positives, distinguishes session and persistent memory, exposes consequential uncertainty, and validates typed answers before ranking. Provider failures return an unavailable error instead of keyword results. Shared in-memory admission is bounded to eight concurrent calls and 120 starts per minute, with a four-second provider timeout and no automatic retries. These are service load limits, not durable account spending caps.

BFCL v4 adds six correlated series: three native function-calling evaluations and three external-memory backends. Model matching is conservative, original configurations and unknown measurement dates are retained, and all six series share one benchmark-family identity. Required memory and tool use now enforce declared tools support and direct evidence; compact MCP responses keep qualifying evidence visible. The fixed 80/13/7 ranking formula remains unchanged.

At verification the healthy six-source snapshot was `2026-10-14T17:05:42.081Z`: 213 indexed models, 143 benchmark series, 107 series with matched results, and 4,003 measurements. BFCL contributed 132 measurements across 22 matched models; 20 also declared tools support and were eligible for persistent-memory tasks. The hourly trigger remains minute 7 UTC. Counts and rankings can change as feeds update.

Validation:

- `npm run verify`: all 340 tests passed. New tests cover observed false positives, invalid/refused answers, provider timeout/failure, request admission, memory/tool filters, BFCL parsing and recovery, and shared API/MCP behavior.
- Thirty real Decisions diagnostic calls passed all 83 selected checks; median interpretation was 447 ms, sample p95 897 ms. These development cases do not establish general classification accuracy or downstream task success; see [the experiment record](site-scout-decisions-experiment.md).
- Eight live API cases passed, including invoice wording variants, fictional agents, supplied comparisons, executed functions, persistent memory, session memory and unsupported image generation. The invoice pair returned identical model IDs. Seven of eight measured requests took 310–540 ms end to end; the first took 1,427 ms. This small sample is not a latency guarantee.
- Live MCP initialization, discovery and tool calls passed. Compact results included actual memory and tool evidence. Browser submission, copying results, expanded BFCL evidence, local provider images and the pre-submit disclosure were checked. Desktop and 390 CSS-pixel layouts had no page overflow or browser errors; physical mobile hardware was not tested.
- All 32 changed public assets matched the deployed domain byte-for-byte. Main Worker modules were re-downloaded after publication and matched the captured originals.

Operational files are outside the repository at `/private/tmp/openmerit-scout-decisions-publication-20261014/`; synthetic diagnostic responses, live API/MCP evidence and the page screenshot are in this task's artifact directory. Prior Worker versions above remain rollback references. The guide documents that task descriptions now reach OpenAI and that memory scores evaluate external stores, not built-in model retention.

## Task comparisons and the ordered five — published 14 October 2026

Scout Worker `75a2f812-37a7-4cf8-8272-7e28455a452b` publishes ranking version 2 and interpreter version 4. Main-site documentation version `0b3105c0-a682-49b3-8d46-9c3f4487f518` publishes the maintained guide. The domain router is unchanged. Previous Scout `e80dca5a-64e7-443d-8216-5d5e781596a5` and main-site `d637a04e-3d5c-4990-a296-6429ec1efb62` are rollback references.

The ranker now compares shared benchmark scores between candidates, groups correlated evidence, and orders the whole eligible pool by the strongest supported pairwise preferences without cycles before selecting five. It replaces the earlier within-cohort percentiles and fixed 80/13/7 blend. One Decisions call now supplies 17 typed choices, including workload size and a quality/cost/latency priority. Reference cost uses separate input/output rates; completion time includes the first answer token delay and throughput from each matching configuration. Older snapshots without first-answer measurements cannot silently supply reasoning-token latency. A data-format revision selects a compatible bundled snapshot during deployment. No database, extra inference call, model-specific ranking override, or production dependency was added.

The table shows cost per 1,000 reference tasks, reference completion seconds, and the disclosed token assumptions. The first-place badge was removed. These values are estimates from public evidence, not actual executions of the user's task. The guide documents policy weights, comparison gaps, unknown timing, reasoning/image cost exclusions, and the difference between rank and the aggregate supporting score.

Validation included `npm run verify` (352 tests), four separate invoice-scorer tests, a 120-call paid comparison, and live API/MCP checks. The paid comparison froze one snapshot and the ranking policy before calls. It reused eight public real invoices as a regression set and added four synthetic text-extraction cases and four synthetic tool-call cases. The pool was the union of the old/new top fives, with two invoice boundary controls. No production ranking code imports these answers or model identities. Three requests ran concurrently, each once, with a 90-second timeout and no retry or provider fallback. A harness pause after the first unknown charge resumed only unattempted cases against the identical manifest.

| Task | Correct fields/cases across the five, before → after | Top-five overlap, before → after | Pair order agreement, before → after |
| --- | --- | --- | --- |
| Visual invoice extraction | 231/240 → 233/240 | 4/5 → 4/5 | 8/10 → 9/10 |
| Text extraction | 56/60 → 59/60 | 3/5 → 4/5 | 6/10 → 4/10 |
| Tool calling | 16/20 → 20/20 | 4/5 → 4/5 | 6/10 → 8/10 |

Overlap and ordering use a measured-policy reference within the tested pool: the already-declared balanced 60/20/20 preference rule applied to observed accuracy, reported cost and elapsed time. It is not an objective universal ranking or a comparison against every catalogue model. All ten pairs within each recommended five are evaluated. Both invoice shortlists produced valid JSON on all 40 calls. HTTP failures count against accuracy; three Kimi timeouts, one Nemotron rate limit and four DeepSeek rate limits remain in the record. All six models with successful tool responses passed the simple tool cases; no external tool action was executed. Reported inference cost was $0.427400, with timeout charges unknown. This small test shows improved aggregate selection and mixed ordering, not reliable exact top-five accuracy. In particular, text ordering regressed and expensive candidates remain overrated on some tasks.

The live invoice page returned the evaluated five in 383 ms in one browser observation. API samples for invoice, text and tool tasks took 556, 792 and 1,714 ms; these are samples, not guarantees. API and MCP returned the same ordered invoice IDs and ranking metadata. All six sources were healthy on the compatible `2026-10-14T17:55:04.185Z` snapshot: 213 indexed models, 143 series, 107 with matched results and 4,013 measurements. The hourly trigger remains `7 * * * *`; a subsequent production cron tick was not awaited.

Browser checks covered the table, source evidence, keyboard disclosure, reference assumptions and loaded provider icons, with no browser errors. The measured narrow viewport was 433 CSS pixels with no page overflow; physical mobile hardware was not tested. Deployment metadata and verification scripts remain outside the repository in `/private/tmp/openmerit-scout-ranking-publication-final-20261014/`. The frozen manifest, raw calls, metrics, report and live screenshot are retained in this task's `scout-ranking-eval` artifact directory.

Post-publication verification matched all 32 changed public assets, excluding only the existing Cloudflare-injected analytics beacon from HTML comparisons. Re-downloaded main Worker modules matched the captured originals, and the expected main version was active. Main application bindings, storage, containers and asset routing were preserved.


## Ranking version 3 — published 14 October 2026

Added typed operation scoping, required-versus-useful capability weighting, a conservative benchmark margin, and a 35,613-byte file of calibration aggregates. Measured ranking uses quality, observed charges and full request time, with repeated request failures shared across calibration tasks. There are no model/provider conditionals, additional runtime inference calls, or new databases. Two parser boundary repairs keep retry loops out of single-dispatch evidence and visual inputs out of the short-text workload bucket.

Calibration comprises 438 observations (410 task observations plus 28 additional route-health observations). No held-out outcome is used to choose or score a model in production. The first 358-call test improved membership 25/35→32/35 and order 39/70→59/70 but exposed failures being forgotten across task slices. A second, frozen validation used 159 fresh calls across six text types; the unchanged visual shortlist retained its original 40-call test. Final membership 24/35→28/35 and order 38/70→55/70. None of the seven exact five-model orders was established. Text 43/45→42/45, retrieval 45/45→43/45, and photos 135/150→134/150 remain regressions, explicitly disclosed in the public guide and report. Do not describe the text regression as solved or the complete five as validated.

There were 835 new OpenRouter requests across both iterations, with known charges $1.9646678058; failed/timed-out requests can have unknown billing and Decisions usage is separate. Old rows were reused without repeating calls. Evaluation code runs only in opt-in local scripts; hourly production refresh still fetches six public feeds. The 2-point benchmark indifference band and 20-point full-preference gap are policy choices, not confidence intervals.

UI review: the table identifies calibration accuracy, reported cost, median timing and sample count; benchmark rows retain their separate reference labels. Native evidence disclosure works, favicons remain bundled, and a 390px browser check contained the 670px table in its horizontal scroll region with no page overflow. Physical hardware was not tested. Main-site publication must preserve the current application modules and bindings through the captured production workflow; never deploy the root Wrangler configuration.

Published Scout Worker `5dcffb9e-5055-464d-b8f9-d9f1deefbf9d` and main documentation Worker `664523ed-0aae-456c-bdad-b4be779e4678`. The main application modules, bindings, storage and routing are preserved. Full `npm run verify` passed 362 tests; the independent extraction/SQL/tool scorers passed another seven tests. Deployment repeated Scout and documentation checks. Seven live API requests matched the frozen final lists, MCP returned the same measured text shortlist, client task overrides were rejected, and the public calibration file matched exactly. Live API round trips were 525–1,612 ms; the browser text request took 623 ms. Live measured-table verification at 390px found no page overflow, and no browser runtime errors were observed.

Final report: `/Users/lazim/.codex/visualizations/2026/10/14/01a13ab1-5051-79f2-b483-5392dab0f97e/scout-ranking-v4/report.html`. The first iteration remains in the sibling `scout-ranking-v3` folder. Raw protocols, scores, frozen policy hashes and calibration aggregates are retained with the reports.


## Terminal-style interface — 14 October 2026

| Before | After | Why |
| --- | --- | --- |
| Large marketing headline, illustration, slogans, and repeated overlines | One task heading and a compact input | Put the search first and describe the action directly |
| Green accents, score bars, bordered rows and boxed favicons | Neutral terminal surfaces, plain measurements, open rows and 13px provider marks | Make model names and comparisons the main visual content |
| Shared marketing stylesheet and downloaded font | Scoped Scout stylesheet using the terminal’s system typeface | Keep Scout lean and prevent marketing styles from affecting the workspace |
| Large agent promotion and separate supporting sections | Compact native API/MCP, capability and source disclosures | Keep setup and provenance available without competing with results |

The same live API, ranking, calibration disclosures and reference estimates remain in use. Unknown or failed provider images now leave a text-only identity. Search status gives total round-trip time; the API still exposes ranking time separately. No motion was added to search or result updates. Published as Scout Worker `325e6da9-1451-44a7-a3ed-274de638092b` and documentation Worker `30edf3a6-33a4-4ad3-92aa-f3ab922e68c1`. The existing main application modules, bindings, containers and routing were preserved. All 34 changed public assets matched the built files, excluding only the existing edge-injected analytics script in HTML. The retired 152 KiB illustration is omitted from the Scout asset bundle.

`npm run verify` passed all 362 tests plus type, build and syntax checks. Browser review covered real measured and benchmark searches, a typed task submitted with Enter, model evidence, copy feedback, agent setup deep links, 320px and 390px layouts, and a light-palette preview. Table overflow stays inside its region and the model column remains pinned. The live desktop search returned five rows in 0.48 seconds with no failed provider images, page overflow or console errors. Light appearance was reviewed using a local stylesheet preview; physical mobile hardware was not tested. The live screenshot is saved in the task’s `scout-ui-redesign` artifact directory.
