# Security

## Credential ownership

OpenMerit accepts no model-provider or Jev credential. Credentials belong to the coding harness, its environment, or an external secret store.

Never place secrets in profiles, policies, intent constraints, summaries, evidence URIs, audit events, fixtures, traces, or committed environment files.

## Mutation authorization

Most intents carry `modelMutationAllowed: false`. Only application-target apply-swap and rollback intents can authorize a mutation, limited to the relevant proposal, prior configuration, and confirmed target ID. Pi's model is explicitly excluded. Automatic swaps require explicit policy opt-in and meeting the configured verified-swap threshold, which can be zero. Otherwise a proposal requires approval. Post-swap evaluation depends on the harness performing the checks and reporting their results. OpenMerit is not a sandbox around the harness's tools.

Persistent wakeup provisioning is a separate authorization boundary. An adapter that needs to install a system scheduler, create a paid cloud agent, or change infrastructure must declare `wakeupProvisioning: "infrastructure_change"`; OpenMerit will not request that provisioning unless the confirmed check policy sets `infrastructureChangesAllowed: true`.

The unreleased macOS Pi adapter installs a user LaunchAgent only under that authorization and persistent execution mode. The plist stores the project path, selected Pi model identifier, and executable paths, but no API key. It verifies that Pi authentication works without shell-only credentials before installing. The agent launches Pi headlessly only for due elapsed-time checks, so the configured model provider may receive project context and incur charges under the confirmed policy. Pause unloads the agent; already-running work is not cancelled.

The source runner imposes a 15-minute wall-clock limit and records a nonzero status if Pi fails to complete a due intent. This is a safety bound, not a provider-spend cap. Headless completion remains unverified in the current live test.

## Local state

`.openmerit/` may reveal task names, candidate identifiers, evidence locations, budgets, or model choices. Treat it as sensitive project metadata even though it must not contain credentials.

Pi also records OpenMerit requests and results in its session history. Project context and evaluation data may be sent to the model providers, tools, and evidence systems configured in the harness. Local OpenMerit storage does not imply that all processing stays on your machine.

## Evidence integrity

OpenMerit validates structure and deterministic Pareto conformance, not the truth of arbitrary external evidence. Use authenticated observability, immutable artifacts, and digests where stronger provenance is required.

Do not include credentials, private traces, or proprietary evaluation data in public issues.

## Inference Terminal (preview)

The preview terminal reads selected project metadata, bounded loopback runtime inventory/metrics endpoints, and whole-machine CPU and memory. It calls no inference endpoint and exposes no mutation API. Default discovery reads only the project's `.env`, `.env.local`, `package.json`, and `requirements.txt`, with per-file bounds and project containment after symlink resolution. It never executes those files or expands expressions. Known credential-variable presence can identify a configured provider; credential contents are neither retained, returned, nor used for provider calls. Only safe loopback origins and recognized service identity metadata survive projection.

Coding-harness histories are outside the terminal’s application scope and are not scanned or imported. The retired Pi history reader and access prompts are removed; legacy grants in `~/.openmerit/terminal-access.json` are never consulted. Application request logs and explicit exports retain only allowlisted metadata. Sources must belong to the selected application; the terminal cannot infer the purpose of an unlabeled API response. Records explicitly marked `scope: "development"` are rejected.

The local web service binds to `127.0.0.1` and rejects unexpected Host, Origin, and cross-site browser requests. It only serves bundled assets and specific read-only JSON routes. It is not authenticated against other local processes or machine users. Names and identifiers in imported metadata must still be kept free of secrets. Usage caches disappear when the process exits. Legacy history permission files are left untouched but have no effect. No cloud usage APIs, credential stores, arbitrary source-tree indexing, process inspection, or general home-directory scans are performed. See [terminal data handling and limits](inference-terminal.md) for supported sources, precedence, retention bounds, and sample-data separation.
