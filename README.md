# openmerit

An **experimental model-merit harness** for [pi](https://pi.dev). Its first
per-task loop observes model A's pi run, trials B and C sequentially through
pi, maintains a quality/price/latency frontier, and recommends a model switch
for that task. A background catalog watcher also exists, but first-run
model discovery is not yet the primary alpha workflow.

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

node dist/cli.js init          # sets up ~/.openmerit (policy, state)
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
pi install /absolute/path/to/openmerit  # package manifest loads the extension
# add instructions/OPENMERIT.md to your project/global AGENTS.md context
pi
```

## Per-task alpha loop

The `trial` command first reuses model A's completed result from the active pi
session trace when its latest task and model match the task file. It then runs
models B and C **sequentially through pi**, rather than calling OpenRouter chat
completions for the candidate answers. If the active trace does not match, A
also runs in a fresh pi session and the CLI says so. Pi's traces and JSON event
stream supply each model's result, estimated cost, latency, and errors. A
separate OpenRouter judge scores the result against the same rubric, while
OpenRouter's benchmark API helps shortlist candidates. OpenMerit keeps its
existing choice rule: highest judged quality, then lower price and latency.

This first loop supports text tasks with tools disabled during comparison. The
candidate pi runs therefore share the same task and project context, but do
not share previous answers or file changes. Their raw sessions remain in pi's
session store; the CLI prints each trial session id. Tool-using tasks and exact workspace
replay need further work. The background `watch` mode remains experimental and
does not bootstrap an A/B/C comparison from a fresh catalog snapshot.

From a clean checkout with Node 22.18+ and pi 0.85.1+ installed:

```bash
npm ci                         # runs the build via prepare
node dist/cli.js init
pi install /absolute/path/to/openmerit
# Put OPENROUTER_API_KEY=... in ~/.openmerit/.env (chmod 600), and log in to
# OpenRouter in pi with /login openrouter or an environment variable.
```

Copy `examples/task.example.json` and set `initial_model` to the OpenRouter
model you will use in pi. In a pi TUI session, start with that model and the
**exact** task text from the JSON file; use `--no-tools` for this text-only
comparison. Wait until pi finishes task A. Keep that session open, then in
another terminal run:

```bash
node dist/cli.js trial /path/to/your-task.json --rounds 3
node dist/cli.js frontier
```

The extension polls for a recommendation tied to the most recent task in that
pi session. Use `/openmerit` to inspect it and `/openmerit apply` to switch the
session model. The next pi turn should show the selected OpenRouter model. The
default policy is recommend-only; no swap occurs until you apply it.

## State layout (`~/.openmerit/`)

| file | contents |
|---|---|
| `policy.json` | the policy file (gate thresholds, budgets, intervals) |
| `harness-state.json` | written by the pi extension: current model, fallback, session |
| `recommendations.jsonl` | the channel: swap recommendations + status updates |
| `trials.jsonl` | every model trial point (source, score, price, latency) |
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
