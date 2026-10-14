# Commands

The standalone `openmerit dash` command runs in your shell. The `/openmerit` slash commands run inside Pi with the extension loaded.

## Inference Terminal

Install with `npm install -g openmerit` to use `openmerit dash [path]` for a passive local view of models, connections, usage, and compute. From this checkout, use `npm run dash -- [path]`. It is independent of Pi setup and does not run model comparisons or inference.

See the [Inference Terminal guide](inference-terminal.md) for local installation, automatic discovery, `--no-discovery`, `--json`, `--demo`, collection intervals, and data limitations. Discovery is part of `dash` and is scoped to application evidence. Coding-harness histories are not collected.

## Inspect status

```text
/openmerit
/openmerit status
```

Both show the task profile, metric readiness, evaluation status, active work, next assessment, lifecycle stage, incumbent candidate, candidate and assessment counts, challenger spend, proposed candidate, and pause flag. A readiness label is based on the harness’s structured reports; inspect the evidence for the underlying measurements.

## Start or recover setup

```text
/openmerit setup
```

Requests setup explicitly or reopens setup to correct stale target/incumbent state. Accepted replacement setup clears prior candidate, assessment, frontier, and baseline handoffs while retaining the audit log.

Request setup explicitly only when recovering, rerunning, or configuring a custom integration. An unconfigured project starts setup when bounded source detection finds an application LLM call at session start or after a settled Pi build turn. OpenMerit refuses another intent while work is active.

## Cancel interrupted work

```text
/openmerit cancel
```

Record the active intent as cancelled after an interrupted or abandoned harness run. This clears durable active-work state without claiming success and releases any interactive request that was queued behind setup.

## Request an assessment

```text
/openmerit assess
```

Ask OpenMerit core to check stored baseline metric windows now. It reports missing or immature required metrics without starting Pi, or starts candidate discovery when they pass. It does not create missing measurements or override sample requirements.

## Request a frontier

```text
/openmerit frontier
```

Ask the harness to calculate a model comparison now. OpenMerit validates the returned frontier against the confirmed profile and supplied assessments. The command does not itself authorize a model change.

## Approve a proposal

```text
/openmerit approve
```

Approve the current proposal after its frontier result has passed validation. If there is no proposal in the expected lifecycle stage, the command reports that no verified proposal is awaiting approval. See [comparisons and swaps](lifecycle.md) for automatic-swap policy.

## Pause and resume

```text
/openmerit pause
/openmerit resume
```

Pause is persisted in `.openmerit/state.json`, blocks automatic due decisions and lifecycle follow-ups, and unloads the project's managed macOS LaunchAgent. Incoming signals can still be recorded. Resume clears pause and restores scheduling only when the confirmed policy authorizes it. Neither command cancels an already-active intent; explicit commands remain available. The standalone Inference Terminal is independent and keeps collecting until its CLI process exits.

## Locate logs and evidence

```text
/openmerit logs
```

Show the local audit, exporter-error, evidence-manifest, and state paths. See [project files and logs](operations.md) for their contents.

## Check the installation

```text
/openmerit doctor
```

Show adapter diagnostics, UI availability, and scheduling support. This checks extension wiring; it does not prove provider authentication, successful evaluations, or a completed model swap.
