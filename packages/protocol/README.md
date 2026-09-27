# Protocol

Harness-neutral contracts for OpenMerit intents, results, evidence, metrics, and capabilities.

The first contract slice models an intent as a durable job:

- OpenMerit requests an outcome without prescribing harness implementation details.
- A harness reports explicit lifecycle transitions.
- Terminal results refer to durable evidence rather than embedding arbitrary traces.
- All cross-boundary values remain JSON-safe.

The metric contract includes the complete initial catalogue, normalized metric records, task objectives with explicit sampling plans, candidate assessments, dominance comparisons, and versioned frontier snapshots. Sampling plans distinguish single runs, repeated identical inputs, representative task sets, repeated representative sets, and load tests. Every metric record declares its aggregation; total cost windows use `sum` for budget accounting. Missing evidence is represented explicitly and never coerced to zero.

Every profile confirms the application LLM call under evaluation. Setup also identifies the exact incumbent application candidate. Metrics, candidates, assessments, frontier artifacts, swaps, and automation signals carry that target identity; a harness's own model usage is orchestration data rather than application evidence. Challenger results include a durable experiment manifest so later frontier calculation can use the accepted comparison rather than reconstructing it from conversation history.

`HarnessDescriptor` and `HarnessCapability` support capability negotiation. `IntentOutputMap` defines the required output for every intent kind so adapters do not rely on Pi-specific undocumented JSON.

## Runtime result schemas

`INTENT_OUTPUT_SCHEMAS` is the versioned, harness-neutral runtime contract for all ten intent outputs. `intentOutputSchemaFor(kind)` returns the canonical schema for an adapter, while `completionToolSchemaFor(kind)` composes it into the standard completion-tool envelope. The schemas use a conservative JSON Schema-compatible subset and are checked against `IntentOutputMap` at compile time.

Adapters should present the active intent's schema through their strongest available structured-output mechanism. They must report that mechanism in `HarnessDescriptor.structuredOutput`. OpenMerit validates the same canonical schema again when accepting a successful result; harness validation does not replace authorization, evidence, lifecycle, or Pareto-conformance checks.

`AutomationCheckPolicy`, `AutomationSignal`, `AutomationPlan`, and `HarnessWakeupRequest` define the portable automation boundary. Users confirm the policy; adapters declare event and scheduling capabilities; OpenMerit evaluates idempotent signals and determines due intents; harnesses provision authorized native wakeups and execute the work.

## Initial intent kinds

- `establish_evals`
- `instrument_observability`
- `run_assessment`
- `discover_candidates`
- `run_challenger_trials`
- `calculate_frontier`
- `investigate_regression`
- `apply_model_swap`
- `verify_model_swap`
- `rollback_model_swap`

OpenMerit defines and sequences these outcomes. The connected harness performs candidate discovery, evaluation work, frontier calculation, model mutation, and post-swap verification.

The supervised-graduation contract keeps evaluation spend bounded, requires early swap confirmation, verifies every swap, and can request rollback when the approved policy requires it. Automatic swapping is always an explicit opt-in.
