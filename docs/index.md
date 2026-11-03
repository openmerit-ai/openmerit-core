# OpenMerit documentation

These guides distinguish current source work from published behavior. OpenMerit **0.1.12** adds native Scout support for Pi **1.5.0**, replacing the old Pi 0.87 evaluation extension. The Inference Terminal and standalone agent-evaluation CLI are separate products and are unchanged by that replacement. The website, hosted samples, Scout service and npm package are deployed independently; dated receipts describe the versions actually tested.

## See your inference environment

With Node.js 22.19 or newer:

```sh
npm install -g openmerit
cd /path/to/your/application
openmerit dash
```

The terminal shows application services, model declarations, recorded requests, and linked compute. It reads supported local evidence, needs no Pi installation or provider API key, and makes no inference calls or model changes. Configuration can identify declared services; actual activity requires existing supported logs or exports.

Start with [installation and setup](getting-started.md) or the [Inference Terminal guide](inference-terminal.md).

## Discover model candidates

For a shortlist before building an integration, the separate [Scout beta](scout.md) accepts a task description and returns up to five evidence-backed model candidates. It is available at [openmerit.ai/scout/](https://openmerit.ai/scout/), with a prompt-only JSON API and MCP tool for coding agents.

## Connect Scout to Pi

The thin Pi 1.5.0 adapter uses native MCP and shared Scout guidance. Pi owns tools, models, permissions and sessions; the adapter has no `/openmerit` lifecycle commands, evaluation scheduling, LaunchAgent or automatic updates.

Follow [setup](getting-started.md#connect-scout-to-a-coding-agent) and [the Pi guide](pi-extension.md), including browser approval, per-client/scope credentials, explicit reinstall updates and SDK requirements. Registry setup requires OpenMerit 0.1.12 or newer.

## Evaluate application changes

Use [the standalone evaluation CLI](agent-evaluations.md) for Claude Code, Codex and OpenCode. Custom harnesses may use the core coordinator. The following guides retain core concepts and historical Pi 0.87 workflows; they do not describe the new Scout adapter:

- [Metrics and evidence](metrics-and-evidence.md): measurements, sample requirements, and readiness.
- [Comparisons and swaps](lifecycle.md): baseline, challenger trials, approval, verification, and rollback.
- [Budgets and permissions](budgets.md): challenger accounting and provider-spend limits.
- [Automatic checks](automation.md): durable signals, cadence, and authorized macOS scheduling.

## Operate and troubleshoot

[Troubleshooting](troubleshooting.md), [security and data](security.md), and [current limitations](roadmap.md) explain current Pi setup and its boundaries. [Commands](commands.md) and [project files and logs](operations.md) also retain explicitly historical Pi lifecycle references alongside standalone/core information; their old pause and recovery commands are not part of the new adapter.

## Build an integration

Pi now supplies a native Scout connection, not an evaluation `HarnessAdapter`. Custom evaluation harnesses can implement the protocol and coordinator boundary described in [architecture](architecture.md) and [the adapter guide](adapter-guide.md). The [Pareto specification](pareto-spec.md) defines comparison rules; [testing and validation](testing.md) distinguishes automated coverage from product evidence.
