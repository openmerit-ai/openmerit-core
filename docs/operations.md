# Project state and operations

## State location

Operational data lives under `.openmerit/` in the target product repository. It should be ignored by version control because it can contain local lifecycle state and evidence locations.

- `config.json` — task profiles and policy.
- `state.json` — current cycle, active or pending intent, last result, processed signal IDs, task counters, metric baselines, catalogue fingerprint, and assessment/swap checkpoints.
- `events.jsonl` — append-only audit events.
- `evidence/*.json` — evidence-reference manifests.

Snapshot writes are atomic. Files use owner-only permissions where POSIX modes are supported.

## Diagnostics

Start with `/openmerit status`, which reports profile, metric and evaluation readiness, active work, next assessment, lifecycle, and pause state. `/openmerit doctor` confirms adapter loading without printing secrets.

`/openmerit pause` stops proactive nudges for the current process; explicit commands still work. `/openmerit resume` re-enables them.

## Audit and recovery

OpenMerit records initialization, intent requests and completions, automation signals and duplicates, due checks, task checkpoints, catalogue changes, frontier validation, confirmation boundaries, and lifecycle advancement.

If Pi stops during an intent, durable state retains it. Inspect `state.json` and `events.jsonl` before manual changes. Deleting `.openmerit/` discards the audit trail, budget, profile, and evidence references.
