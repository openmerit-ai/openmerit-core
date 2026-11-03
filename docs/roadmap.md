# Current limitations and roadmap

## Current status

The Inference Terminal provides a read-only view of existing application evidence. The Pi **1.5.0** adapter in OpenMerit **0.1.12** provides only native Scout MCP and shared guidance, not evaluation coordination. The standalone evaluation CLI and reusable core coordinator remain separate. Neither a populated dashboard nor passing implementation tests establishes that an application has better models, trustworthy evaluations, or reliable unattended automation.

## Known limitations

- The terminal does not instrument the application, call inference providers, route traffic, run evaluations, or apply model changes. It needs supported logs or exports for actual request history. Code/configuration declarations alone cannot supply past requests or spend.
- History and inventory can be incomplete because of source availability and read/parser limits. “All time” means retained supported evidence, not a complete lifetime archive. Cloud account usage is not fetched.
- Machine and runtime readings describe shared resources; they are not per-request resource measurements. Static endpoints do not prove deployment, availability, or physical location.
- Hosted samples and the before/after dashboard demo are fictional. Their cost projections and public benchmark screens do not establish application quality or latency.
- The Pi 0.87 evaluation adapter is removed in source. Pi 1.5.0 setup needs explicit browser approval, a new session and an explicit installer rerun for updates. It has no lifecycle commands, scheduler, LaunchAgent or auto-update hooks. The host owns tools, model, permissions and sessions; SDK hosts must load Pi's native MCP extension explicitly.
- Scout rule/skill availability does not guarantee invocation or measured application quality. Missing project policy requires asking; unavailable or insufficient Scout evidence requires pausing the model choice.
- Custom core evaluation harnesses must establish task-specific evaluations and observability. Generic coding checkpoints cannot replace product telemetry, and structured-result validation cannot prove external evidence is truthful.
- Background provisioning and unattended validation belong to custom evaluation integrations, not the new Pi adapter. Existing legacy Pi jobs require separate cleanup during migration.
- Core pause policy does not cancel active intents or stop explicit commands or the standalone terminal. It is not a command exposed by the new Pi adapter.
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
