# Commands

**Pi adapter — npm 0.1.12 and later:** Pi 1.5.0 uses only native Scout MCP and shared guidance. Run `npx -y openmerit@latest install --client pi [--scope user|project]` and approve in the browser. Shell `login`, `logout`, `status`, `remove`, and `doctor` accept the same target flags. Updates require explicit reinstall; no Pi update hooks or scheduler are installed. See [Pi setup](pi-extension.md).

`openmerit dash` remains available. The Pi 0.87 `/openmerit` slash commands were removed with that adapter and have no replacement.

**Unreleased retirement:** this source no longer provides any `openmerit eval` commands, including `plan`. It also retires `/scout/api/recommend`; use Scout's conversational agent or MCP. Existing local evaluation files are untouched. Published packages and hosted Workers change only through separate approved releases. See [retirement details](agent-evaluations.md).

The [Scout setup commands](scout.md#commands) remain available, beginning with `npx -y openmerit@latest install --client claude-code`.

## Inference Terminal

Install with `npm install -g openmerit` to use `openmerit dash [path]` for a passive local view of models, connections, usage, and compute. From this checkout, use `npm run dash -- [path]`. It is independent of Pi setup and does not run model comparisons or inference.

See the [Inference Terminal guide](inference-terminal.md) for local installation, automatic discovery, `--no-discovery`, `--json`, `--demo`, collection intervals, and data limitations. Discovery is part of `dash` and is scoped to application evidence. Coding-harness histories are not collected.
