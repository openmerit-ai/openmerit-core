# Close the model-selection loop

Scout recommends candidates; your own evals decide whether they work. Never put
inputs, outputs, patient records, source code or secrets in recommendation prompts
or tool arguments. Connector credentials use the protected paths described below.

**Version requirements:** the Langfuse setup commands below require npm 0.3.5 or
newer and a matching Scout serving deployment. Saving Langfuse credentials also
requires connection encryption to be enabled on the server. Publishing the npm
package alone does not deploy or enable the hosted connector. npm 0.3.4 supports
reporting aggregates per conversation, not this connector.

## Install and consult

Install the published package, approve the device code in your browser and start a
new coding-agent session. See [setup](getting-started.md) for Pi and unattended
reuse of an already-approved device key. Do not copy another user's key.

```sh
npx -y openmerit@latest install --client claude-code --scope project
npx -y openmerit@latest scout "Extract invoice line items as structured JSON" --all-endpoints
```

Use your saved project inventory instead of `--all-endpoints` when policy limits
access. Existing-only policy cannot be broadened by that flag. Answer Scout's
questions in the same conversation with `--brief`, or explicitly choose `--skip`.
Each recommended model names an exact endpoint and provider model ID.

## Measure with your own evals

**Eval-readiness and evidence guidance — npm 0.3.7:** this
package adds the readiness and cleanup workflow below to the installed Scout
skill. Existing npm 0.3.6 instructions cover measuring and aggregate reporting,
but do not yet prescribe all three readiness paths or an evidence-first cleanup
record. This is guidance for the customer's coding agent, not an automated eval
runner, platform provisioner or deletion service.

### Choose the readiness path

- **No eval setup.** Scout can still suggest candidates from public evidence;
  that is not measured application quality. Propose a minimal customer-owned
  eval setup and obtain approval before creating it. Langfuse is the default
  suggestion because Scout has its aggregate connector. A hosted platform is
  optional: customer-owned scripts and fixtures can report aggregates directly.
  Phoenix/Arize and Braintrust are alternatives, not supported Scout connectors.
- **A setup exists, but the evals are missing or too weak for model selection.**
  Keep the existing system. Have the user or their coding agent write a local
  task-specific Markdown eval plan with exact candidates/endpoints, quality floor,
  task/agent/outcome checks, labelled boundary cases and controls, sample size,
  early stopping, spend cap, aggregate mappings and temporary-run retention.
  Review it before implementing it with the customer's tools. OpenMerit's access
  remains Viewer-only; it does not install or maintain those evals.
- **Suitable evals already exist.** Reuse their fixtures and definitions. Add
  approved candidate runs rather than creating another dataset or platform.

Add the shortlist as runs of your existing evals, not a second platform. Obtain
approval before model spend or platform writes. For agents, change **one agent at
a time** while holding the other models, prompts, tools, fixtures and controls
fixed. Use that agent's own checks, not just end-to-end success, to attribute
failures. Include cost and latency per call or agent run.

If every candidate scores 100%, the eval does not distinguish their quality.
Add harder labelled boundary cases, rare failures and adversarial examples;
cheaper on this test is not proof of equal quality in production.

### Preserve evidence, then request cleanup

Save a local Markdown decision record before removing temporary comparison data.
Include the date, package and service versions, task and policy, exact candidates,
unchanged controls, metric definitions and direction, sample counts, aggregate
quality/cost/time, failures and exclusions, decision, limitations and next review.
Exclude keys, private record identifiers, prompts, outputs and trace bodies.

State cost regret in a consistent unit (for example USD per agent run): the
chosen model's measured cost minus the cheapest measured candidate meeting the
same quality floor on comparable evals. If there is no measured comparison,
write **not measurable**, not zero. One success or all candidates scoring 100%
on a tiny eval is not proof of equal production quality.

Comparison records are temporary, but deletion is **not automatic**. After
checking the saved evidence, propose the exact newly created comparison runs and
any cascading deletions, then obtain explicit scoped approval. The customer or
their coding agent performs cleanup using customer-controlled write access;
Scout's Viewer key cannot delete Langfuse data. Never delete pre-existing customer
records, reusable fixtures, dataset definitions or eval definitions. Verify that
only the approved records disappeared and retained controls still exist. Record
cleanup as pending when permission or verification is missing.

