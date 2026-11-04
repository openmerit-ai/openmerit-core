# Commands

**Pi replacement — unreleased, unpublished source:** Pi 1.5.0 uses only native Scout MCP and shared guidance. Run `npx -y openmerit@latest install --client pi [--scope user|project]` after publication and approve in the browser. Shell `login`, `logout`, `status`, `remove`, and `doctor` accept the same target flags. Updates require explicit reinstall; no Pi update hooks or scheduler are installed. See [Pi setup](pi-extension.md).

The standalone `openmerit dash` and `openmerit eval` commands are unchanged. The Pi 0.87 `/openmerit` slash commands were removed with that adapter and have no replacement.

Stable npm `openmerit@0.1.7` provides `openmerit eval init`, `doctor`, `plan`, `run`, `watch` and `report`. See [agent evaluations](agent-evaluations.md) for scope selection, repeated task checks and budgets. These are shell commands, separate from Pi commands. The same release includes [Scout setup commands](scout.md#commands), beginning with `npx -y openmerit@latest install --client claude-code`.

Since `0.1.7-preview.2`, `openmerit eval plan [--scope existing|all] [--budget <USD|unlimited>]` asks for a budget after scope. Choose $10, a custom amount, or no fixed cap; saved choices and cumulative usage persist. See [budget selection](agent-evaluations.md#budget-selection).

## Inference Terminal

Install with `npm install -g openmerit` to use `openmerit dash [path]` for a passive local view of models, connections, usage, and compute. From this checkout, use `npm run dash -- [path]`. It is independent of Pi setup and does not run model comparisons or inference.

See the [Inference Terminal guide](inference-terminal.md) for local installation, automatic discovery, `--no-discovery`, `--json`, `--demo`, collection intervals, and data limitations. Discovery is part of `dash` and is scoped to application evidence. Coding-harness histories are not collected.
