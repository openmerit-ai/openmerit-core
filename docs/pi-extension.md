# Pi extension

## Supported version

The adapter targets Pi 0.87 and declares `>=0.87.0 <0.88.0`. Development uses 0.87.0 without modifying a globally installed Pi.

## Loading

Install the published package with `pi install npm:openmerit`. For development
from a checkout, load the source extension with:

```sh
./node_modules/.bin/pi -e ./packages/pi/src/index.ts
```

Use `/openmerit doctor` to confirm that the adapter and intent executor are available.

Use `/openmerit logs` to locate the project-local audit stream, exporter failures, evidence manifests, and state while testing an end-to-end run.

On `session_start`, an interactive unconfigured project receives a bounded source preflight. The adapter automatically issues one `establish_evals` intent only when it detects an actual application LLM call pattern; otherwise it stays idle and reports that `/openmerit setup` is available for custom integrations. Durable active-intent state prevents the setup nudge from being reissued on every session. Non-interactive runs do not attempt a confirmation flow.

For configured projects with a confirmed application target, session start reports the available model catalogue and a scheduled tick. Application instrumentation reports idempotent completed-task and metric-window signals. OpenMerit evaluates the confirmed policy before issuing work. Pi currently declares no persistent scheduling or background execution, so persistent policies require an external scheduler to start Pi; the adapter reports that gap explicitly.

The adapter does not convert Pi's own provider usage into application metrics. Application-task signals must carry the application model, target ID, and durable evidence; application telemetry may include provider-reported USD cost, token counts, and wall-clock latency. If automatic setup is active when interactive input arrives, the input is queued and released after setup completes instead of racing the setup turn.

Pi also exposes `openmerit_report_signal` for verified `product_task_completed`, `metric_window_available`, and `verification_window_completed` events. Evals or observability work performed by Pi can submit measured application-target metric records through this typed ingress using stable signal IDs. This does not create a background scheduler; it gives the active harness a validated way to connect the infrastructure it built to OpenMerit's due-check engine.

## Intent delivery

The extension persists each intent as a custom Pi session entry, sends private extension-authored context with `display: false`, and triggers a follow-up Pi turn. The intent describes the outcome, constraints, evidence, task profile, and authorization boundary without prescribing Pi's method.

Pi must finish by calling `openmerit_complete_intent` exactly once. Success without evidence is rejected. Setup, assessment, and frontier intents receive additional structured-output checks.

If Pi exits while an intent is active, the next session reports the recovered intent. Use `/openmerit cancel` to record an explicit cancellation before retrying; OpenMerit does not silently reinterpret interrupted work as success.

The extension replaces the completion tool definition whenever an intent becomes active. Its `outputs` property therefore exposes the canonical schema for that exact intent instead of untyped JSON. Pi validates the arguments before execution and requests provider-side JSON Schema constrained sampling when supported. OpenMerit validates the canonical schema and semantic rules again when accepting the result.

## Model changes

The extension never treats Pi's model as the application target. After policy authorization, it sends a bounded, target-bound `apply_model_swap` intent. Pi performs the application-route change and returns configuration proof; the target ID must match the confirmed application LLM target, and Pi's own model must remain unchanged.

## Jev System One

Jev is not integrated into OpenMerit. If configured in Pi, the intent asks Pi to use harness-configured fast decision resources aggressively for bounded ranking, triage, and judgment. Credentials remain outside OpenMerit.

## Non-interactive modes

A harness must not attempt interactive confirmation in a mode without dialog-capable UI. It should return a waiting-for-user or failed result with an actionable reason.