Deleting platform runs, disconnecting Scout and deleting Scout's stored aggregates
are separate operations. Disconnect does not erase past conversations or customer
platform records. Keep enough permitted aggregate evidence locally to explain a
later decision, without promising Scout can refresh a deleted source experiment.

## Report aggregates

Report up to 50 aggregates per call, one per model, metric and scope. Use public
catalogue model or endpoint IDs. `scope` and `source` must be aggregate labels,
not record IDs, emails or URLs containing private identifiers.

```json
[
  {
    "level": "agent", "kind": "quality", "task": "Invoice extraction",
    "scope": "Invoice extraction", "model": "<catalogue-model-id>",
    "metric": "fields-correct", "value": 0.96, "higherIsBetter": true,
    "samples": 100, "source": "Held-out invoice eval"
  }
]
```

```sh
openmerit scout --conversation <id> --results results.json
```

Use `kind: "usd"` or `"seconds"` for measured money or time; they are not quality
scores. On the enabled hosted connector, aggregates apply across your
conversations. Re-reporting the same level/kind/task/scope/model/metric/source
updates that aggregate rather than duplicating it.

## Connect Langfuse

`openmerit connect langfuse` opens the optional signed-in
[connection page](https://openmerit.ai/connect/?integration=langfuse). Create a
**separate Viewer key pair** in Langfuse Project Settings → API Keys. Enter it
in the password fields there, or use the protected headless paths below. Never
paste it in chat, command arguments, issues or tracked files. Keep the
application's tracing keys unchanged. US, EU and HIPAA Cloud hosts
are supported; self-hosted instances are not. Selecting a Langfuse region does
not promise that Scout stores or processes your data in that region.

You can connect the key first with empty mappings. To import results, expand
**Score and model mappings** and supply a start date, experiment-tag prefix,
score mappings and model aliases. In npm 0.3.6 with the matching Scout deployment,
the headless paths below can update settings without re-entering the saved Viewer
key. Changing settings invalidates old imports; sync again afterwards. Reported
results remain. Older deployments require disconnecting and reconnecting.

### Headless CLI setup

First authorize a **separate connection-management key**. This is not an upgrade
to your existing recommendation key and does not change Claude Code or Pi setup.
The first account authorization still requires a signed-in person to approve the
displayed device code; `--no-open` lets them do that on another device. After
approval, all connector operations can run without the web UI.

```sh
openmerit connect langfuse --authorize --no-open
```

If it returns exit 10 (approval pending), approve the matching code and rerun the
same command. The resumable login stores the management key with mode 0600 in
`connector/user/credentials.json` under the OpenMerit config directory (normally
`~/.config/openmerit`). Never display or share that file. The key grants
`scout:connections`, not `scout:recommend`; it can manage **all evaluation data
for your account**, not only one project. It cannot approve devices, list other
device keys, run recommendations or spend on models. Like recommendation keys,
it expires after 90 days without use and can be revoked from the connection page
or with `openmerit logout --client connector`. Disconnecting Langfuse does not
revoke this management credential; revoke it separately when retiring a runner.

Save only non-secret settings in `mappings.json`:

```json
{
  "region": "us",
  "from": "2026-11-01",
  "tagPrefix": "experiment:",
  "mappings": [],
  "models": {}
}
```

Have your secret manager inject `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`
into the CLI process environment, then run:

```sh
openmerit connect langfuse --config mappings.json
openmerit connect langfuse --status
openmerit connect langfuse --sync
```

**Updating an existing connection (npm 0.3.6 and matching deployment):** edit the
non-secret settings file and run the same `--config` command with both
`LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` absent. Scout reuses and reverifies
the encrypted Viewer key internally; neither CLI nor model receives it. One key
without the other is rejected. Without a connected key, first connect through a
protected credential path. Settings changes remove prior imports, not reported
results, and require a new sync.

Alternatively, `openmerit connect langfuse --stdin` reads a full JSON object with
the same settings plus `publicKey` and `secretKey` from a protected pipe, up to
18 KB. It does not echo or save the Viewer credentials locally. Do not use inline
JSON, `echo` with literal secrets, command substitutions that print secrets into
an agent transcript, or an interactive shell history entry. Authorize before
piping a secret. Environment variables and pipes are not a vault: trust the
runner and restrict process/debug access, and disable shell tracing and request
logging. Unattended jobs may instead inject an already-approved
`OPENMERIT_CONNECTION_KEY` through a secret manager; keep recommendation and
management credentials separate.

### MCP management

The canonical `/scout/mcp` endpoint exposes `scout_connection` when authenticated
with the separate management key (or a current browser session). Register a
separate trusted MCP client connection using `Authorization: Bearer <management
key>` without putting the actual key in chat or tool arguments. A recommendation
key still discovers only `scout_models`; a management key discovers only
`scout_connection`. This separation is enforced on calls, not just discovery.

`scout_connection` supports `status`, `configure`, `sync`, `disconnect` and
`clear`. `configure` takes the non-secret settings above as `config`. Supply the
Viewer key pair through **client-controlled HTTP headers**
`X-Langfuse-Public-Key` and `X-Langfuse-Secret-Key`, sourced from your secret manager,
not from the model. These headers are consumed only for configuration and are
never returned in tool results or sent to the recommendation model. Remove them
from client configuration after connecting. Do not configure a client/proxy that
records these headers. If your MCP client cannot securely inject headers outside
model context, have the agent invoke the CLI with protected input instead, or
use the web UI; do not fall back to putting credentials in tool arguments.

On the matching 0.3.6 deployment, omit both Viewer headers to update an existing
connection using its saved encrypted key. A new connection still needs both.
The authenticated HTTP POST similarly accepts non-secret settings without either
key field for an existing connection. The saved key is never exported. Settings
changes reverify Viewer access and invalidate imported results before a new sync.

```json
{"action": "configure", "config": {"region": "us", "from": "2026-11-01", "tagPrefix": "experiment:", "mappings": [], "models": {}}}
```

This checks and saves the connection, not a sync. Send `{"action":"sync"}` to
import mapped aggregates without starting inference. For deletion, obtain the
user's consent and pass `confirm: true` with `disconnect` or `clear`. Tool
confirmation is not a substitute for consent in your application.

### HTTP API

The same authenticated account store is available without MCP:

| Method | Path | Operation |
| --- | --- | --- |
| GET | `/connect/api/langfuse` | Connection status and aggregate counts, never credentials |
| POST | `/connect/api/langfuse` | Configure/replace using full JSON settings including `publicKey` and `secretKey` |
| POST | `/connect/api/langfuse/sync` | Import mapped aggregates without inference |
| DELETE | `/connect/api/langfuse` | Delete the Viewer key pair and imported aggregates |
| DELETE | `/connect/api/evaluations` | Also delete manually reported aggregates |

Send the management key in the `Authorization: Bearer` header and
`Content-Type: application/json` for configuration. Browser session tokens still
work. Recommendation keys, anonymous requests and cross-origin browser requests
are rejected. No request accepts a target user ID: ownership comes from the
authenticated identity. Inject credentials into the HTTP client, not command-line
arguments; keep request bodies/headers out of logs. Check status after an ambiguous
network failure before retrying a change. None of these paths bypasses the Viewer
check, explicit mappings, encryption, retention limits or per-user isolation.

### Attribute imported scores

Every scored trace must carry a tag formed from the prefix plus its experiment
ID, for example `experiment:<id>`. The experiment's metadata must identify the
model for that agent. Scout does not infer model attribution from timestamps,
trace contents or the currently selected model. Untagged historical runs are
not imported: report their aggregates instead. Each mapping specifies an exact
trace name so other agents in the same experiment cannot contaminate its score.

Example score mapping (replace the task title with the exact Scout task):

```json
[
  {
    "metric": "coding-finding-found", "modelKey": "model_coding",
    "task": "Coding review", "traceName": "review-coding",
    "level": "agent", "kind": "quality", "higherIsBetter": true
  }
]
```

Model aliases explicitly map metadata values to Scout model or endpoint IDs:

```json
{"<experiment metadata model value>": "<Scout catalogue model or endpoint ID>"}
```

The first import supports numeric/boolean score averages and counts, not strings,
raw scores, percentile distributions or automatic cost/latency extraction from
generation bodies. At most eight mappings, 100 aliases and 100 experiments are
read per sync. Narrow the date if a response or import exceeds its limit. Only
experiment headers/metadata and aggregate Metrics v2 reads are requested. A
deliberately invalid dataset-create request checks read-only permission without
ever sending a valid write payload. Only an authenticated read followed by HTTP
403 on that probe is accepted; other responses fail closed. A connected key or
nonzero import proves neither application quality nor a completed customer loop.

**npm 0.3.8 and later:** when your project records a confirmed
Langfuse connection and mappings, the coding agent should request aggregate sync
on its first consultation and before a final model decision. This refresh reads
Langfuse aggregates and updates Scout's cache; it does not execute candidates or
create customer-platform records, so it does not require new model-spend or
platform-write approval. Do not retype old measurements from project notes in
place of refreshing the connection. If sync fails, disclose the failure and
distinguish retained cached evidence from a fresh import. A tracing key in the
application does not establish that Scout is connected: check connection status
before proposing another setup. This guidance does not make the server sync
implicitly; the agent still requests it through the existing command or tool.

Click **Sync aggregates**, or request a fresh recommendation with:

```sh
openmerit scout --conversation <id> --sync langfuse
```

MCP uses `sync: "langfuse"`. Successful reads are cached for ten minutes; a
failed read cannot be retried for one minute. A failed import leaves the previous
complete set intact. `conversationId` alone reads a saved answer, not a rerank;
send a follow-up or `sync` to recompute with the current results.

**Serving update in preparation:** aggregate queries group mapped score names
within each experiment and trace role, rather than requesting every metric
separately. Experiment tags and explicit model aliases still isolate attribution.
On this updated deployment, a rate-limited sync honors Langfuse's `Retry-After`
duration, persists the cooldown and continues to report failure during it; a
failed refresh is not a successful cache hit. Without a valid duration the
fallback is one minute. Langfuse's Metrics quota can be hourly or daily and is
shared across the organization's projects and keys, so repeatedly retrying or
changing keys does not solve exhaustion. See [Langfuse API limits](https://langfuse.com/faq/all/api-limits).
This server update does not grant access to trace or observation bodies and
does not execute models or change Langfuse records.

### When a sync imports zero aggregates

A connected Viewer key and a successful experiment read do not establish that
score import is configured. Empty mappings are allowed when first connecting.
Before repeating sync, check the score mappings and model aliases, then check
that scored traces carry the exact experiment tag, trace name and metric name
in those mappings. Merely linking a trace through Langfuse's native experiment
attributes does not add the explicit experiment tag required by this connector.
Do not remove the tag filter to make an import nonempty: that can combine scores
from different models or runs. Untagged historical results need attributable
aggregate reporting or a separately approved, verified tagging backfill.

**Diagnostic version requirement:** a matching Scout serving deployment adds
`mappingCount` and `modelAliasCount` to connection status, without returning the
saved keys or mapping values. The web page distinguishes a connected key from
incomplete setup and warns when a sync imports no matching scores. npm 0.3.5
does not display these new counts; use authenticated API/MCP status until a
matching CLI patch is published. These counts diagnose missing configuration,
not whether matching scores exist or whether a model improves quality.

## Choose and delete

Check measured quality, the quality floor, price calibration and limitations
before adopting a model. Benchmark estimates are not application acceptance.
Test endpoint connectivity and application behavior separately.

Results belong only to your Scout user account, not other customers. Up to 5,000
aggregates or 1 MB are retained for 90 days from report/import; expired rows are
excluded immediately and pruned daily (allow scheduling delay). An evaluation
account inactive for 90 days is erased by the same cleanup. See the
[data policy](scout-data-policy.md) for processors and backup limitations.

`openmerit disconnect langfuse` opens the optional browser confirmation;
`openmerit disconnect langfuse --yes` deletes headlessly, and adding
`--delete-all` also deletes reported results. **Disconnect &
delete imports** removes the encrypted key pair and imported aggregates, including
an in-flight sync. **Delete all evaluation data** also removes manually reported
aggregates. Neither erases past conversation text or previously generated
recommendations; do not keep treating those answers as current measurements.
Contact the address in the policy for broader deletion.

This release changes the installed instruction-data contract. Existing automatic
updaters stop at that boundary; explicitly reinstall to adopt the new instructions.
