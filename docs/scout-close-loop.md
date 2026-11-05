# Close the model-selection loop

Scout recommends candidates; your own evals decide whether they work. Never send
Scout inputs, outputs, patient records, source code or secrets.

**Release status:** the Langfuse connection, per-user results and `--sync` below
are unreleased source changes. They need a Scout serving deployment and a new npm
patch. npm 0.3.4 supports reporting aggregates per conversation, not this connector.

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

Add the shortlist as runs of your existing evals, not a second platform. Obtain
approval before model spend or platform writes. For agents, change **one agent at
a time** while holding the other models, prompts, tools, fixtures and controls
fixed. Use that agent's own checks, not just end-to-end success, to attribute
failures. Include cost and latency per call or agent run.

If every candidate scores 100%, the eval does not distinguish their quality.
Add harder labelled boundary cases, rare failures and adversarial examples;
cheaper on this test is not proof of equal quality in production.

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
scores. Once the per-user change is deployed, aggregates apply across your
conversations. Re-reporting the same level/kind/task/scope/model/metric/source
updates that aggregate rather than duplicating it.

## Connect Langfuse

After release, `openmerit connect langfuse` opens the signed-in
[connection page](https://openmerit.ai/connect/?integration=langfuse). Create a
**separate Viewer key pair** in Langfuse Project Settings → API Keys. Enter it
only in the password fields there, never in a chat, command, issue or environment
file. Keep the application's tracing keys unchanged. US, EU and HIPAA Cloud hosts
are supported; self-hosted instances are not. Selecting a Langfuse region does
not promise that Scout stores or processes your data in that region.

You can connect the key first with empty mappings. To import results, expand
**Score and model mappings** and supply a start date, experiment-tag prefix,
score mappings and model aliases. To change saved settings, disconnect and
reconnect; this deletes the old imports, not reported results.

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
403 on that probe is accepted; other responses fail closed. Actual Viewer-key
acceptance remains pending the release check.

Click **Sync aggregates**, or request a fresh recommendation with:

```sh
openmerit scout --conversation <id> --sync langfuse
```

MCP uses `sync: "langfuse"`. Successful reads are cached for ten minutes; a
failed read cannot be retried for one minute. A failed import leaves the previous
complete set intact. `conversationId` alone reads a saved answer, not a rerank;
send a follow-up or `sync` to recompute with the current results.

## Choose and delete

Check measured quality, the quality floor, price calibration and limitations
before adopting a model. Benchmark estimates are not application acceptance.
Test endpoint connectivity and application behavior separately.

Results belong only to your Scout user account, not other customers. Up to 5,000
aggregates or 1 MB are retained for 90 days from report/import; expired rows are
excluded immediately and pruned daily (allow scheduling delay). An evaluation
account inactive for 90 days is erased by the same cleanup. See the
[data policy](scout-data-policy.md) for processors and backup limitations.

`openmerit disconnect langfuse` opens the browser confirmation. **Disconnect &
delete imports** removes the encrypted key pair and imported aggregates, including
an in-flight sync. **Delete all evaluation data** also removes manually reported
aggregates. Neither erases past conversation text or previously generated
recommendations; do not keep treating those answers as current measurements.
Contact the address in the policy for broader deletion.

This release changes the installed instruction-data contract. Existing automatic
updaters stop at that boundary; explicitly reinstall to adopt the new instructions.
