# Improvement lifecycle

## Stages

1. **Unconfigured** — no confirmed profile exists.
2. **Establishing evidence** — Pi creates and verifies evals and observability.
3. **Collecting baseline** — normal product work accumulates evidence.
4. **Baseline ready** — Pi establishes sufficiency for every required objective.
5. **Discovering candidates** — Pi researches credible candidates within budget.
6. **Running challenger trials** — Pi runs comparable controlled trials.
7. **Calculating frontier** — Pi calculates and explains the Pareto frontier.
8. **Frontier ready** — OpenMerit verifies the returned snapshot.
9. **Approval or swap** — policy decides whether confirmation is required.
10. **Verifying swap** — every applied change receives post-swap evaluation.
11. **Monitoring** — production evidence continues to accumulate.
12. **Rollback** — a covered regression restores the prior verified route.

## Event-driven nudges

OpenMerit remains quiet when no action is justified. On first interactive entry to an unconfigured product, it automatically nudges Pi to establish the user-confirmed profile, evals, observability, check policy, and automation permission. Later nudges become due when durable harness signals satisfy the configured task-count or elapsed-time cadence, a metric crosses a regression threshold, the model catalogue changes under an enabled policy, a post-swap window completes, an intent enables the next stage, rollback policy covers a regression, or the user invokes a command.

Every signal has an idempotency key. A due intent is persisted before dispatch so duplicate webhooks, restarts, and retrying adapters do not double-count tasks or silently lose pending work.

## Evaluation budget

Candidate work can cost money but is bounded by the confirmed policy. The contract can constrain currency, spend, candidate count, runs per candidate, and expiration. Pi decides how to work within those limits and must return evidence.

## Supervised graduation

Early proposals wait for `/openmerit approve`. A policy may enable bounded automatic swaps only after the configured number of verified swaps. Post-swap verification remains mandatory.
