# Getting started

OpenMerit provides Scout model-selection guidance. The Inference Terminal (`openmerit dash`) is [retired in npm 0.3.0](inference-terminal.md). Pi Scout setup requires OpenMerit **0.1.12** or newer and Pi **1.5.0**. Package publication and website deployment are independent releases.

## Connect Scout to a coding agent

Claude Code setup is described in [the Scout guide](scout.md#connect-a-coding-agent). For the new Pi integration, use Pi **1.5.0**, Node.js 22.19 or newer, and npm. Run the intended command in your shell:

```sh
npx -y openmerit@latest install --client pi --scope user
```

Approve the matching device code in the browser, then start a **new Pi session**. Only approve a request you initiated. User scope is the default and applies across projects. For one project, run this from that project's root instead:

```sh
npx -y openmerit@latest install --client pi --scope project
```

Each client/scope installation has its own private Scout key; project keys are stored outside the repository. Do not install overlapping Pi user/project adapters or a duplicate `openmerit` MCP entry. The installer reports conflicts rather than overwriting edited or unowned files.

The adapter connects Scout through Pi's native MCP and supplies the shared Scout rule and skill. Pi owns tool discovery, tool execution, model choice, permissions, and sessions. Scout recommends application-model candidates; it does not execute those candidates or change Pi's own model. There are no `/openmerit` lifecycle commands, automatic evaluation setup, scheduler, or LaunchAgent in this adapter.

## Check, update, or remove Pi setup

```sh
npx -y openmerit@latest status --client pi --scope user --check
npx -y openmerit@latest doctor --client pi --scope user
npx -y openmerit@latest remove --client pi --scope user
```

Use `--scope project` from the original project root for a project installation. `login` and `logout` accept the same `--client` and `--scope` flags. These commands target that installation, not another client's connection. Updating Pi setup requires explicitly rerunning `install` and starting a new session; no Pi auto-update hooks are installed. Installing or updating the npm package alone does not reconfigure Pi.

See [the Pi extension guide](pi-extension.md) for installed paths, migration from Pi 0.87, and SDK embedding. Use [troubleshooting](troubleshooting.md) for setup failures.

## Evaluate application changes

The standalone evaluation CLI is retired in npm 0.3.0, and the legacy JSON recommendation API went offline with the Scout serving deploy of 5 November 2026. Scout guidance is not measured application quality; use your own task checks and provider budget controls. See [retirement details](agent-evaluations.md).
