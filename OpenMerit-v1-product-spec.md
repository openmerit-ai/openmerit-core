# OpenMerit v1 — Intelligence Control Plane Product & Technical Specification

> **Status:** Build-ready v1
> **Category:** Open-source autonomous intelligence control plane
> **License:** Open Core — MIT + Commercial
> **Primary interfaces:** CLI, TUI, MCP, SDK, open protocols
> **Hosted service:** OpenMerit Cloud
> **Date:** 2026-09-06

---

## 0. Executive summary

OpenMerit is an **open-source, harness-native intelligence control plane** powered by an autonomous **Controller**.

It connects three independent layers:

1. **Agent harnesses** — Pi, Prime Agent, Hermes, OpenClaw, custom runtimes
2. **Inference infrastructure** — providers, gateways, endpoints, GPU clouds, vLLM, internal serving
3. **Observability & evals** — Braintrust, Langfuse, LangSmith, OpenTelemetry/OpenInference, custom eval systems

OpenMerit does **not** sit in the production inference hot path.

Its job is:

> **Given what a harness is trying to achieve, the policies it must satisfy, and the production signals and eval scores, continuously maintain the best known intelligence configuration for that workload.**

The control loop is:

```text
Harness intent
   ↓
Model Resolver returns inference configuration
   ↓
Inference executes
   ↓
Observability measures
   ↓
Controller evaluates signals and scores
   ↓
Benchmark challenger if needed
   ↓
Update desired state / canary
   ↓
Verify
   ↓
Promote or rollback
```

The core product is not a leaderboard, router, observability product, or inference platform.

It is a **neutral open-source control plane for model and inference configuration**. Its autonomous control loop is implemented by the **Controller**.

---

## 1. Core thesis

### Harnesses answer

> **How should this agent operate?**

They own:

- context
- memory
- planning
- tool use
- subagents
- execution loops
- delegation
- trajectory control

### Inference infrastructure answers

> **How do I execute this intelligence?**

It owns:

- serving
- provider access
- endpoints
- routing
- credentials
- hardware
- failover
- transport

### Observability & eval systems answer

> **What actually happened?**

They own:

- traces
- scores
- production telemetry
- datasets
- evaluators
- user feedback
- runtime metrics
- experiments

### OpenMerit answers

> **What model and inference configuration should this role use now?**

That responsibility is currently scattered across:

- hard-coded model names
- provider defaults
- manual benchmark notebooks
- generic leaderboards
- routing heuristics
- harness-specific logic
- human intuition

OpenMerit makes it explicit.

---

## 2. Positioning

### Category

**Autonomous Intelligence Control Plane**

### Supporting line

**The open-source intelligence control plane between agent harnesses, observability signals and scores, and inference infrastructure.**

### Developer-facing line

> **Agents shouldn't guess which intelligence to use. They should resolve it using signals and scores.**

### One-sentence promise

> **Tell OpenMerit what must remain true; it keeps the intelligence underneath your agents in the best known state.**

### Product vocabulary

Use established infrastructure terms across code, CLI, docs, UI, and schemas:

| Term | Meaning |
|---|---|
| **OpenMerit** | The **control plane** for model/inference decisions. |
| **Controller** | The standard control-loop component that watches current state and inputs, evaluates policy, and moves the system toward desired state. |
| **Model Resolver** | The harness-facing interface that resolves a role to the current approved inference configuration. |
| **Role** | A harness role such as `coding.executor`, `planner`, `reviewer`, or `vision.reader`. |
| **Inference Configuration** | Model, provider/endpoint, runtime, generation parameters, and serving settings for a role. |
| **Signals** | Observability telemetry such as traces, metrics, logs, runtime measurements, and usage/cost data. |
| **Scores** | Eval outputs such as task-success scores, evaluator results, annotations, and benchmark scores. |
| **Policy** | SLOs, constraints, budgets, autonomy rules, provider allowlists, and approval requirements. |
| **Desired State** | The inference configuration that should currently be active for a role. |
| **Rollout Plan** | The canary/promotion/rollback plan used to move current state to desired state. |
| **Decision Record** | Immutable record of why the current desired state was selected. |

The relationship is:

```text
HARNESS → MODEL RESOLVER → INFERENCE CONFIGURATION
                              ↑
                         CONTROLLER
                         ↑          ↑
                      SIGNALS     SCORES
```

The **Model Resolver resolves**. The **Controller runs the control loop**.


---

## 3. Architecture

```text
                        APPLICATION / TASK
                               │
                               ▼
                    ┌────────────────────┐
                    │      HARNESS       │
                    │                    │
                    │ Pi · Hermes        │
                    │ Prime · OpenClaw   │
                    │ Custom             │
                    │                    │
                    │ owns HOW           │
                    └─────────┬──────────┘
                              │
                    ModelResolutionRequest
                              │
                              ▼
                 ┌──────────────────────────┐
                 │        OPENMERIT         │
                 │                          │
                 │ MODEL RESOLVER           │
                 │ role → inference configuration │
                 │                          │
                 │ CONTROLLER               │
                 │ signals and scores + policy        │
                 │ → test → decide → verify │
                 │                          │
                 │ desired state            │
                 └───────────┬──────────────┘
                             │
                     DesiredState /
                       RolloutPlan
                             │
                             ▼
              ┌────────────────────────────┐
              │   INFERENCE INFRASTRUCTURE │
              │                            │
              │ providers · gateways       │
              │ endpoints · vLLM · GPU     │
              │                            │
              │ owns EXECUTION             │
              └─────────────┬──────────────┘
                            │
                            ▼
                         EXECUTION
                            │
                            ▼
              ┌────────────────────────────┐
              │  OBSERVABILITY & EVALS     │
              │                            │
              │ Braintrust · Langfuse      │
              │ LangSmith · OTel · custom  │
              │                            │
              │ owns REALITY               │
              └─────────────┬──────────────┘
                            │
                      TelemetrySignal
                            │
                            └────────────→ OpenMerit
```

The conceptual split is:

```text
HARNESS
How should the agent work?

OPENMERIT
What intelligence should it use?

INFERENCE
Execute that intelligence.

OBSERVABILITY
Measure what actually happened.
```

---

## 4. Non-negotiable product boundary

OpenMerit must be **in the architecture but out of the hot path**.

Bad:

```text
request → OpenMerit → provider → model
```

Correct:

```text
OpenMerit → desired state → harness/inference config

request → harness → inference → model
```

