# Protocol

Harness-neutral contracts for OpenMerit intents, results, evidence, metrics, and capabilities.

The first contract slice models an intent as a durable job:

- OpenMerit requests an outcome without prescribing harness implementation details.
- A harness reports explicit lifecycle transitions.
- Terminal results refer to durable evidence rather than embedding arbitrary traces.
- All cross-boundary values remain JSON-safe.

The metric contract includes the complete initial catalogue, normalized metric records, task objectives, candidate assessments, dominance comparisons, and versioned frontier snapshots. Missing evidence is represented explicitly and never coerced to zero.

`HarnessDescriptor` and `HarnessCapability` support capability negotiation. `IntentOutputMap` defines the required output for every intent kind so adapters do not rely on Pi-specific undocumented JSON.

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
