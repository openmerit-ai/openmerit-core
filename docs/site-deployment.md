# Deployment and rollback

Every production deploy needs the owner's explicit approval (see `AGENTS.md`). This note covers how an approved deploy runs and how to undo it.

## Deploying

```sh
npm run deploy:status                      # read-only: live versions
npm run deploy -- <worker> --dry-run       # build and check without uploading
npm run deploy -- <worker>                 # asks you to type "deploy"
```

`scripts/deploy.ts` refuses to deploy unless:

- the checkout has no uncommitted or untracked files;
- `HEAD` is on `origin/main`;
- the `verify` CI check passed for that commit.

The `playground-claims` target also requires its `playground` CI check and uses
the Wrangler pinned in `playground/node_modules`; run `npm ci` in `playground/`
first. Its deployment does not start scenarios, call models, approve payments or
backfill historical Langfuse data.

It runs the pinned Wrangler with `--strict`, which stops if someone changed the Worker in the dashboard. It tags the new version with the commit's short SHA, and the version message includes the commit subject. A receipt is written to `.deploys/<worker>/<time>.json` (ignored by Git). The receipt records the versions before and after the deploy and the exact rollback command. Pass `--yes` only when a non-interactive run has the owner's approval.

`deploy:status` lists the live versions of every Worker. For each tagged version, it shows how far it is behind `origin/main`. "Untagged" means the version was deployed outside the wrapper.

