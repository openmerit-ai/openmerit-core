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

`/api/info` selects sample mode and identifies the hosted preview. `/api/sample` exposes the fictional environment; other API paths return 404, and mutations return 405. The visible sample disclosure remains present, and the workspace picker offers no real environment. Static assets and API responses carry a same-origin content policy and indexing restrictions. Asset responses use `no-transform` so the zone’s automatic analytics script injection cannot alter the preview HTML; main-site analytics settings are unchanged. `/robots.txt` also requests exclusion. This is public link sharing, not password protection.

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
