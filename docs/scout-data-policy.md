# Scout beta data policy

Updated 26 October 2026.

Scout is operated by OpenMerit. This policy covers the hosted Scout website, recommendation API and MCP endpoint. It describes current data handling, not a promise that beta data is anonymous or exempt from privacy requirements. External coding agents, the local Inference Terminal and other OpenMerit services have separate data flows.

**Coding-agent setup:** Scout stores the approving account, device name you chose (the host name by default), client, scope, timestamps and hashes of device codes and keys, but never a plaintext key. Local setup stores the key in private configuration; external coding agents have their own data handling. Installation and startup guidance do not guarantee an agent will invoke Scout.

**Setup analytics:** current setup usage/installation analytics defaults on. `OPENMERIT_TELEMETRY=0` or `DO_NOT_TRACK=1` disables it and propagates to device approval and installed MCP headers. Browser usage/unlink choices and account opt-outs remain effective; MCP prompt-content capture stays off. Terminal/evaluation analytics remain opt-in. Older installers can have different defaults; rerun setup to update their configuration.

Enabled setup diagnostics include setup-click, clipboard/launch-request, device-authorization, installation/component-verification and MCP-invocation milestones. Linked setup uses random setup and installation identifiers to correlate those milestones; the local ownership record and installed MCP headers retain them across sessions/upgrades. Unlinked mode omits these IDs. A launch request is not proof an app opened, and key authorization is not proof of installation. Delivery retries are bounded; service-level delivery counters exclude identity, content, URLs, device codes and credentials. Earlier activity is not backfilled.

Scout collects page views/leaves, bounded engagement, allowlisted acquisition/UTM and browser/device categories, and sampled browser performance observations where supported and usage analytics is enabled. URL properties use only reconstructed public paths, never raw visitor URLs, queries or fragments. Linked activity can join same-tab visits, signup and searches; unlinking retains request-only server identity, not a cross-request funnel. Feedback records a useful/not-useful rating and optional fixed reason, with linked trace/retry correlation, not free text. Server diagnostics include bounded stage/provider failure codes and actual pipeline attempt tokens when reported, not invented charges or executions of recommended models. Main-site/docs collection and CLI publication have separate release boundaries. No replay or ranking experiment is enabled.

## Help improve Scout during beta

Scout processes your submitted task to generate recommendations. With usage analytics enabled, we record recommendations and usage diagnostics for product evaluation, improvement and debugging, not foundation model training. Our service providers process data on our behalf.

**Beta revision, effective 22 October 2026.** Browser prompt sharing defaults on only where no content choice is stored; a saved off choice remains off. You can turn sharing off before submitting a task, or choose not to link this browser's activity to your account. Browser privacy signals still take precedence. A beta label or this notice does not establish consent or another legal basis.

**Don't submit confidential or sensitive information.** Describe the work rather than pasting credentials, private customer records or real documents. Automated redaction cannot recognize every secret or personal detail.

## What we process and why

| Data | Purpose and collection |
| --- | --- |
| Submitted task and model restrictions | Required to interpret the task, find suitable models and return recommendations. Scout sends task information to an AI processing provider even when analytics is off. |
| Recommendations and search diagnostics | When usage analytics is enabled, our analytics provider receives task categories, model IDs, ranks, available quality/cost/latency evidence, timings, cache status and outcomes. These describe recommendations, not execution of those models on your data. |
| Product interactions and errors | Enabled analytics includes visits, preset selections, sign-in activity, results viewed, evidence opened, copies, provider-link clicks and coding-agent setup activity. API/MCP events record request outcomes. Lifecycle-enabled builds add allowlisted method/tool, reported agent/harness and version, setup/installation correlation and verified-connection diagnostics. A launch request is not proof an app opened, and key authorization is not proof of installation. Error reports use bounded categories and application stack locations, not raw error messages. |
| Account details | An authentication provider handles sign-in with the identity service you choose. Enabled account analytics can synchronize your name, verified primary email, signup time and connected sign-in providers to our analytics provider. Account and session lifecycle events help us understand onboarding and returning use. |
| Optional prompt content | Only when prompt sharing is enabled, our analytics provider also receives the submitted prompt and written task breakdown, for at most three tasks. Prompt text is limited to 4,000 characters, with up to 1,000 characters per excerpt or task-analysis field. Common sensitive patterns are removed where detected; this is not guaranteed anonymization. New prompt, excerpt and task-analysis text is confined to separate content storage with a 30-day retention window, not ordinary recommendation-metadata events. |

Scout does not use session replay, record keystrokes, or automatically capture every page element. Our analytics code does not forward bearer tokens, cookies, raw authentication identifiers or visitor IP addresses to the analytics provider. Hosting and authentication providers still process the connection and security information needed to run their services.

## Your choices and account linkage

Open [**Privacy & analytics**](/scout/privacy/) from the Scout footer:

- **Share usage and account analytics** controls optional product events and account synchronization. It is on by default unless you opt out or a supported browser privacy signal disables it.
- **Share my task prompts and breakdowns for product improvement** defaults on only without a stored content choice. Saved off, general opt-out, DNT/GPC and unreadable preference storage keep content off; usage analytics must also be enabled.
- **Don’t link this browser’s activity to my account** applies to this browser/request only, not your account everywhere. It sends `X-Scout-Analytics-Account: off`.
- Turning sharing off stops future analytics collection. It does not stop necessary task processing, undo in-flight work or delete information already stored.

