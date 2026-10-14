# Testing and validation

## Standard verification

```sh
npm ci
npm run verify
npm pack --dry-run
```

`verify` runs workspace tests, syntax checks, TypeScript checks, the package build, demo tests, generated-documentation checks, and whitespace validation. It does not publish a package or deploy the website.

## Coordinator and Pi coverage

Automated tests cover protocol contracts, task-specific sampling, application-target binding, setup and post-build target detection, incumbent identity, deterministic baseline sufficiency, durable candidate/assessment handoffs, frontier conformance, approval, swap and rollback requests, persistence, evidence requirements, budget accounting, and audit redaction.

Automation coverage includes task and elapsed cadence, signal idempotency, durable pending work, catalogue changes, regression thresholds, delayed post-swap checks, scheduler capability gaps, and persistent pause. Pi's own usage and coding checkpoints are not counted as application measurements.

The disposable-project test in `packages/pi/test/live-wakeup.test.ts` verifies that a due, insufficient baseline is recorded without starting Pi. Scheduler tests validate managed LaunchAgent configuration and authorization boundaries. They do not establish reliable unattended candidate discovery, comparison, or swapping; those require a representative headless product trial.

## Inference Terminal coverage

```sh
npm test --workspace=@openmerit/terminal
```

Tests cover metadata projection and redaction, source containment, recursive syntax indexing, phased worker progress, incremental reuse, coverage limits, endpoint classification, authorized loopback probes, supported request-log formats, UTF-8 boundaries, rotation/truncation, source reconciliation, historical ranges, unknown versus zero measurements, and the read-only API.

Inventory and UI coverage includes model/service identity, explicit deployment and host links, shared capacity, stale/missing hardware, path classification, map completeness, search and filtering, preference-dependent demo decisions, and preservation of unknown costs. Runtime fixtures establish which endpoints collectors call; they do not prove compatibility with every external runtime version.

The three fictional scenarios are separate:

| Scenario | Agents | Tasks | Models / offers | Requests |
| --- | ---: | ---: | --- | ---: |
| Local sample (`--demo` or sample selector) | 40 | 140 | 21 models | 9,600 over 24 hours |
| Hosted enterprise sample | 200 | 699 | 21 models | 9.6 million over 30 days |
| Hosted before/after comparison | 280 | 980 | 26 reviewed offers across six services; assignments depend on preference | 9.6 million over 30 days |

The comparison tests preserve workload and token volume across all six preferences, enforce service/output compatibility, disclose benchmark/efficiency overrides, and verify modeled costs. Sample tests exercise interface scale and arithmetic, not measured throughput, application quality, or hardware performance.

Browser review covers the six views, inspectors, search, activity ranges, map and chart interaction, keyboard navigation, reduced motion, and desktop/narrow layouts. The source light/dark change has local browser verification; it is not yet published to npm or the hosted site. Browser checks are distinct from the committed unit suite.

## Pi load and package smoke tests

```sh
./node_modules/.bin/pi --no-session --no-extensions -e ./packages/pi/src/index.ts --list-models
```

This checks extension loading and catalogue enumeration, not successful provider authentication or a completed product intent. CI also packs the package, installs it in a temporary directory, imports the core/protocol entry points, and loads the installed extension.

## Experimental sandbox

`npm run demo` builds a disposable sentiment-classification application through Pi and runs live provider calls. It requires Pi 0.87 with OpenRouter authentication and an application OpenRouter credential. It is separate from the fictional dashboard comparison and from the recorded website player.

The runner collects a baseline, interleaves incumbent/challenger calls on the prepared cases, records cost/token/latency evidence, submits results to the coordinator, and exercises a change and fresh checks in the temporary app. Missing usage, invalid output, or exhausted allowance stops the run. The default application-spend threshold is $1, checked after responses; Pi's own coding-model spend is excluded. This is not an in-flight provider cutoff.

The default models are `openai/gpt-4.1-mini` and `openai/gpt-4o-mini`. The runner supports `OPENMERIT_DEMO_BASELINE_MODEL`, comma-separated `OPENMERIT_DEMO_CANDIDATE_MODELS`, `OPENMERIT_DEMO_PI_MODEL`, `OPENMERIT_DEMO_REPETITIONS` (2–5), `OPENMERIT_DEMO_MAX_SPEND_USD` (up to $5), and `OPENMERIT_DEMO_SEED`. The printed temporary directory retains the app, plan, lifecycle state, per-call artifacts, comparison manifest, and summary. Small prepared examples do not establish representative product reliability.

## What evidence establishes

- **Unit verified:** deterministic behavior has automated coverage.
- **Runtime smoke verified:** the runtime loads the extension or executable.
- **Product trial verified:** a representative application completes the workflow with inspected evidence.
- **Production verified:** repeated representative runs support the claimed operating conditions and reliability.

Implementation checks, historical demo recordings, and public model benchmarks cannot substitute for target-product validation. See [current limitations](roadmap.md) before relying on unattended changes.
