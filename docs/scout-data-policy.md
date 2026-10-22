# Scout beta data policy

Updated 22 October 2026.

Scout is operated by OpenMerit. This policy covers the hosted Scout website, recommendation API and MCP endpoint. It describes current data handling, not a promise that beta data is anonymous or exempt from privacy requirements. External coding agents, the local Inference Terminal and other OpenMerit services have separate data flows.

## Help improve Scout during beta

Scout processes your submitted task to generate recommendations. With usage analytics enabled, we record recommendations and usage diagnostics for product evaluation, improvement and debugging, not foundation model training. Our service providers process data on our behalf.

**Draft revision — not yet in effect.** Live prompt sharing currently requires explicit opt-in. The changes below would make browser prompt sharing default on only where no content choice is stored; a saved off choice remains off. They also add a browser-specific account-unlinking option and revised content storage. Activation is pending privacy/legal-basis review and live verification. A beta label or this notice does not establish consent or another legal basis. We will update this release notice when the changes take effect.

**Don't submit confidential or sensitive information.** Describe the work rather than pasting credentials, private customer records or real documents. Automated redaction cannot recognize every secret or personal detail.

## What we process and why

| Data | Purpose and collection |
| --- | --- |
| Submitted task and model restrictions | Required to interpret the task, find suitable models and return recommendations. Scout sends task information to OpenAI even when analytics is off. |
| Recommendations and search diagnostics | When usage analytics is enabled, PostHog receives task categories, model IDs, ranks, available quality/cost/latency evidence, timings, cache status and outcomes. These describe recommendations, not execution of those models on your data. |
| Product interactions and errors | Enabled analytics includes visits, preset selections, sign-in activity, results viewed, evidence opened, copies, provider-link clicks and coding-agent setup activity. API/MCP events include method, outcome and confirmed connections. Error reports use bounded categories and application stack locations, not raw error messages. |
| Account details | Clerk handles Google/GitHub login. Enabled account analytics can synchronize your name, verified primary email, signup time and connected providers to PostHog. Account and session lifecycle events help us understand onboarding and returning use. |
| Optional prompt content | Only when prompt sharing is enabled, PostHog also receives the submitted prompt and written task breakdown, for at most three tasks. Prompt text is limited to 4,000 characters, with up to 1,000 characters per excerpt or five-layer field. Common sensitive patterns are removed where detected; this is not guaranteed anonymization. In the proposed change all such text is confined to `$ai_trace.$ai_input_state={prompt,tasks}`; ordinary `scout_search_details` contains no prompt, excerpt or layer prose. |

Scout does not use session replay, record keystrokes, or automatically capture every page element. Our analytics code does not forward bearer tokens, cookies, raw Clerk identifiers or visitor IP addresses to PostHog. Hosting and authentication providers still process the connection and security information needed to run their services.

## Your choices and account linkage

