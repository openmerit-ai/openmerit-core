# The QA organization on production

OpenMerit QA is a production organization that exists only to test app.openmerit.ai and the cloud app with real runs. Agents may use it without asking, within the limits below (`AGENTS.md`, Working unattended). No other production organization is ever used for testing.

| | |
|---|---|
| Clerk organization | `org_3MYkUz0NBuSJqt5DMu3Ek6xSNYj` (OpenMerit QA) |
| Clerk user | `user_3MYkUuqWJ0plmCc52h33YHZq3wn`, username `openmerit-qa-bot`, no email or password, the organization's only member (admin) |
| Stripe (test mode, as production) | customer `cus_VgjLMIZnOQR0r4`, subscription `sub_1UfLsNK1uK1UHDjK5RO6GKy3` on the production price, with coupon `openmerit-qa-free` (100% off, forever). The plan reaches the account through the registered webhook, as a customer's does |
| Environment for runs | `openmerit-qa/fixtures`, with guardrails `spendCapUsd: 5`, `customerSpendCapUsd: 0` and `budgetUsd: 5` per job |

## Limits

- **Spend.** At most $20 of OpenMerit-paid spend a calendar month. The cloud app has no per-account monthly cap (`OPENMERIT_MONTHLY_CAP_USD` applies to every account), so read `GET /api/spend` before each run and stop at $20. Each job is capped at $5 by the environment's guardrails.
- **Scope.** Only this organization and user. Do not add members, change the plan, coupon or caps, or create other Clerk users without the user's approval.
- **Data.** Fictional inputs only; nothing from a real customer.

## Signing in as the bot

- **The app's API (`/api/*`).** Create a sign-in token with Clerk's Backend API (`POST https://api.clerk.com/v1/sign_in_tokens` with `{user_id, expires_in_seconds: 600}` and `CLERK_SECRET_KEY`). On a page of app.openmerit.ai, redeem it with `Clerk.client.signIn.create({ strategy: "ticket", ticket })`, then `Clerk.setActive({ session, organization: "org_3MYkUz0NBuSJqt5DMu3Ek6xSNYj" })`. `Clerk.session.getToken()` then returns a session token for `https://openmerit.ai/api/...`.
- **The coding agent's tools (`/mcp`).** These take a Clerk OAuth access token. Its consent page on accounts.openmerit.ai sits behind Cloudflare's human check, which agents must not try to get past. A person signs the bot in once and approves the consent; the agent keeps the OAuth client and refresh token in `~/.openmerit-qa/` (mode 600, outside the repository, never committed) and renews access tokens with `POST https://clerk.openmerit.ai/oauth/token` (`grant_type=refresh_token`). When an orb is replaced, the refresh token is gone and a person repeats the sign-in.
