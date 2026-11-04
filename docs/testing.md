# Testing and validation

**Unreleased cleanup:** source retires the standalone evaluation CLI, legacy JSON recommendation pipeline and unpublished docs website shell. Dated evaluation/API acceptance records below describe historical releases, not current supported commands. Current verification retains agent, MCP, publisher, status, policy and protected-memo coverage; it does not publish or deploy anything.

**Pi adapter — npm 0.1.12 and later:** the Pi 1.5.0 adapter uses native Scout MCP and shared guidance only. Dated acceptance records below describe the packages tested at the time; some mention package exports that have since been removed. Standalone evaluation tests remain separate.

## Stable 0.1.7 acceptance — 24 October 2026

Published `openmerit@0.1.7` to npm's `latest` channel after full repository verification: 757 passing tests, one existing skip, syntax/type checks, builds and documentation checks. The `preview` tag remains `0.1.7-preview.5`. A fresh registry installation on macOS ARM64 with Node.js 22.23.1 matched the tested 104-file tarball byte-for-byte. Packed core/protocol/Pi exports and the installed terminal runtime smoke checks passed, including passive collection, source removal, runtime outage/recovery and shutdown.

The live Scout button opened a prefilled Claude Desktop Code session through Chrome. That session ran `npx -y openmerit@latest install --client claude-code`, opened the real device-approval page, and completed after approval of the matching code. This was a clean setup after removing and revoking this test's earlier source installation, not reuse of an existing key. Status then reported the MCP server and skill installed and connected; credentials had mode 600 and other MCP servers were preserved.

A fresh Desktop session received an application-model request that never mentioned Scout. It loaded `openmerit-scout` and called the real `scout_models` tool with the saved empty inventory, returning zero candidates. It asked before broadening; after separate approval, its second MCP call returned five candidates and it produced a provisional recommendation. No application code, providers, candidate inference or deployments were performed by that session. Anonymous MCP access and use of the device key on the JSON API both returned 401, while authenticated tool discovery succeeded.

These are integration observations, not a general guarantee that every agent follows the skill. Both search responses reported stale/degraded source data, including incomplete Parallel research. Their approximately 228,000- and 538,000-character payloads exceeded Desktop's inline tool limit; Claude recovered through saved tool-result files. The flow works, but these checks do not establish catalogue freshness, task accuracy or small response size. A separate recovery-path check exposed an obsolete preview install command in the MCP 401 message; its stable-command regression test failed before the source correction and passed afterward. Hosted correction is a separate deployment from the npm release.

## Published preview.5 acceptance — 17 October 2026

Published `0.1.7-preview.5` to npm's `preview` channel after all **679 repository tests**, syntax/type checks, builds and documentation checks passed, including 336 Scout tests. Registry integrity matches the reviewed tarball and stable `latest` remains `0.1.6`. All 101 packaged files are accounted for; runtime bytes, public exports and legal metadata are unchanged from preview.4. Version metadata and public guides carry this release. The frozen package contains the preparation record; this post-publication result is maintained here after the registry and VM checks.

A fresh registry installation in the existing Ubuntu ARM64 Mac Lima VM passed **203/203 assertions** with Node.js 22.23.1 and the official MCP SDK. Package hashes, registry-lock integrity, public core/protocol/Pi exports, live hourly status, tool discovery, seven HTTP/MCP workloads, inventory restrictions and request/protocol errors passed. The seven workloads cover visual category selection, bird identification, safety labels, safety plus rewriting, SQL source generation, photographed invoice JSON and unsupported audio. SQL and safety rewriting each returned five candidates through both interfaces; unsupported audio correctly returned none. The installed CLI's email and SQL plans contained one and two candidates respectively, restricted to the two declared connections. The existing global installation was preserved, and planning executed no recommended models or evaluation budget.

The seven HTTP workload samples had a median of **3.392 seconds** and a maximum of 3.682 seconds. The slowest of all fourteen HTTP/MCP workload requests took **4.376 seconds**; none timed out. Several exact MCP repeats used the result cache. These small samples establish tested integration and matching behavior, not a production latency percentile or exact task accuracy. Scout remains independently deployed with unchanged UI and hourly preparation. Earlier bird/invoice execution limitations and failed acceptance attempts below remain recorded.

