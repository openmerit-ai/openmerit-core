# Current limitations and roadmap

## Current status

The Inference Terminal provides a read-only view of existing application evidence. The Pi **1.5.0** adapter in OpenMerit **0.1.12** provides only native Scout MCP and shared guidance, not evaluation coordination. Unreleased source retires the standalone evaluation CLI and legacy recommendation API together. Neither a populated dashboard nor passing implementation tests establishes that an application has better models, trustworthy evaluations, or reliable unattended automation.

## Known limitations

- The terminal does not instrument the application, call inference providers, route traffic, run evaluations, or apply model changes. It needs supported logs or exports for actual request history. Code/configuration declarations alone cannot supply past requests or spend.
- History and inventory can be incomplete because of source availability and read/parser limits. “All time” means retained supported evidence, not a complete lifetime archive. Cloud account usage is not fetched.
- Machine and runtime readings describe shared resources; they are not per-request resource measurements. Static endpoints do not prove deployment, availability, or physical location.
- The local sample workspace is fictional. Its measurements and prices illustrate the interface, not application quality or latency.
- The Pi 0.87 evaluation adapter is removed in source. Pi 1.5.0 setup needs explicit browser approval, a new session and an explicit installer rerun for updates. It has no lifecycle commands, scheduler, LaunchAgent or auto-update hooks. The host owns tools, model, permissions and sessions; SDK hosts must load Pi's native MCP extension explicitly.
- Scout rule/skill availability does not guarantee invocation or measured application quality. Missing project policy requires asking; unavailable or insufficient Scout evidence requires pausing the model choice.
- Existing legacy Pi 0.87 background jobs require separate cleanup during migration.
- Scout guidance is not execution or evaluation. Use representative application checks and provider spending controls independently.
