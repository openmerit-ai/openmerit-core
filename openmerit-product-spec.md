# Model Decision Layer — Product & Technical Specification

> **Status:** Build-ready v0.1 specification  
> **Audience:** Coding agents, product engineers, design engineers  
> **Working category:** Model Decision Infrastructure  
> **Working product name:** OpenMerit (placeholder; rename without changing the product model)  
> **Last updated:** 2026-09-05

---

## 0. Executive summary

OpenMerit is the **decision layer between model supply/inference infrastructure and application evaluation/observability**.

It answers one narrow, high-value question:

> **For this exact task, which model or model configuration should I use, given my quality, latency, cost, privacy, deployment, and licensing constraints?**

OpenMerit is **not** an inference router, model gateway, token reseller, GPU cloud, or production observability platform.

The platform should be useful to both humans and coding agents. Humans can describe a task, author an eval, inspect comparisons, and understand decisions. Coding agents should be able to invoke the same capabilities programmatically while working inside a repository.

The key architectural rule is:

> **Inference does not flow through OpenMerit.**

Users bring their own provider credentials, endpoints, local models, or private infrastructure. Benchmark runs execute either in the user's environment through a local runner or directly against providers from an execution environment controlled by the user. OpenMerit receives only the metadata/results required to compute and store comparisons, subject to the user's privacy settings.

The business model is intentionally asymmetric:

- **Free:** task definition, eval/rubric authoring, scorer generation, dataset scaffolding, local/manual execution, exportable eval specifications.
- **Premium:** candidate model discovery, automated comparisons, cost/latency analysis, Pareto analysis, model recommendations, decision records, continuous re-benchmarking, team workflows, agent/CI automation, governance.

The long-term goal is for both humans and agents to develop a simple habit:

> **Need to choose or reconsider a model? Ask OpenMerit instead of guessing.**

---

# 1. Product thesis

Modern AI infrastructure has strong products for three adjacent jobs:

1. **Model access and execution**
   - model providers
   - inference clouds
   - hosted endpoints
   - local/self-hosted inference
   - routers and gateways

2. **Application construction**
   - SDKs
   - agent frameworks
   - orchestration
   - retrieval systems

3. **Evaluation and observability**
   - traces
   - datasets
   - experiment tracking
   - production monitoring
   - prompt/eval tooling

The missing abstraction is the **model decision itself**.

A developer can already ask:

- “How do I call model X?”
- “How is my app behaving?”
- “What happened in this trace?”

But the answer to this question is still mostly manual:

> “Should I use model X, Y, or Z for this particular job?”

Generic leaderboards do not solve this because there is no globally best model. A useful decision is conditional on:

- task type
- representative workload
- success thresholds
- critical failure modes
- context size
- structured output requirements
- modalities
- latency constraints
- cost envelope
- deployment constraints
- privacy requirements
- model/provider availability
- licensing restrictions

OpenMerit owns the transformation:

```text
task
  ↓
what good means
  ↓
what models are plausible
  ↓
how to compare them fairly
  ↓
which options are non-dominated
  ↓
what should be used
  ↓
why
```

The product is not the eval.

**The product is the decision.**

---

# 2. Category and positioning

## 2.1 Category

Use the category:

> **Model Decision Infrastructure**

Alternative explanatory phrase:

> **The decision layer between models and applications.**

Do not position the company primarily as:

- an eval platform
- an observability product
- a router
- an inference gateway
- a benchmark leaderboard
- an AI gateway

Those are mechanisms or neighboring categories.

## 2.2 Canonical positioning statement

> **OpenMerit benchmarks available models against your actual task and tells humans and agents which one to use, based on quality, performance, cost, and constraints.**

## 2.3 Neighbor map

```text
MODEL SUPPLY / EXECUTION
──────────────────────────────────────────
OpenAI / Anthropic / Google / Mistral
Hugging Face / Together / Fireworks
Replicate / Modal / Bedrock / Vertex
vLLM / local / internal endpoints
Routers / gateways

                 ↓ candidate execution

┌────────────────────────────────────────┐
│             OPENMERIT                  │
│       MODEL DECISION LAYER             │
│                                        │
│ task → eval → candidates → benchmark   │
│ → Pareto frontier → recommendation     │
│ → decision record                      │
└────────────────────────────────────────┘

                 ↓ chosen model/config

APPLICATION / AGENT
──────────────────────────────────────────

                 ↓ production behavior

EVAL / OBSERVABILITY
──────────────────────────────────────────
Braintrust / Langfuse / LangSmith
Arize / Datadog / custom telemetry
```

OpenMerit should interoperate with both sides and remain neutral.

## 2.4 One-line differentiation

- Providers answer: **“How can I run this model?”**
- OpenMerit answers: **“Which model should I run for this task?”**
- Observability platforms answer: **“How is my AI system behaving?”**

---

# 3. Product principles

These are product constraints, not suggestions.

## 3.1 Never become the hot path

Production inference must not require OpenMerit.

If OpenMerit is down, the customer's production application must continue to operate.

## 3.2 Do not sell or proxy tokens

OpenMerit must not:

- resell API tokens
- add margin to inference
- route production inference
- become a provider marketplace
- optimize traffic based on provider kickbacks

This preserves neutrality.

## 3.3 Task-first, not model-first

The primary object is the **Task Specification**.

Users should not have to start by selecting models.

## 3.4 Decision-first, not leaderboard-first

Do not produce generic rankings as the main output.

Produce:

- qualification
- tradeoffs
- Pareto frontier
- threshold satisfaction
- recommendation
- uncertainty
- explanation

## 3.5 Agent-first, not “UI + MCP later”

Every core product capability must be designed as a stable machine-callable primitive before UI implementation.

The web UI is a first-party client of the same domain/API layer used by:

- MCP
- CLI
- CI
- coding agents
- SDKs

## 3.6 Exportable and interoperable

Users must be able to export:

- task specs
- eval definitions
- datasets where permitted
- scorer definitions
- benchmark results
- decision records

Avoid lock-in as a business strategy.

## 3.7 Privacy by default

The product should work even when raw production examples cannot leave the user's environment.

Support metadata-only result uploads.

---

# 4. Non-goals

Do not build these in v0/v1 unless a later spec explicitly changes scope:

- production inference proxy
- model routing
- provider failover
- prompt gateway
- token metering gateway
- GPU hosting
- GPU scheduler
- generic production tracing
- generic application observability
- RAG platform
- prompt management suite
- agent orchestration framework
- full annotation workforce product
- generic leaderboard website
- model fine-tuning platform
- model hosting
- provider billing aggregation

The product may **integrate** with systems that do these things.

---

# 5. Primary users

## 5.1 Human: AI/product engineer

Typical question:

> “We currently use Claude for this feature. Is there a cheaper model with statistically equivalent quality?”

Needs:

- task-specific comparison
- reproducible benchmark
- cost and latency
- failure examples
- confidence
- clear recommendation

## 5.2 Human: technical founder / engineering lead

Typical question:

> “What model should we use for this feature?”

Needs:

- low setup cost
- defensible recommendation
- little eval expertise required
- ability to share decision record

## 5.3 Human: ML/platform engineer

Typical question:

> “Can our internal model beat hosted frontier models for this workload?”

Needs:

