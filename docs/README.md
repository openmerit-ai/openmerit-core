# OpenMerit technical documentation

These pages describe the current alpha boundary and the contracts that let a
harness integration evolve independently from the decision engine.

- [Runtime workflow](runtime-workflow.md) — task lifecycle from a settled
  harness run to comparison and recommendation.
- [Harness integration](harness-integration.md) — the provider-neutral adapter
  contract and execution modes.
- [Application workflows](application-workflows.md) — benchmarking an
  application or agent that calls an LLM, including side-effect handling.
- [State and evidence](state-and-evidence.md) — state files, append-only
  records, traces, and evidence requirements.
- [Scheduling and refresh](scheduling.md) — durable jobs, active-session
  polling, and external scheduling when Pi is closed.
- [Architecture decisions](0.1.5-architecture-decisions.md) — the rationale
  behind the 0.1.5 boundaries.

OpenMerit is a decision layer. A harness owns credentials, route discovery,
execution, traces, tool access, and route application. Future harness adapters
should translate their native lifecycle into the same `HarnessAdapter` contract
rather than copying comparison logic.
