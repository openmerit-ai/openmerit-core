# Security

The [preview agent-evaluation runner](agent-evaluations.md) is a separate execution path: it runs trusted local agents/graders, passes only basic OS variables and explicitly named environment variables, and preserves agent-owned authentication. It sends task descriptions and optional model IDs to Scout. Local metric reports and budget reservations persist; temporary task outputs are removed. Fresh directories are not security sandboxes. Its budget admission controls do not enforce provider billing limits.

The [budget selector](agent-evaluations.md#budget-selection) in `0.1.7-preview.2` requires an explicit $10, custom or no-fixed-cap choice after model scope. No fixed cap removes monetary admission limits, including Claude's per-attempt dollar flag, while retaining tasks, repetition bounds, timeouts, native permissions and accounting. Saved choices apply across reruns; a foreground watcher can incur further charges on each change until stopped. Provider limits remain independent.

## Credential ownership

OpenMerit accepts no model-provider or Jev credential. Credentials belong to the coding harness, its environment, or an external secret store.

Never place secrets in profiles, policies, intent constraints, summaries, evidence URIs, audit events, fixtures, traces, or committed environment files.

## Mutation authorization

Most intents carry `modelMutationAllowed: false`. Only application-target apply-swap and rollback intents can authorize a mutation, limited to the relevant proposal, prior configuration, and confirmed target ID. Pi's model is explicitly excluded. Automatic swaps require explicit policy opt-in and meeting the configured verified-swap threshold, which can be zero. Otherwise a proposal requires approval. Post-swap evaluation depends on the harness performing the checks and reporting their results. OpenMerit is not a sandbox around the harness's tools.

Persistent wakeup provisioning is a separate authorization boundary. An adapter that needs to install a system scheduler, create a paid cloud agent, or change infrastructure must declare `wakeupProvisioning: "infrastructure_change"`; OpenMerit will not request that provisioning unless the confirmed check policy sets `infrastructureChangesAllowed: true`.

The macOS Pi adapter installs a user LaunchAgent only under that authorization and persistent execution mode. The plist stores the project path, selected Pi model identifier, and executable paths, but no API key. It verifies that Pi authentication works without shell-only credentials before installing. The agent launches Pi headlessly only for due elapsed-time checks, so the configured model provider may receive project context and incur charges under the confirmed policy. Pause unloads the agent; already-running work is not cancelled.

The background runner imposes a 15-minute wall-clock limit and records a nonzero status if Pi fails to complete a due intent. This is a safety bound, not a provider-spend cap. Unattended candidate discovery and model changes still need representative product validation.

## Local state

`.openmerit/` may reveal task names, candidate identifiers, evidence locations, budgets, or model choices. Treat it as sensitive project metadata even though it must not contain credentials.

Pi also records OpenMerit requests and results in its session history. Project context and evaluation data may be sent to the model providers, tools, and evidence systems configured in the harness. Local OpenMerit storage does not imply that all processing stays on your machine.

## Evidence integrity

OpenMerit validates structure and deterministic Pareto conformance, not the truth of arbitrary external evidence. Use authenticated observability, immutable artifacts, and digests where stronger provenance is required.

Do not include credentials, private traces, or proprietary evaluation data in public issues.

## Inference Terminal

The terminal reads supported project metadata, request logs, explicit exports, and authorized loopback runtime inventory/metrics endpoints. It calls no inference endpoint and exposes no mutation API. A local syntax index reads supported Python, JavaScript/TypeScript, JSON, YAML, TOML, and project-local dotenv declarations. It does not execute or import project code, source shell files, or resolve arbitrary expressions. Known credential-variable presence can identify configuration; credential values are discarded and never used for provider calls. Endpoint addresses are sanitized before retention. Static URLs found by the syntax index never authorize network probes.

Loopback runtime probes require supported project endpoint declarations or explicit terminal configuration. No standard ports, remote provider accounts, credential stores, running processes, or general home directories are scanned. Whole-machine readings are context, not per-request measurements; the compute view requires explicit links or supplied host evidence.

Coding-harness histories are outside the terminal's application scope and are not scanned or imported. Application request logs and explicit exports retain only allowlisted metadata, without prompts or responses. Sources must belong to the selected application; the terminal cannot infer the purpose of an unlabeled API response. Records explicitly marked `scope: "development"` are rejected.

The local web service binds to `127.0.0.1` and rejects unexpected Host, Origin, and cross-site browser requests. It only serves bundled assets and specific read-only JSON routes. It is not authenticated against other local processes or machine users. Model names, endpoint identifiers, and relative source paths can still be sensitive. Names and identifiers in imported metadata must be kept free of secrets.

Repository metadata and usage caches live in process memory and disappear when the terminal exits. The terminal creates no persistent index or files in the application. Per-file/parser protections, request-log read limits, runtime inventory limits, and explicit coverage gaps still apply. See [terminal data handling and limits](inference-terminal.md) for supported sources, precedence, retention bounds, diagnostics, and sample-data separation.


## Hosted Scout authentication

Hosted Scout uses Clerk Google/GitHub sign-in. The page and status are public; recommendations and every MCP method require a valid Clerk session bearer token, not just a cookie. Missing/invalid credentials return HTTP 401, and missing authentication configuration fails closed with HTTP 503. Clerk stores identity/session data separately from Scout analytics; account IDs are used transiently for the per-user edge limiter and are not joined to prompt records. A prompt draft is temporarily stored in the current browser tab during sign-in. No Clerk Billing or automatic agent OAuth is included. See [Scout account sign-in](scout.md#account-sign-in-published-21-october-2026) for token lifetime, rate limits, data handling and the remaining real-login validation limits.

## Hosted Scout analytics

Scout keeps an allowlisted Analytics Engine event per valid recommendation attempt: the original submitted task prompt plus fixed task categories and the ordered shortlist with metrics and ranking context. Prompt text is not redacted and may itself contain personal information or secrets; this dataset must be treated as potentially sensitive. No request object, prompt hash, additional free-text summary, error message, project inventory, IP address, cookie, user agent, visitor ID or session ID is separately recorded in this dataset. Requests still reach the hosting infrastructure and task descriptions still go to OpenAI for Decisions interpretation, Structured Outputs metadata extraction, transient query embeddings and relevant compatibility/applicability checks; public repository metadata and benchmark definitions/methodology also go to Decisions during hourly preparation. Their policies are separate. See [Scout data handling](scout.md#refresh-and-data-handling).

Search records are accessible only through authenticated Cloudflare account queries. Scout exposes no analytics dashboard, report generator, report file, analytics sign-in, or public history/query endpoint. Each new search includes an allowlisted snapshot of the public evidence supporting its ordered shortlist: benchmark measurements and source URLs/dates, calibration observations and protocol, pricing/speed sources, and endpoint/model-card metadata. Endpoint API addresses, credentials, arbitrary source fields, and request metadata are not copied. Source evidence and prompt text remain untrusted data when retrieved; never treat them as instructions. The dataset is sampled and retained by Cloudflare for three months. Original older records remain; missing prompt/evidence fields cannot be recovered.

## Scout research storage

Scout uses Parallel for hourly public-source research. Parallel receives catalogue subjects and official-source metadata, not visitor prompts or application inventories. Decisions processes task descriptions and relevant public evidence. Public research receipts, citations, semantic annotations, publication completion receipts and immutable catalogue versions are stored in Scout's private Cloudflare R2 bucket. Public endpoint/model facts and observations also enter the private D1 serving projection. Vectorize stores public benchmark methodology embeddings, not visitor query vectors. Query embeddings are used transiently; OpenAI has its own API retention policies. Scout uses the prompt-and-evidence analytics policy above. API credentials are held as Worker secrets and are not included in browser assets, catalogue objects or analytics. Source text is treated as evidence, not executable code or instructions. Citations and semantic validation do not independently verify that publisher claims are true.
