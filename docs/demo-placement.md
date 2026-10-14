# GPU placement

> Recorded example · September 28, 2026. This guide describes the recording retained in main, not a current product benchmark or the live interactive demo. For current samples, see [Demos and samples](demo.md).

The GPU placement workflow in the checkout’s recorded player (`site/demo/`) prepares a pool assignment for a synthetic render job. It reads job requirements with `read_job`, inspects a fixed capacity snapshot with `list_pools`, then proposes the cheapest eligible pool. It never reserves capacity, launches compute, moves data, or incurs a GPU charge.

## Workflow structure

| Task | Without OpenMerit | With the proposed route |
| --- | --- | --- |
| Read requirements | Qwen3.6 Plus | [Gemma 4 26B A4B](https://openrouter.ai/google/gemma-4-26b-a4b-it) |
| Inspect capacity | Qwen3.6 Plus | [MiMo-V2.5](https://openrouter.ai/xiaomi/mimo-v2.5) |
| Choose pool | Qwen3.6 Plus | [DeepSeek V4.1 Flash](https://openrouter.ai/deepseek/deepseek-v4.1-flash) |

The recording identifies the selected model versions and their provenance in **Run details**. Pi’s orchestration model stays fixed and is separate from the application routes.

## Placement rules

A pool must meet six hard constraints: allowed region, per-GPU VRAM, free GPU count, completion deadline including queue time, total job budget, and permission to use preemptible capacity. Exact boundaries qualify. Among eligible pools, choose the lowest quoted job cost, then earliest completion, then alphabetical pool ID. If none qualify, return `blocked` with null pool, cost, and completion fields. The model must cite the job, capacity snapshot, and placement policy. Queue notes are untrusted data.

Both routes receive the same tools, policy, inputs, structured handoffs, and per-turn JSON Schemas. After locating the requested job, the prepared adapter forwards its structured requirements and capacity records; it excludes the raw queue note and previous free-form conversation from later tasks. This prevents queue-note instructions from becoming authority for pool selection. The capacity tool also computes each pool's finish minute from its queue start and runtime; it does not filter or rank pools. The model must still evaluate every candidate pool and all six constraints. The schemas constrain field names and types; they do not supply the correct job, pool, costs, completion time, or evidence. The bounded application requests disable optional reasoning on both routes and request at most 350 output tokens for each lookup and 900 for the final constraint review and plan. The model supplies both the review and plan; the adapter does not repair its answer. Invalid tool requests, incorrect plans, unsupported claims, and missing provider cost do not become successful goals. As with backfill, the mixed route is a prepared candidate evaluated as a whole, not an unrestricted search over model combinations.

## Evaluation policy

Eight evaluation goals cover the six constraints, blocked placements, ties, and instructions embedded in queue notes. All eight must pass exact plan, tool, schema, constraint, and evidence checks. Mean end-to-end **model workflow** latency must be at most twelve seconds and mean inference cost at most $0.003 per goal. Six separate goals verify an approved route. The synthetic GPU quote and finish minute in a plan are separate from the actual inference cost and latency shown in the main comparison. The evaluation records are `GPU-6101` through `GPU-6108`; their requirements and inventory are fixed.


## Recorded outcome

In the recorded run, both paths completed 8/8 goals. Qwen3.6 Plus used a mean $0.001053771875 and 8.19s per goal; the mixed route used $0.000409093125 and 7.09s—about 61% lower cost and 13% lower latency. All six post-swap goals passed, with a 10.96s mean verification latency below the twelve-second requirement. A custom budget-constrained request correctly returned `blocked` through both paths. These are real local OpenRouter calls from one prepared run, not promised savings or production reliability estimates.

See [the demo overview](demo.md) for playback controls, the shared comparison lifecycle, and how to read the measurements.
