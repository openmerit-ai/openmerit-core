# OpenMerit product and architecture rules

- **Optimize for useful model choices.** OpenMerit exists to find better task-specific tradeoffs between quality, cost, and latency—not to become a general-purpose agent or telemetry platform.

- **Act as a control plane, not a gateway.** Normal traffic stays between the harness and provider; OpenMerit observes evidence, runs explicit trials, and returns recommendations without intercepting ordinary work.

- **Make Pi plug-and-play first.** Pi and Pi-based harnesses are the first supported user experience because that is where early users already work; broader harness support can follow without weakening this path.

- **Keep the core harness-neutral.** Pi is the first `HarnessAdapter`, not a permanent assumption in scoring, recommendations, policy, or stored data, so other harnesses can be added without rewriting the merit loop.

- **Keep model providers interchangeable.** OpenRouter is a first-class provider and discovery source, not the foundation of the domain model; provider-specific behavior belongs behind a `ModelProviderAdapter`.

- **Require end-to-end provider neutrality.** Discovery, authentication, execution, scoring, and swapping must preserve the selected route; a feature is not provider-neutral if only its API client is abstracted.

- **Separate model identity from execution route.** Keep logical model IDs in stable `vendor/model` form, while recording the actual provider or route separately, so the same model can be compared through OpenRouter, a native provider, or a local provider.

- **Respect the harness's eligible model pool.** Prefer models already available and configured in the active harness; external catalogs may enrich or expand discovery but must not silently override harness scope or credentials.

- **Require explicit metadata instead of price guesses.** Missing price, context, output, or modality data for a custom route may be supplied by an exact-route override; never assume a local route is free or copy metadata across providers.

- **Treat public benchmarks as priors, not proof.** Benchmarks help shortlist candidates, but merit comes from trials on the user's actual task.

- **Keep four integration boundaries distinct.** Model execution (`ModelProviderAdapter`), agent execution (`HarnessAdapter`), incoming traces (`ObservationSource`), and outgoing telemetry (`EventSink`) solve different problems and must not be coupled.

- **Use provider-neutral core records.** Normalize integrations into stable concepts such as `TaskObservation`, `CandidateRun`, `TrialScore`, `Frontier`, `Recommendation`, and `MeritEvent`, so integrations do not leak their schemas into the decision engine.

- **Optimize per task before aggregating per agent.** Agent-level conclusions must be built from measured task evidence rather than assumed from global model rankings.

- **Version persisted events and evolve them additively.** Existing 0.1.x state must remain readable, and append-only recommendation history must stay intact; migrations should normalize old records rather than invalidate them.

- **Keep policy as the sole auto-swap authority.** Trials and strategists may recommend changes, but only the policy gate may approve automatic application, and every recommendation must retain its gate reasons.

- **Default to safe, explicit trials.** Candidate tool access stays off unless deliberately allowed, trials remain isolated, and temporary workspaces are cleaned up because trying a model must not expose or damage a user's project by surprise.

- **Allowlist subprocess extensions.** Keep Pi extension discovery disabled in isolated trials and load only explicitly named provider-registration files; never recursively load OpenMerit or inherit unrelated harness extensions.

- **Keep the shadow track isolated, not necessarily concurrent.** Candidate trials may run sequentially to respect cost, rate, and safety limits while remaining separate from the user's live task.

- **Treat local JSONL as the default integration, not a lock-in.** Local traces and events should work without an external service; systems such as Langfuse can later plug in as observation sources or event sinks.

- **Keep integrations optional and the core lightweight.** New providers, harnesses, and observability services should not impose credentials, network calls, or heavy dependencies on users who do not enable them.

- **Keep 0.1.x focused.** The near-term bar is reliable, provider-neutral use for Pi tinkerers and solo hackers; additional harnesses and hosted observability integrations belong in later releases unless required to prove the boundaries work.
