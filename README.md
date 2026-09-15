# openmerit

An **external model-merit harness** for [pi](https://pi.dev). openmerit plugs into
an existing agent harness (another pi instance) and improves it over time: it
watches what the main harness does, evaluates candidate models on a background
track, maintains a per-task pareto frontier, and tells the main harness — with
reasoning — when to swap models and what its fallback should be.

```
┌────────────────────────┐         traces (session files)         ┌──────────────────────────┐
│      main harness      │ ─────────────────────────────────────▶ │   openmerit (sidecar)    │
│  pi + openmerit ext    │                                        │                          │
│                        │ ◀───────────────────────────────────── │  1. ingest traces        │
│  current model ◀────── │   recommendations.jsonl (swap + why +  │  2. watch catalog for    │
│  fallback model        │   fallback, policy-gated)              │     new model releases   │
└────────────────────────┘                                        │  3. shadow trials        │
        ▲ provider/router change applied via pi.setModel()        │  4. per-task pareto      │
        │                                                         │     frontier             │
        └──────────────────────────────────────────────────────── │  5. recommend swap       │
                                                                  └──────────────────────────┘
```

## How it maps to the design

1. **Instruction file + policy file** — [`instructions/OPENMERIT.md`](instructions/OPENMERIT.md)
   goes into the main harness's context (AGENTS.md-style);
   [`instructions/openmerit.policy.json`](instructions/openmerit.policy.json)
   (copied to `~/.openmerit/policy.json` by `openmerit init`) gates autonomy:
   recommend-only vs auto-apply, score-gain/price thresholds, budgets,
   provider allow-lists. Public-benchmark relevance lives in
   [`src/benchmarks.ts`](src/benchmarks.ts) (task category → benchmarks that
   matter) plus a refreshable digest at `~/.openmerit/benchmarks/digest.json`.
2. **Background track** — `openmerit watch` is a separate process. It never
   blocks the main agent; it reads session files incrementally and runs
   shadow trials under daily budget caps.
3. **Per-task pareto frontier** — trials are keyed by task signature
   ([`src/frontier.ts`](src/frontier.ts), 3 objectives: quality ↑, price ↓,
   latency ↓). The aggregate across all of an agent's tasks is the union of
   its task frontiers (`openmerit frontier`).
4. **New-release watch** — the OpenRouter catalog is snapshotted and diffed;
   newly appeared models are queued, ranked by benchmark prior, and trialed
   against the existing frontier ([`src/catalog.ts`](src/catalog.ts) +
   [`src/daemon.ts`](src/daemon.ts)).
5. **Informing the main harness** — recommendations land in
   `~/.openmerit/recommendations.jsonl`. The pi extension
   ([`extension/openmerit.ts`](extension/openmerit.ts)) polls it and applies
   swaps with `pi.setModel()` — automatically when the policy gate passes,
   otherwise after user approval (`/openmerit`, `/openmerit apply`). The same
   recommendation carries the updated fallback, used when the active model
   starts failing.

## Quickstart

```bash
npm install
npm run build

openmerit init                 # sets up ~/.openmerit (policy, state)
export OPENROUTER_API_KEY=...  # or put it in ~/.openmerit/.env

# one-shot model search on a task spec:
node dist/cli.js trial examples/task.example.json --rounds 5

# the background track:
node dist/cli.js watch         # or --once for a single pass
```

Older checkouts may still have a local `model_search/.env`; it is no longer
read. Move that key to `~/.openmerit/.env` or export it in the environment.

In the main harness (pi):

```bash
cp extension/openmerit.ts ~/.pi/agent/extensions/
# add instructions/OPENMERIT.md to your project/global AGENTS.md context
pi
```

## State layout (`~/.openmerit/`)

| file | contents |
|---|---|
| `policy.json` | the policy file (gate thresholds, budgets, intervals) |
| `harness-state.json` | written by the pi extension: current model, fallback, session |
| `recommendations.jsonl` | the channel: swap recommendations + status updates |
| `trials.jsonl` | every shadow-trial point (model, score, price, latency) |
| `observations.jsonl` | task observations extracted from session traces |
| `catalog/snapshot.json` + `candidates.json` | catalog snapshot + new-model queue |
| `benchmarks/digest.json` | public-benchmark scores per model (seed + refresh) |
| `ledger.json` | daily trial spend (budget enforcement) |

## Benchmarks

The benchmark runners are TypeScript and execute directly on Node 22.18+; no
transpilation step or Python environment is required:

```bash
npm run benchmark:invoice -- --models google/gemini-3.8-flash
npm run benchmark:invoice:round2 -- --verify-only
npm run benchmark:text-to-sql -- --verify-only
npm run benchmark:policy:validate
npm run benchmark:policy -- --verify-only
npm run benchmark:verify-recorded
```

- `benchmark/invoice_ocr/` — two real vision/OCR model slates over the same
  pinned 10-invoice dataset.
- `benchmark/text_to_sql/` — executable SQLite evaluation over 10 analytical
  tasks.
- `benchmark/policy_adjudication/` — 12 adversarial reimbursement-policy cases,
  including prompt-injection cases and frozen input hashes.

All three benchmark families preserve raw JSONL observations, audited summaries,
cost/latency/quality rankings, and Pareto layers. `npm run typecheck` covers both
the application and every benchmark runner. `npm run benchmark:verify-recorded`
replays the checked-in raw results locally and compares them with their audited
artifacts without making provider calls or writing new results.