If OpenMerit is unavailable:

```text
last known good decision
    ↓
cached locally
    ↓
agent continues
```

OpenMerit downtime must never kill production inference.

---

## 5. What OpenMerit is not

Do not build OpenMerit into:

- production inference proxy
- request router
- token reseller
- provider marketplace
- GPU cloud
- prompt gateway
- agent harness
- tracing product
- generic observability suite
- generic leaderboard
- RAG platform
- fine-tuning platform
- model hosting service

It may integrate with all of them.

---

## 6. Product principles

### 6.1 Harness-native

The default consumer is a harness or coding agent.

Humans primarily define policy, investigate decisions, or override exceptional situations.

### 6.2 CLI-first

The CLI is canonical.

The TUI is a human inspection layer over the same domain engine.

The MCP server is a first-class agent interface.

The web app is the hosted management/control plane.

### 6.3 Autonomous by default, constrained by policy

Humans define:

- budgets
- privacy
- licensing
- quality floors
- rollout rules
- provider allowlists
- escalation conditions

Routine changes should not require human approval.

### 6.4 Open by protocol, not by vendor count

The goal is not “we support 100 providers.”

The goal is:

> **Any harness can request intelligence. Any observability system can provide signals and scores. Any inference system can implement desired state.**

### 6.5 Local-first

The complete control loop must run without OpenMerit Cloud.

### 6.6 Neutral

OpenMerit must have no economic reason to prefer a model/provider/gateway.

Do not price by routed tokens.

Do not resell inference.

### 6.7 Production signals and eval scores over generic benchmarks

Generic benchmarks are priors for challenger discovery.

Task-specific eval scores and production signals determine decisions.

### 6.8 Reversible autonomy

Autonomous changes must be:

- attributable
- canaryable where possible
- observable
- reversible
- auditable

---

## 7. Primary domain objects

### 7.1 Role

A named functional role in a harness.

Examples:

```text
coding.planner
coding.executor
coding.reviewer
research.synthesizer
vision.reader
memory.compactor
support.classifier
support.responder
subagent.general
```

### 7.2 Model Resolution Request

A harness asks:

> What should fill this role under this workload and policy?

```json
{
  "role": "coding.executor",
  "harness": {
    "id": "pi",
    "version": "0.42.0"
  },
  "workload": {
    "languages": ["typescript"],
    "estimated_context_tokens": 140000,
    "tools": ["shell", "editor", "git"]
  },
  "policy_ref": "coding-prod"
}
```

### 7.3 Inference Configuration

The actual decision unit.

A profile may include:

```yaml
role: coding.executor

harness:
  id: pi
  version: 0.42.0

model:
  id: qwen-x
  revision: latest-known-good

inference:
  provider: fireworks
  region: us-east

generation:
  reasoning_effort: high
  max_output_tokens: 8000

serving:
  quantization: fp8

context:
  strategy: native
```

OpenMerit optimizes **inference configurations**, not merely model names.

### 7.4 Policy

Defines required invariants and optimization priorities.

```yaml
role: coding.executor

requirements:
  task_success: ">= 0.91"
  regression_rate: "< 0.02"
  p95_cost_usd: "< 1.80"
  p95_duration: "< 12m"

optimize:
  primary: cost
  secondary: duration

constraints:
  commercial_use: true
  privacy_boundary: local
  allowed_regions:
    - local
    - eu-west

autonomy:
  model_switch: true
  provider_switch: true
  endpoint_switch: false
  daily_benchmark_budget_usd: 50

require_human:
  - privacy_boundary_change
  - license_change
  - new_external_provider
  - monthly_cost_increase_over_20_percent
```

### 7.5 Signals and Scores

OpenMerit consumes the terms already used by the adjacent systems:

**Signals** come from observability and runtime instrumentation:

- traces
- metrics
- logs/events
- latency
- errors
- token/usage metrics
- cost metrics
- tool/runtime failures

**Scores** come from eval systems and benchmarks:

- task success
- evaluator scores
- annotations/user feedback
- benchmark scores
- regression scores
- segment-level eval results

### 7.6 Desired State

The inference configuration OpenMerit currently believes best satisfies policy.

### 7.7 Rollout Plan

A safe, reversible transition from current state to desired state.

### 7.8 Decision Record

Immutable record of the decision, inputs, policy, and results behind the current desired state.

---

## 8. The Controller

Conceptually:

```python
while controller_is_running:
    intent = read_role_intent()
    policy = read_policy()
    signals, scores = read_signals_and_scores()
    current = read_actual_state()

    result = controller.evaluate(intent, policy, signals, scores, current)

    if result == NO_CHANGE:
        continue

    if result.requires_benchmark:
        challengers = discover_candidates()
        benchmark(challengers)

    desired = choose_best_known_qualified_profile()

    plan = create_rollout_plan(current, desired, policy)

    if plan.allowed:
        apply(plan)
        verify_rollout()
        promote_or_rollback()
```

Implementation should be event-driven, not a literal infinite loop.

---

## 9. Autonomous control loop

Canonical lifecycle:

```text
OBSERVE
   ↓
DETECT
   ↓
FORM HYPOTHESIS
   ↓
DISCOVER CHALLENGERS
   ↓
BENCHMARK
   ↓
DECIDE
   ↓
PLAN CHANGE
   ↓
CANARY
   ↓
OBSERVE
   ↓
VERIFY
   ↓
PROMOTE / ROLLBACK
```

Triggers may include:

- quality SLO breach
- latency SLO breach
- cost SLO breach
- provider outage
- model deprecation
- pricing change
- new model release
- new endpoint availability
- workload shift
- stale signals and scores
- harness version change
- policy change

**No-op is a first-class decision.**

OpenMerit should prefer stability when no material improvement exists.

---

## 10. Human intervention policy

### May proceed autonomously

- inspect environment
- infer role metadata
- create eval draft
- discover challengers
- run benchmarks within budget
- calculate tradeoffs
- create decision record
- canary within approved limits
- rollback when predefined conditions fail

### Should ask only when ambiguous

Example:

```text
Two definitions of correctness produce different winners.
Policy does not identify the authoritative metric.
```

### Must ask

- privacy boundary change
- incompatible license
- new external provider
- spend above configured ceiling
- destructive infra change
- lowering critical quality floor
- enabling an unapproved data destination

These must be machine-enforced.

---

## 11. Local autonomy configuration

