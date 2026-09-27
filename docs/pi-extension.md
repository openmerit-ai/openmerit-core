# Pi extension

## Supported version

The adapter targets Pi 0.87 and declares `>=0.87.0 <0.88.0`. Development uses 0.87.0 without modifying a globally installed Pi.

## Loading

Install the published package with `pi install npm:openmerit`. For development
from a checkout, load the source extension with:

```sh
./node_modules/.bin/pi --no-extensions -e ./packages/pi/src/index.ts
```

The isolation flag avoids duplicate `openmerit_complete_intent` and `openmerit_report_signal` registrations when npm `openmerit` is also installed in Pi's user settings.

Use `/openmerit doctor` to confirm that the adapter and intent executor are available.

Use `/openmerit logs` to locate the project-local audit stream, exporter failures, evidence manifests, and state while testing an end-to-end run.

On `session_start`, an interactive unconfigured project receives a bounded source preflight. In the unreleased source checkout, the adapter also repeats that bounded detection after a settled Pi turn. This lets Pi build an application from an empty directory and then receive an automatic `establish_evals` intent without requiring `/openmerit setup`. Durable active-intent state prevents duplicate setup nudges. Non-interactive runs do not attempt a confirmation flow.

If Pi exits while an intent is active, the unreleased adapter restores its completion tool and resends that same persisted intent on the next interactive session so the harness can continue it.

For configured projects with a confirmed application target, session start reports the available model catalogue and a scheduled tick. Application instrumentation reports idempotent completed-task and metric-window signals. OpenMerit evaluates the confirmed policy before issuing work. Published `openmerit@0.1.5` has no persistent Pi scheduler. In the unreleased source checkout on macOS, Pi can install a per-project user LaunchAgent after you confirm persistent execution and authorize infrastructure changes in the policy. It uses the selected authenticated Pi model, checks for due work locally every five minutes, and starts a headless Pi only when the due core check finds downstream harness work. If installation or background authentication fails, the adapter reports a scheduling gap. Other platforms still need an external scheduler.

The macOS background runner is not yet product-validated for candidate work. A local runner test verifies that an insufficient baseline is checked and recorded without starting Pi. An earlier live OpenRouter test reached the former due `run_assessment` intent and called Pi tools, but did not obtain a terminal result within the test window. A model-driven runner is capped at 15 minutes and records a nonzero exit and active intent ID on failure. Do not infer that unattended candidate discovery or swapping has passed end-to-end validation.

The adapter does not convert Pi's own provider usage into application metrics. Application-task signals must carry the application model, target ID, and durable evidence; application telemetry may include provider-reported USD cost, token counts, and wall-clock latency. If automatic setup is active when interactive input arrives, the input is queued and released after setup completes instead of racing the setup turn.

Pi also exposes `openmerit_report_signal` for verified `product_task_completed`, `metric_window_available`, and `verification_window_completed` events. Evals or observability work performed by Pi can submit measured application-target metric records through this typed ingress using stable signal IDs. For the unreleased core check, send cumulative metric windows with sample counts and evidence references. The background wakeup only checks whether a time-based action is due; it does not collect application results by itself. `/openmerit assess` checks those stored windows locally and starts candidate discovery only when all required metrics are ready.

## Intent delivery

The extension persists each intent as a custom Pi session entry, sends private extension-authored context with `display: false`, and triggers a follow-up Pi turn. The intent describes the outcome, constraints, evidence, task profile, and authorization boundary without prescribing Pi's method.

Pi must finish by calling `openmerit_complete_intent` exactly once. Success without evidence is rejected. Setup, assessment, and frontier intents receive additional structured-output checks. During setup, Pi first presents its inferred metrics and sampling plan to the user. The accepted task profile records how many representative cases and repetitions each metric needs and how results are aggregated; sample counts are kept separate from optional performance thresholds.

If Pi exits while an intent is active, the next session reports the recovered intent. Use `/openmerit cancel` to record an explicit cancellation before retrying; OpenMerit does not silently reinterpret interrupted work as success.

The extension replaces the completion tool definition whenever an intent becomes active. Its `outputs` property therefore exposes the canonical schema for that exact intent instead of untyped JSON. Pi validates the arguments before execution and requests provider-side JSON Schema constrained sampling when supported. OpenMerit validates the canonical schema and semantic rules again when accepting the result. The source checkout records the exact incumbent during setup, freezes accepted candidates after discovery, and carries accepted assessments and the experiment manifest into frontier calculation so these transitions do not rely on conversational memory.

## Model changes

The extension never treats Pi's model as the application target. After policy authorization, it sends a bounded, target-bound `apply_model_swap` intent. Pi performs the application-route change and returns configuration proof; the target ID must match the confirmed application LLM target, and Pi's own model must remain unchanged.

## Jev System One

Jev is not integrated into OpenMerit. If configured in Pi, the intent asks Pi to use harness-configured fast decision resources aggressively for bounded ranking, triage, and judgment. Credentials remain outside OpenMerit.

## Non-interactive modes

A harness must not attempt interactive confirmation in a mode without dialog-capable UI. It should return a waiting-for-user or failed result with an actionable reason.
