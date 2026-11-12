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
| `domain-router` | `openmerit-domains` | `wrangler.domains.jsonc` | Every public host; redirects; `/memo` to `openmerit-site` |
| `scout-serving` | `openmerit-scout-alpha` | `wrangler.scout-alpha.jsonc` | Landing page, the Clerk sign-in at `/scout/`, `/playground/scout/` |
| `playground-claims` | `playground-claims` | `playground/wrangler.jsonc` | Sahra Health's customer claims and enrollment workflows |
| `site` | `openmerit-site` | `wrangler.jsonc` | Protected memo. Code-only release with asset-retention checks and no container rollout |

Deploy `scout-serving` before `domain-router` when a change spans both, as the rebuild cutover did.

**Scout removal — unreleased source, 10 November 2026.** The repository now keeps only `openmerit-core/`, the playground, the landing page, the memo and the Clerk sign-in. `scout-serving` runs `demo/web.ts` instead of the Scout app: the landing page, `/playground/scout/`, the sign-in page at `/scout/` and two APIs, `GET /scout/api/auth` (the publishable key) and `GET /scout/api/session` (verifies a Clerk session bearer token). Its next deploy removes the `/connect*` route and the R2, D1, Vectorize, Workers AI, rate-limit and version bindings, and applies `remove-scout-1`, which deletes the `ScoutAccounts`, `ScoutAgent` and `ScoutEvaluations` Durable Objects and all their data; back up anything still needed first. It keeps the `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` secrets. The Scout data policy page, the `/connect/` device sign-in, the `openmerit-scout` publisher and the `openmerit-email` Worker are no longer in this repository; anything still deployed is not managed from this checkout.

The hosted terminal sample's `openmerit-terminal-preview` Worker and its configuration were removed from the repository. The router had already stopped binding it. Any Worker still deployed in Cloudflare is not managed from this checkout; deleting it is a separate action that needs the owner's approval.

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

- **`scout-serving`:** a rollback also changes the landing page. Check `/`, `/scout/`, `/scout/api/auth` and `/playground/scout/`. Rolling back across `remove-scout-1` cannot restore the deleted Durable Objects.
- **`domain-router`:** check apex, `www` and legacy `.site` hosts, plus `/memo`. The route cases are in `demo/test/domain-migration.test.mjs`.
- **`site`:** the live version is `9b86e5da-ea75-4463-9d6b-4bc148eb7722` (148), deployed through the wrapper on 4 November 2026 from `8c6070cba2ae` (#46). It is also the latest upload. The [code-only restoration](site-memo.md#protected-memo-reconciliation--released-29-october-2026) was first released as `ebd22a17-37dc-4cad-8348-08f208a83712` (147) on 29 October from `8c1cf81d01eb` (#33). Release 148 applied the `remove-demo-v1` migration, which deleted the retired demo's Durable Object classes, and the live migration tag is now `remove-demo-v1`; see [demo retirement](site-memo.md#demo-retirement--released-4-november-2026). Do not roll back to 147 or earlier: their configuration predates that migration. The configuration retains uploaded assets. Because `keep_assets` inherits the latest upload, the wrapper requires a sole 100% active version matching the latest upload. It rejects every other undeployed latest version and split deployment. Do not activate an intermediate version merely to clear this guard. Do not run concurrent uploads during a site release: the remote check and upload are not atomic. After an approved release, check an existing memo session, real email-code login, protected Markdown, reader/admin permissions, logout and all referenced assets. No production test writes or real email sends are authorized by local verification alone.
