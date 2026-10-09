# Hosted Inference Terminal sample

This separate preview is configured for `https://dash.openmerit.site/`. It uses the isolated terminal branch and its own Cloudflare Worker, `openmerit-terminal-preview`. It does not deploy `wrangler.jsonc`, the main website, or the interactive inference demo.

## Build and deploy

```sh
npm ci
npm run verify
npm run deploy:dash-preview
```

The deploy command pins Wrangler 4.136.3 and uses `wrangler.terminal.jsonc`. Its build hook rebuilds the terminal preview, runs documentation checks, and checks/tests the terminal workspace before upload. The exact `dash.openmerit.site` custom domain uses the existing Cloudflare account. No storage, container, AI, secret, or external service binding is configured. The only binding serves bundled public assets from `dist/terminal-preview/`.

`scripts/build-terminal-preview.mjs` creates this asset directory from the same browser bundle and icons as the local terminal. It adds preview metadata, noindex, and a sample-only bootstrap marker; it never copies a project snapshot. `packages/terminal/hosted/worker.mjs` imports only the fictional sample generator, never the collector or local CLI. The Worker reuses each generated sample for its 15-second time bucket. Browser polling and reduced-motion behavior remain the same as the local interface.

`/api/info` selects sample mode and identifies the hosted preview. `/api/sample` exposes the fictional environment; other API paths return 404, and mutations return 405. The visible sample disclosure remains present, and the workspace picker offers no real environment. Static assets and API responses carry a same-origin content policy and indexing restrictions. HTML responses use `no-transform` so the zone’s automatic analytics script injection cannot alter the preview HTML. Script and stylesheet responses allow Cloudflare compression to reduce transfer time; main-site analytics settings are unchanged. `/robots.txt` also requests exclusion. This is public link sharing, not password protection.

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


### Historical activity — prepared preview, 9 October 2026

Prepared `openmerit@0.1.6-preview.1`, 1,031,362 bytes and 97 files, with SHA-1 `58be1c9606e3e39e33033e8479960eb68e67d03d`. This update removes collector and project-log age cutoffs, adds 7d/30d/default All time, and shows earliest/latest retained evidence with known partial-coverage disclosure. Existing file/read/cache bounds remain; it is not a persistent or complete project-lifetime archive. Publication must be confirmed separately before advising friends to update.

Full verification passed 210 tests plus syntax, typecheck, build, demo, and documentation checks. Browser checks covered exact 24h/7d/30d/All time request counts, keyboard range selection, calendar labels, partial-history disclosure, the enterprise sample and optional map, and a 390-pixel layout without page overflow. No browser warnings or errors were observed. A synthetic stopped Groq project retained three requests from 2020–2022 across separate installed-CLI invocations in the VM; future-dated evidence was excluded and its files were unchanged. The existing real VM workload separately retained all 240 requests, 40 workers, and 120 tasks across a passive refresh, with 111 evidence files unchanged and no inference calls.

Evidence: `/private/tmp/terminal-history-verify.log`, `/private/tmp/terminal-history-pack.json`, `/private/tmp/terminal-history-vm.log`, and `/private/tmp/terminal-history-vm-archive.log`. Browser screenshot: `/private/tmp/openmerit-history-desktop.png`.
