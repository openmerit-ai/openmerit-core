# Scheduling and benchmark refresh

A refresh job represents a previously measured task that may be checked again
against current routes. Jobs are stored under `jobs/` and indexed in
`benchmark-jobs.jsonl`; the job is owned by the harness session that created
the baseline.

Set a positive `benchmark_refresh_minutes` in policy to register jobs after an
eligible task completes. The harness integration checks due jobs while its session is
active and reports recommendations through Pi. Set it to `0` to disable
recurring refreshes.

When the harness is closed, use a user-owned scheduler such as cron, launchd, or CI:

```bash
openmerit refresh              # run all due jobs
openmerit refresh <job-id>     # run one job
openmerit benchmarks           # inspect benchmark and job counts
```

The CLI invokes the configured harness integration; it does not itself wake
Pi, maintain provider credentials, or swap a route in a closed application. A
harness can decide how an accepted recommendation becomes a config change, a
PR, or a deployment action.

Refreshes are deliberately opt-in and remain subject to current provider
availability, price metadata, budgets, evaluator configuration, and the
policy gate. Unknown-price routes and routes marked `preview`, `deprecated`,
or `retired` are not admitted as candidates.
