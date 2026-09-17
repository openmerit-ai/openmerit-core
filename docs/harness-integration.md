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

Candidate execution can be selected explicitly per task:

```ts
const task: HarnessTask = {
  task: "Classify the supplied text",
  cwd,
  images: [],
  files: [],
  mode: "inference", // "agent" (default) or "inference"
};
```

For `inference` tasks, implement `runInference` when the harness can invoke a
model directly without creating files or running an agent loop. For product
workflows, the harness uses its own execution and workspace capabilities.
OpenMerit does not define an application runner, provider SDK, framework,
configuration format, or deployment mechanism. The recommendation's
`harnessAction` tells the harness which route to activate and asks it to run
normal validation.

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