## Hosted matching repair — 17 October 2026

The repair passed full repository verification, including 336 Scout tests and documentation checks, plus eight live-provider staging filter/ambiguity cases checked against the catalogue metadata oracle. The isolated Ubuntu ARM64 VM staging run passed 203/203 assertions using the installed npm preview.4 package, HTTP API, official MCP SDK and CLI planning. Both declared-connection CLI workloads had candidates: email returned one, SQL returned two. All original seven workloads passed through both interfaces. Package hashes/exports, inventories and request/protocol errors passed; no recommended models were executed. The package version and npm tags are unchanged.

Earlier staged attempts are retained: the first run exposed an email retrieval gap after SQL was fixed; another reused the CLI project directory and failed the expected fresh-directory `eval init` assertion. The final run corrected test isolation without changing that assertion. This record does not replace the failed preview.4 post-publication acceptance below. Production rollout results are recorded after deployment. These are matching and integration checks, not proof of task accuracy or a production latency percentile.

The first production rollout passed its 203 VM checks, but the separate filter sweep passed 6/8: impossible context returned unavailable once and explicit SVG produced contradictory task fields. A generic bounded Decisions consistency correction was then added. Full verification passed with 336 Scout tests; the revised staging run passed all 203 VM checks and all eight filter cases. The SVG case exercised the reconciliation path. These phases are recorded separately rather than treating the earlier failures as successful attempts.

The final production deployment passed **203/203 VM assertions and 8/8 filter/ambiguity cases**. All seven HTTP/MCP workloads, both CLI plans, package hashes/exports, exact inventories and request/protocol errors passed. The seven HTTP workload samples had a median wall time of **3.665 seconds**, compared with **4.924 seconds** in the earlier published-preview failure run. Maximum HTTP time was 4.268 seconds; the slowest HTTP/MCP request was 4.840 seconds. Several exact repeated MCP requests used the isolate-local cache; the books/posters MCP request did fresh work, so cache availability is not assumed. No task timed out in this final run. These are small end-to-end observations under different load and cache conditions, not a production percentile or guaranteed response time. The hourly schedule and all 127 UI source files are unchanged; five checked live scripts/styles match source bytes. npm remains preview.4 and no new package was published.

## Preview.4 release checks — 17 October 2026

The published `0.1.7-preview.4` package passed the full repository verification, including 329 Scout tests and documentation checks. Its packaged runtime is byte-for-byte unchanged from preview.3; version metadata and public guides carry this release. Registry integrity matches the reviewed tarball, the `preview` tag resolves to this version, and stable `latest` remains `0.1.6`. Scout deploys independently and its UI files are unchanged. Broader evidence coverage, task calibration and complete quality/cost/latency validation remain follow-up work.

The hosted beta's public post-deployment suite passed 9/11 cases. Explicit SVG generation returned no shortlist; a Qwen-family code-authoring request admitted tool-calling evidence. Restriction checks passed for creator, family, context and dates, including known matches and impossible-context no-match. The actual bird prompt also displayed five recommendations in a browser. Earlier candidate deadline and interpretation failures were recorded separately at the time. These checks do not establish universal semantic reliability or improved task accuracy.

Fresh registry installation in the existing Ubuntu ARM64 Lima VM verified all 101 packaged file hashes, registry integrity and public core/protocol/Pi exports. Seven workloads were sent through both HTTP and the official MCP SDK. Six of those fourteen requests failed their functional expectations: books/posters and invoice HTTP requests returned unavailable responses, while SQL generation and safety classification with rewriting returned empty shortlists through both interfaces. The matching MCP books/posters and invoice requests succeeded; bird identification, label-only classification and unsupported audio behaved as expected. The first harness stopped when it assumed SQL had returned an endpoint. A separate continuation tested exact endpoint scope using the successful bird result, request/protocol errors and installed CLI planning, preserving all original failures. Together the runs recorded 187 passing checks and nine failed assertions, including duplicate agreement failures caused by unavailable responses and an installed-CLI candidate check. Both CLI email and SQL plans were empty. Planning created no execution or spend state, and the existing global VM installation was retained. This is not a clean acceptance pass. The seven first HTTP workload requests had a median wall time of 4.924 seconds and a maximum of 6.229 seconds, including unavailable responses; repeated cached requests were faster.

