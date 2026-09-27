# Getting started

## Prerequisites

- Node.js 22.19 or newer.
- npm.
- Pi 0.87-compatible provider authentication.
- A product repository in which Pi can create and verify evaluation and observability artifacts.

OpenMerit does not require or accept an LLM provider credential. Provider access belongs to the coding harness.

## Install from npm

```sh
pi install npm:openmerit
pi list
```

Run `/openmerit doctor` inside Pi to confirm that the extension is available.

## Install from source

```sh
git clone https://github.com/laz-aslam/openmerit.git
cd openmerit
npm ci
```

Start Pi with the extension:

```sh
./node_modules/.bin/pi --no-extensions -e ./packages/pi/src/index.ts
```

`--no-extensions` prevents a globally installed npm copy from conflicting with the source extension. Run `/openmerit doctor` inside Pi to confirm that the adapter and intent executor are available.

## Establish a product profile

Open the product repository in interactive Pi with the extension loaded. If the project has no OpenMerit state, the Pi adapter performs a bounded source preflight. In the unreleased source checkout it also scans after a settled Pi build turn, so an application created from an initially empty directory can enter setup without a slash command. A repository without such a target remains idle; use `/openmerit setup` only to recover or configure a custom integration explicitly.

OpenMerit sends Pi a private, typed `establish_evals` intent. Pi must identify the application LLM call or shared route under evaluation and its exact incumbent application model. It inspects the application's outputs, tools, and failure modes to infer task-relevant metrics instead of asking you to invent them. Before running setup, Pi shows the proposed metrics, why each matters, the representative case and repetition counts, aggregation, any actual performance threshold, and estimated evaluation cost. You confirm or edit that plan together with the stable target ID, call sites, route key, budget, check cadence, scheduling mode, and automation permissions. Pi's own model is never an application target.

For an active-session demo, Pi defaults the baseline and post-swap verification cadence to one completed evaluation task unless you change it. OpenMerit rejects empty baseline or post-swap cadences.

In this source checkout (not yet published in npm `openmerit@0.1.5`), Pi is also asked to research preliminary model leads during setup. Each reported lead has a current price estimate and reputation summary with sources and check times. OpenMerit stores these leads with the project profile. The field is optional for compatibility with existing protocol-0.1 harnesses, and an empty list means no credible leads were found. It does not change the application model or count as a measurement.

OpenMerit rejects successful setup without a confirmed task profile, at least one valid objective with an explicit sampling plan, a supervised-graduation policy, non-empty baseline and post-swap cadences, a budget, and evidence.

The source checkout's setup instruction asks Pi to run the application path with working provider authentication, execute each required collector and grader, inspect the resulting metric values, and retain verification artifacts. A metric that cannot be produced must be marked missing. This smoke run verifies the pipeline; it is not counted as a production baseline sample. OpenMerit still checks the reported coverage and evidence references, not the authenticity of a grader run itself.

## Collect the baseline

After setup, instrument the confirmed application target and use the product normally. Report application-task completions and cumulative metric windows through Pi's typed signal tool, including the application model where applicable, sample counts, and durable evidence. Pi's own model, tokens, cost, and latency are orchestration telemetry and do not satisfy product metrics. In the unreleased source checkout, OpenMerit core checks the stored baseline windows at the approved cadence without calling Pi; missing evidence stays insufficient. Published `openmerit@0.1.5` still nudges Pi to assess.

## Find the frontier

When the baseline meets every required metric threshold, OpenMerit issues the next approved nudges: discover candidates, run controlled challenger trials, and calculate the Pareto frontier. Pi performs that work. OpenMerit checks the returned result against the [Pareto specification](pareto-spec.md).

Candidate discovery uses current price, capability, availability, reputation, and benchmark signals to shortlist models worth testing. These are starting clues, not evidence that a model performs well on your application. In npm `openmerit@0.1.5`, the shortlist comes after the application's baseline has enough evidence. The unreleased source checkout collects preliminary leads at setup, then refreshes them, probes availability, and freezes the incumbent plus challengers. Pi must use the same cases, application revision, prompt, tools, grader, and run count, with a recorded shuffle seed. It preserves one experiment manifest and reports measured quality, cost, latency, tokens, and other required metrics. OpenMerit durably carries the accepted candidate set and assessments into later intents rather than relying on Pi conversation history. A model proposal must come from the verified frontier of those measured candidate results, not from price or reputation alone.

## Approve an early swap

With automatic swaps disabled, a model proposal that passes frontier validation waits for `/openmerit approve`. That authorizes Pi to apply only the proposed change. OpenMerit then requires post-swap evaluation; the approved policy determines rollback behavior. Automatic swaps may bypass per-proposal approval when enabled and the configured verified-swap threshold is reached, including when that threshold is zero.

Continue with [your first supervised trial](first-trial.md) for a practical walkthrough.
