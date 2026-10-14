# Harness-neutral automation

The user defines cadence, thresholds, budget, scheduling mode, and automation permission. OpenMerit stores that policy, evaluates durable signals, and decides whether a bounded intent is due. A harness adapter arranges native wakeups and reports events. The coding harness performs the resulting intelligent work.

```text
User-confirmed policy
        ↓
OpenMerit due-check engine
        ↓
Harness-native wakeup or lifecycle hook
        ↓
Standard automation signal
        ↓
No work due, or one typed OpenMerit intent
```

## Check policy

`AutomationCheckPolicy` independently configures:

- baseline assessment cadence;
- frontier reassessment cadence and catalogue-change behavior;
- regression-check cadence and per-metric relative deterioration thresholds;
- post-swap verification windows;
- a cooldown between mature-system checks;
- active-session or persistent execution;
- whether wakeup provisioning may make infrastructure changes.

Task-count and elapsed-time triggers use OR semantics. A policy with `afterCompletedTasks: 100` and `afterElapsedSeconds: 604800` becomes due at the first threshold reached. A scheduled wakeup does not directly launch expensive work: it submits `scheduled_tick`, and OpenMerit evaluates policy and durable state before issuing an intent.

The baseline elapsed-time clock starts when setup or required instrumentation finishes. Ordinary task and metric signals do not restart that clock. OpenMerit retains the latest reported aggregate window for each application metric, including sample count and evidence references. It never sums possibly overlapping windows. At a due baseline check, core requires ready instrumentation and a finite measured value, enough samples, and an evidence reference for every required objective. An insufficient check records the gaps and waits for more data; sufficient evidence advances to candidate discovery.

## Signals

Adapters may report:

- `product_task_completed`;
- `metric_window_available`;
- `scheduled_tick`;
- `model_catalog_changed`;
- `verification_window_completed`.

Signal IDs are idempotency keys. OpenMerit persists a bounded history, does not count duplicate task completions twice, and keeps due work pending until an adapter successfully dispatches it.

## Capability negotiation

Every `HarnessDescriptor` declares supported signals, persistent scheduling, background execution, and whether wakeup provisioning is native, unavailable, or requires an infrastructure change. OpenMerit produces an `AutomationPlan` containing required signals, the next wakeup, scheduling strategy, and explicit gaps.

If persistent scheduling is requested but unsupported, the plan says `external_scheduler_required`. The adapter must not claim that a schedule exists. Active-session adapters can submit `scheduled_tick` when they start. An external scheduler may also wake a non-interactive harness and submit the same signal.

OpenMerit calls `scheduleWakeup` only when the confirmed policy requests persistent execution, the adapter declares persistent scheduling and background execution, and any infrastructure-changing provisioning has been authorized. Paid agents, system scheduler installation, and cloud infrastructure remain harness implementation details and authorization boundaries.

## Intent mapping

OpenMerit owns deterministic mapping from due conditions to intents:

| Due condition | Intent |
| --- | --- |
| Baseline cadence | Core checks stored baseline-window sufficiency; if ready, `discover_candidates` |
| Mature frontier cadence or changed catalogue | `discover_candidates` |
| Regression cadence or crossed metric threshold | `investigate_regression` |
| Completed post-swap window | `verify_model_swap` |

Subsequent lifecycle transitions continue through candidate trials, frontier calculation, supervised swap, verification, or rollback. The harness executes those intents; OpenMerit validates their structured result and evidence.

## Pi behavior

Pi reports catalogue and scheduled-tick signals on session start. Application instrumentation submits product-task, metric-window, and post-swap verification signals through its typed `openmerit_report_signal` tool; Pi's own settled-turn telemetry is not treated as product evidence.

On macOS, a confirmed policy with `execution.mode: "persistent"` and `infrastructureChangesAllowed: true` allows the Pi adapter to install a per-project user LaunchAgent. It uses the model selected in the interactive Pi session and checks that Pi authentication works without shell-only credentials. The agent checks local state every five minutes without calling a model. When a baseline check is due, the runner submits `scheduled_tick` directly to core: an insufficient result exits without starting Pi; a sufficient result starts Pi for candidate discovery. The Mac must be logged in; this is not a cloud service, an exact-time alarm, or a source of product metrics. Task-count and metric-window checks still depend on application signals.

Background candidate work remains experimental. A local runner test verifies that an insufficient baseline check needs no Pi process. Candidate discovery, comparison, and swapping from a background Pi run are not yet product-validated. A background Pi run is capped at 15 minutes and writes its exit code and any still-active intent ID to `.openmerit/scheduler-status.json`; an unfinished intent requires inspection and explicit recovery in Pi.

`/openmerit pause` persists the pause, unloads the project's LaunchAgent, and prevents automatic due decisions while still recording incoming signals. `/openmerit resume` clears the pause and restores an authorized schedule. Neither command cancels already-active work. A declined or failed scheduler installation is reported as a gap, not success. On other platforms, persistent policies still require an external scheduler.
