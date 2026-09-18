# Harness integration

A harness integration implements `HarnessAdapter` from `openmerit/harness` and
passes a `SettledHarnessTask` to `compareSettledTask` from `openmerit`.

The harness remains responsible for provider credentials, model discovery,
task execution, traces, and applying a selected route. OpenMerit owns candidate
selection, evaluation orchestration, budgets, Pareto evidence, and policy
decisions.

## Route execution and credential cascade

The adapter must run the completed task once with the active route before it
calls OpenMerit. That baseline result should include the final answer, trace,
cost, latency, tool activity, validation signals, and relevant side effects.
For every admitted candidate, the adapter reruns the same logical task with the
same prompt, attachments, tool policy, and application environment, changing
only the selected route. OpenMerit receives those normalized outcomes through
`HarnessRun` and does not call provider SDKs directly.

Routes can use a native provider integration or a configured gateway such as
OpenRouter. The adapter should resolve credentials in this order:

1. use the native provider route when its credential and integration are
   available;
2. use a configured gateway route when the gateway can execute that model;
3. ask the user for the missing credential or skip the route.

The cascade is an adapter concern, not a provider-specific rule in OpenMerit
core. Credentials must remain in the harness environment or secret store and
must be made available to isolated application trials without being copied into
OpenMerit state, prompts, source files, or benchmark artifacts. After the user
configures a missing credential, the harness may retry the affected trial.

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
baseline. The harness uses the supplied OpenMerit instructions to decide
eligibility and keeps any invocation purpose or application mode locally for
applying a recommendation. If it cannot make that decision, it skips automatic
comparison and may expose an explicit override through its own controls. Load
`openmerit/instructions` through the harness's supported plugin or middleware
hook.
