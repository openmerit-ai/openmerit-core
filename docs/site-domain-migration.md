# Primary domain migration

## Production migration — 12 October 2026

The primary website is `https://openmerit.ai`, with the hosted terminal at `https://dash.openmerit.ai`. The domain stays registered at GoDaddy; DNS is delegated to `anton.ns.cloudflare.com` and `elinore.ns.cloudflare.com` in the existing Cloudflare account. Public TLS, email delivery, memo sign-in, and redirect cutover were verified separately.

The production main site is newer than the main checkout's `demo/worker.mjs` and `wrangler.jsonc`. It includes the protected memo, D1-backed email OTP, a newer interactive demo, and the engineering article. **Do not deploy the root Wrangler configuration to production during this migration.** Doing so would replace the deployed application with older source and omit its auth bindings. The migration instead preserves the downloaded deployed application, every existing asset, all secret bindings, D1, Durable Object namespaces, and container configuration.

The preserved branch `codex/main-before-terminal-2026-10-12` at `d89ebc4` contains the newer memo auth source and binding configuration. Reconcile that source with the promoted terminal branch before resuming root application deployments; do not replace the running app from this checkout simply to publish domain metadata.

`demo/domain-migration.mjs` is the tested domain layer. `demo/domain-router.mjs` and `wrangler.domains.jsonc` deploy a separate Worker with service bindings to `openmerit-site` and `openmerit-terminal-preview`. This ensures all public page and asset requests pass through the domain layer even when the application serves static assets before its own Worker code. The domain router owns the public domains and redirects. The application Workers remain the owners of their content, authentication, and APIs.

The main application also uses the domain layer around its preserved production entry point, with redirects disabled there. It selects the exact memo auth origin from the serving domain. Auth secrets, cookie protections, expiry, rate limits, administrator allowlist, reader records, and OTP verification remain unchanged. Cookies are host-bound: visitors must authenticate again on `.ai`; database users and reader history are retained.

## Cutover contract

- Website pages on `openmerit.site` and `www.openmerit.site` redirect to the same path and query on `openmerit.ai`; `www.openmerit.ai` also redirects to the apex.
- Dashboard pages on `dash.openmerit.site` redirect to the same path and query on `dash.openmerit.ai`.
- Redirects use HTTP 308 with `Cache-Control: no-store` to make an operational rollback effective without a long cached redirect.
- Existing `/demo/api/`, `/demo/internal/`, and `/memo/auth/` requests on `.site` keep their original application handlers and origin checks. This preserves already-open tabs and in-flight container callbacks. New page loads and new sign-ins use `.ai`.
- Existing dashboard `/api/` requests on `dash.openmerit.site` keep serving the same read-only API so already-open dashboard tabs can continue updating. Upgraded connections pass through intact.
- Cloudflare serves its managed `robots.txt` directly on each domain before the Worker. Those files remain available on the legacy hosts. Search, agent, and training bot policies are set to Block on both zones; the new domain's robots responses match the originals.
- HTML and Markdown served on `.ai` use `.ai` links, canonical metadata, social-image URLs, and email addresses. Binary assets and API data pass through unchanged.
- The four existing inbound aliases (`lazim`, `akhil`, `praveen`, and `invest`) are recreated on `.ai` with the same verified destination mailboxes. Existing `.site` aliases and MX records remain valid, avoiding a mail-forwarding chain or loss of old addresses. Catch-all stays disabled.
- The OTP sender changes to `memo@openmerit.ai` only after Email Sending has verified SPF, DKIM, DMARC, and bounce-domain DNS. Inbound routing and outbound email sending require separate Cloudflare setup.

There is no OpenMerit Cloudflare Pages project in this account. The pages are served by Workers static assets. The existing `openmerit-site.listenlater-lazim.workers.dev` address remains an application fallback; the public custom domains are the canonical entry points.

## Verification and rollback

Before enabling redirects, check valid public TLS on every `.ai` host; compare live pages and linked assets to the pre-migration capture; test memo delivery, valid OTP, invalid OTP, logout, protected Markdown, and administrator restrictions; check dashboard APIs and its read-only boundary; verify each inbound alias has the same destination and a ready email zone. Do not reset auth limits or storage to make checks pass. A configuration-only or successful send response is not proof of inbox delivery.

