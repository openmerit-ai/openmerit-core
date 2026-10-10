# Hosted Inference Terminal sample

This separate preview is configured for `https://dash.openmerit.site/`. It uses the isolated terminal branch and its own Cloudflare Worker, `openmerit-terminal-preview`. It does not deploy `wrangler.jsonc`, the main website, or the main website’s interactive inference demo. The terminal-specific comparison lives at `/demo` on this Worker.

## Build and deploy

```sh
npm ci
npm run verify
npm run deploy:dash-preview
```

The deploy command pins Wrangler 4.136.3 and uses `wrangler.terminal.jsonc`. Its build hook rebuilds the terminal preview, runs documentation checks, and checks/tests the terminal workspace before upload. The exact `dash.openmerit.site` custom domain uses the existing Cloudflare account. No storage, container, AI, secret, or external service binding is configured. The only binding serves bundled public assets from `dist/terminal-preview/`.

`scripts/build-terminal-preview.mjs` creates this asset directory from the same browser bundle and icons as the local terminal. It adds preview metadata, noindex, and a sample-only bootstrap marker; it never copies a project snapshot. `packages/terminal/hosted/worker.mjs` imports only the fictional sample generator, never the collector or local CLI. The Worker reuses each generated sample for its 15-second time bucket. Browser polling and reduced-motion behavior remain the same as the local interface.

`/api/info` selects sample mode and identifies the hosted preview. `/api/sample` exposes the fictional enterprise environment, `/api/demo` exposes the comparison, and `/api/sample-seed` supplies the small deterministic browser seed. Remaining API paths return 404, and mutations return 405. The visible sample disclosure remains present, and the workspace picker offers no real environment. Static assets and API responses carry a same-origin content policy and indexing restrictions. HTML responses use `no-transform` so the zone’s automatic analytics script injection cannot alter the preview HTML. Script and stylesheet responses allow Cloudflare compression to reduce transfer time; main-site analytics settings are unchanged. `/robots.txt` also requests exclusion. This is public link sharing, not password protection.

## Package delivery

The terminal ships within the existing `openmerit` npm package. `npm pack` and `npm publish` use the root manifest and compiled core, protocol, Pi adapter, and terminal under `dist/`. The file allowlist excludes the hosted sample, website source, repository tooling, dependencies, and local evidence. Browser assets are prebuilt; registry installs do not require a repository checkout. Node engine requirements, runtime dependencies, exports, and the legal license file remain intact.

For friends' testing, publish a prerelease with the `preview` dist-tag while `latest` remains the stable version. Run `npm run verify`, inspect `npm pack --dry-run`, install the actual tarball in an isolated npm prefix, and validate existing application activity before `npm publish --tag preview`. Confirm the registry version and both tags, then repeat installation with `npm install -g openmerit@preview`. The first registry preview is `0.1.6-preview.0`; confirm publication and install evidence in the deployment record before announcing availability.

The earlier domain-hosted package was an interim delivery method. Its deployment record below is historical. The source build no longer produces installer downloads; deploy the sample only after npm delivery is verified so the already-shared interim URL remains usable during the transition.

## Sharing image

The page title and social preview title are `Inference Terminal by OpenMerit`. `packages/terminal/hosted/social-image.svg` is the editable 1200 × 630 artwork. `scripts/terminal-social-image.mjs` renders it with the bundled Inter font; the preview build writes a content-hashed PNG and its absolute HTTPS URL into Open Graph and Twitter large-card metadata. Rendering needs no network or system fonts. The card and its metadata deploy with the preview assets. The preview robots file permits named link-preview crawlers while keeping the general exclusion and noindex headers; its API remains disallowed to those crawlers.

## Validation

The terminal test suite covers hosted API boundaries, sample identity/counts/freshness, asset headers, and HEAD requests. Before declaring a deployment complete, verify the live custom domain over HTTPS, all six tabs on desktop/mobile, inspector and selector interactions, the sample disclosure, absence of a live-environment switch, read-only API behavior, local asset loading, and no runtime errors. Check the live page title, Open Graph/Twitter image URLs, PNG content type and dimensions when changing the sharing card. A successful local build alone is not publication.

## Deployment record

