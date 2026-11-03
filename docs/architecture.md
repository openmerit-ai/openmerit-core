# Architecture

**Source status:** the Pi 1.5.0 native Scout replacement is unreleased and unpublished. The protocol/core evaluation coordinator described here remains available for custom harnesses; it is not invoked by the new Pi adapter. The standalone evaluation CLI and Inference Terminal are unchanged.

## Design principle

OpenMerit is an orchestrator, not an intelligence layer. The product application LLM call is the system under test; the coding harness is the evaluator and execution environment.

```text
User or lifecycle event
        |
        v
OpenMerit deterministic orchestration
        |
        | typed intent: outcome, constraints, evidence
        v
Custom evaluation harness
        |
        | intelligent work, tools, evals, calculation
        v
Typed result and durable evidence references
        |
        v
OpenMerit validation, policy, persistence, next nudge
```

An automatic OpenMerit action means automatic issuance of an approved intent. OpenMerit does not perform candidate research, evaluate quality, calculate a frontier, or mutate model configuration.

## Packages

### `openmerit/protocol`

Defines the JSON-safe boundary: durable intents, evidence references, metrics, task profiles, candidate assessments, frontier snapshots, budgets, policies, state, and audit events.

It also owns the versioned runtime schema registry for all intent results. Harness adapters consume these schemas rather than defining their own result shapes, report their structured-output capabilities, and may present the active schema using harness-native tools or adapter validation. A confirmed application LLM target is carried through profiles, metrics, candidates, frontier results, automation signals, and swaps; the harness model is not a valid substitute target.

### `openmerit/core`

Contains deterministic behavior: choosing the next lifecycle intent according to confirmation and rollback policy, persisting state, and checking harness-produced frontiers against the normative definition. The verifier rejects invalid harness results; it is not a model-selection engine.

`OpenMeritCoordinator` is the reusable adapter boundary. It constructs canonical intents, negotiates capabilities, records lifecycle progress and observations, validates results, and advances durable state. `OpenMeritStore` makes persistence replaceable; `ProjectStore` is the bundled filesystem backend.

The coordinator also accepts idempotent application-target automation signals and evaluates the user-confirmed `AutomationCheckPolicy`. `buildAutomationPlan` tells an adapter which signals and wakeups are required and reports unsupported persistent scheduling honestly. Provisioning belongs to a custom adapter; the coordinator itself does not create operating-system schedulers or paid cloud workers. The removed Pi 0.87 adapter's LaunchAgent is historical functionality, not part of the new Scout connection.

### `openmerit/pi`

Exports `createScoutPiExtension` and a default native Scout extension for Pi 1.5.0. It registers the authenticated Scout HTTP MCP server through Pi and adds shared rule/skill prompt sections. Pi owns discovery, tools, permissions, model and sessions; SDK hosts must load Pi's `createMcpExtension()` explicitly alongside it.

The package no longer implements `HarnessAdapter`, exposes lifecycle commands, or schedules evaluation work. It shares credential and instruction code with the installer instead of duplicating an MCP client or evaluation coordinator. See [Pi installation and migration](pi-extension.md).

### Inference Terminal

`packages/terminal` supplies a standalone `openmerit dash` executable, passive collectors, a loopback read-only HTTP API, and bundled browser assets. Stable npm 0.1.6 includes the terminal. The source interface and hosted dashboard follow the device’s light/dark preference; that appearance change is not included in npm 0.1.6. It does not invoke the coordinator or harness. One collector cycle reads existing metadata and runtime inventory; browser clients receive the same cached snapshot. Imported activity, runtime counters, and sampled whole-machine resources retain their separate scopes. Missing measurements remain unknown, and fictional sample data is isolated from the real snapshot. See the [terminal guide](inference-terminal.md) for the supported sources and JSON contract.

## Intelligence resources

Models, web research, tools, evaluators, and fast decision systems such as Jev System One are harness resources. They are configured and invoked by the host harness. This keeps the coordinator provider-neutral and lets custom adapters choose their own implementation.

## Trust boundary

The harness is trusted to perform the work and return honest evidence. OpenMerit reduces unsupported claims through structured outputs, evidence references, compatible profile revisions, complete comparisons, and conservative uncertainty handling. It cannot prove that an arbitrary external evidence URI contains truthful data.
