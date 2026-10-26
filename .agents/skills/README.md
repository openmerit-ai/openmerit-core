# Project skills

| Skill | Source |
|---|---|
| `deploying-openmerit-workers` | Written for this repository |
| `wrangler`, `workers-best-practices`, `durable-objects` | Vendored unchanged from [cloudflare/skills](https://github.com/cloudflare/skills) at commit `86505e44f87d801aa1864a3c4109e9a8ae5c409f` (2026-10-15), Apache-2.0; see `LICENSE-cloudflare-skills` |

Vendored skills are copied as whole directories, because `amp skill add` drops their `references/` files. To update them, clone `cloudflare/skills`, review the diff (check for any new `mcpServers`, `mcp.json` or scripts), copy the directories over, and update the commit above. The Cloudflare plugin's bundled MCP server is intentionally not installed: the project's Cloudflare token reaches other projects.