- private endpoints
- local runner
- custom scorers
- reproducibility
- version control
- data residency controls

## 5.4 Machine: coding agent

Typical instruction:

> “We are spending too much on this feature. See what model we should use.”

Needs:

- discover current model usage
- infer task
- create or find eval
- identify candidates
- invoke user-side benchmark execution
- compare
- make recommendation
- return a machine-readable decision
- optionally modify implementation

Coding agents are a first-class persona, not an integration persona.

---

# 6. Core domain objects

## 6.1 Workspace

Top-level tenant.

Fields:

- `id`
- `name`
- `slug`
- `plan`
- `privacy_mode`
- `created_at`

## 6.2 Project

A logical application/repository/product.

Fields:

- `id`
- `workspace_id`
- `name`
- `repo_url?`
- `default_constraints`
- `created_at`

## 6.3 Task

Human-readable job definition.

Examples:

- classify support tickets
- extract fields from invoices
- summarize legal documents
- patch TypeScript bugs
- answer product questions
- generate product descriptions

Fields:

```ts
type Task = {
  id: string
  projectId: string
  slug: string
  name: string
  description: string
  taskType: TaskType
  modalities: Modality[]
  expectedInputShape?: JSONSchema
  expectedOutputShape?: JSONSchema
  contextProfile?: ContextProfile
  constraints: TaskConstraints
  riskProfile: RiskProfile
  version: number
  createdAt: string
  updatedAt: string
}
```

## 6.4 Eval Spec

Defines how to measure success on a Task.

Contains:

- dimensions
- weights
- hard requirements
- critical failures
- scorers
- judge prompts if used
- dataset requirements
- sampling strategy
- normalization
- aggregation
- minimum sample size
- confidence policy

## 6.5 Dataset

Collection of benchmark cases.

A case may contain:

- input
- expected output
- metadata
- source category
- difficulty
- tags
- privacy mode
- attachments
- expected failure conditions

Datasets must support local-only mode.

## 6.6 Candidate

A model plus execution configuration.

A candidate is not only a model name.

```ts
type Candidate = {
  modelId: string
  providerId?: string
  endpointId?: string
  revision?: string
  quantization?: string
  servingRuntime?: string
  hardwareProfile?: string
  temperature?: number
  maxOutputTokens?: number
  structuredOutputMode?: string
  promptVariantId?: string
}
```

Two deployments of the same model may be different candidates.

## 6.7 Benchmark Run

Execution of one or more candidates against an eval version.

## 6.8 Observation

One candidate × one test case execution.

May contain:

- output or output hash
- score dimensions
- latency
- token counts
- provider reported cost
- locally computed cost
- errors
- retries
- metadata

## 6.9 Comparison

Statistical comparison across candidates.

## 6.10 Decision

Final recommendation generated from:

- task
- eval
- dataset
- benchmark
- constraints
- comparison

## 6.11 Model Decision Record (MDR)

Shareable, immutable snapshot explaining a decision.

---

# 7. Free vs premium boundary

## 7.1 Free: eval authoring

The free product should be legitimately useful.

Free capabilities:

- create Task
- describe Task in natural language
- AI-assisted Task normalization
- generate Eval Spec
- edit Eval Spec
- generate scorer skeletons
- generate judge rubrics
- generate dataset structure
- create synthetic starter cases with warnings
- import CSV/JSONL
- create `.eval.md`
- export Eval Spec
- run eval locally/manual
- inspect local results
- public eval templates
- community eval templates
- basic single-model execution summaries
- basic score calculations
- SDK/CLI for local eval execution

Free users should be able to leave OpenMerit with a high-quality portable eval.

## 7.2 Premium: decisions and automation

Premium capabilities:

- automatic candidate discovery
- model intelligence search
- model/provider configuration recommendations
- multi-model benchmark orchestration
- automatic cost normalization
- latency/throughput comparison
- quality/cost/performance Pareto frontier
- statistical equivalence analysis
- recommendation engine
- confidence scoring
- failure clustering
- decision records
- decision history
- continuous re-evaluation
- model release watches
- team workflows
- approvals
- agent automation
- CI benchmark gates
- private organization catalogs
- observability integrations
- governance/audit trails

Principle:

> **Creating the test is free. Asking OpenMerit to make and maintain the model decision is paid.**

---

# 8. Main human user flows

## 8.1 Flow A — Free eval creation

### Entry

Homepage CTA:

> **Describe what your model needs to do.**

Input:

```text
We receive support emails and classify each into one of 14 queues.
Wrongly routing billing or security issues is much worse than other mistakes.
Output must be JSON.
p95 should be under 700 ms.
```

### System behavior

1. Parse description.
2. Propose Task Spec.
3. Ask only for information required to make the eval useful.
4. Generate Eval Spec.
5. Explain each metric in plain language.
6. Scaffold dataset requirements.
7. Offer starter synthetic cases.
8. Save version.

### Output

```text
Task
support-routing

Hard requirements
- valid JSON: 100%
- security false-negative rate: <0.5%
- billing false-negative rate: <1%
- p95 latency: <700ms

Weighted quality
- route accuracy: 60%
- high-risk recall: 30%
- schema validity: 10%

Recommended dataset
- 80 normal examples
- 20 ambiguous examples
- 20 billing/security examples
- 10 adversarial examples
```

Primary CTA:

> **Export eval**

Secondary premium CTA:

> **Find the best model for this task**

## 8.2 Flow B — Premium model decision

Input:

- existing Task + Eval
- dataset
- provider/endpoint capabilities available to local runner
- optional candidate constraints

User clicks:

> **Find candidates**

System:

1. Filter impossible candidates.
2. Rank plausible candidates.
3. Explain why each is worth testing.
4. Propose small screening benchmark.
5. Run screening locally via runner.
6. Remove clearly dominated candidates.
7. Run full benchmark.
8. Compute comparison.
9. Generate recommendation.
10. Generate MDR.

## 8.3 Flow C — Replace expensive production model

User:

> “Can we replace Claude here?”

System:

1. Treat current model as incumbent.
2. Require incumbent benchmark baseline.
3. Search plausible lower-cost alternatives.
4. Test challenger models.
5. Evaluate statistical equivalence and threshold satisfaction.
6. Estimate savings at provided workload.
7. Recommend:
   - replace
   - keep current
   - use conditional split
   - insufficient evidence

## 8.4 Flow D — Internal model vs frontier

User adds:

```text
candidate: internal://claims-13b-v7
```

Runner resolves this privately.

OpenMerit compares only benchmark results.

Decision can say:

> Internal model clears all quality thresholds and is cheaper at current utilization.

Raw endpoint credentials never reach OpenMerit.

---

# 9. Agent-first experience

## 9.1 Agent behavioral contract

The platform should teach agents:

> Use OpenMerit when selecting, comparing, reconsidering, or justifying an AI model for a specific application task.

Do not use OpenMerit for:

- production inference execution
- generic tracing
- generic provider routing
- general model chat

## 9.2 Canonical coding-agent flow

Human says:

> “We’re spending too much on this feature. Optimize it.”

Coding agent:

1. scans repository
2. identifies current model call
3. infers feature/task
4. calls OpenMerit `task.analyze`
5. finds or creates Task
6. calls `eval.create`
7. gathers representative test cases from existing tests/fixtures/log exports if allowed
8. calls `models.search`
9. asks local runner to execute candidates
10. calls `eval.compare`
11. calls `decision.recommend`
12. reports decision to user
13. optionally changes code after user authorization

