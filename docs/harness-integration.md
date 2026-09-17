# Harness integration

A harness integration implements `HarnessAdapter` from `openmerit/harness` and
passes a `SettledHarnessTask` to `compareSettledTask` from `openmerit`.

The harness remains responsible for provider credentials, model discovery,
task execution, traces, and applying a selected route. OpenMerit owns candidate
selection, evaluation orchestration, budgets, Pareto evidence, and policy
decisions.

At minimum, implement:

```ts
const adapter: HarnessAdapter = {
  runTask(route, input) { /* isolated candidate run */ },
  createInferenceClient(onSpend) { /* evaluator through harness */ },
  scoreRun(judge, task, rubric, route, run, client, source, images) {
    /* normalize the harness outcome and evaluator score */
  },
};
```

If the harness supports product workflows, also implement
`runApplication(route, input)` and `applyApplicationRoute(route, input)`. The
first executes the real application in an isolated environment; the second
updates the harness-owned configuration after an accepted recommendation. It
may create a patch or PR, but that decision belongs to the harness and its
user-facing workflow.

Candidate execution can be selected explicitly per task:

```ts
const task: HarnessTask = {
  task: "Classify the supplied text",
  cwd,
  images: [],
  files: [],
  mode: "inference", // "agent" (default) or "application"
};
```

For `inference` tasks, implement `runInference` when the harness can invoke a
model directly without creating files or running an agent loop. For product
workflows, set `mode: "application"` and implement `runApplication`; that
method injects the candidate route into an isolated copy of the application,
executes its real wrapper/orchestration, and returns normalized output and
side-effect observations. OpenMerit does not assume a provider SDK, framework,
configuration format, or deployment mechanism. A harness decides how to inject
the route and can prepare a patch or PR after a recommendation is accepted.

The generic `runTask` method remains the fallback for adapters that do not
declare a specialized mode, preserving compatibility with existing Pi
integrations.

Adapters should copy provider lifecycle metadata into `ModelRoute.availability`
when available. Routes marked `preview`, `deprecated`, or `retired` are excluded
from candidate comparisons; a route with unknown lifecycle remains eligible for
backward compatibility and is still subject to pricing and policy checks.

Call the engine only after the harness has a completed task and a measured
baseline. Load `openmerit/instructions` into the harness's instruction context
using that harness's supported plugin or middleware hook.
