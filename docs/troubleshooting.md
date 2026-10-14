# Troubleshooting

Start with the current status and the local audit trail. These show what OpenMerit requested, what the harness reported, and which evidence references were recorded.

```text
/openmerit status
/openmerit doctor
/openmerit logs
```

## The command is missing

Check that OpenMerit is installed and enabled in Pi:

```sh
pi list
```

The published extension targets Pi 0.87 and Node.js 22.19 or newer. Follow [getting started](getting-started.md) to install it, then start Pi in your product repository.

## Setup did not begin

Automatic setup requires an unconfigured project, an interactive Pi UI, and a bounded source-detection match for an application LLM call. Non-interactive runs do not start the confirmation flow, and a project without a detected target remains idle until `/openmerit setup` is requested. Existing project state or active work may also prevent a fresh setup request.

Inspect status first. If no intent is active, use `/openmerit setup` to request setup explicitly; this is also the supported correction path when source detection or a prior setup recorded the wrong incumbent. A new setup preserves audit history but replaces the active task profile, candidate/assessment handoffs, frontier, and baseline state after the new result is accepted. Do not delete `.openmerit/` as a routine reset: it contains your policy, lifecycle state, evidence references, and audit history.

## Evidence is missing or incomplete

A task profile is not the same as working telemetry. Ask Pi which required metrics are uncovered, where their measurements should come from, and which evaluation artifacts have been run. Normal coding checkpoints do not replace those measurements.

The [metrics guide](metrics-and-evidence.md) explains missing and insufficient evidence. More samples or instrumentation may be needed before a candidate can be compared.

## A result was rejected

Read the validation error and audit event. Successful work needs evidence references and the output structure required by that intent. Frontier results must match the task and product revisions, identify their assessments, and satisfy the comparison rules.

Have the harness correct the measurement or output problem. Do not mark an intent successful merely to advance the workflow.

## Work appears stuck after a restart

Pending or active intent state is durable. Inspect `state.json` and `events.jsonl` using the paths from `/openmerit logs`, and ask the harness to reconcile that work with the current session before requesting another intent. The current adapter may need supervised recovery; automatic completion after a restart is not guaranteed.

## Checks are not running while Pi is closed

On macOS, check that the confirmed policy requests persistent execution and allows infrastructure changes, that the Mac user is logged in, and that Pi authentication works without shell-only credentials. `/openmerit doctor` reports scheduler diagnostics; `.openmerit/scheduler-status.json` records completed wakeups and failures. An active pause unloads the managed LaunchAgent. Other platforms need an external scheduler. A successful schedule does not establish that model-driven work completed. See [automatic checks](automation.md).

## Work continues after pausing

Pause is durable and gates automatic work, but an already-active intent can continue and explicit commands remain available. Inspect the active intent and audit timestamps to distinguish prior work from a new automatic dispatch. `/openmerit cancel` records abandonment; it does not terminate a provider request or harness process. The standalone terminal is independent of Pi pause; stop its CLI with Ctrl+C to stop collection. If a new automatic intent starts while the persisted pause is active, record a sanitized reproduction and your installed version.

## Report a reproducible problem

Include the OpenMerit, Pi, and Node.js versions, the triggering command or signal, the lifecycle stage, and a sanitized error. Remove credentials, private traces, and proprietary evaluation data before sharing anything in a public issue.

[Open an issue on GitHub](https://github.com/laz-aslam/openmerit/issues)
