# Support tickets

[Watch the support-ticket demo](https://openmerit.ai/demo?task=support). One model call turns a synthetic customer email into a structured ticket. Both paths start with GPT-4.1 mini and use the same prompt and JSON schema. The fixed path keeps that model; the managed path changes only after measured comparison and operator approval.

## Input and output

The ticket has exactly three fields:

| Field | Rule |
| --- | --- |
| `category` | `billing`, `shipping`, `account`, or `technical`, according to the email's request. |
| `urgency` | `high` only for an ongoing outage, a blocked business operation, or suspected unauthorized access; otherwise `normal`. |
| `order_id` | The stated `ORD-` identifier, or `null` if none is given. |

An angry tone alone does not make a ticket urgent, and the model must never invent an order ID. Email content is treated as data. For example, “I was charged twice for ORD-1201. Please refund the duplicate.” should produce:

```json
{"category":"billing","urgency":"normal","order_id":"ORD-1201"}
```

## Comparison structure

Pi first checks the prepared grader and measurement collectors, then measures GPT-4.1 mini on 24 synthetic emails. It evaluates GPT-4.1 nano and Gemini 2.5 Flash Lite on the same inputs. Each application request records its output, provider cost, and end-to-end latency. The exact-match grader checks every field and rejects missing or extra fields.

OpenMerit validates the comparison and proposes an eligible cheaper model. The recorded operator approves the proposal; Pi changes the application's model configuration and runs six disjoint verification emails. Pi's own orchestration model stays fixed.

## Evaluation policy

The prepared policy requires at least 90% exact matches on the 24 fixtures and mean end-to-end latency of at most ten seconds. Among eligible frontier candidates, the demo proposes the lowest observed cost only when it is below the incumbent cost. Six separate inputs verify an approved change. These are point values on a finite synthetic suite, not production success-rate estimates or confidence bounds.

## Recorded outcome

| Model | Exact matches | Cost per 1,000 emails | Mean latency |
| --- | --- | --- | --- |
| GPT-4.1 mini | 24/24 | $0.106 | 1.64s |
| GPT-4.1 nano | 17/24 | $0.027 | 1.23s |
| Gemini 2.5 Flash Lite | 24/24 | $0.027 | 1.21s |

GPT-4.1 nano was cheaper but failed the quality requirement. Gemini 2.5 Flash Lite qualified, received approval, and passed all six post-swap checks. The cost column scales each observed per-email mean to 1,000 emails and rounds it; the downloaded recording retains the original values. These observations come from the supervised run recorded on September 28, 2026 and do not promise the same result on another workload.


See [the demo overview](demo.md) for playback controls, the shared comparison lifecycle, and how to read the measurements.
