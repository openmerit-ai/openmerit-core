# Scout publication — 14 October 2026

Scout's beta is published at `https://openmerit.ai/scout/`. It accepts real prompts through the page, `POST /scout/api/recommend`, and the remote Streamable HTTP MCP endpoint `/scout/mcp`. The MCP tool is `scout_models`. This is separate from the npm package and Inference Terminal; no npm release was made.

## Deployed services

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