Post-deployment refresh validation exposed duplicate stable research identities. The hosted integration now updates those exact identities without introducing model or benchmark exceptions. Full verification then passed 331 Scout tests. The normal recovery refresh reused all 24 saved research jobs, completed all 24 and published its catalogue with a matching durable receipt and empty backlog. Its interpretation and staging steps needed memory-limit and vector-readiness retries; successful publication does not establish sufficient memory headroom at larger scale. Live status reported neither stale nor degraded data after recovery. This repair deploys independently of the already published npm runtime.

## Published preview.3 acceptance — 16 October 2026

Published `openmerit@0.1.7-preview.3` under npm's `preview` tag after all 596 repository tests and the syntax, type, build, documentation and whitespace checks passed. Stable `latest` remains `0.1.6`. Registry integrity matches the tested tarball. Runtime files are unchanged from `0.1.7-preview.2`; this release updates packaged Scout guides and excludes internal website/deployment notes. Scout's hosted research and matching service deploys independently of npm.

A registry installation in a separate directory in the existing Ubuntu ARM64 Lima VM, with Node 22.23.1, passed all 202 acceptance assertions, including SHA-256 verification of all 101 packaged files. Public core/protocol/Pi imports and the installed Pi extension load passed. The existing global installation was retained.

Seven workload descriptions were tested through both the live HTTP API and the official MCP SDK: books/posters classification, open bird identification, safety labels, safety labels with explanation/rewrite, SQL generation with a runtime schema, photographed-invoice JSON extraction, and unsupported audio transcription. The operation, modality and output requirements agreed across channels. Inventory restrictions, invalid requests, MCP discovery/ping, and endpoint selection passed. Installed `eval init` and `eval plan --scope existing --budget 1` produced two frozen task shortlists limited to the declared connections; no execution, budget ledger or background work was started.

Across these 14 prompt requests, observed median wall time was 1.43 seconds and the slowest was 4.14 seconds. Source status reported neither stale nor degraded data. This verifies packaging and API/MCP integration, not model task accuracy, universal semantic reliability, a guaranteed response time, or a new hourly-refresh trial. The earlier hosted refresh acceptance remains separate. No website deployment is included in this npm release.

## Standard verification

```sh
npm ci
npm run verify
npm pack --dry-run
```

`verify` runs workspace tests, syntax checks, strict TypeScript checks and the TypeScript migration ratchet, the package build, memo tests, policy/memo build and Markdown-guide checks, Scout tests/build, and whitespace validation. It does not publish a package or deploy the website. `npm run check:worker-types` separately checks generated Worker types; CI also performs packed-install and Pi/terminal smoke checks.

## Inference Terminal coverage

```sh
npm test --workspace=@openmerit/terminal
```

Tests cover metadata projection and redaction, source containment, recursive syntax indexing, phased worker progress, incremental reuse, coverage limits, endpoint classification, authorized loopback probes, supported request-log formats, UTF-8 boundaries, rotation/truncation, source reconciliation, historical ranges, unknown versus zero measurements, and the read-only API.

Inventory and UI coverage includes model/service identity, explicit deployment and host links, shared capacity, stale/missing hardware, path classification, map completeness, search and filtering, and preservation of unknown costs. Runtime fixtures establish which endpoints collectors call; they do not prove compatibility with every external runtime version.

The local fictional sample (`--demo` or the sample selector) has 40 agents, 140 tasks, 21 models and 9,600 requests over 24 hours. Sample tests exercise interface scale and arithmetic, not measured throughput, application quality, or hardware performance.

Browser review covers the six views, inspectors, search, activity ranges, map and chart interaction, keyboard navigation, reduced motion, and desktop/narrow layouts. Browser checks are distinct from the committed unit suite.

