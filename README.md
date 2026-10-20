# OpenMerit

OpenMerit provides a local Inference Terminal for understanding an application's models, services, recorded activity, and compute, plus a Pi integration for evidence-driven model comparisons.

The terminal reads existing evidence. The Pi integration asks a coding harness to build evaluations, measure candidates, and carry out authorized changes. OpenMerit coordinates that workflow and validates its structured results; the terminal does not route requests, run evaluations, or swap models.

## Open the terminal

Requires Node.js 22.19 or newer and npm:

```sh
npm install -g openmerit
cd /path/to/your/application
openmerit dash
```

Stable `openmerit@0.1.6` includes the terminal. No Pi installation or provider API key is needed. It opens a browser connected to a read-only loopback service. Supported source/configuration declarations establish inventory; existing application logs or exports supply request history. Prompts, responses, and credentials are not retained. Unsupported or missing evidence remains unknown.

The source interface and hosted dashboard follow the device's light/dark preference without a theme control. This appearance change is not included in npm 0.1.6.

Explore the [hosted sample](https://dash.openmerit.ai/) or [before/after dashboard demo](https://dash.openmerit.ai/demo). Both use fictional data and make no inference calls. See [the terminal guide](docs/inference-terminal.md) for configuration, discovery, diagnostics, history limits, and agent access.

## Compare models with Pi

The **npm preview** provides `openmerit eval` for evaluating Claude Code, Codex and OpenCode with your CLI. Choose model scope and a $10, custom or no-fixed-cap budget, freeze Scout's shortlist, and compare 3–10 fresh attempts after source changes. Budget and sandbox blocks stay separate from task scores; unknown costs stay unknown. Install with `npm install -g openmerit@preview`. See [agent evaluations](https://unpkg.com/openmerit@preview/docs/agent-evaluations.md) for setup, graders, budgets and availability. Scout's hosted API and MCP service update independently of the npm package. This is separate from the Pi workflow below.

With Pi 0.87 and a model provider configured:

```sh
pi install npm:openmerit
pi list
```

Open the product repository in interactive Pi. An unconfigured project is checked for an application LLM call at session start and after settled build turns. Pi confirms the application target and incumbent model, proposes task-specific metrics and sampling, explains estimated evaluation cost, and requests confirmation of the plan, budget, and permissions. `/openmerit setup` can recover or rerun setup. Pi's own model is never the application target.

Core checks stored baseline windows against the confirmed requirements. When ready, it asks Pi to discover candidates, run controlled comparisons, and calculate a frontier. Core validates the returned evidence contracts and Pareto conformance. The harness must execute the work and provide honest evidence.

Model changes normally require approval. Explicit automatic-swap opt-in can allow changes once the configured verified-swap threshold is reached, including a threshold of zero. Post-swap evaluation and conditional rollback depend on the harness performing and reporting them.

Read [getting started](docs/getting-started.md) and [your first supervised trial](docs/first-trial.md).

## Implemented orchestration

- Task profiles with confirmed metrics, sampling plans, constraints, budgets, and permissions.
- Preliminary model research, incumbent identity, durable candidate handoffs, and controlled challenger experiments.
- Deterministic baseline checks and uncertainty-aware frontier validation.
- Versioned result schemas for all ten intents and a reusable harness adapter boundary.
- Challenger-spend accounting, bounded intent admission, approval, verification, and rollback requests.
- Project-local state, redacted audit events, evidence manifests, and optional event exporters.
- Task-count, elapsed-time, catalogue-change, regression, and post-swap signals.
- Durable pause and authorized macOS user LaunchAgents; other platforms require an external scheduler.

These implementations have automated coverage. They do not establish application-quality improvements or reliable unattended model changes. See [current limitations](docs/roadmap.md).

## Pi commands

- `/openmerit` or `/openmerit status` — inspect readiness, active work, and lifecycle state.
- `/openmerit setup` — request or recover setup.
- `/openmerit assess` — check stored baseline windows; discover candidates only when ready.
- `/openmerit frontier` — request a harness-calculated comparison for validation.
- `/openmerit approve` — approve the current verified proposal.
- `/openmerit pause` / `/openmerit resume` — persist or clear the automatic-work pause and reconcile authorized scheduling; active work is not cancelled.
- `/openmerit cancel` — record abandonment of an interrupted intent; it does not terminate a provider request.
- `/openmerit logs` — locate local state, audit, and evidence files.
- `/openmerit doctor` — inspect adapter and scheduler diagnostics.

## Documentation

The [documentation overview](docs/index.md) links all current guides. The website at [openmerit.ai/docs](https://openmerit.ai/docs/) is deployed separately from the package and this checkout.

- [Inference Terminal](docs/inference-terminal.md)
- [Metrics and evidence](docs/metrics-and-evidence.md)
- [Lifecycle](docs/lifecycle.md), [automation](docs/automation.md), and [budgets](docs/budgets.md)
- [Commands](docs/commands.md), [operations](docs/operations.md), and [troubleshooting](docs/troubleshooting.md)
- [Security and data handling](docs/security.md)
- [Architecture](docs/architecture.md), [Pi adapter](docs/pi-extension.md), and [adapter development](docs/adapter-guide.md)
- [Pareto specification](docs/pareto-spec.md) and [testing](docs/testing.md)

## Development

```sh
npm ci
npm run verify
npm run dash -- /path/to/application
```

For Pi extension development:

```sh
./node_modules/.bin/pi --no-extensions -e ./packages/pi/src/index.ts
```

`--no-extensions` avoids registering an installed npm copy alongside the source extension. Credentials belong to the harness or its environment and must never be committed. Jev, if configured, is invoked by the harness; OpenMerit provides no Jev client.

`packages/terminal` contains the CLI, collectors, hosted sample, and browser interface. `packages/protocol`, `packages/core`, and `packages/pi` provide the protocol, coordinator, and Pi adapter. The package exports `openmerit/core`, `openmerit/protocol`, and `openmerit/pi`.

Edit documentation in `docs/`, then run `npm run check:docs`. The website is generated from those Markdown files. See [documentation maintenance](docs/site-documentation.md) and the [production-source reconciliation note](docs/site-domain-migration.md) before deployment; a local build does not publish changes.
