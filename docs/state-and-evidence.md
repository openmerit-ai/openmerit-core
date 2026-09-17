# State and evidence

The default store is `OPENMERIT_HOME` (otherwise `~/.openmerit`). It is local,
auditable JSON and JSONL so another storage integration can be added without
changing the comparison engine.

`recommendations.jsonl` and the event/trial logs are append-only. A later
recommendation line with the same `id` is the current status. Readers retain
valid records after an interrupted final line. Snapshots are written to a
temporary file and atomically renamed.

A comparison should have:

- a stable task and session identity;
- the original task context captured by the harness;
- the active baseline route and its measured result;
- candidate route metadata, including provider, price, capabilities, and
  lifecycle availability when supplied;
- normalized output, quality score, latency, cost, errors, tool activity, and
  side effects;
- evaluator and policy-gate details sufficient to explain the recommendation.

Raw Pi event streams for candidates live under `traces/trials/`. They are
diagnostic evidence and may contain task data or model output; use non-sensitive
tasks while evaluating the alpha and protect the state directory accordingly.

See the state table in the README for every current file. Harnesses that use a
remote store may preserve the same logical records and append/latest semantics.