```toml
# .openmerit/config.toml

[autonomy]
create_evals = true
discover_candidates = true
run_benchmarks = true
apply_model_switches = true
apply_provider_switches = true
apply_endpoint_switches = false

benchmark_budget_usd_daily = 25
max_candidates_per_benchmark = 6

canary_initial_percent = 5
canary_max_percent_without_review = 50

[autonomy.require_human]
privacy_boundary_change = true
license_change = true
new_external_provider = true
monthly_cost_increase_percent = 20

[privacy]
upload_inputs = false
upload_outputs = false
upload_traces = false
upload_scores = true
upload_runtime_metrics = true

[fallback]
mode = "last_known_good"
max_decision_age_hours = 720
```

---

## 12. Three open interfaces

The interfaces are strategically more important than individual vendor integrations.

All public schemas are MIT and independently versioned.

---

### 12.1 Harness → OpenMerit: Model Resolution Interface

Purpose:

> “Resolve the model/inference configuration for this role.”

Request:

```json
{
  "schema": "openmerit.resolve-request/v1",
  "request_id": "req_123",

  "role": {
    "name": "coding.executor",
    "task_id": "task_optional"
  },

  "harness": {
    "id": "pi",
    "version": "0.42.0",
    "capabilities": {
      "subagents": true,
      "vision": false,
      "tool_use": true
    }
  },

  "workload": {
    "estimated_context_tokens": 140000,
    "expected_output_tokens": 8000,
    "languages": ["typescript"],
    "tools": ["shell", "git", "editor"]
  },

  "environment": "production",
  "policy_ref": "coding-prod"
}
```

Response:

```json
{
  "schema": "openmerit.resolve-response/v1",

  "decision_id": "dec_8291",

  "inference_config": {
    "id": "config_921",

    "model": {
      "canonical_id": "model-x"
    },

    "inference": {
      "provider": "provider-y",
      "endpoint": "endpoint-z"
    },

    "generation": {
      "reasoning_effort": "high"
    }
  },

  "confidence": "high",
  "validated_at": "2026-09-06T09:00:00Z",
  "ttl_seconds": 86400,
  "fallback_config_id": "config_812"
}
```

Rules:

- harness may cache
- local resolution must work
- static fallback must be supported
- OpenMerit is not consulted for every inference request

---

### 12.2 Observability/Evals → OpenMerit: Telemetry and Scores Ingest

Purpose:

> “Here is what actually happened.”

```json
{
  "schema": "openmerit.telemetry-scores/v1",

  "source": {
    "type": "langfuse",
    "instance": "self-hosted"
  },

  "role": "coding.executor",
  "inference_config_id": "config_921",

  "window": {
    "start": "2026-09-06T08:00:00Z",
    "end": "2026-09-06T09:00:00Z"
  },

  "sample_size": 841,

  "quality": {
    "task_success": 0.914,
    "regression_rate": 0.021
  },

  "runtime": {
    "p50_duration_ms": 4100,
    "p95_duration_ms": 12700,
    "error_rate": 0.004
  },

  "economics": {
    "cost_per_attempt_usd": 0.72,
    "cost_per_success_usd": 0.81
  },

  "custom": {
    "tool_failure_rate": 0.015
  }
}
```

Initial telemetry/eval adapters:

- OpenTelemetry
- OpenInference
- Braintrust
- Langfuse
- LangSmith
- Prometheus
- JSON/JSONL
- generic webhook
- local eval runner

Prefer open telemetry standards before bespoke integrations.

---

### 12.3 OpenMerit → Inference: Desired State / Rollout Interface

Purpose:

> “This is what should be running.”

```yaml
protocol: openmerit.desired-state/v1

role: coding.executor
environment: production

current:
  config_id: config_812

desired:
  config_id: config_921

target:
  model: model-x
  provider: provider-y
  endpoint: endpoint-z

generation:
  reasoning_effort: high

rollout:
  strategy: canary
  steps:
    - percent: 5
      minimum_observation_count: 100
    - percent: 20
      minimum_observation_count: 300
    - percent: 50
      minimum_observation_count: 500
    - percent: 100

rollback:
  conditions:
    - metric: task_success
      operator: "<"
      value: 0.91
    - metric: error_rate
      operator: ">"
      value: 0.02
```

Initial execution adapters:

- static config
- generic HTTP control API
- LiteLLM
- Portkey
- vLLM
- Kubernetes
- Bedrock
- Vertex
- gateway/router integrations where control APIs permit

OpenMerit must not assume every inference system has the same routing model.

---

## 13. Pull and push

### Pull

Harness:

```text
resolve(role, workload, policy)
```

Useful at:

- trajectory start
- role switch
- subagent creation
- cache refresh

### Push

OpenMerit:

```json
{
  "event": "decision.updated",
  "role": "support.responder",
  "previous_decision": "dec_91",
  "current_decision": "dec_104",
  "reason": "quality_slo_breach"
}
```

Consumers may include:

- harness
- GitOps
- gateway control plane
- CI
- internal platform

---

## 14. Harness boundary

OpenMerit must not decide:

- when to spawn subagents
- what tools to call
- how memory works
- how context is constructed
- when to plan
- how the trajectory runs

OpenMerit may decide:

- model for planner
- model for executor
- model for reviewer
- provider
- endpoint
- reasoning effort
- serving configuration
- context capability requirement

The harness owns **behavior**.

OpenMerit owns **intelligence assignment**.

---

## 15. Multi-role optimization

Example:

```text
planner       → frontier model
executor      → open coding model
reviewer      → separate judge model
summarizer    → small cheap model
compactor     → local 8B model
vision        → vision-specialized model
```

OpenMerit may update one role independently without requiring harness code changes.

This is a key source of future economic value.

---

## 16. Task and eval layer

The Controller cannot manage model and inference configuration intelligently unless “good” is defined.

A Task/Eval contains:

- objective
- hard requirements
- critical failures
- dataset
- scorers
- equivalence margins
- confidence policy

Example:

```text
HARD
task success >= 91%
security recall >= 99.5%
JSON validity = 100%

OPTIMIZE
cost ↓
duration ↓
```

Never collapse everything into one opaque weighted score.

---

## 17. Repository-native `.eval.md`

Recommended structure:

```text
.openmerit/
  config.toml
  roles/
    coding.executor.yaml
    coding.reviewer.yaml
  evals/
    coding-executor.eval.md
    coding-review.eval.md
  policies/
    production.yaml
  decisions/
    current.json
```

