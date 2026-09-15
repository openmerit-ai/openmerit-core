# Invoice Vision/OCR Benchmark Report

Run date: 2026-09-11 (Asia/Kolkata)  
Workload: 5 models × 10 invoices = 50 planned model–invoice comparisons

## Recommendation

**Use `google/gemini-3.8-flash`.** It produced the best visible-field quality
(99.52% strict exact-leaf accuracy; 9/10 completely exact documents), the
lowest median latency (4.11 s), and cost $0.02107 for all 10 invoices. It is
the clear knee of this benchmark and strictly dominates the OpenAI and
Anthropic models on all three measured objectives.

Use `qwen/qwen3.5-9b` only when minimizing spend matters more than response
time. It cost $0.00636 for 10 invoices and reached 99.04% quality, but its
median latency was 33.71 s and p95 was 72.42 s.

## Results

| Model | Valid JSON | Exact docs | Exact-leaf quality | 10-invoice cost | Median latency | p95 latency |
|---|---:|---:|---:|---:|---:|---:|
| `google/gemini-3.8-flash` | 10/10 | 9/10 | **99.52%** | $0.02107 | **4.11 s** | 7.14 s |
| `qwen/qwen3.5-9b` | 10/10 | 8/10 | 99.04% | **$0.00636** | 33.71 s | 72.42 s |
| `anthropic/claude-sonnet-5` | 10/10 | 8/10 | 99.04% | $0.14062 | 6.63 s | 8.53 s |
| `openai/gpt-5.6-sol` | 10/10 | 6/10 | 98.08% | $0.14418 | 4.26 s | **5.93 s** |
| `deepseek/deepseek-v4-flash-vision-exp` | 6/10 | 5/10 | 59.13% | $0.01071* | 7.18 s* | 81.82 s* |

\* DeepSeek returned four completed responses with no usable content. Its cost
is projected from the six responses for which `usage.cost` was captured, and
its latency distribution covers usable responses only. This makes it unsuitable
for this production workload despite its mathematical Pareto membership.

All usable responses extracted every line-item leaf exactly. The remaining
quality differences came from scalar semantics, chiefly whether printed
`None`/`ATTN: None` text should map to JSON `null` and whether an `ATTN:` label
belongs in the customer name.

## Rankings

Cheapest to most expensive:

1. `qwen/qwen3.5-9b` — $0.00636
2. `deepseek/deepseek-v4-flash-vision-exp` — $0.01071 projected
3. `google/gemini-3.8-flash` — $0.02107
4. `anthropic/claude-sonnet-5` — $0.14062
5. `openai/gpt-5.6-sol` — $0.14418

Fastest to slowest by median end-to-end latency:

1. `google/gemini-3.8-flash` — 4.11 s
2. `openai/gpt-5.6-sol` — 4.26 s
3. `anthropic/claude-sonnet-5` — 6.63 s
4. `deepseek/deepseek-v4-flash-vision-exp` — 7.18 s usable-response median
5. `qwen/qwen3.5-9b` — 33.71 s

Highest to lowest quality:

1. `google/gemini-3.8-flash` — 99.52%, 9 exact documents
2. `qwen/qwen3.5-9b` — 99.04%, 8 exact documents (tie)
2. `anthropic/claude-sonnet-5` — 99.04%, 8 exact documents (tie)
4. `openai/gpt-5.6-sol` — 98.08%, 6 exact documents
5. `deepseek/deepseek-v4-flash-vision-exp` — 59.13%, including four empty outputs

## Pareto frontier

Objectives are minimum 10-invoice cost, minimum median latency, and maximum
strict exact-leaf quality.

- **Layer 1 (nondominated):** `qwen/qwen3.5-9b` →
  `deepseek/deepseek-v4-flash-vision-exp` → `google/gemini-3.8-flash`, ordered
  from lower cost to higher cost.
- **Layer 2 (dominated):** `anthropic/claude-sonnet-5`,
  `openai/gpt-5.6-sol`.

Gemini dominates both Layer 2 models: it was cheaper, faster, and more
accurate. DeepSeek remains nondominated in the strict three-objective math
because it trades lower projected cost for worse quality and latency, but its
40% empty-output rate should be treated as a practical disqualifier.

## Methodology and audit

The 10-image set is a deterministic slice of
[`alamgirqazi/invoice-ocr-synthetic`](https://huggingface.co/datasets/alamgirqazi/invoice-ocr-synthetic)
at revision `44ddfd3c0c373b69f377910f83c4164a1e52d52c`: four clean, three faded,
and three bad-scan invoices across four layouts. The dataset is synthetic, so
results should not be assumed to transfer unchanged to real invoices.

Every request used the same image, prompt, temperature, minimal-reasoning
setting, and strict JSON Schema. Quality is a micro-average over exact JSON
leaf values, penalizing missing and extra array paths. Numeric `1` and `1.0`
are treated as the same JSON number. Latency is client-observed wall time. Cost
comes from OpenRouter's response `usage.cost`.

A manual mismatch audit found that `po_number` was latent in four selected
source records but not rendered in their images; another image showed a value
only under the label `Reference`. That field is excluded from the fair
visible-field score. The untouched source-label score remains in the raw
summary for transparency.

## Artifacts

- `README.md` — reproduction instructions and metric definitions
- `prepare_data.ts` — pinned dataset preparation
- `benchmark.ts` — fixed schema, calls, scoring, and raw aggregation
- `audit_results.ts` — documented visibility audit and final ranking
- `data/manifest.json` — the exact 10 selected invoices
- `results/runs_20260910T211526Z.jsonl` — all per-run predictions and metrics
- `results/summary_20260910T211526Z.json` — untouched source-label summary
- `results/audited_summary_20260910T211526Z.json` — final reported summary
