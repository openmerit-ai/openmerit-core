# Runtime workflow

OpenMerit starts at a harness lifecycle boundary. It does not crawl a
conversation, infer a task from arbitrary historical turns, or replace the
harness's normal model call.

1. The harness starts a task and captures its task context.
2. The harness completes the task and exposes a settled task containing the
   prompt, working directory, attachments, active route, and normalized trace.
3. The integration loads OpenMerit's instruction context and asks the engine
   whether the task is eligible. A harness may provide a semantic eligibility
   decision; the engine retains a deterministic fallback.
4. If eligible, the active run becomes the baseline. The engine admits a
   deterministic slate of currently available, policy-eligible routes.
5. The adapter runs each candidate using the task's declared mode: direct
   inference, an agent run, or an application workflow. Candidate runs are
   isolated by the adapter and return normalized output, tool outcomes, and
   side-effect observations.
6. The configured evaluator scores each result against the task rubric. Cost,
   latency, quality, errors, tool activity, and changed-file counts are stored
   as evidence.
7. The engine computes the task's Pareto frontier, applies the policy gate, and
   appends a recommendation. The integration reports the result in the active
   harness session.
8. The harness or user applies the recommendation. Applying a route is always
   a harness operation; OpenMerit only returns the decision and gate reasons.
9. An optional refresh job can repeat the measurement later against the saved
   task evidence.

The task identity is stable across a session and can be reused by another
session when the harness supplies the same task key. Comparisons remain
sequential per task in the current alpha. The engine does not promise that
running a candidate proves production equivalence; application adapters must
define what output and side effects are meaningful for their workflow.
