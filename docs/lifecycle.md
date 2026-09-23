# Improvement lifecycle

## Stages

1. **Unconfigured** — no confirmed profile exists.
2. **Establishing evidence** — Pi creates and verifies evals and observability. In the unreleased source checkout, setup can also record sourced preliminary price and reputation leads; published `openmerit@0.1.5` does not yet do this.
3. **Collecting baseline** — normal product work accumulates evidence.
4. **Baseline ready** — in the unreleased source checkout, OpenMerit core checks stored application metric windows against every required objective and its sample threshold. Pi still authors graders and collectors and reports the measurements.
5. **Discovering candidates** — Pi researches credible candidates within budget, refreshing any preliminary setup leads and considering new ones. This stage still follows baseline sufficiency.
6. **Running challenger trials** — Pi runs comparable controlled trials.
7. **Calculating frontier** — Pi calculates and explains the Pareto frontier.
8. **Frontier ready** — OpenMerit verifies the returned snapshot.
9. **Approval or swap** — policy decides whether confirmation is required.
10. **Verifying swap** — the harness is asked to evaluate the applied change.
11. **Monitoring** — production evidence continues to accumulate.
12. **Rollback** — the harness is asked to restore the prior configuration when regression policy permits it.

## Event-driven nudges

OpenMerit remains quiet when no action is justified. On first interactive entry to an unconfigured project, the Pi adapter performs a bounded source preflight and automatically nudges Pi to establish the profile only when an application LLM call pattern is detected. A project without a detected target remains idle until `/openmerit setup` is invoked. Later nudges become due when durable application-target signals satisfy the configured task-count or elapsed-time cadence, a metric crosses a regression threshold, the model catalogue changes under an enabled policy, a post-swap window completes, an intent enables the next stage, rollback policy covers a regression, or the user invokes a command.

Every signal has an idempotency key. A due intent is persisted before dispatch so duplicate webhooks, restarts, and retrying adapters do not double-count tasks or silently lose pending work.

## Evaluation budget

Candidate work can cost money. The contract passes the confirmed currency, spend, candidate count, runs per candidate, and expiration constraints to Pi. The harness is responsible for staying within those limits; OpenMerit does not independently meter spending or cut off provider requests. See [budgets and permissions](budgets.md).

## Supervised graduation

Proposals wait for `/openmerit approve` unless automatic swaps are enabled and the configured number of verified swaps has been reached. That number can be zero. Post-swap evaluation remains part of the workflow and depends on the harness reporting its results. A reported post-swap regression can trigger a rollback request when policy permits it.
