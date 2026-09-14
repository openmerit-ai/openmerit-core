# Text-to-SQL Model Benchmark

This benchmark measures five OpenRouter coding/reasoning models on 10
deterministic analytical SQLite tasks. It is intentionally different from the
invoice vision benchmark: models receive only a database schema and a natural
language question, return `{"sql": "..."}`, and are scored by executing the SQL
against a fixed in-memory database.

## Models

- `inception/mercury-2.5` - ultra-cheap fast reasoning model
- `qwen/qwen3-coder-30b-a3b-instruct` - cheap open coding model
- `mistralai/codestral-2508` - code specialist
- `moonshotai/kimi-k2.7-code` - strong agentic coding model
- `anthropic/claude-opus-5` - frontier coding/reasoning model

The runner verifies current catalog availability, pricing, text input, and at
least one live strict-structured-output endpoint before making paid calls. None
of these model IDs overlaps either invoice benchmark slate.

## Metrics

- **JSON/schema validity:** whether the response parses and exactly matches the
  one-field output schema.
- **Execution success:** whether the SQL safely executes in SQLite.
- **Exact tasks:** deep equality of column names, row order, and typed values.
- **Strict result-leaf quality:** micro-averaged exact match over the union of
  expected and actual result JSON leaves. This penalizes missing/extra rows and
  columns, so errors on larger result sets carry proportionally more weight.
- **Latency:** full client wall time for each scheduled run, including retry and
  backoff time.
- **Cost:** OpenRouter `usage.cost` summed across the 10 tasks.
- **Pareto layers:** minimize cost and median latency while maximizing strict
  result-leaf quality.

Predicted SQL is restricted to one read-only `SELECT`, `WITH`, or
`WITH RECURSIVE` statement. It runs in a fresh in-memory database with SQLite
query-only mode, a two-second execution timeout, and a 1,000-row limit.

## Reproduce

```bash
python3 benchmark/text_to_sql/benchmark.py --verify-only
OPENROUTER_API_KEY=... python3 benchmark/text_to_sql/benchmark.py
python3 benchmark/text_to_sql/audit_results.py \
  benchmark/text_to_sql/results/runs_<timestamp>.jsonl
```

The key is read only from the process environment. Timestamped output names
prevent prior results from being overwritten. The audit recomputes every
reference result and re-executes every schema-valid prediction in a fresh
database.

## Data

- `data/schema.sql` - database schema
- `data/seed.sql` - deterministic fixture data
- `data/tasks.json` - questions, skills, difficulty labels, and reference SQL