## 9.3 MCP surface

Keep the MCP surface small.

### Required tools

```text
task.analyze
task.get
task.upsert

eval.create
eval.get
eval.validate

models.search
models.inspect

benchmark.plan
benchmark.submit_results
benchmark.get

decision.recommend
decision.explain
decision.get
```

Later:

```text
decision.watch
decision.refresh
integrations.export
```

Avoid exposing dozens of low-level database CRUD calls.

## 9.4 Example MCP description

```text
Use OpenMerit when you need to select, compare, reconsider, or justify
an AI model for a specific application task.

OpenMerit does not execute production inference.

Use it to:
- define what success means for a task
- create task-specific evaluations
- identify candidate models/configurations
- compare benchmark results
- analyze quality, latency and cost tradeoffs
- recommend and explain a model decision
```

## 9.5 Machine-readable responses

Every MCP response must include:

```ts
type AgentResponse<T> = {
  ok: boolean
  data?: T
  warnings?: AgentWarning[]
  nextActions?: AgentAction[]
  humanReviewRequired?: boolean
  traceId: string
}
```

Do not force agents to scrape prose.

---

# 10. Repository-native `.eval.md`

Support a portable repository specification.

Recommended location:

```text
/openmerit/
  support-routing.eval.md
  invoice-extraction.eval.md
  coding-agent.eval.md
```

## 10.1 Example

```md
---
openmerit: 1
task: support-routing
task_id: task_123
dataset: om://acme/support-routing-v4
---

# Support routing

## Objective

Classify incoming support requests into one of 14 queues.

## Priorities

high-risk recall > overall accuracy > latency > cost

## Hard constraints

- valid JSON = 100%
- security false-negative rate < 0.5%
- billing false-negative rate < 1%
- p95 latency < 700ms

## Critical failures

- route security reports to general support
- omit required queue field
- invent unsupported queue values

## Output schema

```json
{
  "type": "object",
  "required": ["queue", "confidence"],
  "properties": {
    "queue": { "type": "string" },
    "confidence": { "type": "number" }
  }
}
```

## Scorers

- exact_queue_match
- high_risk_recall
- json_schema
- latency_p95
- normalized_cost

## Candidate policy

- text models only
- context >= 16k
- structured output support preferred
- exclude models with incompatible commercial licenses
```

## 10.2 Design rules

- human-readable
- agent-readable
- valid in Git
- diffable
- versionable
- no secrets
- references platform objects using stable URIs
- local-only dataset references allowed

---

# 11. Eval generation system

## 11.1 Goal

Turn a vague natural-language task into a rigorous, auditable Eval Spec.

This is the primary free wedge.

## 11.2 Task analysis pipeline

Input:

- task description
- optional code context
- optional example inputs/outputs
- optional schema
- optional constraints

Produce:

1. task classification
2. modalities
3. determinism level
4. expected output structure
5. failure taxonomy
6. risk profile
7. evaluation dimensions
8. hard constraints
9. suggested scoring methods
10. dataset composition plan
11. minimum viable sample size
12. recommended judge usage
13. known limitations

## 11.3 Evaluation dimension types

Support:

### Deterministic

- exact match
- normalized exact match
- JSON schema validation
- regex
- numeric tolerance
- set equality
- classification accuracy
- precision
- recall
- F1
- tool-call correctness
- test pass rate

### Structured semantic

- field-level semantic equivalence
- citation correctness
- entity extraction
- factual consistency

### LLM judge

- rubric score
- pairwise preference
- categorical judgment
- critique-based scoring

### Runtime

- TTFT
- end-to-end latency
- p50
- p95
- p99
- output tokens/sec
- total tokens
- failures
- retries
- timeouts

### Economic

- input token cost
- output token cost
- request cost
- GPU runtime cost
- cost per successful case
- cost per 1k tasks
- monthly workload estimate

## 11.4 Hard constraints vs weighted objectives

Never collapse every requirement into one weighted score.

Example:

```text
HARD
JSON validity = 100%
security recall >= 99.5%
p95 latency <= 700ms

OPTIMIZE
accuracy ↑
cost ↓
latency ↓
```

A candidate that violates a hard constraint cannot be the recommendation regardless of aggregate score.

## 11.5 Critical failures

Critical failures must be counted separately.

A model with a high mean quality score but repeated catastrophic failures should be visibly penalized or disqualified.

---

# 12. Dataset system

## 12.1 Dataset modes

Support:

- hosted
- encrypted hosted
- metadata-only
- local-only

## 12.2 Case schema

```ts
type EvalCase = {
  id: string
  inputRef?: string
  input?: unknown
  expected?: unknown
  metadata: Record<string, unknown>
  tags: string[]
  difficulty?: "easy" | "medium" | "hard" | "adversarial"
  weight?: number
  privacy: "hosted" | "encrypted" | "local"
}
```

## 12.3 Representative data rules

UI must strongly distinguish:

- synthetic starter data
- curated eval data
- sampled production data

Never imply synthetic-only benchmarks are production-grade evidence.

## 12.4 Dataset health

Compute:

- class balance
- difficulty balance
- duplicated cases
- near-duplicates
- missing expected values
- scorer coverage
- segment coverage

Premium can add deeper dataset diagnostics later.

---

# 13. Candidate discovery

This is premium and strategically central.

## 13.1 Candidate search inputs

```ts
type CandidateSearchInput = {
  taskId: string
  requiredModalities: Modality[]
  minimumContext?: number
  maxCostPerRequest?: number
  maxP95Latency?: number
  deploymentModes?: DeploymentMode[]
  allowedProviders?: string[]
  excludedProviders?: string[]
  openWeightsOnly?: boolean
  commercialUseRequired?: boolean
  regionRequirements?: string[]
  structuredOutputRequired?: boolean
  toolCallingRequired?: boolean
  minimumReleaseDate?: string
}
```

## 13.2 Candidate universe

Maintain a model intelligence catalog containing:

- model family
- exact version
- release date
- open/closed status
- license
- modalities
- context
- structured output
- tool use
- input/output pricing by provider
- deployment requirements
- known providers/endpoints
- hardware profiles
- quantization variants
- broad benchmark priors
- deprecation status

Do not over-index on generic benchmark scores.

They are **priors for candidate selection**, not final evidence.

## 13.3 Discovery algorithm v0

1. eliminate incompatible models
2. group candidates by role:
   - quality ceiling
   - likely production balance
   - economical
   - open/self-hostable
   - incumbent
3. score candidate relevance using task metadata + model metadata
4. return 3–8 candidates
5. explain inclusion/exclusion

Example:

```json
{
  "candidate": "provider/model-x",
  "role": "economic_challenger",
  "why": [
    "supports structured output",
    "context requirement satisfied",
    "low expected cost",
    "strong prior on classification"
  ],
  "confidence": 0.74
}
```

## 13.4 Never claim discovery equals decision

Candidate discovery should use language like:

> “Worth testing”

not:

> “Best model”

until task-specific benchmark evidence exists.

---

# 14. Benchmark planning

## 14.1 Two-stage benchmark

Default premium flow:

### Stage 1 — screening

