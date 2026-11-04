# Commands

**Pi adapter — npm 0.1.12 and later:** Pi 1.5.0 uses only native Scout MCP and shared guidance. Run `npx -y openmerit@latest install --client pi [--scope user|project]` and approve in the browser. Shell `login`, `logout`, `status`, `remove`, and `doctor` accept the same target flags. Updates require explicit reinstall; no Pi update hooks or scheduler are installed. See [Pi setup](pi-extension.md).

The Pi 0.87 `/openmerit` slash commands were removed with that adapter and have no replacement.

**Unreleased retirement:** this source no longer provides `openmerit dash` ([details](inference-terminal.md)) or any `openmerit eval` commands, including `plan`. It also retires `/scout/api/recommend`; use Scout's conversational agent or MCP. Existing local evaluation files are untouched. Published packages and hosted Workers change only through separate approved releases. See [retirement details](agent-evaluations.md).

The [Scout setup commands](scout.md#commands) remain available, beginning with `npx -y openmerit@latest install --client claude-code`.
