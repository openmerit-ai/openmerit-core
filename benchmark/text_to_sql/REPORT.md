# Executable Text-to-SQL Benchmark Report

Run date: 2026-09-11 (Asia/Kolkata)  
Workload: 5 models x 10 tasks = 50 completed comparisons  
OpenRouter availability/pricing verified: 2026-09-11 09:10:53 UTC

## Recommendation

**Use `anthropic/claude-opus-5` when SQL correctness matters.** It was the only
model to return valid JSON, execute successfully, and produce the exact result
on all 10 tasks. Its median latency was 6.22 seconds, p95 was 9.98 seconds, and
the complete workload cost $0.17911.

**Use `mistralai/codestral-2508` as the low-cost speed/value option.** It had the
fastest median latency (2.65 seconds), 100% schema validity, 90% execution
success, 6/10 exact tasks, and 74.79% strict result-leaf quality for $0.00249.
It is appropriate only where downstream review or semantic validation exists;
successful SQL execution alone did not prevent wrong results.

`qwen/qwen3-coder-30b-a3b-instruct` was cheapest at $0.00087 and solved 7/10
tasks exactly, but two large-result mistakes reduced its micro exact-leaf score
to 47.87%, and a 42-second outlier pushed p95 latency to 30.01 seconds. Kimi
produced exact results on every usable response (8/8), but two null-content
responses and a 47.40-second p95 make it a poor standalone route. Mercury is
strictly dominated by Codestral on measured cost, latency, and quality.

For a cost-aware production design, a reasonable next experiment is to run
Qwen and Codestral together, accept only identical executed results, and use
Opus as the disagreement/failure fallback. In this sample the two cheap models
agreed on four tasks, all correctly; six tasks would have fallen back to Opus.
That retrospective routing pattern would cost about $0.111 for these 10 tasks,
roughly 38% less than Opus-only, though it requires a fresh prospective run to
measure fairly.

## Results

Strict quality compares the executed result JSON, including output column names,
row order, row count, and typed values.

| Model | Schema valid | Executed | Exact tasks | Strict result quality | 10-task cost | Median | p95 |
|---|---:|---:|---:|---:|---:|---:|---:|
| `anthropic/claude-opus-5` | **10/10** | **10/10** | **10/10** | **100.00%** | $0.17911 | 6.22 s | 9.98 s |
| `moonshotai/kimi-k2.7-code` | 8/10 | 8/10 | 8/10 | 85.45% | $0.03713 | 14.23 s | 47.40 s |
| `mistralai/codestral-2508` | **10/10** | 9/10 | 6/10 | 74.79% | $0.00249 | **2.65 s** | 6.52 s |
| `qwen/qwen3-coder-30b-a3b-instruct` | **10/10** | 9/10 | 7/10 | 47.87% | **$0.00087** | 7.22 s | 30.01 s |
| `inception/mercury-2.5` | 6/10 | 5/10 | 4/10 | 30.75% | $0.00307 | 3.89 s | **6.24 s** |

All 50 API calls returned a response and reported cost, including responses
whose content was unusable. Recorded total spend was $0.22266.

## Reliability and failure analysis

- **Claude Opus 5:** no failures or mismatches.
- **Kimi K2.7 Code:** two responses had null message content. The remaining
  eight were schema-valid, executable, and exact.
- **Codestral 2508:** all outputs were schema-valid. One query referenced a
  nonexistent alias; three other executable queries returned wrong results.
- **Qwen3 Coder 30B:** all outputs were schema-valid. One query referenced a
  column omitted from its own CTE, one calculated running totals at line-item
  rather than order grain, and one doubled its completed-order count.
- **Mercury 2.5:** four structured-output failures (two null contents, one
  truncated JSON string, and one non-object JSON response), one SQL string that
  did not begin with a query, and one executable but incorrect cohort query.

The difference between exact-task rate and strict micro quality is intentional.
Qwen solved one more whole task than Codestral, but its incorrect running-value
query returned 46 rows instead of 23, so the union-of-leaves metric penalized
that large semantic error heavily. This makes the micro score more sensitive to
the operational blast radius of a wrong query.

## Task difficulty

All models solved the regional revenue, anti-join, and support SLA tasks. The
hardest tasks were monthly reconciliation and repeat-purchase gaps, with only
2/5 models exact on each. Running values and signup activation cohorts were
exact for 3/5 models. Claude was 100% exact across easy, medium, and hard tasks;
Kimi was 5/6 exact on hard tasks but lost two outputs elsewhere.

