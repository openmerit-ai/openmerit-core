# Backfill recovery

The [agent workflow](https://openmerit.site/demo?task=backfill) prepares a recovery manifest for an interrupted data backfill. Its goal is to resume recoverable partitions without duplicating committed data, quarantine malformed input, and stop for investigation when the failure is unknown or involves a checksum conflict. It never executes the manifest or writes to a database.

## Workflow structure

Three dependent model turns perform one goal: request the incident through `inspect_job`, request its authoritative ledger through `read_checkpoint`, then combine those results with the recovery policy into a manifest. The tools are read-only functions over fixed synthetic records. Their requests are JSON commands dispatched by the prepared adapter, not arbitrary code. The runner fixes the three-task sequence; the model supplies the job identifiers and final plan. Invalid requests become scored failures and are not silently repaired.

The fixed agent uses GPT-4.1 mini for all three tasks. Its challenger is one prepared mixed-model route:

| Task | Without OpenMerit | With the proposed route |
| --- | --- | --- |
| Inspect incident | GPT-4.1 mini | GPT-4.1 nano |
| Read checkpoint | GPT-4.1 mini | GPT-4.1 mini |
| Plan recovery | GPT-4.1 mini | Gemini 2.5 Flash Lite |

Each model receives the accumulated context and tool results from preceding tasks. OpenMerit evaluates the **whole route** and can change the application's three-step model configuration after approval. The baseline remains fixed. The route is a supplied candidate, not an unrestricted search over all model combinations or evidence that each individual assignment is optimal. The workflow itself remains prepared in advance.

## Evaluation policy

Eight synthetic recovery goals cover stale runbooks, non-contiguous commits, malformed rows, completed jobs, checksum conflicts, unknown failures, and instructions embedded in incident notes. Eligibility requires all eight complete manifests to match, correct tool use and output structure on every goal, no committed or nonexistent partition scheduled for replay/quarantine, and all required evidence citations. Mean whole-goal latency must be at most eight seconds and mean whole-goal cost at most $0.003. These are constraints on the observed suite, not per-request timeouts or guarantees about other jobs. The lowest-cost eligible frontier candidate must also cost less than the incumbent. Six disjoint goals verify an approved change.

Cost adds every model turn in each goal. Latency measures the complete sequential workflow, including tool dispatch. The `total_task_cost` assessment retains actual spend over the sample window, including every agent call. The per-goal budget is multiplied by the window size for comparison and by the six-goal verification size after a swap; the display divides actual spend by goal count. Provider-level call records, tool requests/results, checks, and manifests are retained in the run evidence. The recording includes the sample's actual tool trace. The evaluation records are `BF-4101` through `BF-4108`; their incidents and ledgers are fixed.

## Recorded outcome

In the recorded run, the fixed agent completed 6/8 goals and the mixed-model route completed 8/8. Mean whole-goal costs were $0.0007742 and $0.0004018625; latencies were 4.12s and 3.80s. This is about 48% lower cost and 8% lower latency in that run. All six post-swap goals passed, and a custom request returned the expected quarantine plan through both paths. The displayed sample preserves a baseline mistake: it scheduled the malformed partition for both replay and quarantine; the mixed route excluded it from replay. The recording's step models come from the actual provider calls and tool traces, not labels added to the earlier single-model recording. These are one run's observations, not promised outcomes.

See [the demo overview](demo.md) for playback controls, the shared comparison lifecycle, and how to read the measurements.