Example:

```md
---
openmerit: 1
task: coding.executor
---

# Coding executor

## Objective

Resolve repository issues by producing correct minimal patches.

## Hard requirements

- project tests pass
- typecheck passes
- patch applies cleanly
- no unrelated modifications

## Critical failures

- introduces regression
- removes tests to make suite pass
- modifies secrets
- changes unrelated dependencies

## Objectives

- task completion
- minimal diff
- regression avoidance
- cost
- duration

## Dataset

om-local://fixtures/coding-executor

## Equivalence

task_success_margin: 0.01
```

The format is MIT, diffable, agent-readable, and vendor-neutral.

---

## 18. Candidate discovery

Candidate discovery answers:

> **What is worth testing?**

It does not answer:

> **What is best?**

A candidate is an inference configuration variant, potentially including:

- model
- provider
- endpoint
- quantization
- hardware
- reasoning effort
- context strategy
- harness compatibility

Discovery algorithm v1:

1. derive role requirements
2. merge policy
3. inspect harness capabilities
4. inspect inference capabilities
5. remove incompatible candidates
6. include incumbent
7. include quality ceiling
8. include economical challenger
9. include open/self-hosted challenger
10. include new/recent challenger
11. return 3–8 candidates with reasons

---

## 19. Benchmark pipeline

Default:

```text
DISCOVER
   ↓
SCREEN
   ↓
FULL BENCHMARK
   ↓
COMPARE
   ↓
QUALIFY
   ↓
DECIDE
```

### Screening

- small stratified sample
- cheap
- eliminates obviously weak candidates

### Full benchmark

- representative dataset
- exact eval version
- repeated runs where stochasticity matters
- runtime metrics
- cost
- failures
- segment performance

Benchmarks may run completely locally.

---

## 20. Comparison engine

For each inference configuration calculate:

- quality dimensions
- hard constraint status
- critical failure rate
- latency
- p50/p95/p99
- cost
- cost per successful task
- throughput
- error rate
- confidence
- signals and scores freshness
- segment performance

---

## 21. Pareto frontier

OpenMerit should reason about tradeoffs instead of publishing a universal score.

Example:

| Profile | Quality | Cost | p95 |
|---|---:|---:|---:|
| A | 99.0 | $10 | 4.2s |
| B | 98.8 | $2 | 1.5s |
| C | 96.1 | $0.20 | 0.8s |
| D | 97.2 | $4 | 2.1s |

D is dominated by B.

Dominated profiles should be visibly classified as such.

---

## 22. Equivalence

Production replacement often depends on “equal enough.”

Example:

```yaml
equivalence:
  task_success: 0.005
```

If incumbent is 98.7% and challenger is 98.4%, both pass all critical requirements, and 0.3pp is inside the configured margin, cost/performance can decide.

---

## 23. Confidence

Every decision has:

```text
LOW
MEDIUM
HIGH
```

Derived from:

- sample size
- variance
- scorer reliability
- dataset coverage
- benchmark completeness
- production corroboration
- signals and scores age
- candidate separation

Never let an LLM invent confidence.

---

## 24. Decision Record

Example:

```text
ROLE
coding.executor

CURRENT
config_812

DECISION
config_921

WHY
task success      91.8%
incumbent         91.9%
difference        -0.1pp

cost/success      $0.38
incumbent         $1.21

p95 duration      7.4m
incumbent         8.9m

all hard requirements satisfied
quality difference inside equivalence margin

CONFIDENCE
high

EVIDENCE
benchmark n=1,204
production observations n=8,129

POLICY
coding-prod@17

VALIDATED
2026-09-06
```

Decision records must be:

- immutable
- machine-readable
- Markdown-exportable
- attributable
- version-linked
- auditable

---

## 25. Continuous reconsideration

Decisions expire or become invalid when:

- quality degrades
- pricing changes
- model is deprecated
- harness changes materially
- workload shifts
- new relevant candidates appear
- signals and scores becomes stale

Example policy:

```yaml
freshness:
  max_age_days: 30
  invalidate_on:
    - harness_major_version
    - provider_price_change_gt_20_percent
    - quality_slo_breach
```

---

## 26. Canary and rollback

Default autonomous rollout:

```text
5%
 ↓
observe
 ↓
20%
 ↓
observe
 ↓
50%
 ↓
observe
 ↓
100%
```

Rollback if predefined conditions fail.

Record:

- rollout plan
- each promotion
- signals and scores window
- rollback reason
- final outcome

---

## 27. Local fallback order

```text
fresh approved decision
    ↓
cached approved decision
    ↓
static project fallback
    ↓
harness default
```

Resolution must remain safe without network access.

---

## 28. OSS / Open Core model

The local product should be genuinely complete.

### MIT

Recommended MIT scope:

- core decision engine
- Controller
- CLI
- TUI
- MCP
- SDKs
- protocols
- schemas
- `.eval.md`
- task/eval engine
- benchmark engine
- comparison engine
- Pareto logic
- equivalence logic
- local decision registry
- local model catalog
- local runner
- harness adapters
- telemetry/eval adapters
- execution adapters
- local autonomous loop
- self-hosted deployment

The full autonomous local loop must be possible without paying.

### Commercial `/ee`

Keep it enterprise-oriented:

- SAML/SSO
- SCIM
- advanced RBAC
- audit exports
- governance
- compliance
- retention controls
- org-wide policies
- enterprise approval workflows
- fleet governance
- managed secrets if added later

Do not hide the interesting developer primitives inside `/ee`.

---

## 29. OpenMerit Cloud

OpenMerit Cloud sells **managed intelligence**, not access to basic decision logic.

### Paid value

#### Global model intelligence

Continuously updated:

- releases
- provider availability
- pricing
- regions
- capabilities
- licenses
- deprecations
- serving options
- generic benchmark priors

#### Challenger discovery

Example:

```text
3 relevant inference configurations appeared since your last validation.
```

#### Continuous managed control

Hosted scheduling and event coordination.

#### Team memory

Organization-wide history of:

- roles
- profiles
- decisions
- policies
- rollouts

#### Fleet intelligence

Example:

```text
127 roles
44 active inference configurations
18 models
6 providers
382 decisions
```

#### Managed runner coordination

Cloud schedules.

Customer runner executes.

Raw data may remain private.

#### Governance

Cross-team policy and audit.

---

## 30. Commercial boundary

Preferred split:

