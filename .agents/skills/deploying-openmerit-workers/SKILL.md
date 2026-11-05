---
name: deploying-openmerit-workers
description: "Deploys, checks and rolls back OpenMerit's Cloudflare Workers (domain router, Scout serving, Scout publisher, memo site). Use before any wrangler deploy, rollback, secret change, route change or deployment status question in this repository."
---

# Deploying OpenMerit Workers

The runbook is [`docs/site-deployment.md`](../../../docs/site-deployment.md). Read it before you act; this skill only lists the rules that must not be missed.

## Hard rules

- **Approval every time.** Deploys, rollbacks, `wrangler secret put`/`delete` (each one deploys a version), route, DNS and email changes all need the owner's explicit approval for that specific action. Approval to push or merge is not approval to deploy.
- **Only through the wrapper.** Run `npm run deploy -- <worker>`. Never run `wrangler deploy` directly. Use the root `wrangler.jsonc` only through the wrapper's `site` target.
- **Publisher releases.** Before deploying `scout-publisher` (`wrangler.scout.jsonc`), validate collection in isolation as `docs/site-scout-architecture.md#deployment` describes, and never trigger its refresh workflow to test it.
- **Memo asset retention.** `site` is locally reconciled, not released. Read `docs/site-memo.md` before its first release. The wrapper checks the retained-asset predecessor and rejects unknown undeployed uploads and split deployments. Do not upload local site assets or activate an intermediate version to clear the guard. The next release deletes the retired demo's container and Durable Object classes (`remove-demo-v1`). Do not run concurrent uploads. Production email/session/asset acceptance still needs an approved release; local checks do not authorize it.
- **Blast radius.** `scout-serving` (`openmerit-scout-alpha`) serves the landing page as well as Scout and `/connect`. Check all three after a deploy or rollback.
- **Shared token.** `CLOUDFLARE_API_TOKEN` also reaches other projects. Touch only Workers named in this repository's Wrangler configs; never the `docex.dev` zone.
- **No production writes for testing.** Never trigger the `openmerit-scout-refresh` workflow, write to R2/D1/Vectorize, or delete an uncertain research receipt to test something.

## Workflow

1. `npm run deploy:status`. It is read-only and shows the live versions, how far each tagged version is behind main, and the Scout catalogue's refresh health. Report anything unexpected before changing it.
2. Confirm the change is merged to `origin/main` and CI is green. The wrapper enforces this.
3. `npm run deploy -- <worker> --dry-run`.
4. With approval: `npm run deploy -- <worker>`. Keep the receipt path and the printed rollback command.
5. Verify the live behavior the change affects, using the checks the runbook lists for that Worker. A successful upload is not verification.
6. If verification fails, report it and propose the receipt's rollback command. Running that command needs approval too.

After editing a Wrangler config, run `npm run types:workers` and commit the generated types.

For Cloudflare API, configuration and Durable Object details, load the vendored `wrangler`, `workers-best-practices` and `durable-objects` skills.