Scout respects Do Not Track and Global Privacy Control for these analytics. An authenticated browser also communicates its usage preference to the server; the latest received account preference controls background synchronization. A browser that is offline or not signed in cannot update that account preference until it reconnects and authenticates.

API/MCP clients can send `X-Scout-Analytics: off` to disable analytics. Prompt text still requires explicit `X-Scout-Analytics-Content: on`; general opt-out and supported privacy signals take precedence. CLI content capture is always off. Older 0.1.8 setup does not inherit this browser's account-linkage setting; the 0.1.9 lifecycle revision explicitly carries usage and unlink preferences into the command and installed headers. Later browser changes do not rewrite existing agent configuration; rerun setup to update it. Request-only refusals in that revision do not overwrite saved account-wide preferences.

Enabled signed-in analytics normally uses a stable account identifier linked to the profile above; hashing does not make it anonymous, and a pre-sign-in visit can be joined after login. In unlinking mode the server uses fresh unrelated random identifiers, sends no profile/identify operation, ignores previously linked browser identifiers and supplied trace IDs, and does not return an analytics trace ID for later interactions to reuse. Account opt-out and deletion gates still apply before sending. Account profile/lifecycle analytics can continue separately under general usage consent. Past records remain linked; signing out or selecting this option does not unlink them. Unlinked request events cannot support cross-request funnels or automatic account-based historical deletion. Prompt text itself may identify a person: unlinking is not anonymization.

## Service providers

We use third-party service providers for the following roles:

| Provider category | Role |
| --- | --- |
| Hosting and infrastructure | Hosts Scout, handles requests and rate limits, holds the public model catalogue, and coordinates analytics preferences, delivery receipts and deletion state. |
| AI task processing | Processes task descriptions and related public evidence for interpretation, matching and query embeddings. The provider's API retention policies apply; Scout does not promise zero retention by that provider. |
| Authentication and identity | Provides sign-in and account/session handling. The identity service you choose is contacted during sign-in. |
| Product analytics | Stores optional product/account analytics, recommendation diagnostics and separately enabled prompt content. Scout uses an EU analytics ingestion endpoint; this is not a claim that every provider processes data only in the EU. |
| Public-source research | Helps research public model and benchmark information, without receiving visitor prompts. |

Scout's twice-daily research uses public model/benchmark sources and a research service provider. Visitor prompts are not sent to that research provider, benchmark publishers or the recommended-model providers as part of that research. Opening a provider link takes you to a separate service under its own policies.

## Storage and retention

Submitting a task is not a zero-storage operation, even with analytics disabled:

- **In your browser:** Scout temporarily keeps a prompt draft in tab storage during sign-in. Analytics preferences use local storage; anonymous visit/session-transition markers use tab storage when analytics is enabled. The authentication provider manages authentication storage separately.
- **Search cache:** Scout temporarily keeps exact tasks and results in server memory for reuse. Cached results are eligible for reuse for 30 seconds. Expired entries are removed on subsequent cache access or when the instance ends; this is not a guarantee of physical erasure at exactly 30 seconds.
- **Analytics:** Shared task content is stored separately from ordinary events under the analytics provider's 30-day content-retention policy, and stripped from ordinary events at ingestion. Recommendation metadata remains under normal event retention and may remain longer. Storage separation and the 30-day setting have been checked with synthetic data; actual expiry and backup erasure have not been independently verified. Historical records from earlier versions may still contain content outside that separate storage. There is no custom retention scheduler or content export, and no claim of retroactive deletion. Other events and profiles remain subject to applicable retention/deletion settings. Disabling sharing is not a deletion request.
- **Account synchronization:** Our hosting provider retains preference state and pseudonymous delivery/deletion records, not a second copy of your name, email or prompts. Pending lifecycle events without a known preference are bounded and expire after seven days. Deletion tombstones are retained to prevent delayed events from recreating an account's analytics.
- **Historical records:** Before the 22 October 2026 consolidation, Scout stored prompts and recommendation evidence in a private analytics archive with our infrastructure provider. New writes have stopped. That archive follows the provider's three-month retention, may contain unredacted personal information, and is not automatically erased by the current analytics account-deletion flow.

AI processing, authentication and other service providers have their own retention and security policies. A change to Scout's analytics settings does not change those policies. Restrict analytics access to authorized personnel with a product evaluation/debugging need; Scout does not expose a public search-history endpoint. The service providers above receive data: this is not a “no third party” service.

## Data questions and deletion requests

Contact [lazim@openmerit.ai](mailto:lazim@openmerit.ai) for data questions or to request access, correction or deletion. Include the account email and approximate dates, but do not send passwords, session tokens or sensitive prompt content. We may need to verify account ownership before acting. The rights and obligations that apply depend on your location and circumstances.

Deleting your Scout account triggers a request to delete its linked analytics profile and events. Deletion is asynchronous, and Scout repeats reconciliation to catch delayed deliveries; an accepted request is not proof that erasure has finished. Unlinked anonymous events and the historical analytics archive are not automatically covered. Clearing a current profile field also does not remove it from older events. Contact us when a request needs review beyond the account-deletion flow.

## Changes during beta

We will update this page when data handling changes and identify the revision date. This notice does not itself override an existing opt-out or guarantee a fixed erasure deadline. Privacy settings remain available before and after submitting a task.
