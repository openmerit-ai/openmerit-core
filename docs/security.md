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

## Inference Terminal (unreleased)

The source-only terminal reads selected project metadata, configured loopback runtime inventory/metrics endpoints, and whole-machine CPU and memory. It calls no inference endpoint and exposes no mutation API. Source files must remain inside the selected project, including after symlink resolution. It does not scan home-directory agent histories or `.env` files. Known credential-variable presence can identify a configured provider; values are neither returned nor used for provider calls.

The local web service binds to `127.0.0.1` and rejects unexpected Host, Origin, and cross-site browser requests. It only serves bundled assets and specific read-only JSON routes. It is not authenticated against other local processes or machine users. Imported records contain only allowlisted metadata; names and identifiers must still be kept free of secrets. No prompts or completions are collected, and its memory caches disappear when the process exits. See [terminal data handling and limits](inference-terminal.md) for source precedence, retention bounds, and sample-data separation.
