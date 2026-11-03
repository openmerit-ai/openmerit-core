# Deployment and rollback

Every production deploy needs the owner's explicit approval (see `AGENTS.md`). This note covers how an approved deploy runs and how to undo it.

## Deploying

```sh
npm run deploy:status                      # read-only: live versions and catalogue health
npm run deploy -- <worker> --dry-run       # build and check without uploading
npm run deploy -- <worker>                 # asks you to type "deploy"
```

`scripts/deploy.ts` refuses to deploy unless:

- the checkout has no uncommitted or untracked files;
- `HEAD` is on `origin/main`;
- the `verify` and `package-smoke` CI checks passed for that commit.

It runs the pinned Wrangler with `--strict`, which stops if someone changed the Worker in the dashboard. It tags the new version with the commit's short SHA, and the version message includes the commit subject. A receipt is written to `.deploys/<worker>/<time>.json` (ignored by Git). The receipt records the versions before and after the deploy and the exact rollback command. Pass `--yes` only when a non-interactive run has the owner's approval.

`deploy:status` lists the live versions of every Worker. For each tagged version, it shows how far it is behind `origin/main`. "Untagged" means the version was deployed outside the wrapper. The report ends with the Scout catalogue's refresh state. The publisher has no other health signal yet.

| Key | Worker | Config | Serves |
|---|---|---|---|
| `domain-router` | `openmerit-domains` | `wrangler.domains.jsonc` | Every public host; redirects; `/memo` to `openmerit-site` |
| `scout-serving` | `openmerit-scout-alpha` | `wrangler.scout-alpha.jsonc` | Landing page, `/scout/`, `/connect/` |
| `terminal-preview` | `openmerit-terminal-preview` | `wrangler.terminal.jsonc` | Nothing public: the router no longer binds it |
| `scout-publisher` | `openmerit-scout` | `wrangler.scout.jsonc` | Hourly catalogue refresh. **Blocked** until its unreleased collection changes are validated |
| `site` | `openmerit-site` | `wrangler.jsonc` | Protected memo. Locally reconciled; code-only release with asset-retention checks and no container rollout |

Deploy `scout-serving` before `domain-router` when a change spans both, as the rebuild cutover did.

## Rolling back

Roll back to the previous version recorded in the receipt, or pick one from `wrangler deployments list --name <worker>`:

```sh
npx wrangler rollback <version-id> --name <worker> --message "Roll back <sha>: <reason>"
```

Rollback needs the same owner approval as a deploy. Afterwards, run `npm run deploy:status` and repeat the checks for the affected pages.

What a Worker rollback does **not** undo:

- **Secrets and bindings:** a rollback keeps the current secret values. Restore a rotated secret separately.
- **Durable Object migrations:** an old version cannot drop classes that a newer migration added. Avoid rolling back across a migration tag.
- **Data:** D1 rows, R2 objects, Vectorize entries and Durable Object storage stay as they are. To roll back the Scout catalogue, republish the validated `previous.json` pointer instead (see [Scout recovery](site-scout-architecture.md#recovery)). Never trigger the shared refresh workflow to test a rollback.

Per Worker:

- **`scout-serving`:** a rollback also changes the landing page. Check `/`, `/scout/`, `/connect/` and `/scout/api/status`.
- **`domain-router`:** check apex, `www`, legacy `.site` and `dash` hosts, plus `/memo`. The route cases are in `demo/test/domain-migration.test.mjs`.
- **`scout-publisher`:** it is not deployed from main. Roll back only to a version listed in its deployment history, and confirm the next hourly run in `deploy:status`.
- **`site`:** keep version `9b0ea195-8c33-40b0-a5ee-a21f3e31a46d` while the [code-only restoration](site-memo.md#protected-memo-reconciliation--local-only-29-october-2026) is awaiting an approved release. Its configuration retains uploaded assets. The next release also applies the `remove-demo-v1` migration, which deletes the retired demo's container and Durable Object classes; see [demo retirement](site-memo.md#demo-retirement--unreleased-source-3-november-2026). Because `keep_assets` inherits the latest upload, the wrapper requires a sole 100% active version matching the latest upload, except for the exact verified 145-active/146-latest retention chain documented in memo maintenance. It rejects every other undeployed latest version and split deployment. Do not activate an intermediate version merely to clear this guard. Do not run concurrent uploads during a site release: the remote check and upload are not atomic. After an approved release, check an existing memo session, real email-code login, protected Markdown, reader/admin permissions, logout and all referenced assets. No production test writes or real email sends are authorized by local verification alone.