Deploy the domain router with `npx --yes wrangler@4.136.3 deploy --config wrangler.domains.jsonc`. Its build hook runs the domain tests and documentation checks. Keep domain ownership in that configuration, rather than adding the same routes back to the application configurations.

Run `node --test demo/test/domain-migration.test.mjs`, `npm run check:docs`, and applicable `npm run verify` checks. Public docs remain generated from Markdown; generated `site/docs/` files are not edited. Homepage product/FAQ claims are unchanged by the domain migration.

Local rollback material and before/after evidence are under `/private/tmp/openmerit-domain-migration/` (private directory). The original main application version is `294f810c-5c46-4353-ab13-67ab0aa89464`; the original terminal version is `111171c5-34bb-4a25-91bc-60f8e96f371e`. The recorded `.site` routes, mail rules, binding metadata, and original deployed modules are preserved there. Restore the previous route ownership and application version together if rollback is needed; keep both domains' mail delivery configured.

## Publication status

The zone activated on 12 October 2026 at 16:45 UTC. Inbound Email Routing is enabled, synchronized, and ready. Email Sending is enabled with configured DNS. A real OTP from `memo@openmerit.ai` reached the owner's inbox with SPF, DKIM, and DMARC passing. A second OTP sent to `lazim@openmerit.ai` reached the same inbox through its `code@lazim.one` destination, verifying the new inbound route.

The main application now uses the verified `.ai` sender while preserving both request origins. The terminal deployment changed only its canonical/social metadata and generated social image; the application JavaScript, CSS, favicon, and flow stylesheet were compared byte-for-byte with production before publishing.

The domain-reference audit covers the README, public guide links, website and memo generators, canonical/Open Graph/Twitter metadata, sharing-image notes, the engineering article's metadata/navigation, hosted dashboard tests, and the demo's provider attribution URLs. GitHub's repository website field is empty. Historical deployment records, compatibility handlers/tests, legacy redirect routes, and the old generated memo snapshot retain their original domains. The two production `HTTP-Referer` constants are changed from `.site` to `.ai` without rebuilding the application or replacing its assets. Both application configurations have empty `routes` arrays; all six public hosts are managed by `wrangler.domains.jsonc`.

All 88 captured legacy URLs retain their original status codes after staging. 83 response bodies are byte-identical; the remaining five are the two intentionally updated dashboard HTML documents and three time-dependent sample API responses. `npm run verify` passed; all seven domain-layer tests and the documentation checks passed.

Valid public HTTPS on all three `.ai` hosts was confirmed at 17:43 UTC. The `.ai` URL comparison retained all 88 original status codes. After matching Cloudflare's crawler policies, 83 bodies match the originals after document-domain substitution; the five exceptions are the two intentionally updated dashboard HTML documents and three time-dependent sample API responses.

A real `.ai` OTP login succeeded in the browser. The protected memo and its 53,283-byte Markdown download were accessible after sign-in, the non-admin reader account was denied the reader list, and sign-out returned to the email gate. Expired/invalid codes and untrusted origins were rejected. Documentation search and its section links, dashboard Activity navigation, and demo initialization worked without browser console errors. Dashboard mutations remain HTTP 405 and the private snapshot route remains 404.

Redirects are enabled. The router owns the old apex/www routes, all three new custom domains, and the old dashboard custom domain. All 88 legacy URLs retain their original final status after cutover and reach the expected host, allowing for the documented API and managed-robots exceptions. HTTP 308 redirects preserve encoded query strings and paths; browser checks also preserved the dashboard fragment. Both email zones remain enabled, synchronized, and ready, with all four new aliases enabled and the catch-all disabled.

Active versions: main application `08a1ad0f-ae83-4179-a4e9-a174ba746b71`; terminal `49abf964-8633-466a-a4c6-29cdc8007f55`; domain router `7e5cbee3-1c26-4cb8-afd6-07b6a092ee31`.

One user-approved live demo request completed with all four comparison cases passing through OpenAI and produced the expected proposed assignment; the session was then ended. OpenRouter candidates returned HTTP 400 from the inference gateway during that run. Their underlying provider error was not exposed, and its cause was not established. This check does not establish that every provider integration is healthy. No additional paid experiment was run, no proposed setup was approved, and no provider credentials, model request bodies, limits, or budgets were changed.
