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
| Baseline cadence | `run_assessment` |
| Mature frontier cadence or changed catalogue | `discover_candidates` |
| Regression cadence or crossed metric threshold | `investigate_regression` |
| Completed post-swap window | `verify_model_swap` |

Subsequent lifecycle transitions continue through candidate trials, frontier calculation, supervised swap, verification, or rollback. The harness executes those intents; OpenMerit validates their structured result and evidence.

## Pi behavior

Pi reports catalogue and scheduled-tick signals on session start. Application instrumentation submits product-task, metric-window, and post-swap verification signals through its typed `openmerit_report_signal` tool; Pi's own settled-turn telemetry is not treated as product evidence. Pi cannot currently provision persistent background wakeups, so its descriptor says so. A persistent policy therefore produces an external-scheduler gap instead of a false success claim. A Pi-compatible scheduler can start Pi non-interactively; Pi then submits the tick and OpenMerit decides whether work is due.
