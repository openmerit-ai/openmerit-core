# OpenMerit cloud

The Node.js app behind `claude mcp add --transport http openmerit https://openmerit.ai/mcp`. It runs as a Rivet Cloud hosted actor node on the cluster `openmeritdr2i`, served at `https://openmeritdr2i.onrivet.dev`. openmerit.ai's domain router (`demo/domain-router.mjs`) proxies `/mcp`, `/.well-known/oauth-protected-resource` and `/api/*` to it when `CLOUD_APP_ORIGIN` is set.

Not released: nothing here is deployed until the deploy below runs.

## What it serves

| Path | Does |
| --- | --- |
| `POST /mcp` | MCP over streamable HTTP, stateless per request, with the tools `openmerit_recommend`, `openmerit_result`, `openmerit_answer` and `openmerit_tasks`. Each call needs a Clerk OAuth access token whose audience is `https://openmerit.ai/mcp`; without one it answers 401 with `resource_metadata`, which starts the client's Clerk sign-in. No tool takes an API key |
| `GET /.well-known/oauth-protected-resource` (and `/mcp` after it) | RFC 9728 metadata naming Clerk (`https://clerk.openmerit.ai`) as the authorization server |
| `/api/*` | The account API for app.openmerit.ai, with Clerk session tokens: `me`, `tasks`, `runs`, `endpoints`, `guardrails`, `spend`, `billing/checkout`, `billing/portal`, `account/export`, `account` (DELETE), `disconnect`. The shared contract lists each |
| `POST /api/stripe/webhook` | Stripe only, signature-verified. The source of truth for an account's plan |
| `GET /r/<job>.md` | A report as Markdown, for the account's members and for agents with their MCP token. `POST /api/runs/<job>/share` makes a public link |

The account is the token's Clerk organization (`org_id`). A token without one is refused with an error that tells the user to create or choose an organization; the app never guesses an account.

## Actors

- `account` (key: Clerk organization ID), in SQLite: the plan from Stripe, members, endpoints with keys encrypted by `OPENMERIT_KEY_ENCRYPTION_KEY` (AES-256-GCM, the account ID as associated data), guardrails at the environment, agent (`environment:agent`) and task levels, the spend ledger, jobs, tasks and reports. It checks the plan, jobs per hour and concurrent jobs at every job start, and reserves spend against the job's budget, the guardrail caps and the monthly caps before every model call.
- `task` (key: account and task ID): the latest bundle, the labels the user gave, the last result and the watch schedule. A watched task checks the catalogue on its schedule and when the catalogue changes, and starts a watch job when the catalogue version is newer than its last run's.
- `job` (key: job ID): the workflow Source ▶ Cases (label check, which waits on the job's queue for `openmerit_answer`) ▶ Models ▶ Ranking (Scout Model Binary Search from `openmerit/engine`, each measure call its own step) ▶ Agent eval (the engine's `checkAgent` rule) ▶ Action (the edit and the report). Each model call's ledger key is the job, the step and the case, so a step that Rivet replays after a crash counts no spend twice.
- `catalogue` (one): openmerit-core's bundled catalogue, refreshed daily when the app has a refresh source.

`src/ranking.ts` stands in for W2's `openmerit/ranking` until it lands: cases come only from the bundle's examples, every endpoint is called as OpenAI chat completions, and grading is exact match or equal JSON. `src/engine.ts` re-exports openmerit-core's `openmerit/engine` from source.

## Checks

`npm run check` typechecks and runs `test/cloud.test.ts` (about 75 s on a 2-CPU orb). The tests start the app in a child process on a local Rivet engine, with test sign-in, fake Stripe and a fake OpenAI-compatible server for OpenRouter and customer endpoints: no credential and no paid call. They include a job that waits on its label check across a SIGKILL of the app, and a measure step replayed after a crash whose spend counts once. The `cloud` CI job also builds the image: `docker build -f cloud/Dockerfile .` from the repository root.

To run it by hand against a local engine: `TEST_STORAGE=$(mktemp -d) TEST_ENGINE_PORT=23400 node test/serve.ts`.

## Configuration

| Variable | Kind | For |
| --- | --- | --- |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | secret, setting | Token verification. The publishable key names the issuer |
| `OPENROUTER_API_KEY` | secret | OpenMerit-paid measuring on OpenRouter |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` | secret, secret, setting | Checkout, the portal, webhooks and metered usage (`STRIPE_METER_EVENT`, default `openmerit_evaluation`). A price's metadata sets `included_evals` and `overage` (`metered` or `refuse`) |
| `OPENMERIT_KEY_ENCRYPTION_KEY` | secret | 32 bytes, base64. Without it `/api/endpoints` refuses new endpoints |
| `OPENMERIT_PUBLIC_URL`, `OPENMERIT_APP_URL` | setting | Default `https://openmerit.ai` and `https://app.openmerit.ai` |
| `OPENMERIT_JOBS_PER_HOUR`, `OPENMERIT_CONCURRENT_JOBS`, `OPENMERIT_JOB_BUDGET_USD`, `OPENMERIT_MONTHLY_CAP_USD`, `OPENMERIT_CUSTOMER_CAP_USD` | setting | Limits: 20, 3, $5, $100 and $100 by default |

The cluster sets `RIVET_ENDPOINT`, `RIVET_TOKEN` and `RIVET_POOL` on every deploy; do not set them.

## Deploying

Every deploy and secret change needs the owner's approval. `npm run deploy` follows the repository's `scripts/deploy.ts` rules: a clean checkout whose HEAD is on `origin/main` and passed the `verify` and `cloud` CI jobs, then a receipt in `.deploys/cloud/` with the rollback command. It needs `RIVET_CLOUD_TOKEN` (a `cloud_api_…` Rivet Cloud token; the engine's admin token does not reach the Cloud API), `RIVET_ORG` when the token does not imply it, and Docker.

```sh
npm run deploy -- secrets          # copies the secrets above from this environment to the cluster, by name
npm run deploy -- --dry-run        # prints the rivet deploy command
npm run deploy                     # builds cloud/Dockerfile, uploads it and rolls the pool onto it
npm run deploy -- --build <id>     # rolls back to an earlier build, without rebuilding
npm run deploy -- status           # read-only: the last receipt and what the origin answers
```

After the first deploy, set `CLOUD_APP_ORIGIN` to `https://openmeritdr2i.onrivet.dev` in `wrangler.domains.jsonc` and deploy the router, and register the Stripe webhook endpoint for `https://openmerit.ai/api/stripe/webhook`.