- smaller stratified subset
- all plausible candidates
- enough to eliminate obviously poor candidates
- optimized for low benchmark cost

### Stage 2 — full comparison

- full dataset or statistically justified sample
- only surviving candidates
- repeated runs where stochasticity matters
- capture complete metrics

## 14.2 Benchmark plan output

```ts
type BenchmarkPlan = {
  taskId: string
  evalVersion: string
  candidates: Candidate[]
  stages: BenchmarkStage[]
  estimatedCalls: number
  estimatedLocalCost?: MoneyRange
  stopConditions: StopCondition[]
}
```

---

# 15. Local runner and BYO execution

This is one of the most important product decisions.

## 15.1 Rule

Provider secrets should remain in the user's environment whenever possible.

OpenMerit does not need to become a credential vault to deliver the core product.

## 15.2 Runner modes

### A. Local CLI

```bash
openmerit run support-routing \
  --candidates openai:gpt-x,anthropic:claude-x,local:qwen
```

Credentials resolved from:

- environment variables
- provider SDK defaults
- local secret managers
- runner config

### B. CI runner

GitHub Actions / GitLab / generic CI.

### C. Customer-hosted runner

Long-running daemon inside VPC.

### D. Browser-triggered local runner

Later: web UI requests a benchmark; authenticated runner pulls a signed job.

## 15.3 Runner responsibilities

- fetch benchmark plan
- resolve provider adapters
- resolve local endpoints
- execute cases
- record runtime metrics
- calculate deterministic scorers locally
- optionally run judge scorers locally
- redact configured fields
- upload result envelope

## 15.4 Result envelope

```ts
type BenchmarkResultEnvelope = {
  benchmarkId: string
  runnerId: string
  candidate: CandidateIdentity
  caseId: string
  scores: Record<string, number | boolean | string>
  runtime: {
    startedAt: string
    completedAt: string
    latencyMs: number
    ttftMs?: number
    inputTokens?: number
    outputTokens?: number
  }
  economics?: {
    reportedCostUsd?: number
    computedCostUsd?: number
  }
  output?: unknown
  outputHash?: string
  error?: RunnerError
  metadata?: Record<string, unknown>
}
```

## 15.5 Privacy controls

Per Task:

```text
Upload raw inputs?        yes/no
Upload raw outputs?       yes/no
Upload scorer traces?     yes/no
Upload hashes?            yes/no
Upload only aggregates?   yes/no
```

OpenMerit must still be usable with:

```text
raw inputs: no
raw outputs: no
aggregated metrics: yes
```

---

# 16. Provider adapter contract

Runner adapters must normalize heterogeneous providers.

```ts
interface ModelAdapter {
  id: string

  supports(candidate: Candidate): Promise<SupportResult>

  invoke(
    input: ModelInput,
    candidate: Candidate,
    ctx: InvocationContext
  ): Promise<ModelInvocationResult>

  estimateCost?(
    usage: TokenUsage,
    candidate: Candidate
  ): Promise<Money>
}
```

Initial adapters:

- OpenAI-compatible
- Anthropic-compatible
- Google-compatible
- Hugging Face endpoint
- generic HTTP endpoint
- local OpenAI-compatible/vLLM

Do not hard-code product architecture around any single provider.

---

# 17. Scorer contract

```ts
interface Scorer {
  id: string
  name: string
  kind: "deterministic" | "judge" | "runtime" | "economic"

  score(
    observation: Observation,
    evalCase: EvalCase,
    context: ScorerContext
  ): Promise<ScorerResult>
}
```

Scorer result:

```ts
type ScorerResult = {
  value: number | boolean | string
  normalizedValue?: number
  passed?: boolean
  explanation?: string
  metadata?: Record<string, unknown>
}
```

---

# 18. Comparison engine

## 18.1 Core outputs

For each candidate:

- dimension scores
- aggregate quality
- hard constraint pass/fail
- critical failure rate
- p50/p95 latency
- cost
- cost per successful task
- throughput if available
- uncertainty/confidence
- segment-level performance

## 18.2 Pairwise comparison

For candidate A vs B:

- quality delta
- latency delta
- cost delta
- failure delta
- confidence interval
- statistical significance where appropriate
- practical significance
- threshold satisfaction

## 18.3 Equivalence matters more than “winner”

A common decision should be:

> “Model B is statistically/practically equivalent to Model A for this task and materially cheaper.”

Support configurable equivalence margins.

Example:

```text
quality equivalence margin: ±0.5 pp
```

If B is within margin and clears hard constraints, cost can decide.

## 18.4 Pareto frontier

A candidate is dominated if another candidate is at least as good on all selected objectives and strictly better on at least one.

Primary objectives may include:

- quality ↑
- cost ↓
- latency ↓
- critical failures ↓

Do not hide dominated models entirely; show them under:

> “Not recommended / dominated”

## 18.5 Recommended decision classes

```ts
type DecisionClass =
  | "replace_incumbent"
  | "keep_incumbent"
  | "best_quality"
  | "best_balance"
  | "lowest_cost_qualified"
  | "conditional_split"
  | "insufficient_evidence"
  | "no_candidate_qualified"
```

---

# 19. Recommendation engine

## 19.1 Inputs

- constraints
- benchmark results
- comparison
- user optimization priorities
- workload volume
- confidence thresholds

## 19.2 Output

```ts
type ModelDecision = {
  id: string
  taskId: string
  benchmarkId: string
  recommendedCandidateId?: string
  decisionClass: DecisionClass
  confidence: "low" | "medium" | "high"
  reasons: DecisionReason[]
  tradeoffs: Tradeoff[]
  rejectedCandidates: RejectedCandidate[]
  estimatedImpact?: {
    monthlyCostDelta?: number
    annualCostDelta?: number
    latencyDeltaMs?: number
    qualityDelta?: number
  }
  evidence: EvidenceRef[]
}
```

## 19.3 Recommendation rules v0

Use deterministic policy before adding an LLM narrative layer.

1. remove candidates failing hard constraints
2. remove candidates exceeding critical failure maximums
3. compute Pareto frontier
4. if user specifies objective priority, rank frontier
5. compare against incumbent if present
6. verify practical/statistical confidence
7. return decision class
8. use LLM only to explain the deterministic result

Never let an LLM silently override numerical policy.

---

# 20. Model Decision Record

The MDR is a core artifact.

## 20.1 Example

```text
TASK
Customer support classification

DECISION
Qwen-X-14B / provider configuration Y

WHY
98.3% task success
$0.00018 / request
340ms p95

ALTERNATIVES
Claude-X
+0.4pp quality
19× cost

GPT-X-mini
-0.2pp quality
4.1× cost

Llama-X-8B
-3.8pp quality

CONSTRAINTS
JSON validity = 100%
security recall >= 99.5%
p95 latency < 700ms

VALIDATED
2026-09-05

DATASET
n = 4,812
eval version = support-routing-v4
```

## 20.2 MDR requirements

- immutable snapshot
- shareable URL
- JSON export
- Markdown export
- author
- agent/human provenance
- benchmark hash
- dataset version/hash
- eval version
- candidate versions
- timestamp
- decision confidence
- evidence links

---

# 21. Conditional split recommendation

Later premium capability, but reserve data model now.

Sometimes one global model is not optimal.