Open **Privacy & analytics** in the [Scout footer](/scout/#analytics-settings):

- **Share usage and account analytics** controls optional product events and account synchronization. It is on by default unless you opt out or a supported browser privacy signal disables it.
- **Share my task prompts and breakdowns for product improvement** currently requires opt-in. After activation it defaults on only without a stored content choice. Saved off, general opt-out, DNT/GPC and unreadable preference storage keep content off; usage analytics must also be enabled.
- The proposed **Don’t link this browser’s activity to my account** checkbox applies to this browser/request only, not your account everywhere. It sends `X-Scout-Analytics-Account: off`.
- Turning sharing off stops future analytics collection. It does not stop necessary task processing, undo in-flight work or delete information already stored.

Scout respects Do Not Track and Global Privacy Control for these analytics. An authenticated browser also communicates its usage preference to the server; the latest received account preference controls background synchronization. A browser that is offline or not signed in cannot update that account preference until it reconnects and authenticates.

API/MCP clients can send `X-Scout-Analytics: off` to disable analytics. Prompt text still requires explicit `X-Scout-Analytics-Content: on`; general opt-out and supported privacy signals take precedence. CLI content capture is always off. Copied agent setup instructions disable prompt-content sharing and do not inherit this browser's account-linkage setting. See the [technical analytics guide](scout.md#product-analytics) for the full contract.

Currently enabled signed-in analytics uses a stable account identifier linked to the profile above; hashing does not make it anonymous, and a pre-sign-in visit can be joined after login. In the proposed unlinking mode the server uses fresh unrelated random identifiers, sends no profile/identify operation, and ignores previously linked browser identifiers and supplied trace IDs. Account opt-out and deletion gates still apply before sending. Clerk profile/lifecycle analytics can continue separately under general usage consent. Past records remain linked; signing out or selecting this option does not unlink them. Unlinked request events cannot support cross-request funnels or automatic account-based historical deletion. Prompt text itself may identify a person: unlinking is not anonymization.

## Service providers

| Provider | Role |
| --- | --- |
| Cloudflare | Hosts Scout, handles requests and rate limits, holds the public model catalogue, and coordinates analytics preferences, webhook receipts and deletion state. |
| OpenAI | Processes task descriptions and related public evidence for interpretation, matching and query embeddings. Its API retention policies apply; Scout does not promise zero retention by OpenAI. |
| Clerk, Google and GitHub | Provide authentication and account/session handling. Google or GitHub is contacted according to the sign-in method you choose. |
| PostHog | Stores optional product/account analytics, recommendation diagnostics and separately enabled prompt content. Scout uses PostHog's EU ingestion endpoint; this is not a claim that every provider processes data only in the EU. |

Scout's hourly research uses Parallel and public model/benchmark sources. Visitor prompts are not sent to Parallel, benchmark publishers or the recommended-model providers as part of that research. Opening a provider link takes you to a separate service under its own policies.

## Storage and retention

Submitting a task is not a zero-storage operation, even with analytics disabled:

- **In your browser:** Scout temporarily keeps a prompt draft in tab storage during sign-in. Analytics preferences use local storage; anonymous visit/session-transition markers use tab storage when analytics is enabled. Clerk manages authentication storage separately.
- **Search cache:** Scout temporarily keeps exact tasks and results in server memory for reuse. Cached results are eligible for reuse for 30 seconds. Expired entries are removed on subsequent cache access or when the instance ends; this is not a guarantee of physical erasure at exactly 30 seconds.
- **PostHog:** The proposed content layout uses the provider's [AI event retention policy](https://posthog.com/docs/ai-observability/data-retention): large AI properties including `$ai_input_state` are stored in `posthog.ai_events` for 30 days and stripped from normal events at ingestion. Metadata remains under normal event retention. This is documented provider policy, not verified live-project storage or expiry. Historical v3 `scout_search_details` may still contain content outside those AI properties. There is no custom retention cron or content export, and no claim of retroactive deletion or exact backup erasure. Other events and profiles remain subject to applicable retention/deletion settings. Disabling sharing is not a deletion request.
- **Account synchronization:** Cloudflare retains preference state and pseudonymous delivery/deletion records, not a second copy of your name, email or prompts. Pending lifecycle events without a known preference are bounded and expire after seven days. Deletion tombstones are retained to prevent delayed events from recreating an account's analytics.
- **Historical records:** Before the 22 October 2026 consolidation, Scout stored prompts and recommendation evidence in a private Cloudflare Analytics Engine archive. New writes have stopped. That archive follows Cloudflare's three-month retention, may contain unredacted personal information, and is not automatically erased by the PostHog account-deletion flow.

OpenAI, Clerk and other providers have their own retention and security policies. A change to Scout's analytics settings does not change those policies. Restrict analytics access to authorized personnel with a product evaluation/debugging need; Scout does not expose a public search-history endpoint. The processors above receive data: this is not a “no third party” service.

## Data questions and deletion requests

Contact [lazim@openmerit.ai](mailto:lazim@openmerit.ai) for data questions or to request access, correction or deletion. Include the account email and approximate dates, but do not send passwords, session tokens or sensitive prompt content. We may need to verify account ownership before acting. The rights and obligations that apply depend on your location and circumstances.

Deleting a Clerk account triggers a request to delete its linked PostHog profile and events. Deletion is asynchronous, and Scout repeats reconciliation to catch delayed deliveries; an accepted request is not proof that erasure has finished. Unlinked anonymous events and the historical Cloudflare archive are not automatically covered. Clearing a current profile field also does not remove it from older events. Contact us when a request needs review beyond the account-deletion flow.

## Changes during beta

We will update this page when data handling changes and identify the revision date. This notice does not itself enable sharing, activate the proposed browser/request unlinking mode, override an existing opt-out or guarantee a fixed erasure deadline. The proposed changes remain subject to the release gates above.
