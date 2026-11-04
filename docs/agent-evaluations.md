# Agent-evaluation CLI retirement

**Unreleased source change, November 2026.** The standalone `openmerit eval` CLI is retired in full, including `init`, `doctor`, `plan`, `run`, `watch` and `report`. The old Scout JSON recommendation API is retired with it. This source change does not itself publish a package, deploy a Worker or change an already installed older package.

After an approved Scout release, `/scout/api/recommend` and its legacy alpha/versioned paths return 404, regardless of authentication. There is no replacement frozen-plan protocol. Use the [Scout conversational agent or MCP](scout.md) for provisional model guidance and your own representative task checks for evaluation. The Inference Terminal is [retired as well](inference-terminal.md); the Pi adapter remains a native Scout MCP integration, not an evaluation runner.

## Existing local artifacts

Upgrading does not delete `.openmerit/eval.json`, reports, budget ledgers, task fixtures or grader files. Review and retain or remove them yourself. Stop any old foreground watcher before upgrading. Instructions previously appended to `AGENTS.md` or `CLAUDE.md` are not automatically rewritten; remove obsolete evaluation instructions deliberately, preserving unrelated project guidance.

Historical reports remain evidence only for the versions and tasks actually tested. Unknown costs do not become known, and past budget reservations are not reconciled provider bills. Retirement does not cancel external agent/provider work, erase historical Scout analytics, change provider retention or enforce billing limits.

## Preserved capabilities

Scout's agent, MCP, coding-agent setup, catalogue refresh/publication, status and account/privacy controls remain. Shared evidence preparation and model projections remain available to those consumers. See [commands](commands.md), [security](security.md) and [testing](testing.md) for the remaining interfaces and verification boundary.
