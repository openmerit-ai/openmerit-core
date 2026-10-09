# Testing

## Standard verification

```sh
npm install
npm test
npm run check
npm run verify
npm pack --dry-run
```

Tests cover protocol contracts, lifecycle decisions, post-build target detection, incumbent identity, baseline sufficiency, durable candidate handoffs, candidate/frontier/swap sequencing, conservative Pareto verification, persistence, audit events, safe evidence identifiers, Pi commands, private intent delivery, evidence requirements, and mutation boundaries.

The routine `packages/pi/test/live-wakeup.test.ts` test uses a disposable project to verify that a due, insufficient baseline is checked and recorded without starting Pi. A prior opt-in live OpenRouter run proved the former harness-driven assessment could issue an intent and call tools, but Pi did not complete it within the bounded test. Candidate discovery and model changes still require a representative headless end-to-end trial before claiming unattended operation.

Automation tests additionally cover task and elapsed cadence, idempotent target-bound signal delivery, durable pending work, catalogue changes, metric regression thresholds, native wakeup requests, unsupported-scheduler fallbacks, delayed post-swap verification, and Pi dispatch from explicit application-task signals. Pi's own settled-turn telemetry is not a product-observation test path.

## Inference Terminal verification (unreleased)

`npm test --workspace=@openmerit/terminal` tests metadata projection, unknown/redacted values, incremental UTF-8 imports, stable-ID updates, rotation, truncation, project boundaries, source precedence, local runtime contracts, aggregate counter scope, CLI arguments, sample isolation, chart sample gaps and inspection, and the loopback read-only API. Local HTTP fixtures prove which endpoints the collectors call; they do not prove every external runtime version is compatible.

The source UI was also reviewed in a browser at desktop and 390-pixel widths, including all six views, model search and location filters, time windows, node inspection, the command palette, Escape dismissal, and a real empty project. The full `npm run verify` command includes terminal tests and syntax checks through the workspace scripts. See the [terminal guide](inference-terminal.md) for current collection coverage and limitations.

The enterprise sample tests assert 40 reported agents, 140 tasks, 21 used models, 9,600 unique requests, consistent task-to-agent assignments, all path classifications, and unknown measurements on running requests. Browser checks cover the larger inventories, agent/task lists and nested details, command search, map coverage, and desktop/mobile layouts. This fixture exercises interface density; it does not establish production throughput or hardware performance.

The sidebar and animation revision was additionally checked for persistent chart/DOM identity across polls, CPU/memory selection, exact-sample keyboard inspection, compact navigation, Torph transitions, immediate keyboard updates, and static charts under reduced motion. These are browser checks, not a committed browser automation suite. Browser source lives in `packages/terminal/client/`; `scripts/build-terminal.mjs` bundles it into the ignored `public/app.js` before `npm run dash` and during the package build.

Path-category tests cover explicit metadata precedence, unknown/invalid types, case-insensitive inventory/source matching, conflicting declarations, and mixed paths without double counting. They verify that endpoint location alone never establishes a request path. Sample data exercises direct, local, router, and gateway paths, including one model reached through multiple types.

Deployment and capacity tests cover strict identity matching, duplicate-ID rejection, ordered path projection and entry conflicts, shared-pool deduplication, stale/future/missing/zero readings, positive-limit ratios, safe project-local capacity files, export failure clearing, and highest-series vLLM cache usage. The enterprise fixture checks 27 deployments, 12 pools, 9,479 identified requests, and explicit stale/missing capacity coverage.

## Pi load smoke test

```sh
./node_modules/.bin/pi --no-session --no-extensions -e ./packages/pi/src/index.ts --list-models
```

This proves the real Pi runtime loads the extension and enumerates its available catalogue. It does not prove a provider can complete an end-to-end product intent.

CI also packs `openmerit`, installs the tarball in a temporary directory,
imports its public core and protocol entry points, and loads the installed Pi
extension. This checks the published artifact rather than only the workspace.

## Evidence levels

- **Unit verified** — deterministic behavior has automated coverage.
- **Runtime smoke verified** — the actual Pi runtime loads the extension.
- **Product trial verified** — Pi creates evals and observability in a real product and completes an intent with evidence.
- **Production verified** — representative repeated runs support reliability and distribution claims.

