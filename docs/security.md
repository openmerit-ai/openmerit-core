# Security

## Credential ownership

OpenMerit accepts no model-provider or Jev credential. Credentials belong to the coding harness, its environment, or an external secret store.

Never place secrets in profiles, policies, intent constraints, summaries, evidence URIs, audit events, fixtures, traces, or committed environment files.

## Mutation authorization

Most intents carry `modelMutationAllowed: false`. Only apply-swap and rollback intents can authorize a mutation, limited to the active proposal. Early swaps require confirmation; automatic swaps require explicit policy opt-in and sufficient verified history. Every swap requires verification.

Persistent wakeup provisioning is a separate authorization boundary. An adapter that needs to install a system scheduler, create a paid cloud agent, or change infrastructure must declare `wakeupProvisioning: "infrastructure_change"`; OpenMerit will not request that provisioning unless the confirmed check policy sets `infrastructureChangesAllowed: true`.

## Local state

`.openmerit/` may reveal task names, candidate identifiers, evidence locations, budgets, or model choices. Treat it as sensitive project metadata even though it must not contain credentials.

## Evidence integrity

OpenMerit validates structure and deterministic Pareto conformance, not the truth of arbitrary external evidence. Use authenticated observability, immutable artifacts, and digests where stronger provenance is required.

Do not include credentials, private traces, or proprietary evaluation data in public issues.
