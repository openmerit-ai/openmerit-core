# Building a harness adapter

OpenMerit adapters are transport bridges. They do not reproduce OpenMerit's lifecycle, validation, persistence, or Pareto rules, and OpenMerit does not reproduce the harness's intelligence.

## Required components

An adapter provides a `HarnessAdapter` with:

- a stable harness descriptor;
- the OpenMerit protocol versions it supports;
- declared capabilities;
- supported execution modes;
- a `dispatch` method that accepts a canonical `OpenMeritIntent` and returns an acceptance receipt.

```ts
import {
  OpenMeritCoordinator,
  ProjectStore,
  type HarnessAdapter,
} from "@openmerit-v2/core";
import { PROTOCOL_VERSION } from "@openmerit-v2/protocol";

const adapter: HarnessAdapter = {
  descriptor: {
    id: "my-harness",
    name: "My coding harness",
    version: "1.0.0",
    protocolVersions: [PROTOCOL_VERSION],
    capabilities: [
      "user_confirmation",
      "evaluation_authoring",
      "observability_instrumentation",
      "production_observation",
      "candidate_discovery",
      "challenger_execution",
      "frontier_calculation",
      "model_mutation",
      "post_swap_verification",
      "rollback",
    ],
    executionModes: ["interactive"],
  },
  async dispatch(intent) {
    await myHarness.enqueue(intent);
    return { accepted: true, harnessJobId: intent.id };
  },
};

const coordinator = new OpenMeritCoordinator(
  new ProjectStore(process.cwd()),
  adapter,
);
```

`ProjectStore` is the included local-filesystem backend. A remote or hosted integration can implement the `OpenMeritStore` interface instead.

## External telemetry export

OpenMerit always writes its canonical, redacted audit stream locally. A host integration may pass `eventExporters` to `ProjectStore` to mirror those same safe events to OpenTelemetry, Langfuse, LangSmith, or another observability backend:

```ts
const store = new ProjectStore(projectRoot, {
  eventExporters: [{
    id: "my-otel-bridge",
    async export(event) {
      await telemetry.emit("openmerit.audit", event);
    },
  }],
});
```

Exporters are not the durable source of truth. They are best effort, and failures are recorded locally without blocking OpenMerit decisions.

## Dispatching work

```ts
const issued = await coordinator.issue("establish_evals");
```

The coordinator builds the canonical intent, checks the descriptor's protocol and capabilities, creates durable state, records audit events, and calls the adapter. The harness decides how to execute the job.

If a required capability is absent, dispatch is rejected before harness work starts.

## Reporting progress

A harness may send durable lifecycle progress through `recordLifecycle`:

```ts
await coordinator.recordLifecycle({
  protocolVersion: PROTOCOL_VERSION,
  intentId: issued.intent.id,
  status: "running",
  occurredAt: new Date().toISOString(),
  message: "Generating representative evaluation cases",
});
```

Use `waiting_for_user` when an interactive confirmation is required but cannot be completed in the current execution mode.

## Completing work

Each intent kind has a typed output in `IntentOutputMap`. Return an `IntentResult<K>` with durable evidence references, then submit it to the coordinator:

```ts
await coordinator.acceptResult(result);
```

The coordinator validates the active intent, version, evidence, intent-specific output, frontier conformance, mutation authorization, and lifecycle transition. Adapters must not duplicate this logic.

### Present the canonical result schema

Import `completionToolSchemaFor(intent.kind)` from `@openmerit-v2/protocol` and present it through the harness's strongest structured-output mechanism. Do not recreate result schemas inside an adapter. A harness that supports changing tool definitions should specialize the completion tool whenever an intent becomes active; other harnesses may expose intent-specific tools or perform adapter-side validation.

Declare the behavior in `HarnessDescriptor.structuredOutput`:

- `schemaDialect` identifies the canonical OpenMerit JSON Schema dialect;
- `presentation` states whether the adapter uses a dynamic tool, a static union, or adapter validation;
- `enforcement` states whether validation occurs at the provider and harness, harness only, or adapter only.

Schema validation catches malformed structure. The coordinator still owns semantic checks such as authorized candidate identity, evidence sufficiency, lifecycle consistency, and Pareto conformance.

## Reporting normal work and catalogue changes

After a real product task completes:

```ts
const observation = await coordinator.recordTaskObservation({
  modelId: "vendor/model",
});

if (observation.assessmentDue) {
  await coordinator.issue("run_assessment");
}
```

When the harness's available model catalogue changes, compute a stable fingerprint and call `recordModelCatalogFingerprint`. The returned `reassessmentDue` flag tells the adapter whether the lifecycle justifies candidate discovery.

New adapters should use `recordAutomationSignal` for product tasks, metric windows, scheduled ticks, catalogue observations, and verification windows. Signal IDs must remain stable across delivery retries. If the returned decision issues an intent, dispatch it through the coordinator. `recordTaskObservation` and `recordModelCatalogFingerprint` remain compatibility helpers.

Call `reconcileAutomation` after configuration changes or when restoring a project. It returns an `AutomationPlan`. Implement `scheduleWakeup` only when the harness can genuinely arrange the requested wakeup. Declare persistent scheduling, background execution, supported signal sources, and provisioning requirements accurately in `HarnessDescriptor.automation`.

If persistent scheduling is unavailable, expose the plan's active-session or external-scheduler fallback. Do not report a seven-day schedule as configured merely because the adapter checks policy when an interactive session starts.

## Capability mapping

| Intent | Required capability |
| --- | --- |
| `establish_evals` | confirmation, evaluation authoring, observability instrumentation |
| `instrument_observability` | observability instrumentation |
| `run_assessment` | production observation |
| `discover_candidates` | candidate discovery |
| `run_challenger_trials` | challenger execution |
| `calculate_frontier` | frontier calculation |
| `investigate_regression` | production observation |
| `apply_model_swap` | model mutation |
| `verify_model_swap` | post-swap verification |
| `rollback_model_swap` | rollback |

## Conformance checklist

An adapter is ready when it:

1. advertises only capabilities it can actually execute;
2. preserves intent IDs and protocol versions;
3. never reports success without durable evidence;
4. returns the typed output for every supported intent;
5. performs model mutation only when the intent explicitly authorizes it;
6. reports ordinary product tasks without counting OpenMerit orchestration turns;
7. passes a durable issue-and-complete cycle using `OpenMeritCoordinator`;
8. proves the requested side effect, not merely a generated description.

The fake non-Pi adapter in `packages/core/test/adapter-conformance.test.ts` is the executable reference.
