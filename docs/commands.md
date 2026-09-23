# Commands

Run these slash commands inside Pi with the OpenMerit extension loaded. Shell commands such as `pi install` run in your terminal instead.

## Inspect status

```text
/openmerit
/openmerit status
```

Both show the task profile, metric readiness, evaluation status, active work, next assessment, lifecycle stage, and pause flag. A readiness label is based on the harness’s structured reports; inspect the evidence for the underlying measurements.

## Start or recover setup

```text
/openmerit setup
```

Request setup explicitly when recovering or rerunning it. An unconfigured project normally starts setup automatically in an interactive Pi session. OpenMerit refuses another intent while work is active.

## Request an assessment

```text
/openmerit assess
```

Ask the harness to assess baseline evidence now. This does not create missing measurements or override sample requirements.

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

In 0.1.5, pause suppresses some lifecycle follow-ups, but task, measurement, and session-start signals can still start due checks. The flag resets on process restart and does not cancel active work. Explicit commands still work. Do not treat “paused” as a guarantee that all OpenMerit work has stopped.

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
