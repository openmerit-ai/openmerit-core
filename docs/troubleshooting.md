# Troubleshooting

The Pi Scout adapter requires OpenMerit **0.1.12** or newer and targets Pi **1.5.0**. Check the resolved package version when using `@latest`. The removed Pi 0.87 `/openmerit` workflow is not a diagnostic path for the replacement.

## Scout is missing in Pi

Run targeted checks in your shell:

```sh
npx -y openmerit@latest status --client pi --scope user --check
npx -y openmerit@latest doctor --client pi --scope user
```

Use `--scope project` from the original project root for project setup. Check Pi and Node.js versions against [setup](getting-started.md), complete browser device approval, then start a **new session**. Installing the npm package or reconnecting an old session does not load new extension instructions. For SDK embedding, load Pi's `createMcpExtension()` explicitly alongside `createScoutPiExtension`; the Scout factory alone is not an MCP runtime.

## The connection configuration is invalid

The installed extension reads `openmerit-scout.json` beside its bundle; that file points to a private credential file outside the repository. Do not put the key in the extension or prompt. Check the scope and configuration-directory overrides against [installed paths](pi-extension.md#installed-files-and-credentials). Reinstall explicitly to repair missing owned files:

```sh
npx -y openmerit@latest install --client pi --scope user
```

Expired or revoked credentials require targeted `login` followed by reinstall. The adapter reports a sanitized setup diagnostic; it never starts sign-in on its own. Approve only a browser code you initiated.

## Installation reports a conflict

The installer does not overwrite edited or unowned files. Inspect and preserve your changes before resolving the conflict. Also check for overlapping Pi user/project installations or an existing `openmerit` MCP entry. Remove the unwanted owned installation using its own scope; do not revoke a different client's key as a repair. Disable the old `npm:openmerit` Pi registration when migrating from 0.87.

## The adapter did not update automatically

That is expected. Pi has no OpenMerit auto-update hooks. Explicitly rerun `install --client pi` with the original scope, then start a new session. Claude Code's update settings do not configure Pi.

## `/openmerit` or evaluation tools are missing

They were removed, not renamed. The Pi adapter now supplies only native Scout MCP and shared guidance. It does not set up evaluations, recover intents, schedule work, swap models, or install a LaunchAgent. Existing legacy background jobs must be removed separately; installing the new adapter is not evidence that they stopped. Preserve old evaluation state and audit files if needed. For new evaluations use [the standalone CLI](agent-evaluations.md); custom harnesses may still use [the core coordinator](adapter-guide.md).

## Scout was not consulted or its evidence is insufficient

The rule and skill are model guidance, not a guaranteed tool gate. Confirm they loaded in a new session and that the host permits the MCP tools. When project model policy is missing, ask the user; when Scout is unavailable or lacks suitable evidence, pause the model choice rather than invent a result. Host model/tool/session restrictions remain authoritative. Scout candidates are not measurements of your application's quality.

## Evaluation or terminal problems

The standalone products are separate from Pi setup. Use [agent-evaluation diagnostics](agent-evaluations.md) for tasks, graders, budgets and execution blocks, or [terminal diagnostics](inference-terminal.md) for missing inventory and request evidence. A populated dashboard is not proof of successful evaluations. Never mark missing or rejected evidence successful merely to advance a workflow.

## Report a reproducible problem

Include OpenMerit, Pi and Node.js versions, the client/scope, the triggering command, and a sanitized error. Remove credentials, private paths, prompts and proprietary data before sharing. Do not attach credential or connection files containing private configuration.

[Open an issue on GitHub](https://github.com/laz-aslam/openmerit/issues)
