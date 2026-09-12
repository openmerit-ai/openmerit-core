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

# one-shot model search on a task spec (standalone, like model_search):
node dist/cli.js trial model_search/task.example.json --rounds 5

# the background track:
node dist/cli.js watch         # or --once for a single pass
```

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

## Prior art in this repo

- `model_search/` — the original Python iterative model-search loop
  (judge + strategist + pareto frontier). `src/` is its TypeScript port,
  extended with traces, the catalog watcher, and the policy gate.
- `benchmark/invoice_ocr/` — a real 3-objective benchmark (quality/cost/
  latency) with pareto analysis; the methodology the frontier follows.