| Model | Easy exact | Medium exact | Hard exact | Hard result quality |
|---|---:|---:|---:|---:|
| `anthropic/claude-opus-5` | 1/1 | 3/3 | **6/6** | **100.00%** |
| `moonshotai/kimi-k2.7-code` | 1/1 | 2/3 | 5/6 | 87.67% |
| `mistralai/codestral-2508` | 1/1 | 2/3 | 3/6 | 72.51% |
| `qwen/qwen3-coder-30b-a3b-instruct` | 1/1 | **3/3** | 3/6 | 31.63% |
| `inception/mercury-2.5` | 1/1 | 2/3 | 1/6 | 7.88% |

## Pareto layers

The objectives minimize observed 10-task cost and median latency while
maximizing strict result-leaf quality.

- **Layer 1:** `qwen/qwen3-coder-30b-a3b-instruct`,
  `mistralai/codestral-2508`, `moonshotai/kimi-k2.7-code`,
  `anthropic/claude-opus-5`
- **Layer 2:** `inception/mercury-2.5`

Each Layer 1 model exposes a real tradeoff: Qwen minimizes spend, Codestral
minimizes latency while improving quality, Kimi improves quality further at a
reliability and latency cost, and Opus is perfect but most expensive. Codestral
strictly dominates Mercury.

## Model availability and pricing

Immediately before the run, the benchmark queried the
[OpenRouter public model catalog](https://openrouter.ai/api/v1/models) and every
selected model's endpoint listing. Each model advertised text input and at
least one live endpoint supporting `response_format` and
`structured_outputs`. Catalog prices are dollars per million tokens.

| Role | Model | Input / output | Live strict endpoints |
|---|---|---:|---:|
| Ultra-cheap fast reasoning | `inception/mercury-2.5` | $0.04 / $0.15 | 1 |
| Cheap open coding | `qwen/qwen3-coder-30b-a3b-instruct` | $0.07 / $0.28 | 2 |
| Code specialist | `mistralai/codestral-2508` | $0.30 / $0.90 | 2 |
| Strong agentic coding | `moonshotai/kimi-k2.7-code` | $0.71 / $3.50 | 12 |
| Frontier coding/reasoning | `anthropic/claude-opus-5` | $5.00 / $25.00 | 7 |

The saved catalog snapshot contains complete endpoint-level pricing and
capability metadata. Actual costs in the results table use each response's
OpenRouter `usage.cost` rather than estimates from catalog rates.

## Methodology

The deterministic fixture contains customers, products, orders, line items,
payments, support tickets, and a multi-level employee hierarchy. The 10 tasks
cover filtered joins, anti-joins, top-N window functions, pre-aggregation across
multiple one-to-many relationships, running totals, cohort/date logic,
conditional aggregation, recursive CTEs, and lag-based interval analysis.

Every model received the same SQLite DDL, question, temperature, token limit,
and strict one-field JSON Schema. The runner accepted only one read-only
`SELECT`, `WITH`, or `WITH RECURSIVE` statement, then executed it in a fresh
query-only in-memory database with a two-second database timeout and 1,000-row
limit. Client latency includes retries and backoff; no request needed a retry in
this run.

The audit independently regenerated all reference results from the pinned SQL
fixture and re-executed every schema-valid model query. File hashes and the
SQLite runtime version are preserved in the raw summary. The dataset is small
and synthetic, so results should be validated on real schemas and query logs
before deployment.

## Reproduction

```bash
python3 benchmark/text_to_sql/benchmark.py --verify-only
OPENROUTER_API_KEY=... python3 benchmark/text_to_sql/benchmark.py
python3 benchmark/text_to_sql/audit_results.py \
  benchmark/text_to_sql/results/runs_20260911T091053Z.jsonl
```

The API key is read only from the process environment and is not stored in the
repository or result artifacts.

## Artifacts

- `data/schema.sql` and `data/seed.sql` - deterministic SQLite fixture
- `data/tasks.json` - natural-language tasks and canonical reference queries
- `benchmark.py` - live model validation, paid calls, safe execution, scoring,
  aggregation, and collision-safe output naming
- `audit_results.py` - independent ground-truth regeneration and query replay
- `results/runs_20260911T091053Z.jsonl` - all 50 per-model task observations
- `results/summary_20260911T091053Z.json` - raw aggregate summary
- `results/audited_summary_20260911T091053Z.json` - independently replayed metrics
- `results/model_catalog_20260911T091053Z.json` - availability and pricing snapshot
