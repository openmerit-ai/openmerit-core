# Current limitations and roadmap

## Current status

The Inference Terminal provides a read-only view of existing application evidence. The Pi integration coordinates supervised model-comparison trials. Neither a populated dashboard nor passing implementation tests establishes that an application has better models, trustworthy evaluations, or reliable unattended automation.

## Known limitations

- The terminal does not instrument the application, call inference providers, route traffic, run evaluations, or apply model changes. It needs supported logs or exports for actual request history. Code/configuration declarations alone cannot supply past requests or spend.
- History and inventory can be incomplete because of source availability and read/parser limits. “All time” means retained supported evidence, not a complete lifetime archive. Cloud account usage is not fetched.
- Machine and runtime readings describe shared resources; they are not per-request resource measurements. Static endpoints do not prove deployment, availability, or physical location.
- Hosted samples and the before/after dashboard demo are fictional. Their cost projections and public benchmark screens do not establish application quality or latency.
- Pi 0.87 is the only implemented coding-harness adapter. Jev must be configured and invoked by the harness; OpenMerit provides no Jev client.
- Setup asks the harness to establish task-specific evaluations and observability. Generic coding checkpoints cannot replace product telemetry, and structured-result validation cannot prove external evidence is truthful.
- Background wakeups require a logged-in macOS user, working headless Pi authentication, and explicit persistent-execution/infrastructure permission. Other platforms require an external scheduler. Deterministic baseline checks have automated coverage; unattended candidate discovery and model changes still need representative product validation.
- Pause persists and gates automatic work, but does not cancel active intents, stop explicit commands, or stop the standalone terminal.
- Challenger accounting depends on reported costs. It cannot independently meter provider billing or stop an in-flight request. Use provider spending controls as well as the confirmed evaluation policy.
- The source interface and hosted dashboard follow the device's light/dark preference. That UI change is not included in npm 0.1.6.

## Next validation milestones

1. Establish working evaluations and observability in a representative product.
2. Inspect generated artifacts, measurements, and side effects.
3. Collect repeated evidence for the confirmed profile.
4. Complete a budgeted challenger cycle and inspect the frontier and recommendation.
5. Perform a supervised swap, post-swap verification, and rollback drill.
6. Validate background candidate work before relying on unattended operation.
7. Repeat with materially different workloads before making broad reliability claims.
