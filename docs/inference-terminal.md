# Inference Terminal retirement

**Unreleased source change, November 2026.** The local Inference Terminal is retired in full: `openmerit dash` and its `--port`, `--interval`, `--no-discovery`, `--no-open`, `--json`, `--diagnostics` and `--demo` options, the fictional sample workspace, repository indexing, request-log and activity-export import, runtime and hardware discovery, and the browser interface. This source change does not itself publish a package or change an already installed older package; those keep the command until they are upgraded.

After an approved npm release, `openmerit dash` reports an unknown command. There is no replacement view of application inventory or request history. Use your application's own logs or observability tools for recorded activity, and [Scout](scout.md) for application-model guidance.

## Existing local files

Upgrading does not delete `.openmerit/terminal.json`, `.openmerit/inference.jsonl`, hardware exports or application request logs under `logs/`, `runs/` or `results/`. Review and retain or remove them yourself. Stop any running `openmerit dash` process before upgrading.

Retirement does not erase previously sent opt-in terminal analytics or change their retention.

## Optional CLI product analytics

The terminal's browser and collection events (`terminal_visited`, `terminal_page_viewed`, `terminal_interaction`, `terminal_snapshot` and `terminal_error`) and their local `/api/analytics` relay are removed with it. CLI command analytics remain.

Scout setup commands (`install`, `status`, `remove`, `login`, `logout`, `project` and `doctor`) default analytics on; see the [setup default contract](scout.md#scout-setup-analytics-default-version-0110). Other commands send analytics only when `OPENMERIT_TELEMETRY=1`. `OPENMERIT_TELEMETRY=0` and `DO_NOT_TRACK=1` always disable them.

When enabled, the CLI posts `cli_command_started` and `cli_command_completed` to `https://openmerit.ai/scout/api/analytics`, with a fresh `crypto.randomUUID()` identity for that process only. Properties contain a command category (`help`, a setup command name, or `unknown`), a random command ID, the package version, platform (`darwin`, `linux`, `win32`, `unknown`) and Node major version. Completion adds the outcome (`ok` or `error`) and integer elapsed milliseconds capped at one day. Errors can add a fixed code, a standard error class and at most eight application-basename/line/column frames from `cli.mjs` or `install.mjs`. Paths, arguments, prompts, configuration, model IDs, error text, environment contents, machine names and email are not included.

Transport is best-effort and silent, and is bounded to about 750 ms per event. It does not change command output or exit status. Abrupt termination can lose events. Setup installation milestones follow the separate [Scout lifecycle contract](scout.md#coding-agent-lifecycle-instrumentation-npm-019).

## Preserved capabilities

Scout setup for Claude Code and Pi, `openmerit scout`, `openmerit update`, and the setup `status`, `doctor`, `login`, `logout` and `remove` commands remain. CLI command analytics keep the same opt-in and opt-out rules. See [commands](commands.md), [security](security.md) and [testing](testing.md) for the remaining interfaces.
