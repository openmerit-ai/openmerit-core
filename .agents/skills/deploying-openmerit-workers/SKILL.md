---
name: deploying-openmerit-workers
description: "Deploys, checks and rolls back OpenMerit's Cloudflare Workers (domain router, web Worker with the landing page and Clerk sign-in, memo site, playground). Use before any wrangler deploy, rollback, secret change, route change or deployment status question in this repository."
---

# Deploying OpenMerit Workers

The runbook is [`docs/site-deployment.md`](../../../docs/site-deployment.md). Read it before you act; this skill only lists the rules that must not be missed.

## Hard rules

- **Approval every time.** Deploys, rollbacks, `wrangler secret put`/`delete` (each one deploys a version), route, DNS and email changes all need the owner's explicit approval for that specific action. Approval to push or merge is not approval to deploy.
- **Only through the wrapper.** Run `npm run deploy -- <worker>`. Never run `wrangler deploy` directly. Use the root `wrangler.jsonc` only through the wrapper's `site` target.
- **Memo asset retention.** `site` (`openmerit-site`) is a code-only release whose configuration retains the last uploaded asset bundle. Read `docs/site-memo.md` before releasing it. The wrapper requires a sole 100% active version that is also the latest upload, and rejects undeployed uploads and split deployments. Do not upload local site assets or activate an intermediate version to clear the guard. Its live release already applied `remove-demo-v1`; never roll back to version 147 or earlier, which predate that migration. Do not run concurrent uploads. Production email/session/asset acceptance still needs an approved release; local checks do not authorize it.
- **Blast radius.** `scout-serving` (`openmerit-scout-alpha`) serves the landing page as well as the Clerk sign-in at `/scout/` and `/playground/scout/`. Check all three after a deploy or rollback. Its next deploy applies `remove-scout-1`, which permanently deletes the retired Scout Durable Objects and their data.
- **Shared token.** `CLOUDFLARE_API_TOKEN` also reaches other projects. Touch only Workers named in this repository's Wrangler configs; never the `docex.dev` zone.
- **No production writes for testing**, except in the QA organization. Never write to D1, R2 or Durable Object storage, send real email or create Clerk users to test something. The one exception is the OpenMerit QA organization that [`docs/qa-account.md`](../../../docs/qa-account.md) describes: after a cloud or app deploy, verify it there with real runs, within its caps, without asking.

## Workflow

1. `npm run deploy:status`. It is read-only and shows the live versions and how far each tagged version is behind main. Report anything unexpected before changing it.
2. Confirm the change is merged to `origin/main` and CI is green. The wrapper enforces this.
3. `npm run deploy -- <worker> --dry-run`.
4. With approval: `npm run deploy -- <worker>`. Keep the receipt path and the printed rollback command.
5. Verify the live behavior the change affects, using the checks the runbook lists for that Worker. A successful upload is not verification.
6. If verification fails, report it and propose the receipt's rollback command. Running that command needs approval too.

After editing a Wrangler config, run `npm run types:workers` and commit the generated types.

For Cloudflare API, configuration and Durable Object details, load the vendored `wrangler`, `workers-best-practices` and `durable-objects` skills.