The current repository is unit- and runtime-smoke-verified. Product and production claims require target-product evidence.

## Experimental Pi/OpenMerit sandbox demo

This repository includes a disposable, live-provider demo for showing the complete experimental loop. It is not the shipping product workflow and its small evaluation set is not evidence for reliability claims.

Requirements: Node.js 22.19+, Pi 0.87.x with OpenRouter coding-harness authentication, and an OpenRouter application credential available as `OPENROUTER_API_KEY` or in Pi's local `auth.json`. The coding-harness credential is not passed to the generated application; the demo runner supplies the application credential only while making provider calls.

```sh
npm run demo
```

Pi builds a small sentiment-classification app and infers a task/evaluation plan in a temporary directory. The runner validates the plan against available collectors, shows the selected metrics and rationales, smoke-tests the app's configurable route through a live application call, and passes the inferred profile to OpenMerit's coordinator. Task quality is scored only by exact sentiment-label match; rationale plausibility is not graded. The runner collects a baseline, randomly interleaves incumbent/challenger calls over Pi's same three to five representative cases with two repetitions per case, records provider-reported token use and request cost plus measured latency and task outcomes, asks OpenMerit to calculate and verify the Pareto frontier, applies a selected frontier route only in that temporary app, and runs a new post-swap check for every case/repetition. It stops on missing model availability, missing provider usage/cost, invalid output, or a $1 default application-provider spend threshold checked after each response. The saved summary includes its randomization seed.

The default baseline is `openai/gpt-4.1-mini`, with `openai/gpt-4o-mini` as the challenger. Override the selection with `OPENMERIT_DEMO_BASELINE_MODEL` and comma-separated `OPENMERIT_DEMO_CANDIDATE_MODELS`; candidates must be available in the current OpenRouter catalogue. `OPENMERIT_DEMO_PI_MODEL` selects the Pi coding model. `OPENMERIT_DEMO_REPETITIONS` accepts 2–5, `OPENMERIT_DEMO_MAX_SPEND_USD` accepts a cap up to $5, and `OPENMERIT_DEMO_SEED` supplies a repeatable ordering seed.

The temporary directory path is printed at startup and completion. It contains the generated app and inferred plan, `.openmerit/` lifecycle state and redacted event log, per-call `artifacts/application-runs.jsonl`, comparison manifest, and summary. The runner executes application calls serially. Its spend threshold measures application calls only; Pi's coding-model spend is not measured or included. Its tiny task set and sample count are a mechanics demo only: do not present its observed rates, average latency, or frontier as representative reliability, quality, or performance claims.

### Inference Terminal hardware checks (unreleased)

`npm test --workspace=@openmerit/terminal` covers bounded and project-contained hardware exports, duplicate/reserved host IDs, future and stale timestamps, missing versus empty residency, per-host history deduplication/reset, sample placement, and the hashes of locally bundled official favicons. Browser verification covers path-series selection and keyboard bin inspection, enlarged table headers, host and location selection, separate host chart histories, stale/missing hardware, exact-name connection icons, and narrow-screen layouts. These checks exercise passive metadata; they do not run inference or discover remote hardware.

The terminal identity checks additionally cover all 21 sample models across inventory, requests, deployments and residency; official versus arbitrary model namespaces; unknown-name fallbacks; runtime/maker separation; and consistent HTML/SVG asset selection. Browser checks cover model and service marks on all six views, search results, deployment/path/source/model inspectors, and loaded-model rows, plus image loading without external requests, mobile overflow, and nonduplicated accessible names.


The terminal naming tests cover source-supplied IDs without display names, absent workload labels, configured-address fallback for unnamed runtimes, full system hostnames, exported host name/hostname/ID precedence, and missing site/rack metadata. Browser checks cover colored all-path stacks and isolated paths, readable activity subtitles, compact Sources rows, name provenance inspectors, and host filters that appear only for reported sites. Sample naming is explicitly fictional.


Top-navigation browser checks cover all six tabs, manual arrow/Home/End activation, panel labels, direct hash views, source coverage, environment switching, command search, sticky positioning, responsive tab overflow, and focus/scroll preservation through a passive poll. The old sidebar and collapse controls are absent. Desktop and narrow layouts retain readable content with no page-level horizontal overflow.

