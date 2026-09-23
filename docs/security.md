# Security

## Credential ownership

OpenMerit accepts no model-provider or Jev credential. Credentials belong to the coding harness, its environment, or an external secret store.

Never place secrets in profiles, policies, intent constraints, summaries, evidence URIs, audit events, fixtures, traces, or committed environment files.

## Mutation authorization

Most intents carry `modelMutationAllowed: false`. Only application-target apply-swap and rollback intents can authorize a mutation, limited to the relevant proposal, prior configuration, and confirmed target ID. Pi's model is explicitly excluded. Automatic swaps require explicit policy opt-in and meeting the configured verified-swap threshold, which can be zero. Otherwise a proposal requires approval. Post-swap evaluation depends on the harness performing the checks and reporting their results. OpenMerit is not a sandbox around the harness's tools.

Persistent wakeup provisioning is a separate authorization boundary. An adapter that needs to install a system scheduler, create a paid cloud agent, or change infrastructure must declare `wakeupProvisioning: "infrastructure_change"`; OpenMerit will not request that provisioning unless the confirmed check policy sets `infrastructureChangesAllowed: true`.

## Local state

`.openmerit/` may reveal task names, candidate identifiers, evidence locations, budgets, or model choices. Treat it as sensitive project metadata even though it must not contain credentials.

Pi also records OpenMerit requests and results in its session history. Project context and evaluation data may be sent to the model providers, tools, and evidence systems configured in the harness. Local OpenMerit storage does not imply that all processing stays on your machine.

## Evidence integrity

OpenMerit validates structure and deterministic Pareto conformance, not the truth of arbitrary external evidence. Use authenticated observability, immutable artifacts, and digests where stronger provenance is required.

Do not include credentials, private traces, or proprietary evaluation data in public issues.
