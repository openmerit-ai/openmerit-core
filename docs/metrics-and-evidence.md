# Metrics and evidence

## Task-specific profiles

The full catalogue is available to every product, but a confirmed task profile selects required metrics, direction, minimum sample count, tolerance, and optional hard constraints.

## Initial metric catalogue

Quality and behavior: task quality, task success, consistency, instruction following, tool-use performance, structured-output reliability, hallucination rate, reasoning efficiency, recovery ability, context handling, retrieval-use quality, long-horizon performance, and preference fit.

Cost and resources: input tokens, output tokens, total task cost, cost per successful task, and agent steps.

Latency and operations: time to first useful output, end-to-end latency, throughput, retry rate, and human-intervention rate.

## Metric states

- `measured` — numeric value and evidence exist.
- `not_applicable` — the metric does not apply.
- `not_configured` — collection or evaluation is missing.
- `insufficient_evidence` — relevant, but without enough representative samples.

Missing measurements are never converted to zero.

## Single and repeated runs

A single execution can report its cost, latency, token use, steps, success, and evaluator score. Distribution and reliability claims require repeated runs: rates, consistency, variance, averages, percentiles, throughput, prompt sensitivity, and regression stability.

Two forms of repetition may be needed: repeat the same input to measure stochastic variance, and run representative task instances to measure general task performance.

The task profile sets the minimum sample count for each required metric; there is no universal number of runs. A completed-task signal can advance an assessment cadence, but it does not by itself supply a quality score. Quality requires a task-specific evaluator, known outcome, or other justified measurement. Cost, token use, and latency must come from the application call or its observability layer. The baseline and controlled challenger runs supply the measured evidence used for comparison. Catalogue price and model reputation help the harness choose candidates to test; they are not substitutes for these measurements. In the unreleased source checkout, preliminary setup leads are stored separately from metric records and passed to later candidate discovery; published `openmerit@0.1.5` does not store them during setup.

In the unreleased source checkout, each `metric_window_available` signal replaces the stored aggregate window for that metric. Send a cumulative, application-run window with its sample count and evidence reference; OpenMerit does not add separate or overlapping window counts. Core marks the baseline ready only when instrumentation is ready and every required metric has a finite measured value, the confirmed minimum sample count, and an evidence reference. The harness remains responsible for measuring the real application call and authenticating those references; a reported window is not independently re-run or verified by core.

## Evidence references

Results point to durable evidence rather than embedding arbitrary traces. Sources include harness traces, evaluation artifacts, observability records, external sources, and user feedback. References may contain a URI, media type, and digest. Successful intents require evidence; frontier certification also requires calculation evidence and exact assessment IDs.

## Readiness contract

Setup must return an explicit observability coverage report containing every required metric, which metrics are covered, which remain missing, and when the check occurred. OpenMerit derives readiness from those sets; a harness cannot label coverage `ready` while a required metric is absent.

If setup reports a required gap, OpenMerit issues `instrument_observability`. A successful instrumentation result is accepted only when every required metric is reported as covered. The unreleased source checkout explicitly asks Pi to exercise each collector and grader through the application path, inspect output values, and retain artifacts. OpenMerit validates the coverage report but does not independently run the collector or grader, so `ready` is still a harness claim rather than independently verified end-to-end proof. Request a reported production metric window before relying on it for model decisions.

Product instrumentation and OpenMerit auditing are separate. The confirmed application LLM target emits measurements such as quality, success, tokens, cost, latency, retries, tool calls, and intervention. Every metric record carries that target ID. OpenMerit records the signals, policy decision, intent lifecycle, evidence identifiers, and readiness or frontier decision that followed.

Pi's own assistant messages are orchestration data, not application evidence. Application provider cost, input and output tokens, and end-to-end task latency must come from the confirmed application call or its observability layer. Tool-use performance requires harness-trace evidence; code coverage alone is not evidence of tool-use quality. Quality and task-specific behavior can still come from verified project evaluators.
