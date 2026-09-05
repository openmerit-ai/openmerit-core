# OpenMerit MCP tool specification

Proposed interface from the v0.1 product specification. This document is not a live MCP service or an installation guide.

Use OpenMerit to select, compare, reconsider, or justify a model/configuration for a specific application task.

## Canonical workflow
1. task.analyze — infer task requirements from the feature and current model usage.
2. task.upsert — create or version a Task Specification.
3. eval.create — define dimensions, hard constraints, scorers, and dataset requirements.
4. eval.validate — check the eval before execution.
5. models.search — find plausible model configurations within the task's constraints.
6. benchmark.plan — plan screening and full comparison.
7. Execute with the user's local, CI, or customer-hosted runner. Credentials stay in that environment.
8. benchmark.submit_results — submit only data permitted by the privacy policy, including metadata-only results.
9. decision.recommend — return a decision class, confidence, tradeoffs, rejected candidates, and evidence.
10. decision.explain — explain the decision for review.

## Required tools
- task.analyze
- task.get
- task.upsert
- eval.create
- eval.get
- eval.validate
- models.search
- models.inspect
- benchmark.plan
- benchmark.submit_results
- benchmark.get
- decision.recommend
- decision.explain
- decision.get

## Response envelope
```typescript
type AgentResponse<T> = {
  ok: boolean;
  data?: T;
  warnings?: AgentWarning[];
  nextActions?: AgentAction[];
  humanReviewRequired?: boolean;
  traceId: string;
};
```
AgentWarning and AgentAction are structured domain types to be defined by the service.

## Decision classes
replace_incumbent, keep_incumbent, best_quality, best_balance, lowest_cost_qualified, conditional_split, insufficient_evidence, no_candidate_qualified.

Filter hard-constraint failures before computing the Pareto frontier. Verify equivalence and confidence before recommending a change. A shortlist alone is not a benchmark-backed decision.

## Product boundary
Eval authoring, scorer scaffolding, local/manual execution, and portable eval exports are free. Automated comparisons, candidate discovery, decision records, and agent/CI automation are premium capabilities.

Production inference never flows through OpenMerit. A coding agent may propose an implementation change after a decision; authorization to modify or deploy the application remains separate.