## Pi load and package smoke tests

CI packs the package, installs it in a temporary directory, imports `openmerit/pi`, smoke-tests the installed terminal command, and loads the installed extension in Pi with `--list-models`. These checks establish packaging and loading, not successful provider authentication or Scout recommendations.

## What evidence establishes

- **Unit verified:** deterministic behavior has automated coverage.
- **Runtime smoke verified:** the runtime loads the extension or executable.
- **Product trial verified:** a representative application completes the workflow with inspected evidence.
- **Production verified:** repeated representative runs support the claimed operating conditions and reliability.

Implementation checks and public model benchmarks cannot substitute for target-product validation. See [current limitations](roadmap.md).


## Agent-evaluation preview validation — 15 October 2026

The npm preview `0.1.7-preview.1` package adds a separate agent-evaluation loop. `npm run verify` passes 393 tests, plus syntax/type/build/documentation checks. Fifteen evaluation-runner tests cover fresh workspaces, frozen input bytes, scope acknowledgement, final-output parsing, balanced/adaptive repeats, revision compatibility, process timeout, invalid graders, connection errors, cumulative unknown-cost reservations, corrupt ledgers, file collisions, locking and watch coalescing.

An isolated installation of the actual npm tarball completed init, real hosted Scout planning and a disabled-budget check. Twelve simulated agent attempts through that installed command verified two CLI revisions, six attempts each, compatible deltas and persistent accounting. Simulated metrics are packaging tests, not model-performance evidence.

Real macOS smoke runs used Claude Code 2.1.7, Codex CLI 0.162.0-alpha.17.2 and OpenCode 1.18.30. On one tiny JavaScript normalization fixture, with three fresh attempts per route, Claude/Haiku 4.5 and Codex/GPT-6 Luna passed all executable checks. OpenCode/Gemini 2.5 Flash Lite passed one of three. Costs remained unknown for Codex. These different model/harness combinations validate execution and grading paths; they are not an unbiased comparison of agents or a general model ranking. Earlier smoke runs deliberately exposed unsupported authentication/model access, native permission failures, a timeout and invalid JSON. Those cases informed connection-error handling and conservative partial-cost accounting. No model-specific ranking rule was added.

Scout Worker `7ddeacd3-1310-48bd-b546-60fcab4fa4ef` passed live HTTP/MCP checks for pre-ranking model eligibility, empty inventory and duplicate-ID rejection. npm publication is separate from the successful tarball installation; the registry credential returned HTTP 401 during release preparation.


### Published preview on Linux — 15 October 2026

Installed `openmerit@0.1.7-preview.1` from npm into a separate prefix in the existing Ubuntu ARM64 VM. The live Scout API returned a frozen shortlist within the declared OpenRouter connections. A deterministic CSV grader scored quoted commas, escaped quotes, leading-zero identifiers and field types; the uncorrected and corrected CLI passed 8/12 and 12/12 checks respectively in grader sanity checks.

Claude Code/Haiku 4.5 completed three attempts per revision at 66.7% then 100% mean field accuracy. The combined watcher stopped on budget admission before OpenCode’s last post-change attempt, so its report has no automatic comparison. A separate OpenCode/Gemini 2.5 Flash Lite watcher completed three attempts per revision at 66.7% then 100%, detected the source edit, emitted token/cost/time deltas, and exited cleanly. Earlier partial trials remain separate. Codex/GPT-4.1 Mini could not execute filesystem tools under this VM’s Linux sandbox; no passing Codex task result is claimed. Total account usage was approximately $0.26 including diagnostics, while native reported estimates differed. One authored fixture and three repetitions do not establish general performance or a cost improvement. Source and diagnostic artifacts are retained in the task’s `openmerit-vm-eval` directory; a scan found no temporary key in the 66 test-project files.

### Accounting corrections on Linux — unreleased source, 15 October 2026

