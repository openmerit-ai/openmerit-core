# Invoice Vision/OCR Benchmark - Round Two

Run date: 2026-09-11 (Asia/Kolkata)  
Workload: 5 models x 10 invoices = 50 completed model-invoice observations  
OpenRouter availability/pricing verified: 2026-09-10 23:11:53 UTC

## Recommendation

**Use `qwen/qwen3-vl-235b-a22b-instruct` from this round.** It returned valid,
strictly schema-conforming JSON for all 10 invoices, had the lowest median and
p95 latency among reliable models (6.12 s and 6.84 s), and cost $0.01055 for
the complete workload. Its visible-field exact-leaf quality was 98.56% overall
and 99.19% across the six faded or bad-scan invoices.

`openai/gpt-6-astra` reached the highest overall round-two quality at 99.04%,
but it tied Qwen on degraded-scan quality (99.19%) and exact documents (8/10),
was slower, and cost $0.75879 - about 72 times as much. It does not justify its
premium for this extraction contract.

Across both benchmark rounds, `google/gemini-3.8-flash` remains the best
quality/latency default: its first-round result was 99.52% quality, 9/10 exact
documents, a 4.11 s median, and $0.02107 total cost. Round-two Qwen3-VL is the
strong lower-cost alternative when doubling the small per-batch spend for
Gemini is less attractive, and it provides especially good degraded-scan
performance.

Do not deploy the tested Gemma or MiMo routes without a fallback. Each produced
usable content on only 5/10 requests. Grok was reliable, but Qwen3-VL was
cheaper, faster, and more accurate. Astra was reliable and slightly more
accurate overall than Qwen, but delivered no measurable degraded-scan advantage.

## Audited results

The quality figures below exclude `po_number` using the same visibility audit
as round one. Valid and schema-valid rates use all 10 scheduled observations;
latency covers usable responses only.

| Model | Valid / schema-valid | Failures | Exact docs | Exact-leaf quality | Degraded quality | 10-invoice cost | Median | p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `qwen/qwen3-vl-235b-a22b-instruct` | **10/10 / 10/10** | **0%** | **8/10** | 98.56% | **99.19%** | $0.01055 | **6.12 s** | **6.84 s** |
| `openai/gpt-6-astra` | **10/10 / 10/10** | **0%** | **8/10** | **99.04%** | **99.19%** | $0.75879 | 6.82 s | 9.65 s |
| `x-ai/grok-4.6` | **10/10 / 10/10** | **0%** | 6/10 | 98.08% | 98.39% | $0.08375 | 8.37 s | 11.06 s |
| `xiaomi/mimo-v2.5` | 5/10 / 5/10 | 50% | 4/10 | 46.63% | 78.23% | $0.01020 projected* | 13.48 s* | 23.51 s* |
| `google/gemma-4-26b-a4b-it` | 5/10 / 5/10 | 50% | 5/10 | 43.27% | 22.58% | **$0.00499 projected*** | 27.51 s* | 35.73 s* |

\* Gemma and MiMo each returned five responses whose message content was null.
Their comparison cost is the mean captured cost of usable responses multiplied
by 10, matching the first benchmark's treatment of partial model results.
Captured usable-response cost was $0.00250 for Gemma and $0.00510 for MiMo.
Null-content responses did not retain usage metadata, so actual billed cost can
differ. Their latency distributions also cover only the five usable responses.

Every usable response from every model conformed to the complete fixed JSON
Schema. Every usable response also extracted all line-item leaves exactly. The
remaining non-failure errors were scalar semantics:

- Qwen3-VL returned printed `None` as a string on two invoices and inferred one
  due date that the label data marks as absent.
- Astra returned printed `None` as a string on two invoices.
- Grok sometimes retained the printed `ATTN:` label in `customer_name`, and
  also returned printed `None` text as a string.
- MiMo's only usable-output mismatch retained `ATTN: None` as the customer.

## Degraded-scan robustness

The degraded slice contains the same three faded and three bad-scan invoices
used in round one.

| Model | Valid degraded outputs | Exact degraded docs | Degraded exact-leaf quality | Bad-scan quality |
|---|---:|---:|---:|---:|
| `qwen/qwen3-vl-235b-a22b-instruct` | **6/6** | **5/6** | **99.19%** | **98.28%** |
| `openai/gpt-6-astra` | **6/6** | **5/6** | **99.19%** | **98.28%** |
| `x-ai/grok-4.6` | **6/6** | 4/6 | 98.39% | **98.28%** |
| `xiaomi/mimo-v2.5` | 5/6 | 4/6 | 78.23% | **98.28%** |
| `google/gemma-4-26b-a4b-it` | 2/6 | 2/6 | 22.58% | 24.14% |

