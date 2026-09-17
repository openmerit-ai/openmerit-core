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

Call the engine only after the harness has a completed task and a measured
baseline. Load `openmerit/instructions` into the harness's instruction context
using that harness's supported plugin or middleware hook.