### Installed terminal smoke test

The package-smoke CI job installs the npm tarball into a fresh directory, then runs `scripts/terminal-package-smoke.mjs` against its installed executable. It checks the CLI, packaged browser assets, cached passive collection, request-update deduplication, source loss/recovery, sample separation, read-only HTTP boundary, and shutdown. Its default runtime is a deterministic fixture; that test makes no inference calls.

For a separate real-runtime check, supply a disposable Ollama server with `smollm2:135m` already installed and unloaded:

```sh
node scripts/terminal-package-smoke.mjs /path/to/install/node_modules/.bin/openmerit --ollama-url http://127.0.0.1:11434 --output /tmp/terminal-evidence
```

This opt-in test application makes four real local generation calls. The terminal itself still reads only inventory endpoints and a temporary metadata export. Two requests are exported with Ollama's actual token and timing measurements. A separate, explicitly synthetic running-to-completed record tests update semantics. A generation without an export must produce no invented request or agent history. The test removes its temporary project and stops its terminal process; the caller owns the disposable runtime's lifecycle. The JSON report excludes prompts and generated text. No cloud credentials are needed.

### Automatic application discovery (unreleased)

Terminal tests cover bounded literal project declarations, credential omission, SDK hints without invented usage, canonical project containment, malformed/oversized inputs, safe loopback endpoints, runtime discovery without configuration, outage handling, and no added polling between discovery passes for never-seen endpoints. Application request logs and explicit exports reconcile without duplicating requests. Application agent identities remain intact. Records explicitly marked as development usage are rejected.

A normal CLI fixture starts with application logs, valid legacy Pi history grants, native Pi history, and other coding-tool history directories. It verifies that only application requests contribute to the snapshot and that OpenMerit `product_task_completed` summaries still work when request-level evidence is absent. Retired access flags give an explanatory error; sample JSON bypasses collectors. The installed-package smoke covers runtime/request lifecycle and read-only HTTP boundaries.

The earlier history-based checks below document a superseded preview. Pi history is no longer a supported terminal source.

### Historical VM check with Pi history (superseded)

On 8 October 2026, the preview was built and installed in a dedicated Ubuntu 24.04.5 ARM64 VM with four virtual CPUs and 4 GiB of RAM, using Node 22.23.1, Ollama 0.40.1, and Pi 0.87.0. Eighteen actual Pi requests ran across `smollm2:135m`, `qwen2.5:0.5b`, and `smollm2:360m`. After explicit project-scoped history consent, the installed dashboard collected all 18 completed requests and their reported 1,402 input and 587 output tokens directly from native Pi sessions. No activity export supplied those requests.

This was a controlled local-model workload, not a production-traffic test. Pi's configured local-model rates were zero; displayed cost does not measure hardware or electricity. In that initial build, route names remained unknown because the adapter omitted Pi’s recorded provider connection ID. Deployments, agent/task identities, and request durations were not reported by the history. The VM had no host-directory mounts or forwarded host credentials, and its dashboard was forwarded only to host loopback.

The real browser check exposed an overview coverage check that omitted native history. A regression test then covered Pi-only usage, connected empty sources, retained partial history, and inventory without request evidence; it now covers application logs instead. The same count check is used by the overview, path summary, and model table.


### Historical Pi connection identity (superseded, 9 October 2026)

That preview adapter preserved Pi's recorded provider connection ID as the route name. Its regression coverage included Ollama, an arbitrarily named local runtime, a declared gateway, unknown connection types, conflicting declarations, and an end-to-end approved-history collector check. Generic activity records still do not acquire a route from their serving-provider name. These checks do not infer physical deployments or reconstruct historical endpoints from mutable credentials or current Pi model configuration.


### Application-only VM acceptance (unreleased, 9 October 2026)

The updated installed CLI was run as `openmerit dash` from the VM application directory with no terminal configuration or custom activity feed. All 240 existing application requests, 40 worker identities, and 120 task identities remained unchanged; the 36 earlier Pi-history requests were excluded. The default server, JSON CLI, next passive poll, and private dashboard agreed. Application log hashes and the legacy grant file were unchanged, and runtime inventory remained available. No new inference was performed. This supersedes the Pi-history acceptance scope above and verifies supported existing application logs, not universal discovery.
