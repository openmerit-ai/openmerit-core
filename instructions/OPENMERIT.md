# OpenMerit — Model Merit Harness

You are running under a main agent harness that is observed by **OpenMerit**, an
external merit harness. OpenMerit's job is to make sure you are always running on
the best model for the task at hand, at the best price, with a vetted fallback.

## What OpenMerit does

1. **Observes** this harness's session traces (models used, tokens, cost,
   latency, errors) without intercepting or slowing down your work.
2. **Evaluates** candidate models for each completed text or image task sequentially
   through pi and scores their outputs with a judge model.
3. **Maintains a pareto frontier** per task (quality vs. cost vs. latency) and
   an aggregate frontier across all of your tasks.
4. **Watches for new model releases** (provider catalogs + public benchmarks)
   and queues promising releases for trial against your existing frontier.
5. **Recommends or applies model swaps**, with reasoning, and keeps your
   fallback model up to date.

## What you should do

- **Treat model changes as explicit routing decisions.** If you notice your
  model identity change, it was approved by the user or passed their opt-in
  auto-apply policy. Continue the task; your instructions and context are
  unchanged.
- **Respect the fallback.** If your current model errors, rate-limits, or is
  retired, OpenMerit can offer the current fallback or apply it under an
  opt-in automatic policy. Treat an approved fallback as normal operation.
- **State your task clearly in your first message** of a session when possible.
  OpenMerit keys its pareto frontier to task signatures; clear task statements
  produce better model choices for you.
- **Do not edit OpenMerit state files** (`~/.openmerit/`). If something looks
  wrong, tell the user.

## What you can ask the user for

- `/openmerit` — show current model, fallback, frontier position, and pending
  recommendations.
- `/openmerit apply` / `/openmerit dismiss` — act on a pending recommendation
  when automatic application is declined by the policy gate.
- Policy changes (auto-apply thresholds, budgets, provider allow-lists) are
  made by the user in `~/.openmerit/policy.json`, not by you.

## Guarantees

- Per-task comparisons send the task text, uploaded images (when present), and
  candidate answers through pi/OpenRouter for model runs and judging. Use
  non-sensitive examples while evaluating this alpha.
- The shipped policy is supervised. Swaps happen automatically only after the
  user opts in and the configured quality/cost guardrails pass; otherwise they
  remain recommendations for a human to approve.