The source package was packed and installed into a separate VM prefix; the registry preview and existing VM installations were left unchanged. All 400 repository tests pass, including 22 eval-runner tests. The added cases cover partial usage/cost recovery, missing prices, conservative old/new ledgers, scored wrong answers, native budget and permission blocks, zero-exit sandbox failures, and the free Linux sandbox probe. Replaying the previously captured Claude budget response recovers 30,820 input tokens and 196 output tokens instead of zero.

The real Codex connection now stops during sandbox preflight with `environment_blocked`, zero attempts, no reserved allowance and no inference spend. A deliberately small Claude budget stops after one attempt with unknown quality, 21,532 input tokens, 190 output tokens and a retained $0.110705 partial native estimate. A second normal-run attempt also hit its native cap; its unscored record and $0.1505768 reservation were preserved. With sufficient per-attempt allowance, Claude completed three scored CSV attempts at 100%, a 12.82-second median, and a $0.06029 mean native estimate. This is not a billed-dollar measurement or a before/after Claude comparison.

OpenCode's real watcher completed three attempts per revision. The earlier CLI averaged 44.4% field accuracy (one actual zero-score task output remained included); the corrected CLI averaged 100%. Median times were 5.05 and 5.79 seconds. One earlier and two later attempts had incomplete native step pricing, so the cost means and cost delta correctly remained unknown while partial estimates were retained. The cumulative reservation stayed at $0.03. These checks validate accounting and failure separation on the same integration fixture, not general task quality, model ordering or savings. Sanitized reports, package and verification output are retained in the task's `openmerit-eval-accounting` directory.

### Budget setup — unreleased source, 15 October 2026

The eval suite now has 29 tests. New coverage checks the three budget choices after scope, custom amount validation, explicit unlimited configuration, reuse of saved choices, automatic reservations, retained cumulative usage, bounded repetitions and cancellation. A real CLI subprocess uses a loopback Scout fixture to verify persistence across replans and failed requests, rejection of missing or invalid noninteractive choices, and lock cleanup. An interactive terminal smoke test also verifies scope-before-budget, custom input, no-repeat questions, no fixed cap and EOF cancellation. These are offline workflow tests; no model calls, provider charges or npm publication were required.

### Published preview.2 acceptance — 15 October 2026

Published `0.1.7-preview.2` to the npm `preview` tag after all 407 verification tests passed. Stable `latest` remains `0.1.6`. A fresh registry installation in a separate Ubuntu ARM64 VM directory matched the tested package integrity and all 124 packaged files. The installed command rejected a missing budget, asked scope before the custom-budget question, saved all three budget modes, reused saved choices, and preserved the ledger across limit changes. No install-time evaluation or background service was added.

On a fresh CSV fixture, the real foreground watcher completed three attempts per agent per revision: twelve scored attempts total. With Claude Code/Haiku 4.5, mean field accuracy changed from 66.7% to 100%, mean input/output tokens from 87,826/666 to 87,781/653, native estimated cost from $0.09333 to $0.06534 per attempt, and median elapsed time from 13.87 to 13.42 seconds. With OpenCode/Gemini 2.5 Flash Lite, accuracy changed from 44.4% to 100%, tokens from 20,093/306 to 22,726/511, estimated cost from $0.001501 to $0.001896, and median time from 4.97 to 5.72 seconds. One baseline OpenCode output correctly remained a zero-score task failure. Both revised tools passed all checks; better quality did not imply lower cost or faster execution on every route. These are native estimates and one integration fixture, not reconciled per-attempt bills or a general model ranking.

A deliberate native Claude budget stop retained 21,516 input tokens and a $0.0286866 partial estimate, with unknown quality and no revision comparison. Codex's Linux sandbox probe stopped before inference with zero attempts and no reserved spend. The initial sandbox fixture had an empty route list, which planning correctly rejected; declaring the intended Codex route allowed the separate sandbox check without repeating paid trials. Across the acceptance run, provider-reported account usage increased by approximately $0.17, below the $1 test allowance. All three projects released their locks, the watcher exited, and a scan found no temporary credential in 57 test files. Reports and registry verification are retained in the task's `openmerit-preview2-release` directory. The website was not deployed as part of this npm release.
