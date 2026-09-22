# Core

Harness-neutral adapter SDK, orchestration, lifecycle, persistence, scheduling, and deterministic policy.

The core requests intelligent work through the protocol; it does not implement a coding agent.

The core does not calculate a Pareto frontier or change a model. It orchestrates typed work that an intelligent harness performs, validates the returned evidence envelope, and advances the approved improvement lifecycle.

`verifyFrontierSnapshot` is a conformance verifier. It checks a harness-produced snapshot against OpenMerit's normative Pareto rules; it does not discover candidates, run evaluations, select a model, or apply a swap.

`HarnessAdapter` declares identity, supported protocol versions, capabilities, execution modes, and a dispatch transport. `OpenMeritCoordinator` owns durable intent issuance, progress, observations, result validation, and state transitions. `OpenMeritStore` is replaceable; `ProjectStore` provides local filesystem persistence.