Published on 7 October 2026 as Worker version `f9c37164-aa44-4a84-9c09-e61272bb87c3`, at [dash.openmerit.site](https://dash.openmerit.site/). The earlier first upload was `fa5114d4-fa78-47c8-98fc-085d8b0e58e9`; the final version adds the scoped `no-transform` response header after live browser testing detected automatic zone-level beacon injection.

`npm run verify` passed 158 tests plus syntax, typecheck, build, demo, and documentation checks. Both deployments repeated the preview build, documentation checks, and all 48 terminal tests. The public HTTPS page returned 200 and matched the built HTML; its sample API returned 40 agents, 140 tasks, 21 models, and 9,600 fictional requests. The live snapshot API returned 404, and POST to the sample API returned 405.

All six tabs were checked at 1440 px and 390 px with no page overflow. Keyboard agent selection, agent and model inspectors, the fictional-data disclosure, and absence of a live-environment switch passed. The final browser check recorded no JavaScript errors, console errors, or external requests. Browser TLS verification used the published Cloudflare addresses while this machine's resolver retained its earlier negative DNS result; Cloudflare and Google public resolvers returned the new domain's A records. Physical phones were not tested.

Only the separate terminal Worker and its 19 public assets were published. No main-site deployment, npm release, provider call, upload, or local environment exposure was introduced. Deployment and verification logs are retained locally as `/private/tmp/terminal-hosted-deploy.log` and `/private/tmp/terminal-hosted-verify.log`; the final screenshot is `/private/tmp/terminal-hosted-final.png`.

### Sharing card update — 7 October 2026

Published Worker version `09a8e6ad-1185-4e27-9252-78e368755949`. The 1200 × 630 PNG is 41,977 bytes and is served as `/inference-terminal-og-2330cc415994.png`. Live page title, Open Graph, and Twitter card metadata use `Inference Terminal by OpenMerit`. Requests with browser, Twitterbot, Facebook, WhatsApp, and Slack link-preview user agents returned 200 for both HTML and image; the PNG matched the local build byte for byte. Named preview crawler rules permit the page and image, but disallow API crawling. These checks verify origin responses, not the state of third-party preview caches.

Full verification passed before deployment. The deployment hook repeated documentation checks and all 48 terminal tests after the crawler-rule adjustment. A fresh Chrome session loaded the public domain using normal DNS, rendered the overview, and reported no JavaScript errors. Logs: `/private/tmp/terminal-og-verify.log`, `/private/tmp/terminal-og-deploy.log`, and `/private/tmp/terminal-og-live.json`.

### Service identity update — 8 October 2026

The sample now includes fictional Baseten, Groq, and Cerebras connections with separately declared model creators. Its catalog remains 21 models and 27 deployments, with 14 shared pools (12 recent, one stale, one missing). It illustrates environment-variable evidence, shared and dedicated serving modes, and unreported cloud hardware. Official service icons are bundled locally. The hosted Worker still imports only the fictional sample generator; it does not run environment detection or collect visitor data.

Before publication, the real collector was exercised against an isolated synthetic project with fake inherited credentials, an OpenAI-compatible endpoint override, activity metadata, deployment configuration, and an accelerator export. Groq, Cerebras, and Baseten were identified without labeling the overridden OpenAI client as OpenAI. Credential values and raw URLs were absent from the snapshot. Cloud deployments retained unreported hardware. Browser checks covered all six sample tabs at 1440 px and 390 px, separate creator/service details, configuration evidence, and locally served icons, with no overflow or JavaScript errors.

Published at `dash.openmerit.site` as Worker version `27295601-f3a5-4c32-a6f9-68b71911b40f`. Full verification passed 163 tests; deployment repeated all 53 terminal tests and documentation checks. Live HTTPS verification confirmed the three service icons, configuration evidence, creator/service separation, and sample counts. The snapshot API remains 404. The browser reported no JavaScript errors or external requests. Logs are `/private/tmp/terminal-services-final-verify.log` and `/private/tmp/terminal-services-deploy.log`; the live inspector screenshot is `/private/tmp/terminal-services-live.png`. The isolated collector test used synthetic credentials and metadata, not customer cloud accounts.

### Services inventory update — 8 October 2026

Services replaces Connections while keeping six top-level tabs. Its default inventory groups the fictional environment's 18 services into five Model APIs, three Inference clouds, four Routers, three Gateways, and three Runtimes. Unclassified entries remain available when a source does not establish a type. The environment map is a secondary view; old `#connections` links still open it. Service details link models, deployments, reported paths, explicitly associated limits, and identification evidence. Creators alone never create API connections.

Local verification passed 171 tests, including eight new service-aggregation cases, plus syntax, typecheck, build, demo, and documentation checks. Browser verification covered type filters, search/reset, service-to-model and source details, command search, the overview map link, legacy hashes, keyboard focus across passive refreshes, and all six tabs at 1440 px and 390 px. A synthetic browser fixture verified configured-only and unclassified entries with no activity, redacted endpoint identity, and an inspector without horizontal overflow on an emulated touch screen. No JavaScript errors or external requests were observed. Physical phones and customer cloud accounts were not tested. Logs: `/private/tmp/terminal-service-inventory-verify.log`; screenshots: `/private/tmp/terminal-service-inventory-desktop.png` and `/private/tmp/terminal-service-inventory-detail.png`.

Published at `dash.openmerit.site` as Worker version `be6cbecd-0094-42e9-943d-58d63158dabd`. The deployment hook repeated documentation checks and all 61 terminal tests. Live HTTPS checks confirmed the Services tab, 18 service rows, all three inference clouds, service/source inspectors, the secondary map, and no page overflow at 390 px. The title and fictional-data boundary remain intact: `/api/snapshot` returns 404, sample mutations return 405, and there is no local-environment switch. No browser or console errors or external requests were observed. Deployment log: `/private/tmp/terminal-service-inventory-deploy.log`; live screenshot: `/private/tmp/terminal-service-inventory-live.png`. Only the separate terminal preview was deployed.


### Application scope and complete maps — 9 October 2026

Published source commit `43ad7c5` at `dash.openmerit.site` as Worker version `a16b01be-b280-448b-9dbe-503b20a1dfdd`. This includes the complete grouped environment map, the separately bundled `?map=flow` experiment, and application-only source guidance. The sample still contains 9,600 fictional requests, 40 agents, 140 tasks, and 21 models. Local application collectors and VM data are not included in the Worker.

The first upload (`1cd39eb1-a394-43e6-9a1e-573910400108`) exposed a public-network loading problem: a compressed sample transfer took about 13 seconds while the browser used a 5-second localhost deadline. The final build allows 30 seconds for hosted sample refreshes, preserving 5 seconds for local snapshots and the existing single-request guard. This is a response deadline, not a change to the 15-second polling cadence or data retention. A follow-up fixes script/style headers so Cloudflare can compress the larger optional map bundle; HTML retains `no-transform` to prevent zone-level analytics injection.

The deployment hook passed all 92 terminal tests, 11 documentation checks, and syntax checks. Live HTML, app JavaScript, styles, and both map assets matched the built files byte for byte. The sample-only info and API counts were verified over HTTPS; `/api/snapshot` returned 404 and sample mutations returned 405. All six default tabs passed browser checks at desktop and 390-pixel widths without page overflow. Agent selection represented the complete focused request count, the agent inspector opened, and the environment selector offered only the fictional sample. The optional map represented all 9,600 requests, workload search returned its recorded member, and its 390-pixel view had no page overflow. A fresh browser load and subsequent refresh succeeded with no console errors. The compressed map script transferred 585,941 bytes instead of 1,934,755 bytes and matched the built file after decoding. One Node HTTP check timed out; the HTTP/2 transfer and fresh browser load succeeded.

Deployment log: `/private/tmp/terminal-application-scope-compressed-deploy.log`. Asset and API evidence: `/private/tmp/terminal-application-scope-live.json`. Live screenshot: `/private/tmp/terminal-application-scope-live.png`. The published npm package and main website were not changed.


### Friends’ install download — 9 October 2026

Published source commit `9c62859` as Worker version `9453d410-b7bc-4719-a0e7-9dc4139049c4`. The public test download is `openmerit@0.1.5-dash.d1288465e28b`, 1,026,220 bytes, with SHA-256 `0fd079d4ab241d8e83010ad147cbe6559c39aa37fcd803fff57afbb06b60b13d`. The stable npm release and main website were not changed. Only two new static assets were uploaded: the package and its build information; the sample's browser assets and Worker collection boundaries are unchanged.

Full verification passed 205 tests plus syntax, typecheck, build, and documentation checks. The deployment hook repeated all 95 terminal tests and 11 documentation checks. A disposable VM npm prefix installed directly from `https://dash.openmerit.site/install/openmerit-preview.tgz` in seven seconds. Its installed `openmerit dash`, run from the existing application directory, retained all 240 requests, 40 worker IDs, and 120 task IDs across a passive refresh, with 111 evidence files unchanged and zero inference calls. The public package metadata matched the deployed build. Local macOS acceptance verified actual default-browser opening; headless Linux acceptance verified the printed URL. Windows desktop opening remains unit-tested only.

Logs: `/private/tmp/terminal-friends-verify.log`, `/private/tmp/terminal-friends-deploy.log`, and `/private/tmp/terminal-friends-public-install.log`. Default-browser proof: `/private/tmp/terminal-friends-browser-open.png`.


### npm preview release — 9 October 2026

Published `openmerit@0.1.6-preview.0` to the existing npm package under the `preview` dist-tag. Registry metadata confirms `latest` remains `0.1.5`. The 96-file package is 1,027,818 bytes; its registry SHA-1 is `f24084567529a6bcfcace5b73c1578ca4fe53d92`, and its SHA-512 integrity matches the tested tarball. npm first accepted the upload for publish-time scanning; availability and the preview tag were verified after processing, before the successful installation test.

`npm run verify` passed 205 tests plus syntax, typecheck, build, demo, and documentation checks. The normal root `npm pack` contains the compiled core, protocol, Pi adapter, and terminal, with documentation and legal files. Package export checks and installed-package smoke tests passed. The sample-only build also passes after removal of the separate installer builder.

A fresh npm cache and disposable global prefix in the isolated Linux VM installed directly with `npm install -g openmerit@preview`. The cold install added 86 packages in approximately three minutes. Running its installed `openmerit dash` from the existing application directory retained all 240 requests, 40 worker IDs, and 120 task IDs across a passive refresh. All 111 evidence files remained unchanged, and the terminal made zero inference calls. The headless session printed its localhost URL. Actual macOS default-browser opening was verified for the same CLI implementation before this release; Windows desktop opening remains unit-tested only.

The package is now available through npm without a repository checkout or build step. The separate sample Worker and main website were not redeployed by this release; the earlier domain-hosted test download remains at its last deployed version. The source sample build no longer generates that download.

Evidence: `/private/tmp/terminal-npm-preview-verify.log`, `/private/tmp/terminal-npm-preview-smoke.log`, `/private/tmp/terminal-npm-registry-release.json`, and `/private/tmp/terminal-npm-registry-vm.log`. Publication screenshot: `/private/tmp/openmerit-npm-preview-published.png`.


### Historical activity — npm preview release, 9 October 2026

Published `openmerit@0.1.6-preview.1` under the `preview` dist-tag, 1,031,362 bytes and 97 files, with SHA-1 `58be1c9606e3e39e33033e8479960eb68e67d03d`. Registry metadata and SHA-512 integrity match the tested package; `latest` remains `0.1.5`. This update removes collector and project-log age cutoffs, adds 7d/30d/default All time, and shows earliest/latest retained evidence with known partial-coverage disclosure. Existing file/read/cache bounds remain; it is not a persistent or complete project-lifetime archive. npm availability was confirmed after publish-time processing completed.

Full verification passed 210 tests plus syntax, typecheck, build, demo, and documentation checks. Browser checks covered exact 24h/7d/30d/All time request counts, keyboard range selection, calendar labels, partial-history disclosure, the enterprise sample and optional map, and a 390-pixel layout without page overflow. No browser warnings or errors were observed. A synthetic stopped Groq project retained three requests from 2020–2022 across separate installed-CLI invocations in the VM; future-dated evidence was excluded and its files were unchanged. The existing real VM workload separately retained all 240 requests, 40 workers, and 120 tasks across a passive refresh, with 111 evidence files unchanged and no inference calls.

Evidence: `/private/tmp/terminal-history-verify.log`, `/private/tmp/terminal-history-pack.json`, `/private/tmp/terminal-history-vm.log`, and `/private/tmp/terminal-history-vm-archive.log`. Browser screenshot: `/private/tmp/openmerit-history-desktop.png`.

A separate disposable global prefix in the Linux VM installed directly with `npm install -g openmerit@preview` and resolved `0.1.6-preview.1`. The registry-installed CLI repeated both acceptance checks: the existing real application retained all 240 requests, 40 worker IDs, and 120 task IDs across a passive refresh, with 111 evidence files unchanged; the synthetic dormant Groq project retained its three 2020–2022 requests across CLI restarts and rejected future-dated evidence. Neither check generated inference traffic. Friends can update with the same npm command and restart `openmerit dash`. The sample Worker and main website were not redeployed.

Registry-install evidence: `/private/tmp/terminal-history-registry-release.json`, `/private/tmp/terminal-history-registry-vm.log`, and `/private/tmp/terminal-history-registry-vm-archive.log`.


### Project evidence corrections — npm preview release, 9 October 2026

Published source commit `eb2f6c4` as `openmerit@0.1.6-preview.2` under the `preview` channel. The 98-file package is 1,037,558 bytes, with SHA-1 `f6d1885ac219e34df6e63d63f1e829be94015592`. npm registry metadata and SHA-512 integrity match the verified tarball. It removes inferred project services and physical placement, separates task summaries from request metrics, retains unknown request metadata, discloses inventory omissions, and distinguishes unknown activity from measured zero. Publication completed after npm's upload processing. The stable `latest` tag remains `0.1.5`; the hosted sample and main website were not deployed.

The same implementation, packaged locally before the version bump, passed 230 repository tests and VM acceptance. Plain `openmerit dash` started in 106 ms, preserved all 240 existing request records, 40 original agent IDs, and 120 original task IDs, and refreshed passively. Two additional direct local Ollama calls were automatically read from a new application log within about nine seconds, bringing totals to 242 requests, 41 agents, and 122 tasks. All 125 original project files were unchanged. No terminal configuration was needed and no paid provider calls were made. Separate temporary projects verified that ambient shell keys and unrelated Ollama do not create inventory, native project endpoint declarations return the three installed models, and explicit host links match the VM's real hostname and current resident model list. The retained local acceptance report is `/private/tmp/terminal-evidence-vm/acceptance.json`.


The VM subsequently updated directly from npm with `npm install -g openmerit@preview` (using sudo for its root-owned global prefix). Installation completed in 13 seconds and resolved `0.1.6-preview.2`. Plain `openmerit dash` started in 109 ms and preserved all 242 request records, 41 agent IDs, and 122 task IDs through passive refresh. All 126 project files were unchanged; no new inference calls were made during this registry acceptance. Core, protocol, and Pi exports imported successfully, and the headless browser fallback printed the local URL. The registry-installed CLI repeated the empty-project, declared-Ollama, and explicit-host checks against real VM inventory. The persistent service was restarted and verified at the private forwarded URL `http://127.0.0.1:4313/`.

Friends can update with `npm install -g openmerit@preview`, stop the old terminal process, and run `openmerit dash` again in their application directory. Full release verification passed 230 tests plus syntax, typecheck, build, demo, and documentation checks. Registry evidence: `/private/tmp/terminal-evidence-release/registry.json`, `/private/tmp/terminal-evidence-release/tags.json`, and `/private/tmp/terminal-evidence-release/registry-vm.json`. The package remains a test preview; these checks do not establish universal application-log compatibility.


### Endpoint coverage and review corrections — npm preview release, 10 October 2026

Published source commit `d9b4c17` as `openmerit@0.1.6-preview.3` under the `preview` dist-tag. The package contains 101 files, is 1,064,965 bytes, and has SHA-1 `1724996b2826aaf93ab1dee5e7701b7f9aabe886`. Registry SHA-512 integrity matches the exact tested tarball. Availability was confirmed after npm publish-time processing completed; stable `latest` remains `0.1.5`. The release includes the shared 39-service endpoint registry, separate Hugging Face dedicated/router identities, bounded JSONL continuity checks, outcome conflict reporting, fresh multi-host residency precedence, and unavailable model-usage handling.

Full release verification passed 256 tests (146 terminal tests) plus syntax, types, build, demo, and documentation checks. Before publication, the exact preview.3 tarball was installed into an isolated VM prefix and passed plain `openmerit dash`, a passive refresh, and separate temporary endpoint fixtures. The preceding implementation acceptance also passed 47 targeted Linux regression tests. Endpoint fixtures test declaration recognition and redaction; they do not establish live connectivity to all supported providers.

After publication, the VM updated directly with `npm install -g openmerit@preview` (using sudo for its existing root-owned global prefix). The installed version is `0.1.6-preview.3`. Its persistent dashboard was restarted and verified at `http://127.0.0.1:4313/`. All 242 retained request records, 41 agent IDs, and 122 task IDs stayed deeply equal across a 15-second passive refresh; all 126 application files remained unchanged. Installed endpoint-registry and served-client hashes match the tested build. Core, protocol, and Pi package exports import successfully. Temporary endpoint fixtures repeated configuration-only, unknown-override, saved-metadata, and credential/resource-redaction checks and were removed. No new inference calls were made.

Friends can update with `npm install -g openmerit@preview`, stop any running terminal, and run `openmerit dash` again from their application directory. The main website and hosted sample were not deployed. The source branch remains `codex/inference-terminal-preview`; this is a preview release, not a stable-channel release or a claim of universal log compatibility.

Evidence: `/private/tmp/terminal-preview3-release/verify.log`, `pack.json`, `registry.json`, `tags.json`, `tarball-vm.json`, and `registry-vm.json`. Publication screenshot: `/private/tmp/terminal-preview3-release/npm-published.png`.


### Repository index — npm preview release, 10 October 2026

Published source commit `38d294f` as `openmerit@0.1.6-preview.4` under the `preview` dist-tag. The 103-file package is 1,080,626 bytes, with SHA-1 `f5217dc0e49f89cb48c129d65cd046443667a56a`. npm registry SHA-512 integrity matches the exact tested tarball. Availability and the preview tag were verified after npm processing; stable `latest` remains `0.1.5`. The release adds bounded repository syntax indexing, nested configuration and custom endpoint references, file/line evidence, and counts-only diagnostics. Static declarations remain distinct from recorded usage.

Full release verification passed 272 tests (162 terminal tests) plus syntax, typecheck, build, demo, and documentation checks. Before publication, the exact release tarball was installed in an isolated VM prefix and passed plain `openmerit dash`, a passive refresh, diagnostics, package-export imports, and installed/served asset hashes. It preserved all 246 request records and all 128 application files.

After publication, the VM updated from the registry using `npm install -g openmerit@preview` with sudo for its existing root-owned prefix. Installation completed in 14 seconds; plain `openmerit dash` started in 306 ms. The temporary source-build service override was moved to the VM release evidence directory, restoring the original `/usr/local/bin/openmerit` service command. The persistent dashboard at `http://127.0.0.1:4313/` passed the same checks across a passive refresh. All 246 request records remained deeply equal and all 128 application files stayed unchanged. The four HF records retain three completed requests, one prior credit failure, 99 input tokens, and 30 output tokens. Those calls were made by a separate test application before release acceptance; the application explicitly logged its provider/route metadata. Installation and acceptance generated no new inference calls.

Friends can update with `npm install -g openmerit@preview`, stop the running terminal, and launch `openmerit dash` again in the application directory. This verifies the saved VM workload and supported source patterns; it does not establish complete discovery of arbitrary applications or reconstruct missing usage. The hosted sample and main website were not deployed.

Evidence: `/private/tmp/terminal-preview4-release/verify.log`, `pack.json`, `build.json`, `registry.json`, `tags.json`, `tarball-vm.json`, `registry-vm.json`, and `persistent-vm.json`. Publication screenshot: `/private/tmp/terminal-preview4-release/npm-published.png`.


### Sample synchronized with preview.5 — 10 October 2026

Published source commit `0648af7` to `dash.openmerit.site` as Worker version `1cff2493-3b72-4609-ad6c-7bf02d47d669`. The sample now uses the browser assets from npm `0.1.6-preview.5`, including the historical activity ranges, revised evidence displays, service identities, and current map bundles. Repository discovery and phased indexing remain local collector behavior; the hosted Worker still imports only the fictional sample generator. No actual repository, VM history, or local environment was uploaded. The obsolete interim installer assets are no longer included; npm is the documented delivery channel.

The deployment hook passed 171 terminal tests, 11 documentation checks, and syntax checks. All 26 public assets matched the local build over HTTPS. The sample matched the current generator (allowing only negligible cross-runtime floating-point differences), with 9,600 requests, 40 agents, 140 tasks, and 21 models. `/api/info` identifies a hosted sample, `/api/snapshot` returns 404, and POST to `/api/sample` returns 405. All six views passed browser checks at desktop and 390-pixel widths with no page overflow or console errors. The 7d/All time controls, agent inspector, and sample-only environment picker worked; the optional map also represented all requests without mobile page overflow. Physical phones were not tested.

Only the terminal sample was deployed; the npm package, private VM service, and main website were unchanged. Evidence is retained at `/private/tmp/terminal-sample-preview5/deploy.log`, `live.json`, and `live-overview.png`.

### Enterprise comparison — implementation, 10 October 2026

The hosted root now uses the enterprise grouped sample described in `inference-terminal.md`. `/demo` and `/demo/` serve the terminal with an explicit before/after switch; all request and token volumes remain identical across the switch. Standard published model rates and provider links are bundled with the deterministic scenario. This is an illustrative cost calculation, not a measured optimization result. Browser loads use a small seed instead of transferring the full 9,600-row snapshot; full sample APIs remain available. The local collector and npm release are unchanged. Deployment verification is recorded below after publication.

Published commit `9412b38` as Worker version `4ceaa337-fc28-47fb-af4e-c61b3386fad5`. The root contains 9.6 million represented requests, 200 agent IDs, 699 task IDs, 21 models, 93.5 billion tokens and approximately $118,991 in modeled token cost with partial price coverage. The comparison uses nine model assignments across six providers, with 94.8 billion identical tokens in each state: $248,117.60 before and $89,371.07 after, a computed 64.0% difference. These are scenario totals, not measured OpenMerit results.

Full verification passed 288 tests and the applicable syntax, build and documentation checks. The final deployment repeated 178 terminal tests and documentation checks. Local browser checks covered all six tabs at desktop and 390 px, keyboard stage selection, seven-day ranges, model names after switching, and the price inspector's 18 official-source links. The live root's larger totals and unknown-cost explanations were verified, and the published comparison switched all nine model assignments while retaining the request total. No page or inspector overflow or browser errors were observed. Root, `/demo`, `/demo/`, application JavaScript, styles and the optional map bundle matched the local build over HTTPS. The seed response contains only a recipe version and timestamp; `/api/snapshot` remains 404 and sample mutations return 405.

The first deployment revealed Cloudflare's canonical-HTML redirect behavior: fetching `/demo/index.html` through the asset binding redirects to `/demo/`. The final Worker fetches that canonical directory directly so both comparison URL forms return 200 without a redirect loop. Evidence: `/private/tmp/enterprise-verify.log`, `/private/tmp/enterprise-deploy-final.log`, `/private/tmp/terminal-enterprise-demo/live.json`, `/private/tmp/terminal-enterprise-demo/live-overview.png` and `/private/tmp/terminal-enterprise-demo/live-models.png`.


### Insurance comparison and evidence policy — implementation, 10 October 2026

The comparison scenario is now `insurance-tech-demo`: 200 fictional application workers, 700 task IDs, ten insurance workflow families, six model services, and the same 9.6 million represented requests and 94.8 billion tokens before and after. A small reviewed catalog replaces the earlier unconditional cheap-model assignments. A replacement must retain its configured service and output contract, match or improve the selected comparable public tool-use, capability and reasoning scores, and reduce token cost or have a matched latency improvement. Decision workflows additionally require accuracy and calibration evidence. Jev is recognized as a typed-decision model; it is not used without those checks.

Three workflows qualify in the reviewed catalog, with seven baselines retained. The scenario computes $277,301.98 before and $228,960.34 after, a 17.4% modeled token-cost reduction. The evidence drawer includes source links, score/configuration details, rejected candidates and the limitations of selected publisher point estimates. This does not establish application-level quality, latency, or universal benchmark superiority. The previous 64.0% comparison in the historical record above is superseded.

The After preference menu offers default, ZDR, open weights, no open weights, US-developer and Chinese-developer choices. Biases rank eligible replacements without weakening the checks. The current catalog yields the same three swaps in every preference; no additional ZDR, open-weight or Chinese replacement qualifies. The hard no-open-weights setting flags three incompatible retained baselines as unresolved. ZDR describes the documented endpoint policy and does not establish privacy across routers or application logs; developer origin does not establish residency.

Full local verification passed 295 tests, including 185 terminal tests, plus syntax, types, build, demo and documentation checks. Browser checks covered all six views, six preferences, keyboard selection and focus, URL persistence across navigation, seven-day and thirty-day comparisons, and a 390-pixel layout with no page or drawer overflow. No console warnings or errors were observed. These changes affect the hosted fictional demo, not production model routing. Publication verification is recorded below after deployment.

Published implementation commit `0c7e9ed` as Worker version `add11fe1-bf20-4fff-808a-2d9a4535a3fe`. Deployment repeated 185 terminal tests and the documentation checks. Live root HTML, both `/demo` URL forms, application JavaScript, styles, and the optional map bundle matched the built assets over HTTPS. The comparison API confirmed 9.6 million requests, 200 workers, 700 task IDs, the three qualified swaps, and three unresolved workloads for the no-open-weights setting; invalid preferences fall back to default. The browser seed is 33 bytes, `/api/snapshot` remains 404, and POST to `/api/demo` returns 405. The root enterprise snapshot remains deeply equal to the prior implementation at a fixed timestamp.

All six published views passed desktop and 390-pixel browser checks. Preference persistence, the evidence drawer, keyboard interaction and restored focus passed, with no horizontal page overflow or console warnings/errors. Physical phones were not tested. Only the hosted sample Worker was deployed; npm, the private VM service, and the main website were unchanged. Evidence: `/private/tmp/insurance-verify.log`, `/private/tmp/insurance-deploy.log`, `/private/tmp/terminal-insurance-demo/live.json`, `/private/tmp/terminal-insurance-demo/live-preferences.png`, and `/private/tmp/terminal-insurance-demo/live-evidence.png`.


### Expanded insurance comparison — implementation, 10 October 2026

The reviewed search now includes 25 model/service offers across all six configured services, plus Jev as an explicitly out-of-stack candidate. Workloads no longer have hand-selected candidate lists or an original-provider-only restriction. Model identity is separate from the serving offer, so a move from Groq to Baseten for the same gpt-oss checkpoint is reported as a service change. Every matched metric on each required benchmark axis must pass; a second passing metric cannot mask a regression. Public model-card evidence does not establish endpoint quality parity or insurance-task performance.

At fixed 30-day usage, four model changes and one service change produce $215,363.17 in modeled token cost versus $277,301.98 before, a 22.3% reduction. Five workflows retain their baseline. The soft preferences still converge on these choices under the reviewed evidence: the UI now explicitly reports this and shows match counts, qualifying alternatives, and before/after models and services per workload. The hard no-open-weights option has three unresolved workloads and blocks the entire After plan; no baseline open models or partial savings are presented as a compliant After result. These outcomes supersede the three-change comparison above.

Full verification passed 299 tests, including 189 terminal tests, plus syntax, types, build, demo and documentation checks. A new test renders the actual comparison and evidence views for all six preferences, including the blocked plan. Desktop browser checks verified preference selection, keyboard navigation with restored focus, URL state, the model inventory, evidence drawer and disclosure state. The browser viewport override did not apply during this run, so a new 390-pixel verification is not claimed. Changes affect the fictional hosted comparison; no production routing or local collector behavior changed. Publication verification follows after deployment.
