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
./node_modules/.bin/pi -e ./packages/pi/src/index.ts
```

Run `/openmerit doctor` inside Pi to confirm that the adapter and intent executor are available.

## Establish a product profile

Open the product repository in interactive Pi with the extension loaded. If the project has no OpenMerit state, the Pi adapter performs a bounded source preflight. Setup begins automatically only when it detects an actual application LLM call pattern. A repository without such a target remains idle; use `/openmerit setup` to inspect and configure a custom integration explicitly.

OpenMerit sends Pi a private, typed `establish_evals` intent. Pi must identify the application LLM call or shared route under evaluation and ask you to confirm its stable target ID, call sites, and route key. It then understands the product task, infers objectives, asks you to confirm requirements, an evaluation budget, check cadence, thresholds, scheduling mode, and automation permissions, creates and verifies the necessary infrastructure, and completes the intent with durable evidence. Pi's own model is never an application target.

OpenMerit rejects successful setup without a confirmed task profile, at least one valid objective, a supervised-graduation policy, a budget, and evidence.

## Collect the baseline

After setup, instrument the confirmed application target and use the product normally. Report application-task completions and metric windows through Pi's typed signal tool, including the application model and durable evidence. Pi's own model, tokens, cost, and latency are orchestration telemetry and do not satisfy product metrics. At the required sample threshold, OpenMerit nudges Pi to assess the baseline. Missing evidence is not treated as zero or failure.

## Find the frontier

When Pi reports a sufficient baseline, OpenMerit issues the next approved nudges: discover candidates, run controlled challenger trials, and calculate the Pareto frontier. Pi performs the work. OpenMerit checks the returned result against the [Pareto specification](pareto-spec.md).

## Approve an early swap

With automatic swaps disabled, a model proposal that passes frontier validation waits for `/openmerit approve`. That authorizes Pi to apply only the proposed change. OpenMerit then requires post-swap evaluation; the approved policy determines rollback behavior. Automatic swaps may bypass per-proposal approval when enabled and the configured verified-swap threshold is reached, including when that threshold is zero.

Continue with [your first supervised trial](first-trial.md) for a practical walkthrough.
