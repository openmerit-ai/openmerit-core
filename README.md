# OpenMerit

OpenMerit provides Scout guidance for application-model choices: in the browser, from the `openmerit scout` command, and through MCP for Claude Code and Pi.

Scout recommends candidates to evaluate. It is not a request router or proof of application-quality improvements.

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

## Evaluation CLI retirement — npm 0.3.0

OpenMerit 0.3.0 removes the standalone `openmerit eval` commands, including planning. Existing local evaluation files are not deleted. The old Scout JSON recommendation API went offline with the Scout serving deploy of 5 November 2026. Scout's conversational agent, MCP, coding-agent setup and catalogue publication remain available; see [retirement details](docs/agent-evaluations.md).

## Inference Terminal retirement — npm 0.3.0

OpenMerit 0.3.0 also removes the local Inference Terminal: `openmerit dash`, its `--demo` sample, collectors, repository index and browser interface. Existing `.openmerit/terminal.json`, `.openmerit/inference.jsonl` and application logs are not deleted. Older installed packages keep the command until they are upgraded. See [retirement details](docs/inference-terminal.md).

## Documentation

The [documentation overview](docs/index.md) links the maintained Markdown guides. The unpublished `/docs/` website shell is retired; the live Scout data policy and protected memo have separate builds.

- [Getting started](docs/getting-started.md) and [troubleshooting](docs/troubleshooting.md)
- [Scout](docs/scout.md) and [Pi adapter](docs/pi-extension.md)
- Retired: [Inference Terminal](docs/inference-terminal.md) and [agent evaluations](docs/agent-evaluations.md)
- [Security and data handling](docs/security.md)
- [Testing](docs/testing.md) and [current limitations](docs/roadmap.md)

## Development

```sh
npm ci
npm run verify
```

`packages/terminal` contains the `openmerit` CLI: Scout setup, updates and the `scout` command; `packages/pi` supplies only the native Scout adapter. The package exports `openmerit/pi` and the `openmerit` command. See the [Pi package README](packages/pi/README.md) for bounded adapter tests. Provider credentials belong to the harness or its environment and must never be committed.

Edit documentation in `docs/`, then run `npm run check:docs`. `npm run build:site` builds only the Scout data policy and protected memo, not a docs website. A local build does not publish changes; follow [deployment maintenance](docs/site-deployment.md) before any approved release.
