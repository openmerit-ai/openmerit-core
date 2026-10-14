# Project state and operations

## State location

Operational data lives under `.openmerit/` in the target product repository. It should be ignored by version control because it can contain local lifecycle state and evidence locations.

- `config.json` — task profiles and policy.
- `state.json` — current cycle, active or pending intent, last result, explicit observability coverage, processed signal IDs, task counters, latest aggregate baseline metric windows with evidence references, catalogue fingerprint, and assessment/swap checkpoints.
- `events.jsonl` — append-only audit events.
- `audit-export-errors.jsonl` — failures from optional external event exporters; these failures never replace or erase the canonical local event.
- `evidence/*.json` — evidence-reference manifests.
- `scheduler-status.json` — last headless wakeup time and exit code from the macOS background runner, when a wakeup actually ran.
- `terminal.json` — optional source configuration and declared inventory for the Inference Terminal.
- `inference.jsonl` — optional request-metadata export supplied by your existing tools for the terminal. The terminal reads this file; it does not instrument your application or create the feed.

Snapshot writes are atomic. Files use owner-only permissions where POSIX modes are supported.

The [Inference Terminal](inference-terminal.md) runs independently of the orchestration lifecycle. Its collector caches are memory-only and stop when the command exits. Permissions and retention for imported source files remain the responsibility of the tool that writes them.

## Diagnostics

Start with `/openmerit status`, which reports profile, metric and evaluation readiness, active work, next assessment, lifecycle, and pause state. `/openmerit doctor` confirms adapter loading without printing secrets.

Pause is stored in `.openmerit/state.json`, blocks automatic due decisions, and unloads an OpenMerit-managed macOS LaunchAgent for that project. Resume restores scheduling only if the confirmed policy still permits persistent execution and infrastructure changes. Incoming signals can still be recorded while paused, and an already-active intent is not cancelled. `/openmerit doctor` shows the LaunchAgent and status-file paths. A LaunchAgent runs only while the Mac user is logged in; a headless run requires Pi credentials available without a shell-only environment variable.

Inspect `scheduler-status.json` after a headless wakeup. A successful baseline-only check records a decision without starting Pi. A nonzero `exitCode` or `activeIntentId` means model-driven work did not complete; open the project in interactive Pi, inspect `/openmerit status` and `.openmerit/events.jsonl`, then use `/openmerit cancel` only if you intend to abandon that work. Model-driven runs have a 15-minute limit. The runner does not silently mark incomplete work successful.

`/openmerit logs` prints the exact local paths to the audit log, exporter failures, evidence manifests, and current state. During an end-to-end run, `tail -f .openmerit/events.jsonl | jq .` shows signals and decisions as they occur.

## Audit and recovery

OpenMerit records initialization, intent requests and completions, automation signals and duplicates, due checks, task checkpoints, catalogue changes, frontier validation, confirmation boundaries, and lifecycle advancement.

Automation-signal records include safe application measurement summaries: application model ID and application-reported token/cost/latency fields for completed tasks; or metric ID, state, scope, direction, method, value, unit, sample count, interval/window, and evidence IDs for metric windows. Pi's own model usage is not recorded as product-task evidence. Intent completions record their kind, status, next stage, harness, summary, and evidence IDs/sources. Secret-shaped keys and common API-key patterns are redacted before local persistence or export.

The local JSONL file is the canonical source of truth. `ProjectStore` can also receive optional event exporters for OpenTelemetry or vendor-specific adapters. Export is best effort: a failed exporter is written to `audit-export-errors.jsonl` and does not interrupt lifecycle state or canonical logging.

If Pi stops during an intent, durable state retains it. Inspect `state.json` and `events.jsonl` before manual changes. Deleting `.openmerit/` discards the audit trail, budget, profile, and evidence references.