Qwen and Astra were indistinguishable on the aggregate degraded slice. Qwen
therefore wins the practical comparison on cost and latency. MiMo happened to
complete all three bad scans accurately apart from the same `ATTN: None`
semantic mismatch, but its clean-image and faded-image null outputs make that
result unsuitable as a production guarantee.

## Pareto layers

The formal objectives minimize projected 10-invoice cost and median successful
response latency while maximizing visible-field exact-leaf quality.

- **Layer 1:** `google/gemma-4-26b-a4b-it`, `xiaomi/mimo-v2.5`,
  `qwen/qwen3-vl-235b-a22b-instruct`, `openai/gpt-6-astra`
- **Layer 2:** `x-ai/grok-4.6`

Gemma and MiMo remain mathematically nondominated only because their low
projected cost trades against their severe failure penalty. With a 100%
valid-output requirement, the round-two frontier is Qwen3-VL and Astra; Grok is
dominated by Qwen3-VL. Across both rounds and after the same reliability filter,
the practical frontier is Qwen 3.5 9B for minimum cost, Qwen3-VL for much lower
latency and document specialization, and Gemini 3.8 Flash for the best measured
quality and latency.

## Model availability and pricing snapshot

Immediately before the paid run, the runner queried the
[OpenRouter public model catalog](https://openrouter.ai/api/v1/models) and each
model's endpoint listing. Every selected model advertised image input, and at
least one live endpoint advertised both `response_format` and
`structured_outputs`. Prices are dollars per million tokens.

| Model role | Model | Catalog input / output | Lowest listed strict input / output rates | Live strict endpoints |
|---|---|---:|---:|---:|
| Very cheap open model | `google/gemma-4-26b-a4b-it` | $0.042 / $0.22 | $0.042 / $0.22 | 7 |
| Document/OCR-oriented | `qwen/qwen3-vl-235b-a22b-instruct` | $0.21 / $1.90 | $0.20 / $0.88 | 5 |
| Strong general VLM | `xiaomi/mimo-v2.5` | $0.14 / $0.28 | $0.13 / $0.336 | 2 |
| Strong general VLM | `x-ai/grok-4.6` | $2.00 / $6.00 | $2.00 / $6.00 | 5 |
| Frontier model | `openai/gpt-6-astra` | $10.00 / $50.00 | $5.00 / $25.00 | 5 |

The complete endpoint-level response, including alternative providers and
prices, is preserved in the catalog snapshot. Actual benchmark cost uses
OpenRouter's response `usage.cost`, so it reflects the provider route selected
for each successful request rather than an estimate from the table. The lowest
listed input and output rates are independent minima; for MiMo they belong to
different endpoints.

## Methodology and comparability

Round two reused the exact pinned 10-image manifest: four clean, three faded,
and three bad-scan synthetic invoices across four layouts. It imported round
one's prompt, JSON Schema, request builder, parser, scoring functions, cost
aggregation, percentile calculation, and Pareto implementation. Each model saw
each invoice exactly once at the benchmark level; the inherited request helper
allowed up to three retries for request errors.

Strict quality is the same micro-average over the union of expected and actual
JSON leaf paths. Missing or extra leaves are penalized, and JSON integer/float
representations compare numerically. Exact-document rate uses deep JSON
equality after parsing. The audited score removes `po_number` from both expected
and predicted objects because the selected images do not visibly support the
source records' PO labels. Raw source-label scores remain unchanged.

One inherited latency limitation matters: the request timer restarts for each
retry, so a later successful attempt reports that attempt's latency rather than
the full retry-plus-backoff wall time. Grok invoice 4 succeeded on its second
attempt. Reported median and p95 values preserve this round-one methodology for
comparability, but should not be interpreted as full job completion SLOs.

The dataset is synthetic and contains only 10 documents. The results are strong
screening evidence, not a substitute for a larger evaluation on production
invoice distributions, languages, layouts, and corruption modes.

## Reproduction

```bash
npm run benchmark:invoice:round2 -- --verify-only
OPENROUTER_API_KEY=... npm run benchmark:invoice:round2
npm run benchmark:invoice:round2:audit -- \
  benchmark/invoice_ocr/results/runs_round2_20260910T231153Z.jsonl
```

The API key is read only from the process environment and is not included in
the repository or any result artifact.

## Artifacts

- `benchmark_round2.ts` - fixed round-two slate, live catalog validation, calls,
  raw aggregation, and collision-safe output naming
- `audit_round2.ts` - identical PO visibility projection, strict local schema
  validation, degraded-scan slices, reliability metrics, and Pareto layers
- `results/runs_round2_20260910T231153Z.jsonl` - all 50 per-invoice observations
- `results/summary_round2_20260910T231153Z.json` - untouched source-label summary
- `results/audited_summary_round2_20260910T231153Z.json` - final reported metrics
- `results/model_catalog_round2_20260910T231153Z.json` - availability, capability,
  provider, and pricing snapshot taken immediately before the run
