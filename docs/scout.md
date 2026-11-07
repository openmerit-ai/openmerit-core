# Scout by OpenMerit

Scout helps you choose application-model candidates through the
[website](https://openmerit.ai/scout/), CLI and coding-agent MCP. It recommends;
it does not route inference, run candidates or prove their application quality.
Use your own evals before adopting a model.

## Connect a coding agent

Use Node.js 22.19 or newer. Claude Code requires the `claude` CLI on PATH;
Pi requires version 1.5.0. Run one installer from your project:

```sh
npx -y openmerit@latest install --client claude-code --scope project
# Or:
npx -y openmerit@latest install --client pi --scope project
```

Approve the matching device code in the browser, then start a new agent session.
Only approve requests you initiated. Codes expire after 30 minutes; if the
installer returns pending, approve its link and rerun the same command to resume.
Use `--no-open` on a remote machine. Installing the npm package alone does not
configure either agent.

User scope applies across projects. Project credentials stay outside the
repository. For Claude, private local MCP configuration follows the Git root,
not necessarily the directory containing the skill. With npm 0.3.9 and Claude
2.1.63 or newer, linked worktrees share that configuration under the main checkout;
older Claude uses the worktree root. Use the same Claude CLI for setup and sessions.
Existing edited or unowned entries are not overwritten or migrated.

See [setup](getting-started.md), [Pi details](pi-extension.md) and
[troubleshooting](troubleshooting.md). Package publication, hosted deployment and
your installed instructions are separate: rerun setup to install a published fix.

## Commands

```sh
openmerit status --client claude-code --scope project --check
openmerit doctor --client claude-code --scope project
openmerit scout "Extract invoice line items as structured JSON" --all-endpoints
openmerit scout --conversation <id> --brief input="English invoice text"
openmerit scout --conversation <id> --sync langfuse
```

Use `--client pi` for Pi checks. `--json` returns structured CLI results.
`--plan` previews setup/removal without applying it. `remove` removes unchanged
owned configuration and revokes that installation's key; edited files and project
policy remain. `logout` revokes and deletes its key; rerun `login` and `install`
to recover an expired or revoked setup.

## Scope and model choice

The published CLI uses `.openmerit/scout.json` to declare accessible public
catalogue endpoint IDs. `project --policy existing-only --endpoint-id <id>` limits
searches to that inventory. `existing-first` tries it first and requires approval
before broadening. `--all-endpoints` explicitly requests the whole catalogue and
cannot override existing-only. An empty inventory grants access to no endpoints.
Never put credentials or private endpoint URLs in this file.

Scout asks for missing task requirements. Answer in the same conversation or
explicitly use `--skip` to continue with stated assumptions. A recommendation
names exact model/endpoint IDs, quality evidence, estimated workload cost and gaps.
Cheapest meeting the quality bar is the default; an explicit quality or recency
priority changes the order. The bar is an estimate, not a measured accuracy floor.
An unmeasured candidate that another unmeasured candidate beats on both quality
estimate and estimated cost is left out, so a shortlist can have fewer than five
models. Candidates at the same price stay, and measured candidates are never left
out this way.
Unknown processing location is not evidence of residency compliance.

## Close the loop

1. Install, authorize and consult Scout with non-confidential task requirements.
2. Reuse suitable evals. If none exist or they are too weak, agree on a local
   task-specific plan before creating customer-owned evals.
3. Run approved candidates, changing one agent at a time. Keep the quality floor,
   prompts, tools and controls fixed; judge that agent's own checks.
4. Connect Langfuse with a separate Viewer key and confirmed score/model mappings,
   or report aggregates from your own system. Never submit raw records.
5. Refresh Scout, compare measured quality, cost and limitations, and save the
   decision. All candidates passing a tiny eval is inconclusive, not equal quality.

The [close-the-loop guide](scout-close-loop.md) covers readiness paths, protected
connection setup, aggregate schemas, mappings, sample counts, regret and
evidence-first cleanup. Langfuse is the supported connector; other platforms can
report aggregates. Scout does not write customer datasets, runs or scores.
New model spend, provider credentials, deployments and deletion need approval.

## Using Scout from the agent

The installed startup rule and skill ask the coding agent to consult Scout before
application-model choices, including implicit pretrained-model defaults. They
are guidance, not enforcement. Unrelated edits, ordinary inference and the coding
agent's own model are outside scope. Pi owns tools, permissions and sessions.

With a confirmed Langfuse connection and mappings, npm 0.3.8+ instructions request
aggregate sync before selection. Sync does not execute candidates. A failed sync
must be disclosed; retained cached evidence is not a fresh import. Reading only a
conversation ID retrieves its saved answer; a follow-up or sync recomputes it.

## Automatic instruction updates (version 0.1.10+)

Claude setup defaults to automatic instruction updates through asynchronous
startup/response-end hooks. Checks use npm's stable registry at most once daily;
failed checks retain the installed version and retry after 15 minutes of eligible
use. New sessions load new instructions reliably. Disabled hooks or an exiting
one-shot process can prevent a check or notice.

```sh
openmerit update --client claude-code --scope project
```

Checks verify package integrity and read a bounded instruction bundle; they do
not execute downloaded scripts or replace credentials/project policy. Edited
files are retained. `OPENMERIT_AUTO_UPDATE=off` suppresses automatic checks in that
process, not explicit updates. Pi has no update hooks: rerun its installer.

## Device keys

Each client/scope approval creates its own private recommendation key, accepted on
Scout MCP and expiring after 90 days without use. The server stores its hash.
Local credentials and Claude's private MCP headers contain the key; protect them
and never paste it in chat. Revoke devices on the connection page or through the
targeted `logout`/`remove` command. Langfuse management uses a separate approval
and key; a recommendation key does not gain deletion permissions.

## Account sign-in — published, 21 October 2026

Browser recommendations require Clerk sign-in. Agent MCP uses the separate device
flow above; a browser cookie is not an agent credential. Sign-in and provider
processing have their own policies. Failed authorization does not grant access.

## Product analytics

Use [Privacy & analytics](https://openmerit.ai/scout/privacy/) and the
[data policy](scout-data-policy.md) to review collection and retention. General
opt-out, Do Not Track and Global Privacy Control suppress optional analytics,
not necessary task processing. Redaction is best effort, not permission to send
confidential data. There is no session recording.

### Scout setup analytics default — version 0.1.10

Setup usage analytics defaults on. `OPENMERIT_TELEMETRY=0` or `DO_NOT_TRACK=1`
disables it. Installed MCP connections do not share prompt content for analytics.
Rerun setup to apply changed installation preferences.

### Coding-agent lifecycle instrumentation — npm 0.1.9

Eligible setup and MCP usage can report bounded milestones and fixed error codes,
not keys, source files, paths or transcripts. Linked setup uses random identifiers;
request-only unlinking does not erase earlier account links.

### Version-5 instrumentation

Eligible web/API/MCP events can include allowlisted diagnostic categories, actual
computation counts and latency. Unknown cost or usage stays unknown. Delivery is
best effort; an accepted request does not prove downstream ingestion.

### Unified product and search analytics — deployed, 22 October 2026

Optional PostHog analytics is separate from necessary service processing and the
historical Cloudflare prompt archive. Retention and deletion are not interchangeable
between those systems. See the policy rather than assuming one universal expiry.

### Account profile synchronization — deployed, 22 October 2026

Enabled account-linked analytics can include name, verified email, signup time
and sign-in providers. It is identifiable, not anonymous. Account deletion is
asynchronous and broader deletion may require contacting the policy's address.

## Refresh and data handling

Public benchmarks, catalogue prices and vendor metadata may be incomplete or
outdated; citations do not certify model quality, access, residency or zero
retention. Verify the exact endpoint in your application. No claim is made that
all catalogue models can be run in your environment.

**Deployed 6 November 2026:** decision models that OpenRouter routes (supplied
choices, ordered rubric scores and boolean probabilities through its alpha
Decisions API) are listed alongside Vercel AI Gateway's. An OpenRouter route
whose expiration date has passed is no longer listed; a route with a removal
date still ahead shows it as `retiresAt`, and Scout mentions it when it
recommends a model through that route. Other hosts' deprecation dates do not
remove a route. Moving aliases such as OpenRouter's `~lab/…-latest` IDs are
never treated as one model.

**Unreleased, not deployed:** more host routes are matched to the model they
serve when a host spells the version or names the lab differently, for example
Amazon Bedrock's `eu.cohere.embed-v4:0`, Azure's `embed-v-4-0` or Fireworks'
`glm-5p2`. A model that OpenRouter or Vercel AI Gateway listed under its own
spelling, such as `cohere/embed-5-fast` beside `cohere/embed-v5.0-fast`, is
merged into the existing model, so it no longer appears twice.

On enabled deployments, reported and imported aggregates belong to your account
and apply across conversations. They are not shared with other customers. The
connector reads experiment headers/metadata and aggregate metrics, never trace
or observation bodies. Source/scope identifier warnings are not guaranteed
redaction. Retention, encrypted credentials, disconnect behavior and deletion
limits are specified in the [data policy](scout-data-policy.md) and
[security guide](security.md). Disconnecting does not erase past conversations
or customer-platform records; deleting those is a separate approved action.

## Run locally

The CLI runs on your machine but calls hosted Scout; it does not install a local
Scout server. Use `openmerit scout --help` for published options. The standalone
[evaluation CLI](agent-evaluations.md), [Inference Terminal](inference-terminal.md)
and legacy `/scout/api/recommend` interface are retired. Use the conversational
agent, CLI or canonical MCP instead.