| Key | Worker | Config | Serves |
|---|---|---|---|
| `domain-router` | `openmerit-domains` | `wrangler.domains.jsonc` | Every public host; redirects; `/memo` to `openmerit-site`; `/mcp`, `/.well-known/oauth-protected-resource` and `/api/*` to the cloud app |
| `scout-serving` | `openmerit-scout-alpha` | `wrangler.scout-alpha.jsonc` | Landing page, `/playground/scout/`, the buyer-question pages and the contact-sales form; redirects `/scout` and everything under it to `/contact-sales/` |
| `playground-claims` | `playground-claims` | `playground/wrangler.jsonc` | Sahra Health's customer claims and enrollment workflows |
| `site` | `openmerit-site` | `wrangler.jsonc` | Protected memo. Code-only release with asset-retention checks and no container rollout |
| `app` | `openmerit-app` | `wrangler.app.jsonc` | `app.openmerit.ai`: the cloud plan's run, task and account pages, built from `app/` by `scripts/build-app.ts` and served by `app/worker.ts`. Clerk sign-in; data from the cloud app's `/api/*`. Its first deploy creates the `app.openmerit.ai` custom domain |
| `email` | `openmerit-email` | `wrangler.email.jsonc` | Inbound `openmerit.ai` aliases that reach more than one person; see [Email forwarding](#email-forwarding) |

Deploy `scout-serving` before `domain-router` when a change spans both, as the rebuild cutover did.

**Scout sign-in retired — unreleased source, 26 November 2026.** At the owner's request, `/scout/` and its Clerk sign-in are gone: `scout-serving` answers `/scout` and every path under it, including `/scout/api/auth` and `/scout/api/session`, with a 308 to `/contact-sales/`, and the homepage's **Get Demo** button and every page's nav link go there. Nothing else used those APIs; `app.openmerit.ai` has its own sign-in. The Worker no longer reads its `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` secrets; deleting them is a separate secret change that needs approval.

**Team inbox — unreleased source, 26 November 2026.** `email/` and `wrangler.email.jsonc` are back, so `openmerit-email` is managed from this checkout again (key `email`); the deployed version matched the last source except for `team@`. `team@openmerit.ai` reaches lazim and praveen, and the contact-sales form sends there. See [Email forwarding](#email-forwarding) for the order of the deploy and the routing rule.

**Contact-sales form — unreleased source, 26 November 2026.** `scout-serving` handles `POST /contact-sales/api` in `demo/contact.ts`. It validates the form, allows three submissions a minute per IP (`CONTACT_RATE`, rate-limit namespace `2026112601`) and emails each request through the `CONTACT_EMAIL` send binding from `CONTACT_FROM` (`memo@openmerit.ai`, the sender the memo already verified) to `CONTACT_TO` (`team@openmerit.ai`, the only allowed destination), with Reply-To set to the sender. It stores nothing. The deploy that first adds these bindings is an email change and needs the owner's approval like any deploy. After it, submit the form once with a real address and check the email arrives and Reply-To works; the form falls back to the `mailto:` address when sending fails.

**Cloud app routes — unreleased source, 18 November 2026.** On `openmerit.ai`, the router proxies `/mcp`, `/.well-known/oauth-protected-resource` and `/api/*`, each with its subpaths, to the cloud app at the origin in the `CLOUD_APP_ORIGIN` variable of `wrangler.domains.jsonc`. It keeps the method, query, body and headers, drops the `Cookie` header, and sets `X-Forwarded-Host` and `X-Forwarded-Proto`. It is `https://openmeritdr2i.onrivet.dev`, the cloud app on Rivet Cloud. When the variable is empty, those paths return 503 with `Cache-Control: no-store`, and nothing else on the site changes; setting it to `""` and deploying is the way to take them offline without a rollback. After changing it, run `npm run types:workers`, land the change, and deploy `domain-router` with approval. No DNS change is needed. Deploy the router only once the cloud app answers at that origin: until then `/mcp` and `/api/*` return the origin's errors instead of 503.

**Website pageviews — unreleased source, 19 November 2026.** The router sends a PostHog `$pageview` (`interface: "website"`) from `demo/pageview.ts` for each successful `GET` on `openmerit.ai` whose response is HTML, after the response is returned (`ctx.waitUntil`, 2 s timeout); it never changes or delays the response. It skips `HEAD` and other methods, non-2xx responses, the `www` and `.site` redirects, `/mcp`, `/.well-known/*`, `/api/*`, `/assets/*`, non-HTML responses and user agents matching `bot`, `crawl`, `spider`, `preview` or `headless`. It is cookieless and anonymous: it neither reads nor sets cookies, the `distinct_id` is a SHA-256 hash of a fixed salt, the client IP, the user agent and the UTC date, so it changes daily, and `$process_person_profile` is `false`. It sends the origin and path without the query string, the host, the referrer's origin only, the user agent, the client IP (`$ip`, for PostHog's GeoIP) and `utm_source`, `utm_medium` and `utm_campaign` when present. `POSTHOG_PROJECT_TOKEN` (the production OpenMerit project, a public token) and `POSTHOG_HOST` are variables in `wrangler.domains.jsonc`; an empty token sends nothing. Tests use a fake endpoint.

**App pages — unreleased source, 18 November 2026.** `openmerit-app` replaces the static mockup with the real pages: Runs, the run report at `/r/<id>/`, Tasks with each task's watch state (watching; idle after 30 days without a recommend call; frozen by the `watch` guardrail; or retired by the coding agent with `openmerit_retire`), a project switcher in the sidebar (each project's Runs, Tasks, Guardrails and Project settings, which holds its GitHub repositories and the endpoint and key form), Coding agents with Disconnect, Account settings with the member's own Claude and ChatGPT sign-ins (added 24 November 2026), each task's page with its Runs and an Eval tab that edits the eval as a new version, and Review evals, a sidebar item shown only while a repository review's evals wait for approval (added 24 November 2026; every project-scoped call sends the open project in `X-OpenMerit-Project`), Guardrails per level with where each value came from, Plan and usage with Stripe Checkout and the billing portal and spend split into OpenMerit-paid and customer-paid, and Your data with Export and Delete everything. Each page is a shell that `app/main.ts` fills after Clerk sign-in: it calls the cloud app's `/api/*` at the `API_ORIGIN` variable (`https://openmerit.ai`, through the router) with the Clerk session token. The response shapes follow `cloud/src/api.ts`; agent-level guardrails are addressed as `environment:agent`. Stripe Checkout and the portal return to `/plan/`; the Worker still redirects `/billing` to `/plan/`. API keys typed on Project settings go only to `POST /api/endpoints`; the pages show only their last four characters. The Worker serves `/config.json` with the `CLERK_PUBLISHABLE_KEY` and `API_ORIGIN` variables, both public, and holds no secrets or data. Signed-in pages send PostHog a `$identify` once per page load and a `$pageview` per view (`interface: "app"`, the Clerk user ID as `distinct_id`, the path with run IDs replaced by `/r/:id/` and no query string, the referrer's origin and the screen size); signed-out pages send nothing, and the pages set no cookies or storage for it. They post to the Worker's first-party `/ingest/e/`, which adds the public `POSTHOG_PROJECT_TOKEN` variable (the production project), forwards that one path to `POSTHOG_HOST`'s `/i/v0/e/`, refuses bodies over 32 KB and always answers 204; without a token it sends nothing. `npm run app` uses only the environment's `POSTHOG_PROJECT_TOKEN` (the orb's is the Internal project) and logs each `/ingest/e/` post. Until `CLOUD_APP_ORIGIN` is set on the router, signed-in pages show an error with a retry button. `npm run app` previews the pages locally against a fake of `/api/*` and a stand-in for Clerk. It opens on Tonic Ultra, a fictional, fully populated account (`app/dev/tonic-ultra.ts`); `?preview=` picks another state, such as `populated` (the smaller Sahra Health account), `empty`, `error`, `noplan` or `signed-out`. After a deploy, check sign-in, `/config.json`, a run report at `/r/<id>/` and that `https://openmerit.ai/api/me` answers the app's CORS preflight.

**Scout removal — unreleased source, 10 November 2026.** The repository now keeps only `openmerit-core/`, the playground, the landing page, the memo and the Clerk sign-in. `scout-serving` runs `demo/web.ts` instead of the Scout app: the landing page, `/playground/scout/`, the sign-in page at `/scout/` and two APIs, `GET /scout/api/auth` (the publishable key) and `GET /scout/api/session` (verifies a Clerk session bearer token). Its next deploy removes the `/connect*` route and the R2, D1, Vectorize, Workers AI, rate-limit and version bindings, and applies `remove-scout-1`, which deletes the `ScoutAccounts`, `ScoutAgent` and `ScoutEvaluations` Durable Objects and all their data; back up anything still needed first. It keeps the `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` secrets. The Scout data policy page, the `/connect/` device sign-in, the `openmerit-scout` publisher and the `openmerit-email` Worker are no longer in this repository; anything still deployed is not managed from this checkout.

The hosted terminal sample's `openmerit-terminal-preview` Worker and its configuration were removed from the repository. The router had already stopped binding it. Any Worker still deployed in Cloudflare is not managed from this checkout; deleting it is a separate action that needs the owner's approval.

## Email forwarding

An Email Routing rule forwards an alias to exactly one verified destination, so the single-person aliases on `openmerit.ai` (`lazim@`, `praveen@`, `akhil@`, `invest@`) are plain forwarding rules. An alias that reaches several people has a rule that sends it to the `openmerit-email` Worker instead. [`email/worker.ts`](../email/worker.ts) lists each such alias with its recipients, forwards every message to all of them and rejects addresses it has no list for.

| Alias | Recipients |
|---|---|
| `code@openmerit.ai` | lazim and praveen |
| `team@openmerit.ai` | lazim and praveen; also where the contact-sales form sends |

To add a recipient or alias:

1. Check that each destination is a verified address under Email Routing's destination addresses; the Worker cannot forward to an unverified one. Adding a destination sends its owner a verification email.
2. Add it to `recipients` in `email/worker.ts`, merge, and deploy with `npm run deploy -- email`.
3. For a new alias, create the routing rule only after that deploy: a custom address on the `openmerit.ai` zone whose action is **Send to a Worker** with `openmerit-email`.

Rule changes and destination changes are email changes and need the owner's approval, like deploys. After a change, send a real message to the alias and confirm that every recipient received it; the zone's Email Routing activity log shows each delivery. A successful deploy or API response is not proof of delivery. Replies go out from each person's own mailbox: Email Routing only receives mail, so nobody can send as `team@` without a separate outbound provider.

## Rolling back

Roll back to the previous version recorded in the receipt, or pick one from `wrangler deployments list --name <worker>`:

```sh
npx wrangler rollback <version-id> --name <worker> --message "Roll back <sha>: <reason>"
```

Rollback needs the same owner approval as a deploy. Afterwards, run `npm run deploy:status` and repeat the checks for the affected pages.

What a Worker rollback does **not** undo:

- **Secrets and bindings:** a rollback keeps the current secret values. Restore a rotated secret separately.
- **Durable Object migrations:** an old version cannot drop classes that a newer migration added. Avoid rolling back across a migration tag.
- **Data:** D1 rows, R2 objects, Vectorize entries and Durable Object storage stay as they are.

Per Worker:

- **`scout-serving`:** a rollback also changes the landing page. Check `/`, `/contact-sales/`, `/playground/scout/` and that `/scout/` redirects to `/contact-sales/`. Rolling back across `remove-scout-1` cannot restore the deleted Durable Objects.
- **`email`:** send a real message to each alias in [Email forwarding](#email-forwarding) and confirm every recipient received it. If the Worker itself is failing, pointing the alias's rule back at a single verified destination restores delivery to that person.
- **`app`:** a rollback before the app pages restores the static mockup. Check `/`, `/config.json` and `/r/<id>/`.
- **`domain-router`:** check apex, `www` and legacy `.site` hosts, plus `/memo`, `/mcp` and `/api/me`. The route and pageview cases are in `demo/test/domain-migration.test.mjs`. Rolling back before the website pageviews stops them. Rolling back before the cloud app routes sends `/mcp` and `/api/*` to `openmerit-scout-alpha`, which returns 404.
- **`site`:** the live version is `9b86e5da-ea75-4463-9d6b-4bc148eb7722` (148), deployed through the wrapper on 4 November 2026 from `8c6070cba2ae` (#46). It is also the latest upload. The [code-only restoration](site-memo.md#protected-memo-reconciliation--released-29-october-2026) was first released as `ebd22a17-37dc-4cad-8348-08f208a83712` (147) on 29 October from `8c1cf81d01eb` (#33). Release 148 applied the `remove-demo-v1` migration, which deleted the retired demo's Durable Object classes, and the live migration tag is now `remove-demo-v1`; see [demo retirement](site-memo.md#demo-retirement--released-4-november-2026). Do not roll back to 147 or earlier: their configuration predates that migration. The configuration retains uploaded assets. Because `keep_assets` inherits the latest upload, the wrapper requires a sole 100% active version matching the latest upload. It rejects every other undeployed latest version and split deployment. Do not activate an intermediate version merely to clear this guard. Do not run concurrent uploads during a site release: the remote check and upload are not atomic. After an approved release, check an existing memo session, real email-code login, protected Markdown, reader/admin permissions, logout and all referenced assets. No production test writes or real email sends are authorized by local verification alone.
