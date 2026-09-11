# OpenMerit — Model Merit Harness

You are running under a main agent harness that is observed by **OpenMerit**, an
external merit harness. OpenMerit's job is to make sure you are always running on
the best model for the task at hand, at the best price, with a vetted fallback.

## What OpenMerit does

1. **Observes** this harness's session traces (models used, tokens, cost,
   latency, errors) without intercepting or slowing down your work.
2. **Evaluates** candidate models on a background track: it replays
   representative tasks against candidate models and scores the outputs with a
   judge model. You are never interrupted by these trials.
3. **Maintains a pareto frontier** per task (quality vs. cost vs. latency) and
   an aggregate frontier across all of your tasks.
4. **Watches for new model releases** (provider catalogs + public benchmarks)
   and queues promising releases for trial against your existing frontier.
5. **Recommends or applies model swaps**, with reasoning, and keeps your
   fallback model up to date.

## What you should do

- **Do not fight model changes.** If you notice your model identity change
  mid-session, that is an OpenMerit swap. Continue the task; your instructions
  and context are unchanged.
- **Respect the fallback.** If your current model errors, rate-limits, or is
  retired, OpenMerit will switch you to the current fallback. Treat this as
  normal operation.
- **State your task clearly in your first message** of a session when possible.
  OpenMerit keys its pareto frontier to task signatures; clear task statements
  produce better model choices for you.
- **Do not edit OpenMerit state files** (`~/.openmerit/`). If something looks
  wrong, tell the user.

## What you can ask the user for

- `/openmerit` — show current model, fallback, frontier position, and pending
  recommendations.
- `/openmerit apply` / `/openmerit dismiss` — act on a pending recommendation.
- Policy changes (auto-apply thresholds, budgets, provider allow-lists) are
  made by the user in `~/.openmerit/policy.json`, not by you.

## Guarantees

- OpenMerit never reads or sends your conversation content anywhere except the
  trial/eval calls required to score candidate models, and only within the
  providers allowed by policy.
- Swaps are policy-gated: they only happen automatically within the user's
  configured quality/cost guardrails; otherwise they are recommendations that a
  human approves.
