# OpenMerit documentation

These maintained Markdown guides describe Scout setup and model-selection workflows. The policy, protected memo, Scout service and npm package are released independently. A local documentation build does not publish a hosted change.

## Discover model candidates

Start with [installation and setup](getting-started.md). The [Scout beta](scout.md) provides conversational application-model guidance at [openmerit.ai/scout/](https://openmerit.ai/scout/) and through MCP for coding agents. The legacy prompt-only JSON recommendation endpoint is retired.

## Connect Scout to Pi

The thin Pi 1.5.0 adapter uses native MCP and shared Scout guidance. Pi owns tools, models, permissions and sessions; the adapter has no `/openmerit` lifecycle commands, evaluation scheduling, LaunchAgent or automatic updates.

Follow [setup](getting-started.md#connect-scout-to-a-coding-agent) and [the Pi guide](pi-extension.md), including browser approval, per-client/scope credentials, explicit reinstall updates and SDK requirements. Registry setup requires OpenMerit 0.1.12 or newer.

## Evaluate application changes

Use your own representative task checks to evaluate model candidates. The [standalone evaluation CLI is retired in npm 0.3.0](agent-evaluations.md); existing local artifacts are not deleted.

Follow [close the model-selection loop](scout-close-loop.md) to consult, measure,
import aggregates and choose. Protected Langfuse setup requires npm 0.3.5 or newer
and a matching hosted connector; npm 0.3.6 adds saved-key mapping updates.

## Operate and troubleshoot

[Commands](commands.md) lists the Scout and setup commands. The [Inference Terminal is retired in npm 0.3.0](inference-terminal.md); existing local files are not deleted. [Troubleshooting](troubleshooting.md), [security and data](security.md), and [current limitations](roadmap.md) explain setup failures and product boundaries. [Testing and validation](testing.md) distinguishes automated coverage from product evidence.