```text
LOCAL DECISION MAKING
MIT + free

MANAGED INTELLIGENCE
paid hosted service
```

Not:

```text
eval free
decision paid
```

---

## 31. CLI

Binary:

```bash
openmerit
```

### Inspect

```bash
openmerit inspect .
```

Discover:

- harness
- model usage
- provider
- endpoint
- roles
- policies
- evals

### Audit

```bash
openmerit audit
```

Example:

```text
ROLE                 STATUS        CURRENT
coding.executor      current       qwen-x
coding.reviewer      stale         gpt-x
invoice.reader       SLO breach    gemini-x
support.classifier   unvalidated   claude-x
```

### Resolve

```bash
openmerit resolve coding.executor
```

### Eval

```bash
openmerit eval init coding.executor
openmerit eval validate coding.executor
openmerit eval run coding.executor
```

### Candidates

```bash
openmerit candidates coding.executor
```

### Benchmark

```bash
openmerit benchmark coding.executor
```

### Decide

```bash
openmerit decide coding.executor
```

### Explain

```bash
openmerit decision explain coding.executor
```

### Controller

```bash
openmerit controller run
openmerit controller start
openmerit controller status
openmerit controller pause
```

### Doctor

```bash
openmerit doctor
```

Checks:

- credentials available locally
- endpoints reachable
- telemetry/eval sources reachable
- policies valid
- runner capabilities
- cached decisions

### Improve

High-level flagship command:

```bash
openmerit improve
```

Conceptually:

```text
inspect
→ identify stale/unvalidated roles
→ create/find eval
→ discover challengers
→ benchmark
→ Controller evaluates and updates desired state
```

---

## 32. CLI requirements

Every command supports:

```text
--json
--non-interactive
```

Agents must never scrape prose.

Exit codes are stable and documented.

---

## 33. TUI

Launch:

```bash
openmerit
```

Example:

```text
┌ OpenMerit ──────────────────────────────────────────┐
│                                                    │
│ ROLE               STATUS      CURRENT      ACTION │
│                                                    │
│ coding.executor    current     qwen-x       —      │
│ coding.reviewer    stale       gpt-x        test   │
│ invoice.reader     breach      gemini-x     switch │
│ support.classifier unvalidated claude-x     eval   │
│                                                    │
│ enter inspect   s controller     e eval   q quit      │
└────────────────────────────────────────────────────┘
```

The TUI must expose no unique capabilities.

Everything must also be possible through CLI/API.

---

## 34. MCP

Keep tool count deliberately small.

```text
intelligence.resolve
intelligence.explain

task.inspect

eval.create
eval.validate

candidates.search

benchmark.plan
benchmark.submit

controller.run
decision.get
decision.explain

policy.get
```

MCP must be a thin adapter over domain services.

Do not duplicate logic.

---

## 35. SDK

Initial:

- TypeScript
- Python

Example:

```ts
const om = new OpenMerit()

const profile = await om.resolve({
  role: "coding.executor",
  harness,
  workload,
  policy
})
```

Signals and Scores:

```ts
await om.signals and scores.submit(signal)
```

Controller:

```ts
await om.controller.run({
  role: "coding.executor"
})
```

---

## 36. Monorepo

```text
openmerit/
│
├── apps/
│   ├── cli/
│   ├── tui/
│   ├── mcp/
│   ├── cloud/
│   └── docs/
│
├── packages/
│   ├── core/
│   ├── controller/
│   ├── protocol/
│   ├── policy/
│   ├── task/
│   ├── eval/
│   ├── models/
│   ├── benchmark/
│   ├── comparison/
│   ├── decision/
│   ├── registry/
│   ├── sdk-ts/
│   └── sdk-python/
│
├── runners/
│   ├── python/
│   └── node/
│
├── adapters/
│   ├── harness/
│   │   ├── pi/
│   │   ├── hermes/
│   │   ├── openclaw/
│   │   ├── prime/
│   │   └── generic/
│   │
│   ├── signals and scores/
│   │   ├── otel/
│   │   ├── openinference/
│   │   ├── braintrust/
│   │   ├── langfuse/
│   │   ├── langsmith/
│   │   ├── prometheus/
│   │   └── generic/
│   │
│   └── execution/
│       ├── litellm/
│       ├── portkey/
│       ├── vllm/
│       ├── kubernetes/
│       ├── bedrock/
│       ├── vertex/
│       ├── static-config/
│       └── generic/
│
├── ee/
│   ├── sso/
│   ├── scim/
│   ├── governance/
│   ├── audit/
│   └── org-policy/
│
└── examples/
```

---

## 37. Licensing map

```text
/apps/cli                 MIT
/apps/tui                 MIT
/apps/mcp                 MIT
/packages/**              MIT
/runners/**               MIT
/adapters/**              MIT
/examples/**              MIT

/ee/**                    Commercial
OpenMerit Cloud           Commercial SaaS
```

---

## 38. Core technical rules

### Deterministic code owns

- policy enforcement
- hard constraints
- Pareto dominance
- cost arithmetic
- confidence derivation
- authorization
- rollout thresholds
- rollback conditions

### LLMs may assist with

- task understanding
- eval generation
- candidate rationale
- scorer generation
- failure clustering
- decision explanation

Principle:

> **LLMs propose and explain. Deterministic systems enforce.**

---

## 39. Event model

The Controller should consume normalized events:

```text
telemetry.updated / scores.updated
policy.updated
model_catalog.updated
pricing.updated
harness.updated
inference_state.updated
decision.expired
benchmark.completed
rollout.updated
```

Local mode can use an in-process event bus.

Cloud can use a durable queue/event system.

---

## 40. Local state

Use SQLite initially for local mode.

Core local entities:

```text
roles
tasks
evals
datasets
policies
inference_configs
signals and scores
benchmarks
decisions
desired_states
rollouts
adapter_state
model_catalog
```

Cloud uses PostgreSQL.

---

## 41. Decision Registry

Example:

```text
coding.executor@production
→ config_921

coding.reviewer@production
→ config_440

invoice.reader@production
→ config_228
```

CLI:

```bash
openmerit resolve coding.executor --env production
```

Response:

```json
{
  "role": "coding.executor",
  "environment": "production",
  "config_id": "config_921",
  "decision_id": "dec_8291",
  "confidence": "high",
  "validated_at": "2026-09-06T09:00:00Z",
  "fallback_config_id": "config_812"
}
```

---

## 42. Telemetry and score normalization

OpenMerit should not become a trace store.

