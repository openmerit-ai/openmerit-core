# Policy-Adjudication Model Benchmark

This benchmark evaluates five OpenRouter models on 12 frozen reimbursement
cases. It measures exact policy decisions, arithmetic and precedence handling,
strict structured-output reliability, prompt-injection resistance, cost, and
latency.

The complete contract and deployment threshold are in `EVAL_SPEC.md`.
`EVAL_MANIFEST.json` pins SHA-256 hashes for the specification, policy, and
case data; the runner refuses to proceed if any frozen input has changed.

## Run

```bash
npm run benchmark:policy:validate
npm run benchmark:policy -- --verify-only
OPENROUTER_API_KEY=... npm run benchmark:policy
npm run benchmark:policy:audit -- \
  benchmark/policy_adjudication/results/runs_<timestamp>.jsonl
```

`--verify-only` validates frozen inputs plus current model availability and
structured-output endpoint support without making paid completion calls. Raw
JSONL, catalog snapshots, aggregate summaries, and independently recomputed
audits are written under `results/`; timestamped names and explicit overwrite
guards preserve earlier artifacts.

## Data

- `data/policy.txt` — the numbered reimbursement policy.
- `data/cases.json` — 12 cases and frozen expected outputs, including three
  prompt-injection cases.
- `EVAL_SPEC.md` — scoring, precedence, controls, and deployment threshold.
- `EVAL_MANIFEST.json` — frozen-input hashes.
