# Website memo

Domain operations: see the [primary domain migration](site-domain-migration.md) for current routing, email, auth, and deployment constraints. Historical publication records below retain their original domains.

## Demo retirement — unreleased source, 3 November 2026

The `openmerit-site` Worker now serves only the memo. `demo/site.ts` handles memo routes and falls back to the retained asset bundle for memo styles; the domain router already sent nothing else to this Worker. The recorded and interactive demos, their container, admission ledger and provider gateway are removed from the source, and `wrangler.jsonc` drops the container and both Durable Object bindings.

The configuration adds the `remove-demo-v1` migration, which deletes the `DemoContainer` and `DemoGate` classes and their stored admission records on the next release. That release needs the owner's approval like any other deploy. Afterwards, check whether the `openmerit-site-democontainer` container application still exists in Cloudflare and delete it separately if so.

## Protected memo reconciliation — local only, 29 October 2026

The protected article's maintained source is [the recovered published memo](memo-published.md), restored byte-for-byte from `codex/main-before-terminal-2026-10-12`. The earlier `docs/memo.md` draft is unchanged and is not built. This avoids replacing the running article with the older draft during a logo release. The historical static-page records below describe earlier releases, not the current access boundary.

`demo/memo/auth.ts` and `worker.ts` restore the preserved email-code contract: six-digit codes, ten-minute expiry, five wrong attempts, single-use verification, hashed codes, database-backed send/attempt limits, seven-day HttpOnly sessions without sliding renewal, and sign-out revocation. Any verified email can read the article and Markdown. Only exact addresses in `MEMO_ADMIN_EMAILS` can access reader records and CSV export. Article GET requests count as visits; HEAD, prefetch, Markdown, sign-in and admin requests do not. Missing configuration or database failures keep the article closed. These records include email, first/latest visit and visit count; sessions also retain IP address and user agent. There is no automatic reader-record deletion.

Better Auth is pinned to 1.7.14 rather than restoring the archived 1.7.6 dependency, whose audit reports security advisories. The preserved migrations are not rewritten. Local verification uses disposable D1, not production data; no remote migration, email, secret change or deployment is part of this reconciliation.

The root entry point `demo/site.ts` puts memo authentication before asset fallback. The deployed interactive gateway, provider/catalogue adapters and admission ledger have also been recovered in TypeScript, retaining their existing storage keys and class exports. `demo/runtime/site-config.ts` keeps the deployed Worker configuration separate from the older local demo's fixture catalogue. The root configuration matches production's nonsecret settings, memo database ID, email sender restrictions and historical Durable Object migration tags. The existing domain wrapper preserves legacy `.site` auth origins. It does not enable direct Worker URLs, claim public domains or change the domain router.

The release configuration is code-only: documented `keep_assets` upload metadata retains the existing asset bundle instead of uploading the older local `site/` directory. The container is pinned to its live image digest, and the deployment wrapper forces `--containers-rollout none` for a future site release. No container rebuild or new database migration is required. Wrangler 4.136.3 exposes asset retention through its experimental `unsafe.metadata`/`unsafe.bindings` configuration; successful local checks do not prove that the remote asset attachment has happened.

Local verification passed `npm run verify`, 88 status/body/header comparisons against the exact active Worker modules, and all eight archived admission/gateway tests with only their imports redirected to the recovered TypeScript. A read-only production schema query confirmed all seven required memo/auth tables; no user records were read. The published Markdown remains exactly 53,283 bytes. Both memo stylesheets match production byte-for-byte. Earlier Chrome runs exercised sign-in, wrong-code recovery, reload/new tab, protected Markdown, reader/admin permissions, CSV, logout, offline recovery, JavaScript-disabled reading, print and mobile light/dark. Archived Better Auth sessions, pending codes and reader history survived the dependency upgrade in disposable local D1.