Store only what is necessary for intelligence-state decisions and control.

```ts
type TelemetryWindow = {
  role: string
  executionProfileId: string
  source: TelemetrySource

  window: {
    start: string
    end: string
  }

  sampleSize?: number
  metrics: Record<string, MetricValue>
  segments?: Record<string, MetricSegment>
  freshness: string
}
```

Raw traces remain in source systems by default.

---

## 43. Adapter contracts

### Execution

```ts
interface ExecutionAdapter {
  id: string

  getCurrentState(
    role: string,
    environment: string
  ): Promise<ExecutionState>

  validatePlan(
    plan: RolloutPlan
  ): Promise<ValidationResult>

  applyPlan(
    plan: RolloutPlan
  ): Promise<ApplyResult>

  rollback?(
    rolloutId: string
  ): Promise<RollbackResult>
}
```

### Signals and Scores

```ts
interface TelemetryAdapter {
  id: string

  poll?(
    cursor?: string
  ): Promise<TelemetryBatch>

  subscribe?(
    handler: (event: TelemetrySignal) => Promise<void>
  ): Promise<Subscription>

  normalize(
    input: unknown
  ): Promise<TelemetryWindow[]>
}
```

### Harness

```ts
interface HarnessAdapter {
  id: string

  inspect(
    target: InspectTarget
  ): Promise<HarnessInspection>

  resolveRole?(
    role: string
  ): Promise<HarnessRoleContext>

  notifyDecision?(
    event: DecisionUpdatedEvent
  ): Promise<void>
}
```

---

## 44. Provider credentials

Default:

> **Credentials remain in the user's environment.**

Resolve from:

- environment variables
- cloud workload identity
- local secret managers
- provider SDK defaults
- existing gateway configuration

OpenMerit Cloud should not require provider credentials for core value.

---

## 45. Privacy modes

```text
LOCAL
nothing leaves environment

METRICS
normalized metrics only

HASHED
hashes + metrics

SELECTIVE
configured fields

HOSTED
OpenMerit stores benchmark data
```

The autonomous loop should work in `METRICS` mode.

---

## 46. Benchmark runner

Runner responsibilities:

- fetch plan
- resolve local credentials
- execute candidates
- collect runtime metrics
- execute deterministic scorers
- optionally execute judge scorers
- redact
- sign results
- submit normalized output

No provider secret needs to reach OpenMerit.

---

## 47. Policy engine

Example:

```yaml
requirements:
  task_success: ">= 0.91"
  json_validity: "== 1.0"
  p95_duration_ms: "< 12000"
  cost_per_success_usd: "< 0.90"

critical:
  regression_rate: "< 0.02"

optimize:
  - cost_per_success_usd
  - p95_duration_ms
```

Use a deterministic expression engine.

---

## 48. Controller output

```ts
type ControllerResult =
  | "no_change"
  | "benchmark_required"
  | "switch_recommended"
  | "switch_planned"
  | "canary_in_progress"
  | "promoted"
  | "rolled_back"
  | "human_review_required"
  | "insufficient_signals and scores"
  | "no_candidate_qualified"
```

---

## 49. Change-plan safety

Before apply:

1. validate policy
2. validate adapter capability
3. validate target
4. validate privacy
5. validate license
6. validate benchmark freshness
7. validate confidence
8. validate spend ceiling
9. generate rollback conditions

No autonomous change should bypass these checks.

---

## 50. Model intelligence catalog

Cloud catalog tracks:

- model family
- exact version
- release date
- open/closed
- license
- context
- modalities
- tool calling
- structured output
- reasoning controls
- providers
- regions
- pricing
- serving options
- quantizations
- deprecation
- generic benchmark priors
- harness compatibility

Every field may include:

```json
{
  "value": "...",
  "source": "...",
  "observed_at": "...",
  "confidence": "..."
}
```

---

## 51. Shadow mode

Before enabling autonomous writes:

```text
observe
→ decide
→ record what would have changed
→ do not apply
```

Measure:

- would-have-switched events
- expected gains
- false-positive switches
- missed regressions

Shadow mode is required for safe validation.

---

## 52. Progressive autonomy

Recommended maturity:

```text
read-only
→ recommendation
→ canary-only
→ autonomous rollout
→ autonomous rollback
```

Per-adapter capability levels:

### Execution

```text
L0 inspect
L1 recommend
L2 apply
L3 canary
L4 verify + rollback
```

### Signals and Scores

```text
E0 manual
E1 poll
E2 streaming
E3 segmented signals and scores
```

### Harness

```text
H0 static
H1 pull resolve
H2 cached resolution
H3 push updates
```

---

## 53. Hosted UI

Primary navigation:

```text
Roles
Decisions
Policies
Runs
Integrations
```

### Roles

```text
ROLE                STATE      PROFILE       HEALTH
coding.executor     current    config_921   healthy
coding.reviewer     stale      config_440   reconsider
invoice.reader      breach     config_228   controller
```

### Role detail

```text
Overview
Policy
Signals and Scores
Candidates
Benchmarks
Decisions
Rollouts
```

### Integrations

Visually split into:

```text
HARNESS
EVIDENCE
EXECUTION
```

This reinforces the category.

---

## 54. Design principles

- infrastructure aesthetic
- terminal-native identity
- muted colors
- low visual noise
- no gradient-heavy AI SaaS styling
- tables are first-class
- charts only when explanatory
- every score inspectable
- every autonomous action attributable
- signals and scores / policy / decision / execution clearly separated
- no magic universal model score

---

## 55. API

Prefix:

```text
/api/v1
```

### Roles

```text
GET    /roles
POST   /roles
GET    /roles/:id
POST   /roles/:id/resolve
POST   /roles/:id/controller/run
```

### Policies

```text
GET    /policies/:id
POST   /policies
PATCH  /policies/:id
POST   /policies/:id/validate
```

### Signals and Scores

```text
POST   /signals and scores
GET    /roles/:id/signals and scores
```

### Evals

```text
POST   /evals/generate
POST   /evals
GET    /evals/:id
POST   /evals/:id/validate
```

### Candidates

```text
POST   /roles/:id/candidates/search
```

### Benchmarks

```text
POST   /benchmarks/plan
POST   /benchmarks/:id/results
GET    /benchmarks/:id
```

### Decisions

```text
GET    /decisions/:id
GET    /decisions/:id/explain
GET    /roles/:id/decision
```

### Desired state

