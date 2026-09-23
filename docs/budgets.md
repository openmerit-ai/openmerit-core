# Budgets and permissions

Setup asks you to confirm the limits and permissions for evaluation work. OpenMerit stores the policy and passes its constraints to the harness.

## Evaluation costs

OpenMerit is MIT-licensed, free to install, and has no OpenMerit subscription. Model-provider charges still apply to setup, assessments, challenger trials, and verification. Paid tools, telemetry, or infrastructure used by your harness may add costs. Application-provider cost for ordinary product tasks can be reported separately as production evidence; Pi's own orchestration usage is not application cost and is not charged to the challenger-evaluation budget.

## Budget fields

| Field | Meaning |
| --- | --- |
| `currency` | Currency for the evaluation budget. |
| `maximumSpend` | Spending limit the harness is instructed to respect. |
| `maximumCandidateCount` | Optional limit on candidate count. |
| `maximumRunsPerCandidate` | Optional limit on runs per candidate. |
| `expiresAt` | Optional expiration for the evaluation budget. |

In the unreleased development version, OpenMerit keeps a separate ledger for controlled challenger trials. Each challenger intent receives the amount already spent and the remaining allowance. Challenger results that exceed the approved limit are rejected, and another challenger intent cannot start after the limit is exhausted. Provider-side spending controls remain the strongest protection against a request that exceeds its estimate while it is running.

Setup, baseline product work, assessments, and swap verification remain visible costs, but do not consume `evaluationBudget.maximumSpend`. This separation prevents normal product usage from silently exhausting the allowance reserved for comparing challengers.

## Model changes

OpenMerit normally waits for `/openmerit approve` before issuing a swap request. It can request an automatic swap when `automaticSwapsEnabled` is true and `confirmationRequiredUntilVerifiedSwaps` has been reached. That threshold may be zero.

Post-swap evaluation remains part of the workflow. The harness performs the change and reports whether it passed evaluation. `rollbackOnRegression` determines whether a reported post-swap regression can trigger a rollback request.

## Infrastructure changes

Persistent scheduling is a separate permission. An adapter that provisions infrastructure must declare that capability, and the confirmed check policy must allow infrastructure changes before OpenMerit asks it to provision a wakeup.

The current Pi adapter does not provide persistent scheduling or background execution. An external scheduler is needed to start Pi for unattended checks. See [automatic checks](automation.md).

## What a policy can establish

OpenMerit uses policy and lifecycle state to decide which requests to issue, then checks the results returned by the harness. It is not a sandbox around the harness’s tools or provider access. See [security](security.md) for the responsibility boundary.
