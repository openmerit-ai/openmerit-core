# Scout for Pi

This source adapter targets Pi **1.5.0**. It replaces the obsolete Pi 0.87
evaluation adapter; it does not expose the old `/openmerit` commands, completion
tools, scheduler, or background wakeups. Core and evaluation products are separate.

The default export is `createScoutPiExtension()`. SDK hosts may pass an explicit
credential file with `createScoutPiExtension({ credentialsPath })` and must load
Pi's own `createMcpExtension()` alongside it. Pi's CLI already supplies native MCP.

At session startup, the default extension reads `openmerit-scout.json` beside its
installed bundle. That small file contains only `{ "credentialsPath": "…" }`.
Without it, the adapter uses the shared Pi user credential path. An explicit
factory option takes precedence. Missing or invalid credentials produce a
sanitized setup diagnostic; the adapter never initiates login.

The adapter registers `openmerit` through Pi's native HTTP MCP integration with
direct tool exposure, and adds the shared Scout rule and skill as structured
prompt sections. Pi owns connections, discovery, tool calls, permissions, and
session management. Host tool restrictions and existing prompt sections remain
intact. Credentials are HTTP headers only, never model instructions. There are
no adapter HTTP checks or credential reads on individual turns.

Run `npm run test --workspace @openmerit/pi` for bounded native SDK/loopback MCP
contract tests. These tests make no application-model or inference calls.