```text
GET    /roles/:id/desired-state
POST   /roles/:id/change-plan
```

### Rollouts

```text
POST   /rollouts
POST   /rollouts/:id/promote
POST   /rollouts/:id/rollback
GET    /rollouts/:id
```

---

## 56. Machine response envelope

```ts
type OpenMeritResponse<T> = {
  ok: boolean
  data?: T
  warnings?: Warning[]
  nextActions?: Action[]
  humanReviewRequired?: boolean
  traceId: string
}
```

Agents should never infer next actions by parsing prose.

---

## 57. Versioning

Historical decision dependencies must be immutable.

Every Decision Record references exact versions of:

- role
- task
- eval
- dataset
- policy
- inference configuration
- model metadata
- pricing
- signals and scores
- benchmark

---

## 58. Security

### Never log

- API keys
- provider secrets
- cloud tokens
- endpoint credentials

### Cloud roles

```text
Owner
Admin
PolicyEditor
Operator
Runner
Viewer
```

### Audit

Record:

- policy change
- adapter change
- benchmark
- decision
- desired-state change
- rollout
- rollback
- human override

---

## 59. Human override

Humans may:

```text
pin profile
pause controller
disable provider
override policy
rollback
force reevaluation
```

Overrides must be:

- recorded
- visible
- optionally expiring
- readable by agents

Example:

```yaml
override:
  role: coding.executor
  profile: config_812
  reason: provider incident
  expires: 2026-09-07T12:00:00Z
```

---

## 60. Product levels

### Level 1 — Model / execution decision

> What should I use?

### Level 2 — Continuous optimization

> Is this still what I should use?

### Level 3 — Autonomous intelligence control

> Keep this role on the best known qualified intelligence automatically.

v1 architecture supports all three.

---

## 61. Hosted pricing philosophy

Do not price by inference tokens.

Possible meters:

- managed roles
- active controllers
- team size
- retained history
- hosted model intelligence
- managed challenger watches
- fleet analytics

OSS local control remains free.

---

## 62. Product metrics

North star:

> **Number of roles continuously maintained by OpenMerit.**

Supporting:

- validated decisions
- autonomous Controller actions
- successful switches
- successful canaries
- rollbacks
- estimated savings
- quality regressions prevented
- decision freshness
- harness integrations
- signals and scores integrations
- execution integrations

Do not use routed token volume as a success metric.

---

## 63. OSS adoption strategy

The strongest validation is not signups.

It is:

> **A respected harness treats intelligence resolution as a first-class extension point.**

Ideal:

```text
Pi        ✓
Hermes    ✓
OpenClaw  ✓
Prime     ✓
Custom    ✓
```

Common flow:

```text
role + context + policy
        ↓
OpenMerit
        ↓
inference configuration
```

Trying OpenMerit must be easier than implementing custom decision logic.

Removing it must be trivial.

---

## 64. Adapter contribution strategy

Community should own the long tail.

Provide:

- adapter interfaces
- fixtures
- conformance tests
- reference implementations

Example:

```bash
openmerit adapter test ./my-adapter
```

Output:

```text
✓ protocol
✓ inspect
✓ dry-run
✓ apply
✓ rollback
```

---

## 65. Open protocol packages

Publish independently:

```text
@openmerit/protocol
openmerit-protocol-python
```

A harness/vendor should be able to implement the protocol without importing the full OpenMerit runtime.

---

## 66. Validation strategy

### Test 1 — Non-obvious decisions

Does OpenMerit produce useful decisions that differ from:

- generic leaderboard
- static frontier default
- cheapest model default

If not, the thesis is weak.

### Test 2 — Material value

Aim for outcomes like:

```text
same quality envelope
30–70% lower cost
```

or:

```text
same cost
materially higher success rate
```

### Test 3 — Harness willingness

Ask harness maintainers:

> Would you expose a `resolve intelligence` hook instead of owning this entire decision stack internally?

### Test 4 — Decision volatility

Run shadow mode.

Measure:

- challenger events
- meaningful re-evaluations
- validated switches
- regressions avoided

If almost nothing changes, the control-plane need is weak.

---

## 67. Existential risks

### Harnesses internalize model-role selection

Mitigation:

- neutral cross-harness intelligence
- open protocol
- local-first
- cross-provider signals and scores

### Observability platforms absorb autonomous decision loops

Mitigation:

- signals and scores-neutral
- harness-native
- inference-neutral
- open Controller

### Routers absorb dynamic model selection

Mitigation:

OpenMerit does not make per-request routing decisions.

It maintains **desired state**.

### Vertically integrated stacks dominate

If:

```text
Claude harness → Claude
Codex → OpenAI
Gemini → Gemini
```

becomes universally optimal, OpenMerit gets squeezed.

The bet assumes persistent model/provider/harness heterogeneity.

### Evals are wrong

Mitigation:

- confidence
- canaries
- rollback
- production corroboration
- critical metrics
- freshness
- explicit `insufficient_signals and scores`

---

## 68. Honesty requirement

Never claim:

> “This is the best model.”

Canonical claim:

> **This is the best known qualified inference configuration under the current policy, telemetry, and eval scores.**

That language should shape the entire product.

---

## 69. First implementation

Do not begin with the full cloud product.

Build one complete loop.

### Harness

Choose:

```text
Pi or Hermes
```

### Signals and Scores

Choose:

```text
OpenTelemetry/OpenInference
or Langfuse
or Braintrust
```

### Execution

Choose:

```text
static config
or LiteLLM
or vLLM
```

Implement:

```text
signals and scores
   ↓
policy
   ↓
challenger benchmark
   ↓
decision
   ↓
desired state
   ↓
config change
   ↓
observe
   ↓
keep / rollback
```

CLI first.

No dashboard required.

---

## 70. Build phases

### Phase 0 — Protocol + domain kernel

Build:

- Model Resolution Request
- Signals and Scores
- Desired State
- Policy
- Inference Configuration
- Decision Record
- Rollout Plan

### Phase 1 — Static resolver

Build:

```text
role → profile
```

with local registry and fallback.

### Phase 2 — Eval + benchmark

Build:

- `.eval.md`
- local runner
- deterministic scorers
- provider adapters
- comparison
- Pareto
- equivalence

### Phase 3 — Telemetry and score ingestion

Build:

- generic JSON
- OTel/OpenInference
- one native observability adapter

### Phase 4 — Controller

Build:

