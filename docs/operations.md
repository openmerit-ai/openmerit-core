# Project state and operations

## State location

Operational data lives under `.openmerit/` in the target product repository. It should be ignored by version control because it can contain local lifecycle state and evidence locations.

- `config.json` — task profiles and policy.
- `state.json` — current cycle, active or pending intent, last result, explicit observability coverage, processed signal IDs, task counters, metric baselines, catalogue fingerprint, and assessment/swap checkpoints.
- `events.jsonl` — append-only audit events.
- `audit-export-errors.jsonl` — failures from optional external event exporters; these failures never replace or erase the canonical local event.
- `evidence/*.json` — evidence-reference manifests.

Snapshot writes are atomic. Files use owner-only permissions where POSIX modes are supported.

## Diagnostics

Start with `/openmerit status`, which reports profile, metric and evaluation readiness, active work, next assessment, lifecycle, and pause state. `/openmerit doctor` confirms adapter loading without printing secrets.

In version 0.1.5, `/openmerit pause` suppresses lifecycle follow-up nudges but does not gate the automation-signal dispatch path. Task, measurement, and session-start signals can still issue due work while status says paused. The setting is process-local, resets on restart, and does not cancel active work. Explicit commands still work. `/openmerit resume` clears the pause flag. Do not rely on this version's pause command to stop all OpenMerit work.

`/openmerit logs` prints the exact local paths to the audit log, exporter failures, evidence manifests, and current state. During an end-to-end run, `tail -f .openmerit/events.jsonl | jq .` shows signals and decisions as they occur.

## Audit and recovery

OpenMerit records initialization, intent requests and completions, automation signals and duplicates, due checks, task checkpoints, catalogue changes, frontier validation, confirmation boundaries, and lifecycle advancement.

Automation-signal records include safe measurement summaries: model ID and token context for completed tasks; or metric ID, state, scope, direction, method, value, unit, sample count, interval/window, and evidence IDs for metric windows. Intent completions record their kind, status, next stage, harness, summary, and evidence IDs/sources. Secret-shaped keys and common API-key patterns are redacted before local persistence or export.

The local JSONL file is the canonical source of truth. `ProjectStore` can also receive optional event exporters for OpenTelemetry or vendor-specific adapters. Export is best effort: a failed exporter is written to `audit-export-errors.jsonl` and does not interrupt lifecycle state or canonical logging.

If Pi stops during an intent, durable state retains it. Inspect `state.json` and `events.jsonl` before manual changes. Deleting `.openmerit/` discards the audit trail, budget, profile, and evidence references.