**Asset-retention provenance is reconciled; publication is not authorized.** The active version is `9b0ea195-8c33-40b0-a5ee-a21f3e31a46d` (145), and the latest uploaded version is `f6c5d9ae-107a-49e9-883a-5046e57d810c` (146), which was never activated. The [analytics upload record](https://ampcode.com/threads/T-01a15d52-479c-714c-8a71-95470f68cab4) preserves the executed request and creation receipt: its pre-upload guards required 145 to be both latest and 100% active, and the upload explicitly used `keep_assets: true` with no `assets.jwt`. A read-only comparison also confirmed unchanged original modules, bindings, asset configuration, containers and compatibility. This establishes the retained predecessor bundle through the upload request, not an independent complete asset-manifest export.

`keep_assets` inherits the latest upload, not a caller-selected active version. The wrapper permits only a sole 100% active version matching the latest upload, or the exact verified 145-active/146-latest pair above. It rejects other undeployed uploads and split deployments. Do not activate 146 merely to clear a guard. The blanket source-mismatch block is removed locally; clean merged code, green CI, a dry run and explicit release approval are still required. After an approved release, verify real inbox delivery, an existing production session and the retained assets. Neither that production acceptance nor the remote asset attachment has been exercised by local verification. Do not bypass the wrapper or write production test data without approval. Current changes are local, not published.

## Editing and building

- Edit `docs/memo-published.md` for article changes. Do not edit the generated `site/memo/` directory.
- `scripts/docs.config.mjs` records the memo's source, route, and description separately from the product guides. The memo is outside the documentation navigation and operational search index.
- `scripts/build-memo.mjs` generates the article HTML, exact Markdown and sharing metadata into ignored `demo/memo/generated/content.ts`, outside public assets. It removes stale memo assets before writing only the login gate to `site/memo/index.html`. `/memo/source.md` is served only after session verification. Both memo Markdown sources remain excluded from npm by `docs/.npmignore`.
- `scripts/memo-svg.ts` restores the small allowlisted SVG renderer for the published article's ten diagrams. Raw Markdown HTML remains disabled.
- `site/memo.css` retains the reference reading layout and device-driven themes. The gate, article and admin pages use Scout's OpenMerit logo. Sign-in and sign-out require the built `site/memo-access.ts` client; private content itself is server-rendered. Sharing metadata uses the existing social image and never grants crawler access to the article.

Run `npm run check:demo` to install the pinned demo dependencies, build the private content, strictly typecheck the memo and exercise the production entry point with real local D1. The simulator intercepts the delivery adapter's outbound email HTTP request; it never sends real email. `npm run check:docs` additionally checks that article/source text is absent from the gate and public search. `npm run check:typescript` enforces TypeScript for the recovered first-party code.

For an interactive local preview, install dependencies with `npm ci --ignore-scripts --prefix demo`, then run `npm run memo`. It listens on loopback port 45834 by default (`MEMO_PREVIEW_PORT` overrides it). Its separate local entry point bypasses only the canonical-host wrapper and captures email into ignored `.wrangler/memo-preview/last-email.json` with mode 0600. D1 is disposable, local admin is `admin@example.test`, and external network requests are blocked by the simulator. A plain static preview can show the gate but cannot sign in. Building or passing checks does not publish anything.

## Local verification

On 2026-09-28, all 11 documentation checks passed. The maintained memo is byte-for-byte identical to the supplied attachment. Browser checks confirmed `/memo` resolves to the article, one H1, nine section headings, ten reading links, and no horizontal overflow at widths from 320px to 1440px. Desktop and phone-sized screenshots were reviewed. The homepage's mobile Menu → Memo link, keyboard skip link, back-to-top link, and Markdown link worked; the complete article and navigation also worked with JavaScript disabled. No browser runtime errors were observed. These were local browser checks; physical phone hardware was not tested. Production asset verification is recorded below.

## Production publication

Published on September 28, 2026 as Worker `6b9dfbd1-d9a0-4f13-9120-4e754774998a`. The memo HTML, exact Markdown download, stylesheet, and abstract header artwork on both `openmerit.site` and `www.openmerit.site` match the maintained local build byte for byte. The homepage navigation is also published and matched. Repository verification and all 11 documentation checks passed.

## Device appearance — published 14 October 2026

Memo prose, tables, SVG diagrams, and the recovered protected-memo access components now use the shared device-driven light/dark palette. The email gate, code-entry/error states, reader list, and message pages use the same colors. Print remains light. No authentication logic or protected content was changed. See [theme maintenance](site-themes.md), including the production-source mismatch and presentation-only verification limits.