Example:

```text
82% easy cases   → small model
15% medium       → mid model
3% hard          → frontier model
```

OpenMerit may recommend a **decision policy**, but must not execute production routing.

Output:

```ts
type DecisionPolicy = {
  classifierDescription: string
  branches: Array<{
    condition: string
    candidateId: string
  }>
  expectedQuality: number
  expectedCost: number
  expectedLatency: number
}
```

A separate router/provider/application may implement it.

This preserves product boundaries.

---

# 22. Continuous model reconsideration

Premium v2.

## 22.1 Goal

Remember why a current decision was made.

Store:

```text
quality >= 97%
critical-field accuracy >= 99%
p95 < 2.5s
cost < $0.001/request
```

When new models/configurations become available, identify plausible challengers.

## 22.2 Behavior

1. model catalog detects new candidate
2. task-candidate relevance model scores it
3. if relevant, create challenge proposal
4. user or CI runner executes benchmark
5. compare against incumbent
6. notify only if evidence suggests actionable improvement

Example:

> Qwen-Y can replace your current model with equivalent measured quality and 43% lower estimated cost.

Do not spam users for every model release.

---

# 23. Integrations with Braintrust / Langfuse / LangSmith

OpenMerit should complement them.

## 23.1 Integration goals

Import:

- datasets
- production examples
- evaluation outputs
- latency/cost traces where allowed

Export:

- chosen candidate metadata
- decision record
- eval definition
- benchmark tags
- recommended thresholds

## 23.2 Product boundary

OpenMerit should not attempt to replace their full trace/observability UI.

Position integrations as:

```text
production telemetry
      ↓
Braintrust/Langfuse/LangSmith
      ↓ representative cases
OpenMerit
      ↓ model decision
application configuration
```

---

# 24. Information architecture

## 24.1 Navigation

Keep primary nav small:

```text
Tasks
Decisions
Models
Runs
```

Workspace/settings elsewhere.

## 24.2 Task detail

Tabs:

```text
Overview
Eval
Dataset
Candidates
Runs
Decision
```

## 24.3 Models page

Not a generic leaderboard.

Default behavior:

> “Search models for a task”

Model profile shows:

- capabilities
- providers
- pricing
- deployment modes
- relevant task decisions
- benchmark evidence in this workspace

Do not lead with meaningless global rank.

## 24.4 Decisions page

Chronological Model Decision Records.

This should become the organizational memory:

> Why are we using this model?

---

# 25. Core web screens

## 25.1 Landing / command screen

Primary control:

```text
What does the model need to do?
[........................................]
```

Examples should be task-oriented, not model-oriented.

## 25.2 Eval editor

Split layout:

Left:
- Task
- priorities
- constraints
- critical failures

Right:
- generated metrics
- scorers
- dataset plan

Every generated item must explain:

> Why is this being measured?

## 25.3 Candidate screen

Sections:

```text
Must test
Worth testing
Optional
Excluded
```

Each item includes “why”.

## 25.4 Run screen

Show progress by candidate and case segment.

Do not imitate a production trace viewer.

## 25.5 Comparison screen

Primary visual:

**Pareto chart**

Then:

- threshold table
- segment performance
- failures
- latency distribution
- economic model
- dominated candidates

## 25.6 Decision screen

Top:

```text
Recommended: Candidate X
Confidence: High
```

Then concise reasoning.

Below:

- evidence
- tradeoffs
- alternative decisions
- MDR export

---

# 26. Visual/product design principles

- serious infrastructure product
- low visual noise
- avoid gradient-heavy “AI SaaS” styling
- dense where comparison demands density
- generous whitespace around decisions
- tables and plots should be first-class
- charts should explain tradeoffs, not decorate
- use muted colors
- reserve strong color for:
  - pass
  - fail
  - recommendation
  - warning
- every score should be inspectable
- no “magic AI score” without decomposition
- no anthropomorphic assistant UI as the entire product

Agent-first does not mean “everything is chat”.

---

# 27. Technical architecture

## 27.1 Recommended monorepo

```text
/apps
  /web          Next.js web app
  /api          Fastify or Hono API
  /mcp          MCP server
  /docs         docs site

/packages
  /domain       pure domain models + decision logic
  /db           schema + migrations
  /model-catalog
  /eval-core
  /comparison
  /sdk-ts
  /ui
  /config

/runner
  /python       local/CI runner
  /adapters
  /scorers

/examples
  /support-routing
  /invoice-extraction
  /coding-agent
```

## 27.2 Recommended stack

Web:
- TypeScript
- current stable Next.js
- React
- server components only where useful
- client state kept minimal

API:
- TypeScript
- Fastify/Hono
- REST/JSON first
- OpenAPI generated from schemas

Validation:
- Zod or equivalent shared schemas

Database:
- PostgreSQL

ORM:
- Drizzle or equivalent transparent SQL-oriented ORM

Queue:
- Redis + BullMQ or managed equivalent

Object storage:
- S3-compatible

Auth:
- managed OIDC provider initially
- workspace RBAC

Billing:
- Stripe

Analytics:
- privacy-respecting product analytics

Runner:
- Python 3.12+
- `uv` for packaging
- async HTTP clients
- provider adapters
- optional isolated evaluator subprocesses

## 27.3 Why split runner from SaaS

The runner needs:

- provider SDK flexibility
- ML ecosystem compatibility
- local endpoint support
- sandboxing
- access to private data
- CI ergonomics

The SaaS should not execute arbitrary user evaluator code.

---

# 28. Backend services

Logical services:

## 28.1 Task Service

- Task CRUD
- versioning
- natural-language analysis

## 28.2 Eval Service

- Eval Spec CRUD
- scorer metadata
- validation
- export

## 28.3 Dataset Service

- metadata
- hosted cases
- local case manifests
- dataset versions

## 28.4 Model Catalog Service

- model metadata
- provider metadata
- pricing
- deployment modes
- release ingestion

## 28.5 Candidate Service

- task-model compatibility
- candidate discovery

## 28.6 Benchmark Service

- plans
- signed runner jobs
- result ingestion
- run state

## 28.7 Comparison Service

Pure deterministic/statistical computation.

## 28.8 Decision Service

- policies
- recommendations
- MDR creation

## 28.9 Agent Service

Thin MCP/API adapter around domain services.

Do not duplicate business logic in MCP handlers.

---

# 29. Data model

Suggested PostgreSQL tables:

```text
users
workspaces
workspace_members
projects

tasks
task_versions
task_constraints

evals
eval_versions
eval_dimensions
eval_scorers
eval_hard_constraints

datasets
dataset_versions
dataset_cases
dataset_case_refs

model_families
model_versions
providers
provider_models
model_capabilities
model_prices
model_deployments

candidates
benchmark_plans
benchmark_runs
benchmark_candidates
benchmark_observations
benchmark_scores

comparisons
comparison_pairs
pareto_sets

decisions
decision_candidates
decision_reasons
decision_records

runners
runner_capabilities

integrations
audit_events

subscriptions
feature_entitlements
```

## 29.1 Versioning rule

Never mutate historical benchmark dependencies.

A benchmark references exact immutable versions of:

- Task
- Eval
- Dataset
- Candidate configuration
- Model version if known
- pricing snapshot

---

# 30. API surface

Prefix:

```text
/api/v1
```

## 30.1 Tasks

```text
POST   /tasks/analyze
POST   /tasks
GET    /tasks/:id
PATCH  /tasks/:id
POST   /tasks/:id/versions
```

## 30.2 Evals

```text
POST   /tasks/:id/evals/generate
POST   /evals
GET    /evals/:id
POST   /evals/:id/validate
POST   /evals/:id/export
```

## 30.3 Datasets

```text
POST   /datasets
POST   /datasets/:id/versions
POST   /datasets/:id/cases
POST   /datasets/:id/import
GET    /datasets/:id/health
```

## 30.4 Models

```text
GET    /models/search
GET    /models/:id
GET    /models/:id/providers
```

## 30.5 Candidate discovery

```text
POST   /tasks/:id/candidates/search
POST   /tasks/:id/candidates/validate
```

## 30.6 Benchmarks

```text
POST   /benchmarks/plan
POST   /benchmarks
GET    /benchmarks/:id
POST   /benchmarks/:id/results
POST   /benchmarks/:id/complete
```

## 30.7 Decisions

```text
POST   /benchmarks/:id/compare
POST   /benchmarks/:id/recommend
GET    /decisions/:id
GET    /decisions/:id/explain
GET    /decisions/:id/export
```

---

# 31. CLI

Binary:

```bash
openmerit
```

Core commands:

```bash
openmerit auth login

openmerit task analyze
openmerit task pull
openmerit task push

openmerit eval init
openmerit eval validate
openmerit eval run

openmerit models search

openmerit benchmark plan
openmerit benchmark run
openmerit benchmark submit

openmerit decision show
openmerit decision export
```

## 31.1 Agent-friendly output

Every CLI command supports:

```text
--json
```

No decorative prose in JSON mode.

Exit codes must be stable.

---

# 32. Local runner protocol

## 32.1 Runner registration

```bash
openmerit runner register
```

SaaS stores:

- runner ID
- workspace
- labels
- capabilities
- public key

No provider secrets.

## 32.2 Signed benchmark job

OpenMerit issues a signed plan.

Runner verifies signature.

Runner may reject if:

- adapter unavailable
- local model missing
- secrets unavailable
- privacy policy conflict

## 32.3 Result integrity

Each result envelope includes:

- benchmark ID
- eval hash
- dataset manifest hash
- runner ID
- candidate hash
- timestamp
- signature

This improves reproducibility without pretending results are tamper-proof.

---

# 33. Cost modeling

## 33.1 API providers

Use price snapshot at benchmark time.

Compute:

```text
cost =
input_tokens × input_rate
+
output_tokens × output_rate
+
provider-specific fees
```

Store both:

- provider-reported cost if available
- OpenMerit-computed cost

## 33.2 Self-hosted models

Support user-defined cost profile:

```text
GPU hourly cost
average utilization
replicas
tokens/sec
batching
idle percentage
```

Compute:

- benchmark marginal cost
- estimated normalized request cost
- workload monthly cost

Always label estimates.

Do not compare API list pricing and self-hosted fully-loaded economics without explaining assumptions.

---

# 34. Latency and performance

Capture separately:

- queue time if observable
- TTFT
- generation time
- end-to-end latency
- input tokens
- output tokens
- tokens/sec
- concurrency
- cold start
- timeout/error rate

For self-hosted benchmarks record:

- hardware
- runtime
- quantization
- batch size
- concurrency

A model without serving configuration is not a complete performance candidate.

---

# 35. Statistics and confidence

v0 must avoid fake precision.

## 35.1 Required concepts

- bootstrap confidence intervals for aggregate metrics where appropriate
- proportion confidence intervals for pass/fail metrics
- paired comparisons when candidates run same examples
- minimum detectable effect guidance
- equivalence margin
- multiple-run variance for stochastic tasks

## 35.2 Confidence labels

```text
Low
Medium
High
```

Must be derived from:

- sample size
- metric variance
- dataset coverage
- scorer reliability
- benchmark completion
- candidate separation

Do not let an LLM choose confidence labels.

---

# 36. LLM judges

LLM-as-judge is allowed but treated as a fallible scorer.

Requirements:

- judge model recorded
- judge prompt/version recorded
- temperature recorded
- pairwise randomization when appropriate
- position bias mitigation
- deterministic scorers preferred when possible
- judge should not be the sole scorer for high-stakes claims unless explicitly accepted

UI must show:

> “This score uses an LLM judge.”

---

# 37. Security and privacy

## 37.1 Secrets

Default:

- provider secrets remain local
- OpenMerit stores no provider credentials

Optional hosted credential vault may be a later enterprise feature but is not required for v1.

## 37.2 Data

Encrypt hosted data:

- in transit
- at rest

Support configurable retention.

## 37.3 RBAC

Roles:

```text
Owner
Admin
Editor
Runner
Viewer
```

## 37.4 Audit events

Record:

- Task changes
- Eval changes
- dataset changes
- benchmark creation
- result submission
- decision creation
- integration exports
- runner registration/revocation

## 37.5 Local-only mode

Must be a first-class product path, not an enterprise afterthought.

---

# 38. Billing and entitlement

## 38.1 Suggested plans

### Free

For individuals and OSS.

Includes:
- unlimited local eval authoring within reasonable abuse limits
- local runs
- public templates
- export

### Pro

Includes:
- candidate discovery
- comparisons
- recommendations
- MDRs
- agent integration
- reasonable benchmark/result storage
- CI

### Team

Includes:
- shared workspace
- decision history
- approvals
- private templates
- integrations
- larger retention

### Enterprise

Includes:
- SSO/SAML
- SCIM
- VPC/customer runner controls
- private model catalog
- audit export
- custom retention
- on-prem/control-plane options later

## 38.2 Do not price by inference tokens

Possible premium meters:

- active Tasks under decision management
- benchmark comparisons
- team seats
- continuous watches
- retained result volume

Avoid creating incentives that compromise model neutrality.

---

# 39. Product metrics

North-star candidate:

> **Number of production model decisions made or validated through OpenMerit.**

Supporting:

- free evals created
- evals exported
- eval → benchmark conversion
- benchmark → decision conversion
- incumbent replacements
- estimated customer savings
- decisions referenced by agents
- repeat decisions per workspace
- percentage of recommendations with high confidence
- time from Task creation to Decision

Do not use raw model calls as the north star.

---

# 40. MVP scope

## 40.1 MVP objective

A developer can:

1. describe a task
2. get a strong eval
3. add representative examples
4. compare 2–4 models using own credentials
5. receive a defensible recommendation
6. export a Model Decision Record

## 40.2 MVP features

### Free

- auth/workspace
- Task creation
- AI task analyzer
- Eval Spec generator
- eval editor
- CSV/JSONL dataset import
- deterministic scorer library
- LLM judge scorer
- `.eval.md` export/import
- local runner
- OpenAI-compatible adapter
- Anthropic adapter
- generic HTTP adapter

### Premium

- model catalog
- candidate search
- comparison engine
- Pareto frontier
- cost/latency comparison
- recommendation engine
- MDR
- MCP tools
- CLI JSON mode

## 40.3 Explicitly defer

- continuous watches
- automatic production-log sampling
- conditional split recommendation
- enterprise SSO
- hosted credential vault
- complex observability imports
- automatic endpoint provisioning
- community marketplace
- advanced self-hosted TCO optimizer

