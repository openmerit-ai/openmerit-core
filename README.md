# OpenMerit

OpenMerit provides a local Inference Terminal for understanding an application's models, services, recorded activity, and compute, plus Scout guidance for application-model choices.

The terminal reads existing evidence; Scout recommends candidates to evaluate. Neither is a request router or proof of application-quality improvements.

## Open the terminal

Requires Node.js 22.19 or newer and npm:

```sh
npm install -g openmerit
cd /path/to/your/application
openmerit dash
```

No Pi installation or provider API key is needed. The terminal opens a browser connected to a read-only loopback service. Supported source/configuration declarations establish inventory; existing application logs or exports supply request history. Prompts, responses, and credentials are not retained by terminal collection. Unsupported or missing evidence remains unknown.

The terminal follows the device's light/dark preference without a theme control. CLI and terminal product analytics are off unless explicitly enabled; see [the analytics contract](docs/inference-terminal.md#optional-cli-product-analytics).

Run `openmerit dash --demo` to explore a fictional sample workspace. See [the terminal guide](docs/inference-terminal.md) for configuration, discovery, diagnostics, history limits, and agent access.

## Connect Scout to Claude Code

Run `npx -y openmerit@latest install --client claude-code`, then approve the device in your browser. The command installs the MCP server and shared Scout guidance and checks the connection. New Claude Code sessions can consult Scout before choosing application models. Requires the `claude` CLI on PATH; see [setup, project policy and removal](docs/scout.md#connect-a-coding-agent). Installing the npm package alone makes no agent configuration changes.

## Connect Scout to Pi

OpenMerit **0.1.12** adds a thin Scout adapter for Pi **1.5.0**, replacing the old Pi 0.87 evaluation extension:

```sh
npx -y openmerit@latest install --client pi --scope user
```

Approve the matching device code in your browser, then start a new Pi session. Scope defaults to `user`; run with `--scope project` from a project's root for project-only setup. Each client/scope installation has its own key; project credentials stay outside the repository. The installed `openmerit-scout.ts` extension references private configuration and uses Pi's native MCP with the shared Scout rule and skill. Pi owns tools, model, permissions and sessions.

There are no `/openmerit` lifecycle commands, evaluation setup, scheduler, LaunchAgent, or automatic update hooks. To update, explicitly rerun the installer with the same scope. Shell `login`, `logout`, `status`, `remove` and `doctor` support `--client pi --scope user|project`. See [Pi setup and migration](docs/pi-extension.md) for paths, conflicts, old background-job removal, and SDK embedding with `createScoutPiExtension` plus Pi's explicit `createMcpExtension()`.

Package publication and website deployment are separate releases. Pi setup requires OpenMerit 0.1.12 or newer; check the resolved package version when using `@latest`.

## Evaluation CLI retirement — unreleased

This source removes the standalone `openmerit eval` commands, including planning, together with the old Scout JSON recommendation API. Existing local evaluation files are not deleted. Scout's conversational agent, MCP, coding-agent setup and catalogue publication remain available. This is not an npm release or production deployment; see [retirement details](docs/agent-evaluations.md).

## Documentation

The [documentation overview](docs/index.md) links the maintained Markdown guides. The unpublished `/docs/` website shell is retired; the live Scout data policy and protected memo have separate builds.

- [Getting started](docs/getting-started.md) and [troubleshooting](docs/troubleshooting.md)
- [Scout](docs/scout.md) and [Pi adapter](docs/pi-extension.md)
- [Inference Terminal](docs/inference-terminal.md) and [agent evaluations](docs/agent-evaluations.md)
- [Security and data handling](docs/security.md)
- [Testing](docs/testing.md) and [current limitations](docs/roadmap.md)

## Development

```sh
npm ci
npm run verify
npm run dash -- /path/to/application
```

`packages/terminal` contains the CLI, collectors and browser interface; `packages/pi` supplies only the native Scout adapter. The package exports `openmerit/pi` and the `openmerit` command. See the [Pi package README](packages/pi/README.md) for bounded adapter tests. Provider credentials belong to the harness or its environment and must never be committed.

Edit documentation in `docs/`, then run `npm run check:docs`. `npm run build:site` builds only the Scout data policy and protected memo, not a docs website. A local build does not publish changes; follow [deployment maintenance](docs/site-deployment.md) before any approved release.
