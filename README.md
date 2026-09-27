# OpenMerit

OpenMerit is a harness-neutral orchestration layer that helps a coding harness continuously find and maintain the Pareto frontier of models for a real product task.

OpenMerit does not perform the intelligent work. It nudges a connected coding harness, such as Pi, with typed outcome requests. The harness understands the project, establishes evaluations and observability, gathers evidence, discovers and tests candidates, calculates the Pareto frontier, and performs an authorized model change. OpenMerit validates the returned contracts, preserves evidence and preferences, and advances the approved lifecycle.

The npm package `openmerit` contains the Pi extension, the reusable coordinator,
and the protocol in one install. The Pi adapter is the first integration; other
harnesses can use the same core and protocol exports.

## Why OpenMerit

The cheapest model, fastest model, and highest-quality model are often different. Public benchmarks are useful before product evidence exists, but they cannot establish which model is best for a particular workload. OpenMerit connects the initial choice to production evidence and repeated reassessment.

It distinguishes:

- one-run observations from rate, percentile, consistency, and reliability claims;
- missing evidence from poor performance;
- feasible candidates from dominated, unresolved, or ineligible candidates;
- an automatic nudge from an intelligent action performed by the harness;
- a recommendation from an authorized, verified model swap.

## Current capabilities

- Pi 0.87 extension with a single `/openmerit` command surface.
- Harness-inferred, user-confirmed task profiles with explicit metrics, sampling designs, constraints, and evaluation budgets.
- The complete initial quality, reliability, cost, latency, efficiency, and human-intervention metric catalogue.
- Setup-time preliminary model research in the source checkout, followed by baseline evidence collection, refreshed candidate discovery, and controlled challenger trials. The published `0.1.5` package still begins candidate discovery after the baseline.
- A normative, uncertainty-aware Pareto definition owned by OpenMerit.
- Harness-calculated frontier results independently checked by OpenMerit's conformance verifier.
- Versioned result schemas for all ten intents, reusable across harness adapters and exposed dynamically by Pi.
- Configurable swap approval, post-swap verification requests, and policy-based rollback requests. Automatic swaps can begin immediately if explicitly enabled with a zero verified-swap threshold.
- Project-local snapshots, redacted append-only audit events, evidence manifests, and optional best-effort event exporters under `.openmerit/`.
- Model-catalog change detection that can nudge the harness to reassess a mature baseline.
- User-confirmed task-count, elapsed-time, regression, catalogue-change, and post-swap check policies.
- Idempotent harness signals, durable pending work, native wakeup planning, and explicit scheduler capability gaps.
- In the unreleased source checkout, an opt-in macOS Pi LaunchAgent for time-based checks and a durable pause; published `0.1.5` still requires an external scheduler and has a partial, session-local pause.

## Responsibility boundary

| OpenMerit | Coding harness |
| --- | --- |
| Defines typed outcomes and Pareto conformance rules | Understands the product and user task |
| Tracks lifecycle, policy, budget, and evidence references | Builds evals and observability |
| Determines which approved nudge is due | Collects and calculates metrics |
| Verifies returned structure and frontier conformance | Discovers candidates and calculates the frontier |
| Selects intents according to confirmation and rollback policy | Applies and verifies an authorized model change |

Jev System One, when configured, belongs to the coding harness. Pi may use it aggressively for bounded ranking, triage, and fast judgment. OpenMerit contains no Jev client and accepts no Jev credential.

## Install with Pi

Requirements:

- Node.js 22.19 or newer
- Pi 0.87 with a supported model provider configured

```sh
pi install npm:openmerit
pi list
```

When Pi enters an unconfigured project with an interactive UI, the adapter first looks for an actual application LLM call pattern. If the project starts empty, the unreleased source checkout scans again after each settled build turn and automatically begins setup when Pi creates the application call. `/openmerit setup` remains a recovery command rather than a required demo step. Pi confirms the application target and exact incumbent application model, infers task-relevant metrics and their repeated-input or representative-case sampling designs, explains the proposed collection plan and estimated cost, and asks the user to confirm or edit it. It then establishes task-specific eval and observability artifacts, verifies them, and reports evidence to OpenMerit. Pi's own model is never the application target.

Run `/openmerit doctor` inside Pi to check the installation. OpenMerit keeps
project evidence under `.openmerit/` in the product repository. Version 0.1.5
replaces the 0.1.4 background watcher and standalone CLI with this
harness-driven lifecycle; it does not migrate the earlier home-directory state.

## Commands

- `/openmerit` or `/openmerit status` — show evidence readiness and lifecycle stage.
- `/openmerit setup` — explicitly rerun or recover automatic setup.
- `/openmerit assess` — check stored application metric windows against the baseline thresholds now (in the unreleased source checkout); start candidate discovery only when ready. Published `0.1.5` still asks Pi to assess.
- `/openmerit logs` — show the canonical audit, exporter-error, evidence, and state paths.
- `/openmerit frontier` — ask the harness to calculate a frontier now; OpenMerit verifies it.
- `/openmerit approve` — approve a verified proposal during supervised graduation.
- `/openmerit pause` and `/openmerit resume` — control some proactive nudges in the current Pi session; task-triggered checks can still run in 0.1.5. See [pause limitations](docs/commands.md#pause-and-resume).
- `/openmerit doctor` — show sanitized adapter diagnostics.

## Documentation

Read the searchable [OpenMerit documentation](https://openmerit.site/docs/). The Markdown sources below also ship with the package.

- [Getting started](docs/getting-started.md)
- [Your first trial](docs/first-trial.md)
- [Command reference](docs/commands.md)
- [Budgets and permissions](docs/budgets.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture and responsibility boundary](docs/architecture.md)
- [Metrics and evidence](docs/metrics-and-evidence.md)
- [Improvement lifecycle](docs/lifecycle.md)
- [Harness-neutral automation](docs/automation.md)
- [Pi extension guide](docs/pi-extension.md)
- [Building another harness adapter](docs/adapter-guide.md)
- [Pareto conformance specification](docs/pareto-spec.md)
- [Project state and operations](docs/operations.md)
- [Security](docs/security.md)
- [Testing](docs/testing.md)
- [Current limitations and roadmap](docs/roadmap.md)

### Maintaining documentation

Edit the Markdown in `docs/` alongside product changes. The public documentation is generated from these same files; there is no separate article copy to update in `site/`. Run `npm run check:docs` to rebuild and validate it. The normal Cloudflare deployment rebuilds and publishes the documentation. See [the documentation workflow](docs/site-documentation.md) for adding guides and previewing changes.

## Repository layout

- `packages/protocol` — harness-neutral types for intents, results, metrics, policies, and frontier evidence.
- `packages/core` — adapter SDK, durable coordinator, pluggable persistence, policy, and frontier conformance verification.
- `packages/pi` — Pi extension that turns OpenMerit intents into harness work.
- `docs` — user, operator, architecture, and normative documentation.

The workspace modules are private development boundaries. The published
package exposes `openmerit/core`, `openmerit/protocol`, and `openmerit/pi`.

## Development from source

```sh
npm ci
npm run verify
./node_modules/.bin/pi --no-extensions -e ./packages/pi/src/index.ts
```

`--no-extensions` prevents an installed npm copy of OpenMerit from registering the same tools as the source extension. Credentials must never be committed. The repository intentionally contains no provider or Jev API key.
