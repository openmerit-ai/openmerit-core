# Pi extension

## Supported version

OpenMerit **0.1.12** adds a Scout adapter for Pi **1.5.0**. It replaces, rather than upgrades in place, the Pi 0.87 evaluation adapter. The `@latest` commands below require OpenMerit 0.1.12 or newer. Package publication and website deployment remain independent releases.

## Installation

With Node.js 22.19 or newer, npm, and Pi 1.5.0 installed:

```sh
npx -y openmerit@latest install --client pi --scope user
```

Approve the matching browser device code and start a new Pi session. Scope defaults to `user`; use `--scope project` from the project's root for project-local setup. Each client and scope gets an independent key and approval; project keys are also separated by project. The npm package alone does not configure Pi.

The website's **Add to Pi** action is copy-only and sits below the Claude action, with the Pi logo before the label. It copies the installer command; it does not open a Pi deep link or prove installation. The button requires the corresponding Scout website deployment.

## Installed files and credentials

| File | User scope | Project scope |
| --- | --- | --- |
| Native extension bundle | `~/.pi/agent/extensions/openmerit-scout.ts` | `.pi/extensions/openmerit-scout.ts` |
| Credential-path reference | `~/.pi/agent/extensions/openmerit-scout.json` | `.pi/extensions/openmerit-scout.json` |
| Shared Scout skill | `~/.pi/agent/skills/openmerit-scout/SKILL.md` | `.pi/skills/openmerit-scout/SKILL.md` |
| Installer ownership record | `~/.pi/agent/openmerit-install.json` | `.pi/openmerit-install.json` |

`PI_CODING_AGENT_DIR` overrides the user agent directory. The connection JSON contains a `credentialsPath`, not the key. The default private key paths are `~/.config/openmerit/pi/user/credentials.json` for user scope and `~/.config/openmerit/pi/<project-id>/credentials.json` for project scope. The project ID derives from the resolved project root; run targeted commands from that root. `OPENMERIT_CONFIG_DIR` or `XDG_CONFIG_HOME` can override the private configuration base. Do not copy credentials into the project or model instructions.

The extension reads credentials at session startup and registers the `openmerit` HTTP MCP server with direct tool exposure. Authorization is an HTTP header, not prompt content. Missing or invalid configuration produces a sanitized setup diagnostic, not an automatic login. The adapter performs no per-turn HTTP connection checks or credential reads.

## Native ownership and shared guidance

Pi supplies the MCP connection, tool discovery and execution, permissions, and session management. The thin adapter adds the same Scout rule and skill used by the shared installer as structured system-prompt sections. It leaves the host's model, tool allow/exclude lists, and other prompt sections intact. This is guidance to consult Scout before application-model choices, not enforcement of tool invocation or permission to download, spend, deploy, or change models. Scout's [data-handling policy](scout.md#refresh-and-data-handling) applies to submitted tasks.

## Updates and targeted lifecycle commands

```sh
npx -y openmerit@latest status --client pi --scope user --check
npx -y openmerit@latest doctor --client pi --scope user
npx -y openmerit@latest login --client pi --scope user
npx -y openmerit@latest logout --client pi --scope user
npx -y openmerit@latest remove --client pi --scope user
```

Replace `user` with `project` for a project installation. Removal and logout target that client's scope/key, not a Claude Code installation or another project. Edited or unowned files are not silently overwritten or deleted. Resolve duplicate user/project adapters or existing `openmerit` MCP entries before installing.

Updates are **explicit reinstall only**: rerun `install --client pi` with the same scope and start a new session. There are no Pi auto-update hooks; Claude Code update-hook settings do not apply to Pi.

## SDK embedding

`openmerit/pi` exports `createScoutPiExtension({ credentialsPath })` and a default extension created by that factory. SDK hosts must explicitly load Pi's own **`createMcpExtension()`** alongside the Scout extension; the Scout factory does not create an MCP runtime. The Pi CLI already supplies native MCP. The explicit credential path takes precedence over the installed adjacent connection JSON, with the shared Pi user credential path as the fallback when that JSON is absent. The host supplies its own model, tools, session and permission configuration.

## Migration from Pi 0.87

Remove or disable the old `npm:openmerit` Pi package registration before loading this adapter, and explicitly remove any previously authorized background job through its existing management path. New setup does not promise to uninstall a legacy LaunchAgent. Preserve `.openmerit/` evaluation state and evidence if needed; do not delete them as a setup repair.

The replacement has no `/openmerit` commands, `openmerit_complete_intent` or `openmerit_report_signal` tools, source preflight, evaluation lifecycle, intent recovery, scheduling, automatic swaps, or LaunchAgent. The [core coordinator](architecture.md) remains available for custom harnesses. The [standalone evaluation CLI](agent-evaluations.md) is unchanged. Older lifecycle guides are retained as historical adapter/core references, not instructions for this Scout adapter.
