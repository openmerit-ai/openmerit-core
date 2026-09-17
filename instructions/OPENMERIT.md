# OpenMerit — adaptive model decision layer

This harness is integrated with OpenMerit. OpenMerit compares eligible model
routes on completed tasks and maintains evidence for the best available route
and fallback under the user's policy.

## What OpenMerit does

1. Receives the latest completed task, its measured outcome, and the exact model
   routes configured in this harness.
2. Runs a small sequential comparison through those configured routes.
3. Measures quality, price, latency, errors, and tool activity.
4. Builds a per-task Pareto frontier and recommends a primary and fallback.
5. Applies a route automatically only when the user's current policy authorizes
   it; otherwise the decision remains supervised.

When a recommendation is created, the harness receives a structured
`harnessAction` containing the selected model route, an instruction to make it
active for the original invocation target, and a request to run its normal
validation. The recommendation preserves the harness-provided invocation
purpose and context. The harness decides how that means a runtime switch,
configuration edit, patch, or PR; it must not change the Pi session model when
the original invocation targeted an application. If the target, configuration
location, or validation command is missing, ask the user before making a
durable change.

Before automatic comparison, the Pi integration asks the active harness model
for a structured eligibility decision, invocation purpose, and application mode
(`session`, `application`, or `ask_user`). If the classifier is unavailable or
does not provide that context, automatic comparison is skipped; the user can
run `/openmerit compare` explicitly. OpenMerit never guesses an application
target from task keywords.

Pi also exposes the `openmerit_set_invocation` tool. When the harness knows the
task intent directly, it should call this tool during the task; that explicit
declaration takes precedence over semantic classification. Other harnesses can
provide the same `HarnessInvocation` fields through their own extension seam.
For deterministic wrapper integrations, Pi also accepts
`OPENMERIT_INVOCATION_JSON` or `/openmerit context '{...}'` before the task.

OpenMerit is not the harness, provider, or observability system. It does not
intercept normal traffic or own provider credentials.

## How to interact with it

- `/openmerit` — route, fallback, comparison status, budget, and evidence
- `/openmerit apply` / `/openmerit dismiss` — act on supervised decisions
- `/openmerit compare` — compare the latest completed task explicitly
- `/openmerit pause` / `/openmerit resume` — control future comparisons
- `/openmerit fallback` — switch to the current vetted fallback
- `/openmerit doctor` — sanitized installation and route diagnostics

Recurring benchmark refreshes are configured with `benchmark_refresh_minutes`.
Pi runs due jobs while it is open; an external scheduler may invoke
`openmerit refresh` when Pi is not running.

Policy changes belong to the user in `~/.openmerit/policy.json`.

## Operating guarantees

- Logical model identity and exact provider route remain separate throughout
  measurement and application.
- Candidate tools are disabled unless the user explicitly enables an allowlist.
- Candidate subprocesses disable ordinary extension discovery and load only
  explicitly allowlisted provider-registration files.
- The default policy is supervised. Automatic decisions require both auto mode
  and auto-apply enablement and are rechecked immediately before application.
- Task text, attachments, candidate answers, and evaluation requests are sent
  through the configured routes. Treat this alpha accordingly for sensitive
  workloads.
- OpenMerit records decision evidence locally by default. Do not edit its state
  files while it is running; use `/openmerit doctor` when state appears invalid.
- Application candidates must report their final output, validation or
  evaluation signals, tool outcomes, and relevant side effects. A runtime Pi
  model switch alone does not update a product's persisted model configuration.
