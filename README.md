# OpenMerit

OpenMerit provides a local Inference Terminal for understanding an application's models, services, recorded activity, and compute, plus Scout guidance for application-model choices.

The terminal reads existing evidence; Scout recommends candidates to evaluate. Neither is a request router or proof of application-quality improvements. A separate standalone evaluation CLI and reusable core coordinator support explicit evaluation workflows.

## Open the terminal

Requires Node.js 22.19 or newer and npm:

```sh
npm install -g openmerit
cd /path/to/your/application
openmerit dash
```

No Pi installation or provider API key is needed. The terminal opens a browser connected to a read-only loopback service. Supported source/configuration declarations establish inventory; existing application logs or exports supply request history. Prompts, responses, and credentials are not retained by terminal collection. Unsupported or missing evidence remains unknown.

The terminal and hosted dashboard follow the device's light/dark preference without a theme control. CLI and terminal product analytics are off unless explicitly enabled; see [the analytics contract](docs/inference-terminal.md#optional-cli-product-analytics).

Explore the [hosted sample](https://dash.openmerit.ai/) or [before/after dashboard demo](https://dash.openmerit.ai/demo). Both use fictional data and make no inference calls. See [the terminal guide](docs/inference-terminal.md) for configuration, discovery, diagnostics, history limits, and agent access.

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

## Evaluate application changes

The standalone `openmerit eval` CLI is unchanged by the Pi replacement. Evaluate Claude Code, Codex and OpenCode with explicit tasks, model scope, budget and graders. Freeze Scout's shortlist and compare fresh repeated attempts after source changes. Budget and sandbox blocks stay separate from task scores; unknown costs stay unknown. See [agent evaluations](docs/agent-evaluations.md) for setup, graders, budgets and availability.

The core coordinator remains available for custom harnesses: task profiles, controlled experiments, baseline and frontier validation, evidence contracts, budgets, approvals and rollback requests. The harness performs the work and supplies evidence; core validation does not establish that external measurements are truthful. The older Pi lifecycle walkthroughs are retained as historical/core references, not supported commands in the new Scout adapter.

## Documentation

The [documentation overview](docs/index.md) links current guides and historical references. The website at [openmerit.ai/docs](https://openmerit.ai/docs/) is deployed separately from the package and this checkout.

- [Getting started](docs/getting-started.md) and [troubleshooting](docs/troubleshooting.md)
- [Scout](docs/scout.md) and [Pi adapter](docs/pi-extension.md)
- [Inference Terminal](docs/inference-terminal.md) and [agent evaluations](docs/agent-evaluations.md)
- [Security and data handling](docs/security.md)
- [Architecture](docs/architecture.md), [adapter development](docs/adapter-guide.md), and [Pareto specification](docs/pareto-spec.md)
- [Testing](docs/testing.md) and [current limitations](docs/roadmap.md)

## Development

```sh
npm ci
npm run verify
npm run dash -- /path/to/application
```

`packages/terminal` contains the CLI, collectors, hosted sample, and browser interface. `packages/protocol` and `packages/core` provide evaluation contracts and coordination; `packages/pi` supplies only the native Scout adapter. The package exports `openmerit/core`, `openmerit/protocol`, and `openmerit/pi`. See the [Pi package README](packages/pi/README.md) for bounded adapter tests. Provider credentials belong to the harness or its environment and must never be committed.

Edit documentation in `docs/`, then run `npm run check:docs`. The website is generated from those Markdown files. See [documentation maintenance](docs/site-documentation.md) and the [production-source reconciliation note](docs/site-domain-migration.md) before deployment; a local build does not publish changes.