- SLO evaluation
- stale decision detection
- challenger workflow
- no-op
- insufficient signals and scores
- desired state

### Phase 5 — Execution

Build:

- static config writer
- one live adapter
- canary
- rollback

### Phase 6 — Harness

Build:

- one native harness adapter
- pull resolve
- cached fallback
- push updates

### Phase 7 — MCP + TUI

Expose existing domain primitives.

### Phase 8 — Cloud

Add:

- model intelligence
- challenger discovery
- hosted coordination
- team/fleet views

---

## 71. v1 acceptance criteria

v1 is done only when all are true:

1. A harness can request an role via open protocol.
2. OpenMerit resolves it to an inference configuration.
3. Production inference does not pass through OpenMerit.
4. OpenMerit operates entirely locally.
5. Provider credentials remain local if desired.
6. Raw production data can remain local.
7. OpenMerit can consume normalized signals and scores.
8. OpenMerit detects an SLO breach.
9. OpenMerit can discover or accept challengers.
10. OpenMerit can benchmark challengers.
11. Hard constraints are enforced.
12. Pareto dominance is computed.
13. Equivalence margins are supported.
14. OpenMerit emits desired state.
15. An execution adapter can apply state.
16. OpenMerit can perform a canary.
17. OpenMerit can promote or rollback.
18. A Decision Record is generated.
19. CLI supports non-interactive JSON.
20. MCP exposes core decision primitives.
21. TUI is optional.
22. Cloud is optional.
23. Cached fallback works when cloud is unavailable.
24. At least one harness integration works end-to-end.
25. At least one observability/eval integration works end-to-end.
26. At least one execution integration works end-to-end.
27. Full local autonomous loop is MIT.
28. Enterprise code is not required for local autonomy.

---

## 72. Example autonomous flow

Policy:

```yaml
role: support.classifier

requirements:
  accuracy: ">= 0.98"
  security_recall: ">= 0.995"
  p95_latency_ms: "< 700"

optimize:
  primary: cost

autonomy:
  model_switch: true
  provider_switch: true
```

Current:

```text
Claude-X
accuracy           98.4%
security recall    99.7%
p95                610ms
cost               $0.0018
```

New challenger:

```text
Qwen-Y
accuracy           98.3%
security recall    99.7%
p95                490ms
cost               $0.0004
```

Decision:

```text
quality difference inside equivalence margin
all hard requirements satisfied
77% lower cost
```

Rollout:

```text
5% → 20% → 50% → 100%
```

Observability confirms:

```text
quality stable
errors stable
latency improved
cost improved
```

OpenMerit:

```text
PROMOTE
```

No human required.

---

## 73. Example harness flow

```ts
const profile = await openmerit.resolve({
  role: "coding.executor",
  harness: {
    id: "pi",
    version: PI_VERSION
  },
  workload: {
    estimatedContextTokens: 120000,
    languages: ["typescript"]
  }
})
```

If resolution is unavailable:

```ts
profile =
  cache.lastKnownGood("coding.executor")
  ?? config.staticFallback
```

Harness executes inference itself.

---

## 74. Example observability flow

Telemetry/eval source reports:

```text
coding.executor task success = 88.4%
```

Policy requires:

```text
task success >= 91%
```

OpenMerit emits:

```text
benchmark_required
```

It does not immediately switch models without validation unless policy explicitly permits that behavior.

---

## 75. Example execution flow

OpenMerit emits:

```yaml
target:
  model: qwen-x
  provider: internal-vllm
```

The execution adapter translates desired state into infrastructure-specific configuration.

OpenMerit does not carry the actual model request.

---

## 76. Homepage direction

Hero:

> **Keep every agent on the right intelligence.**

Subhead:

> Open-source control infrastructure connecting agent harnesses, production signals and scores, and inference systems — with a Controller continuously maintaining which inference configuration should be running.

Alternative:

> **The open-source intelligence control plane between agent harnesses and inference.**

Avoid:

- unified AI platform
- one API for all models
- route every model through us
- AI observability
- universal gateway

---

## 77. Documentation

```text
Why OpenMerit
  The missing control loop
  Harness vs OpenMerit vs inference vs observability

Concepts
  Intelligence roles
  Execution profiles
  Policies
  Signals and Scores
  Desired state
  Controller
  Decisions
  Rollouts

Protocols
  Model Resolution Request
  Signals and Scores
  Desired State

Quickstarts
  CLI
  Pi
  Hermes
  OpenClaw
  Langfuse
  Braintrust
  OpenTelemetry
  LiteLLM
  vLLM

Guides
  Replace an expensive model
  Autonomous canary
  Local-only mode
  Internal model vs frontier
  Multi-role optimization
  Shadow mode

Reference
  CLI
  TUI
  MCP
  SDK
  API
  .eval.md
  config.toml
```

---

## 78. Initial integrations

### Harness

1. Pi
2. Hermes
3. OpenClaw or Prime Agent

### Signals and Scores

1. OpenTelemetry/OpenInference
2. Langfuse
3. Braintrust

### Execution

1. static config / generic resolver
2. LiteLLM or Portkey
3. vLLM / Kubernetes

The goal is to prove all three seams, not maximize integration count.

---

## 79. Long-term standardization opportunity

OpenTelemetry answers:

> **How do systems describe what happened?**

OpenMerit should aim to standardize:

> **How do autonomous AI systems describe what intelligence should be running, under which policy, and based on what signals and scores?**

Do not lead with “standard.”

Earn that role through useful OSS and adoption.

---

## 80. Core invariant

At any moment:

```text
desired_state(role)
```

means:

> **the best known qualified inference configuration under current policy, telemetry, and eval scores.**

The Controller continuously attempts to move:

```text
actual_state(role)
→
desired_state(role)
```

safely.

---

## 81. Final boundary test

If a feature answers:

> **How does the agent plan, use tools, or manage memory?**

It belongs to the harness.

If it answers:

> **How do I serve or transport this inference request?**

It belongs to inference infrastructure.

If it answers:

> **What happened during execution?**

It belongs to observability/evals.

If it answers:

> **What intelligence configuration should this role currently use, and should it change based on signals and scores?**

It belongs to OpenMerit.

---

## 82. North-star statement

> **OpenMerit is an open-source intelligence control plane for autonomous agents. Harnesses declare what intelligence they need, observability systems provide signals and scores of what is happening, and the Controller continuously maintains the best known inference configuration by coordinating with any inference infrastructure — without sitting in the inference path.**
