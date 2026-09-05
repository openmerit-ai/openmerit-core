---
openmerit: 1
task: support-routing
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
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
  },
  "additionalProperties": false
}
```
Replace the queue field with an enum of your 14 real queue names before running this eval.

## Weighted quality
- route accuracy: 60%
- high-risk recall: 30%
- schema validity: 10%

Hard constraints are gates; a weighted score cannot override them.

## Scorer definitions to implement
- exact_queue_match: compare the predicted queue with the reviewed label
- high_risk_recall: measure correct identification of billing/security cases
- json_schema: validate every output against the completed schema
- latency_p95: measure end-to-end request latency
- normalized_cost: compute cost per request and per successful task

## Starter dataset plan
- 80 normal examples
- 20 ambiguous examples
- 20 billing/security examples
- 10 adversarial examples

This is a screening scaffold, not sufficient evidence for rare failure rates. Determine the full sample size and confidence policy before a production decision. Use representative, reviewed cases; label synthetic cases explicitly.

## Candidate policy
- text models only
- context >= 16k
- deployment, privacy, licensing, and budget limits: fill in for your application

## Execution and privacy
Run in your own environment. Keep provider credentials local. Raw inputs and outputs may remain local; submit only permitted results metadata.

## Before a model decision
Specify an incumbent, quality equivalence margin, confidence policy, workload volume, and complete candidate configurations. Reject hard-constraint failures before comparing quality, latency, and cost.

This is an editable starter template, not an executed evaluation or generated recommendation.
