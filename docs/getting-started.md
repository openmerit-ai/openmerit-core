# Getting started

## Prerequisites

- Node.js 22.18 or newer.
- npm.
- Pi 0.87-compatible provider authentication.
- A product repository in which Pi can create and verify evaluation and observability artifacts.

OpenMerit does not require or accept an LLM provider credential. Provider access belongs to the coding harness.

## Install from source

```sh
git clone https://github.com/laz-aslam/openmerit.git
cd openmerit
npm install
```

Start Pi with the extension:

```sh
./node_modules/.bin/pi -e ./packages/pi/src/index.ts
```

Run `/openmerit doctor` inside Pi to confirm that the adapter and intent executor are available.

## Establish a product profile

Open the product repository in interactive Pi with the extension loaded. If the project has no OpenMerit state, setup begins automatically. `/openmerit setup` is only needed to explicitly rerun or recover setup.

OpenMerit sends Pi a private, typed `establish_evals` intent. Pi must understand the product task, infer objectives, ask the user to confirm requirements, an evaluation budget, check cadence, thresholds, scheduling mode, and automation permissions, create and verify the necessary infrastructure, and complete the intent with durable evidence.

OpenMerit rejects successful setup without a confirmed task profile, at least one valid objective, a supervised-graduation policy, a budget, and evidence.

## Collect the baseline

After setup, use Pi normally. OpenMerit records completed-task checkpoints without treating its own orchestration turn as product evidence. At the required sample threshold, OpenMerit nudges Pi to assess the baseline. Missing evidence is not treated as zero or failure.

## Find the frontier

When Pi reports a sufficient baseline, OpenMerit issues the next approved nudges: discover candidates, run controlled challenger trials, and calculate the Pareto frontier. Pi performs the work. OpenMerit checks the returned result against the [Pareto specification](pareto-spec.md).

## Approve an early swap

During supervised graduation, a verified model proposal pauses for `/openmerit approve`. That authorizes Pi to apply only the proposed change. OpenMerit then requires post-swap verification; the approved policy determines rollback behavior.