---

# 41. Implementation phases

## Phase 0 — Domain kernel

Build before UI.

Deliver:

- TypeScript domain types
- Eval Spec JSON schema
- Candidate schema
- benchmark schema
- result envelope
- deterministic comparison engine
- Pareto computation
- recommendation policy
- unit tests

Acceptance:

Given static fixtures, system can produce deterministic decisions.

## Phase 1 — Free eval authoring

Deliver:

- Task API
- natural-language task analysis
- Eval generation
- Eval editor
- scorer definitions
- dataset import
- `.eval.md` import/export

Acceptance:

A new user can turn a paragraph into a usable local eval without connecting a model provider to OpenMerit.

## Phase 2 — Local runner

Deliver:

- Python package
- provider adapters
- CLI
- benchmark plan pull
- result submission
- local-only output mode

Acceptance:

User can benchmark two provider models using environment credentials that never reach OpenMerit.

## Phase 3 — Premium comparison

Deliver:

- model catalog v0
- manual + automatic candidates
- comparison screen
- Pareto frontier
- costs
- latency
- decision policy
- MDR

Acceptance:

User can answer:

> “Can model B replace model A?”

with reproducible evidence.

## Phase 4 — Agent first-class interface

Deliver:

- MCP server
- structured tool schemas
- agent docs
- example Codex/Claude Code workflows
- CLI JSON mode hardened

Acceptance:

A coding agent can create/fetch an eval, search candidates, submit benchmark results, and return a decision without using the web UI.

## Phase 5 — Continuous decisions

Deliver:

- model release ingestion
- task relevance
- challenger proposals
- scheduled benchmark requests
- decision refresh
- actionable notifications

---

# 42. Acceptance criteria by feature

## 42.1 Task analyzer

Given:

```text
Extract invoice number, VAT number, date and total from scanned UAE invoices.
Wrong VAT values are critical.
```

Must produce:

- multimodal/document extraction task type
- structured output recommendation
- critical VAT failure
- field-level metrics
- schema scorer
- dataset composition suggestion

## 42.2 Candidate discovery

Given constraints:

```text
vision required
structured JSON
commercial use
max context 32k needed
```

Must never recommend incompatible text-only candidates.

Every candidate must include inclusion reason.

## 42.3 Comparison

Given:

```text
A quality 98.8, cost 10, latency 4.0
B quality 98.6, cost 2, latency 1.5
C quality 96.0, cost 0.2, latency 0.8
D quality 97.0, cost 4, latency 2.1
```

And quality threshold = 98.0:

- C disqualified
- D disqualified
- A and B qualified
- B is preferred for best balance / lowest cost qualified
- comparison explains 0.2pp quality tradeoff

## 42.4 Privacy

Runner configured:

```text
upload_input=false
upload_output=false
```

Server must be able to complete comparison using scores/runtime metrics only.

## 42.5 MCP

Agent must receive structured `nextActions`.

Example:

```json
{
  "ok": true,
  "data": {
    "task_id": "task_123"
  },
  "nextActions": [
    {
      "tool": "eval.create",
      "reason": "No eval exists for the task."
    }
  ]
}
```

---

# 43. Test strategy

## 43.1 Domain unit tests

Required exhaustive tests for:

- hard constraints
- Pareto dominance
- equivalence margins
- recommendation classes
- cost calculations
- confidence labels
- decision policy

## 43.2 Golden tests

Maintain fixture Tasks:

- classification
- extraction
- summarization
- coding
- RAG QA
- tool calling
- multimodal

Expected Eval Specs reviewed manually.

## 43.3 Runner integration tests

Mock providers.

Test:

- retries
- timeouts
- streaming
- token accounting
- schema failures
- redaction
- interrupted runs

## 43.4 End-to-end

Required flows:

1. create Task → generate eval → export
2. import eval → run local benchmark → compare
3. agent flow via MCP
4. metadata-only benchmark
5. incumbent replacement decision

---

# 44. Failure and edge cases

The product must handle:

- model version disappears
- provider renames a model
- provider pricing changes mid-run
- endpoint throttles
- candidate cannot satisfy output schema
- different candidates receive different retry counts
- judge model fails
- dataset too small
- benchmark partially completes
- only one candidate qualifies
- no candidate qualifies
- incumbent has missing pricing
- local hardware cost unknown
- raw outputs unavailable
- conflicting metrics
- quality delta is statistically unclear

Preferred output in uncertain cases:

> **Insufficient evidence**

Never manufacture a winner.

---

# 45. Model catalog ingestion

## 45.1 Initial approach

Do not build an enormous crawler first.

Create provider connectors that normalize:

```ts
type ModelCatalogEntry = {
  canonicalId: string
  family: string
  version?: string
  releaseDate?: string
  weights: "open" | "closed" | "unknown"
  license?: string
  modalities: Modality[]
  contextWindow?: number
  capabilities: string[]
  providers: ProviderOffering[]
}
```

## 45.2 Data confidence

Every metadata field may carry:

```ts
{
  value: ...,
  source: ...,
  observedAt: ...,
  confidence: ...
}
```

This matters because model/provider metadata changes quickly.

---

# 46. AI components inside OpenMerit

Use LLMs where they create leverage:

- Task understanding
- Eval/rubric generation
- scorer code generation
- candidate rationale
- failure clustering
- natural-language decision explanation

Do not use LLMs for:

- hard constraint computation
- cost arithmetic
- Pareto dominance
- benchmark aggregation
- deterministic metric calculation
- authorization
- billing
- final policy enforcement

Principle:

> **LLMs propose and explain. Deterministic systems decide what can be deterministic.**

---

# 47. Agent safety and authority

Coding agents must not silently switch production models based solely on an OpenMerit recommendation.

Tool response should include:

```json
{
  "humanReviewRequired": true
}
```

for changes that would:

- alter production provider
- alter privacy boundary
- alter license/deployment assumptions
- create material spend
- reduce a critical quality metric

OpenMerit can recommend.

The coding agent applies changes according to its host's authorization model.

---

# 48. Documentation structure

Public docs:

```text
Concepts
  What is a model decision?
  Tasks
  Evals
  Candidates
  Benchmarks
  Decisions

Quickstarts
  Human web flow
  CLI
  MCP
  CI
  Private/local model

Guides
  Replace an expensive model
  Compare open vs frontier
  Benchmark an internal model
  Build an extraction eval
  Build a coding eval

Reference
  .eval.md
  API
  MCP
  CLI
  Runner
  Scorers
```

---

# 49. Example end-to-end agent session

Human:

```text
We use a frontier model for generating short product descriptions.
See if we can cut the cost without lowering quality.
```

Coding agent:

1. finds model call
2. identifies prompt and schema
3. calls:

```text
task.analyze
```

OpenMerit:

```json
{
  "taskType": "constrained_generation",
  "dimensions": [
    "factuality",
    "attribute_coverage",
    "style",
    "constraint_compliance"
  ],
  "hardConstraints": [
    "no unsupported product claims"
  ]
}
```

Agent finds product fixtures.

Calls:

```text
eval.create
```

Calls:

```text
models.search
```

OpenMerit returns:

```text
incumbent frontier model
fast frontier mini
open 14B candidate
open 32B candidate
```

Agent executes locally.

Submits results.

Calls:

```text
decision.recommend
```

Response:

```json
{
  "decisionClass": "replace_incumbent",
  "recommendedCandidate": "candidate_qwen",
  "confidence": "high",
  "estimatedImpact": {
    "qualityDelta": -0.003,
    "annualCostDelta": -187920
  },
  "reasons": [
    "All hard constraints passed.",
    "Quality difference is inside the configured equivalence margin.",
    "Recommended candidate reduces estimated cost by 84.9%."
  ]
}
```

Agent tells human:

> I tested four candidate configurations against 312 representative cases. The recommended open model stayed within the configured quality equivalence margin and passed all critical constraints, while reducing estimated annual inference spend by about $188k. I can update the implementation if you want.

That is the desired product experience.

---

# 50. Homepage copy direction

Hero:

> **Pick models with evidence, not vibes.**

Alternative:

> **The decision layer between models and applications.**

Subhead:

> Benchmark models against your actual task. Compare quality, latency, and cost. Give humans and coding agents a defensible answer to which model to use.

Primary CTA:

> **Create an eval — free**

Secondary:

> **See a model decision**

Avoid:

- “Unified AI platform”
- “AI observability for everyone”
- “Route to the best model”
- “One API for every model”

Those imply the wrong category.

---

# 51. Initial seed eval templates

Ship templates for:

1. structured extraction
2. classification
3. summarization
4. grounded Q&A
5. constrained generation
6. coding patch
7. code review
8. tool selection/tool calling
9. document understanding
10. multimodal image-to-JSON

Each template defines:

- common metrics
- critical failures
- dataset composition
- typical hard constraints
- candidate capability requirements

---

# 52. Initial coding-agent eval template

A coding task should include:

Hard:

- tests pass
- typecheck passes
- no unrelated file modifications
- patch applies cleanly

Objectives:

- task completion
- minimal diff
- regression avoidance
- tool-call efficiency
- latency
- cost

Optional:

- judge for code clarity
- judge for maintainability

This template is strategically important because coding agents are a core distribution channel.

---

# 53. Distribution strategy encoded in product

Build product surfaces that naturally spread:

## 53.1 Shareable MDR

A developer can paste a decision link in:

- PR
- issue
- architecture doc
- Slack
- investor/management update

## 53.2 `.eval.md`

Makes OpenMerit visible inside repositories.

## 53.3 MCP

Makes OpenMerit discoverable to coding agents.

## 53.4 OSS scorer/eval SDK

Make the free eval layer easy to adopt.

The premium product monetizes decisions, not possession of the eval format.

---

# 54. Moat hypothesis

Do not assume the moat is:

- provider API integrations
- model list
- MCP server
- generic eval UI

Those will commoditize.

Potential durable advantages:

1. **Task-to-eval quality**
   - turning vague work into good tests

2. **Task-model relevance graph**
   - which models/configurations are worth testing for which task shapes

3. **Decision history**
   - real task-specific evidence across time

4. **Benchmark methodology**
   - screening, equivalence, failure analysis, confidence

5. **Agent habit/distribution**
   - coding agents learn to consult OpenMerit when making model choices

6. **Neutrality**
   - no incentive tied to inference volume or provider choice

---

# 55. Build order for a coding agent

The coding agent implementing this product should follow this order exactly unless blocked.

## Step 1

Create monorepo and shared schemas.

Do not build UI first.

## Step 2

Implement domain fixtures and deterministic comparison engine.

Create tests proving:

- hard constraints
- Pareto frontier
- recommendation policies

## Step 3

Implement database schema and migrations.

## Step 4

Implement Task + Eval APIs.

## Step 5

Implement eval generation service behind an interface so model provider can change.

## Step 6

Implement `.eval.md` parser/serializer.

## Step 7

Implement local runner with generic OpenAI-compatible adapter first.

## Step 8

Implement benchmark result ingestion.

## Step 9

Implement comparison + decision APIs.

## Step 10

Build minimal web UI around existing APIs.

## Step 11

Add model catalog + candidate discovery.

## Step 12

Add premium entitlement checks.

## Step 13

Add MCP server as thin wrappers around existing services.

## Step 14

Add polished comparison and MDR screens.

## Step 15

Create example repos and E2E tests.

---

# 56. Coding standards

- TypeScript strict mode
- Python typing
- no business logic inside route handlers
- no business logic inside React components
- domain functions should be pure where practical
- all external provider APIs behind adapters
- all LLM prompts versioned
- all Eval Specs versioned
- all decisions reproducible from stored inputs
- all premium checks centralized
- use structured logs
- include trace IDs
- redact secrets
- never log provider API keys
- migrations required for schema changes
- OpenAPI generated and committed/validated in CI

---

# 57. Definition of done for v1

v1 is done only when all statements below are true.

1. A user can create a high-quality eval for free from a task description.
2. The eval is portable and exportable.
3. A user can benchmark at least two models using credentials that remain outside OpenMerit.
4. OpenMerit can compare quality, latency, and cost.
5. OpenMerit can enforce hard constraints.
6. OpenMerit can compute a Pareto frontier.
7. OpenMerit can identify practical/statistical equivalence where configured.
8. OpenMerit can recommend a candidate or explicitly say evidence is insufficient.
9. OpenMerit can generate a shareable Model Decision Record.
10. A coding agent can execute the same core flow through MCP.
11. Production inference never depends on OpenMerit.
12. No feature requires OpenMerit to resell or route tokens.
13. A private/internal endpoint can participate in a benchmark without exposing its credential.
14. Raw eval inputs/outputs can remain local.
15. The product clearly communicates where it sits relative to providers and observability platforms.

---

# 58. Open questions

These should not block initial implementation unless they affect architecture.

## Product

- Is `OpenMerit` the final name?
- Should public community evals exist in v1 or later?
- Should free hosted eval storage have limits?
- How much candidate discovery is useful without a benchmark?
- Should Decision Records be public-by-link or workspace-only by default?

## Technical

- TypeScript or Python as the canonical `.eval.md` parser implementation?
- How should LLM judge execution work in strict local-only mode?
- What minimal model catalog sources are reliable enough for v1?
- How should unknown/self-hosted model cost estimates be normalized?
- How should streamed multimodal inputs be represented in local manifests?

## Business

- Charge by active managed Tasks, seats, comparisons, or mixed entitlement?
- How much continuous model monitoring belongs in Pro vs Team?
- Should an OSS local runner be Apache-2.0/MIT while SaaS remains proprietary?

---

# 59. Final product boundary

If there is ambiguity during implementation, use this test.

If a feature primarily answers:

> **“How do I execute this model request?”**

it probably belongs to a provider, router, gateway, or inference platform.

If a feature primarily answers:

> **“How is my application behaving in production?”**

it probably belongs to an observability/eval platform.

If a feature primarily answers:

> **“Which model/configuration should this task use, and why?”**

it belongs in OpenMerit.

That boundary should remain stable even as the product becomes more capable.

---

# 60. North-star statement for the team and coding agents

> **OpenMerit is model decision infrastructure. It turns a task into an eval, identifies plausible model candidates, compares them using the user's own execution environment, and produces a defensible model decision. It never needs to proxy production inference to be valuable.**

