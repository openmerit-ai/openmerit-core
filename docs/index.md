# OpenMerit documentation

These guides describe the implementation on **main**. The standalone Inference Terminal is included in stable npm `openmerit@0.1.6`; interface changes available in source and the hosted dashboard but absent from that npm release are identified separately. The website, hosted samples, and npm package are deployed independently.

## See your inference environment

With Node.js 22.19 or newer:

```sh
npm install -g openmerit
cd /path/to/your/application
openmerit dash
```

The terminal shows application services, model declarations, recorded requests, and linked compute. It reads supported local evidence, needs no Pi installation or provider API key, and makes no inference calls or model changes. Configuration can identify declared services; actual activity requires existing supported logs or exports.

Start with [installation and setup](getting-started.md) or the [Inference Terminal guide](inference-terminal.md). Explore the [hosted sample](https://dash.openmerit.ai/) and [before/after dashboard demo](https://dash.openmerit.ai/demo) without connecting your machine. The [demo guide](demo.md) explains their fictional data and comparison limits.

## Discover model candidates

For a shortlist before building an integration, the separate [Scout beta](scout.md) accepts a task description and returns up to five evidence-backed model candidates. It is available at [openmerit.ai/scout/](https://openmerit.ai/scout/), with a prompt-only JSON API and MCP tool for coding agents.

## Evaluate model changes with Pi

The separate Pi 0.87 integration asks a coding harness to establish evaluations, gather application measurements, and test candidates. OpenMerit coordinates the approved lifecycle, records evidence references, validates structured results and frontier conformance, and requests authorized changes. The harness executes the work; the terminal does not perform this workflow.

Follow [Pi setup](getting-started.md#set-up-model-comparisons-with-pi), then [your first supervised trial](first-trial.md).

- [Metrics and evidence](metrics-and-evidence.md): measurements, sample requirements, and readiness.
- [Comparisons and swaps](lifecycle.md): baseline, challenger trials, approval, verification, and rollback.
- [Budgets and permissions](budgets.md): challenger accounting and provider-spend limits.
- [Automatic checks](automation.md): durable signals, cadence, and authorized macOS scheduling.

## Operate and troubleshoot

[Commands](commands.md) and [project files and logs](operations.md) explain status, pause, diagnostics, and recovery. [Troubleshooting](troubleshooting.md), [security and data](security.md), and [current limitations](roadmap.md) describe the boundaries to check before relying on automation.

## Build an integration

Pi is the implemented coding-harness adapter. Other harnesses can implement the protocol and coordinator boundary described in [architecture](architecture.md) and [the adapter guide](adapter-guide.md). The [Pareto specification](pareto-spec.md) defines comparison rules; [testing and validation](testing.md) distinguishes automated coverage from product evidence.
