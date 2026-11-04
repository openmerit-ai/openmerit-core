# OpenMerit documentation

These guides distinguish current source work from published behavior. OpenMerit **0.1.12** adds native Scout support for Pi **1.5.0**, replacing the old Pi 0.87 evaluation extension. The Inference Terminal and standalone agent-evaluation CLI are separate products and are unchanged by that replacement. The website, Scout service and npm package are deployed independently; dated receipts describe the versions actually tested.

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

Use [the standalone evaluation CLI](agent-evaluations.md) to compare CLI revisions across Claude Code, Codex and OpenCode with explicit tasks, model scope, budgets and graders.

## Operate and troubleshoot

[Commands](commands.md) lists the terminal, Scout setup and evaluation commands. [Troubleshooting](troubleshooting.md), [security and data](security.md), and [current limitations](roadmap.md) explain setup failures and product boundaries. [Testing and validation](testing.md) distinguishes automated coverage from product evidence.
