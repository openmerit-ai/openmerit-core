# Your first supervised trial

Use one representative product task to learn whether OpenMerit and your harness can collect useful evidence. This guide describes a trial to perform; it does not claim that a trial has already succeeded for your product.

## Choose a bounded task

Pick a task with outcomes you can inspect, such as extracting fields from a document, answering questions over a known collection, or completing a repeatable coding task. Identify the current model configuration so it can be restored if a challenger regresses.

Choose examples that resemble actual use, including difficult cases. A single successful example cannot establish a success rate or reliability claim.

## Confirm the setup

Complete [installation](getting-started.md) and open the product repository in an interactive Pi session. During setup, confirm:

- the required quality, cost, latency, and other metrics;
- the sample requirements and unacceptable outcomes;
- the evaluation budget and any candidate or run limits;
- when reassessments and post-swap checks should happen;
- whether model changes or rollback may happen automatically.

For a supervised first trial, leave automatic swaps disabled. A zero graduation threshold can allow an immediate automatic swap if automation is enabled. Review [budgets and permissions](budgets.md) before confirming.

## Inspect the evaluations

Ask Pi to show the evaluation artifacts and instrumentation it created, explain what they measure, and demonstrate a representative run. Check that all required metrics have a source and that evaluation data is appropriate to send to the configured providers.

```text
/openmerit status
/openmerit logs
```

These commands help locate readiness and evidence. They do not independently certify that an evaluation is correct. Inspect the artifacts and measurements themselves.

## Collect and compare

Use the product normally while its evaluations collect representative measurements. OpenMerit also records completed-work checkpoints; these checkpoints alone do not establish product quality.

In the unreleased source checkout, OpenMerit core checks baseline sufficiency from reported metric windows; when they pass, it asks Pi to discover candidates, run challenger trials, and calculate a comparison. Published `openmerit@0.1.5` still asks Pi to assess the baseline. You can request a check explicitly:

```text
/openmerit assess
```

Review the candidate results, sample counts, costs, and unresolved measurements. A missing metric is a reason to gather evidence, not to assume a model passed or failed.

## Approve and verify a change

If a proposal passes the comparison checks and you want to try it, approve the specific proposal:

```text
/openmerit approve
```

The harness applies the change. Allow the configured post-swap evaluation window to complete and inspect its results. If a regression is reported, the workflow can request rollback when your policy permits it. Ask Pi to demonstrate that the previous configuration can be restored.

## Decide what to trust next

Keep the trial’s artifacts and audit trail. Before enabling automatic changes, confirm that your evaluations detect meaningful failures, provider costs are visible, and post-swap verification and rollback work for this task.

Pi does not wake itself while closed. Version 0.1.5 also has a [partial pause limitation](roadmap.md#known-limitations). Plan supervision around those behaviors.
