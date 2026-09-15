# openmerit

An **experimental model-merit harness** for [pi](https://pi.dev). Start
`openmerit watch`, run a task in pi with model A, and OpenMerit observes
its completed trace, trials B and C sequentially through pi, compares quality,
price, and latency, and swaps that pi session to the selected model before its
next task when the policy gate permits it.

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
   auto-apply by default for session-bound trials, score-gain/price thresholds, budgets,
   provider allow-lists. Public-benchmark relevance lives in
   [`src/benchmarks.ts`](src/benchmarks.ts) (task category → benchmarks that
   matter) plus a refreshable digest at `~/.openmerit/benchmarks/digest.json`.
2. **Background track** — `openmerit watch` is a separate process. It reads the
   latest completed pi task and compares candidates sequentially under daily
   budget caps.
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

# automatic per-task comparison (leave this running):
node dist/cli.js watch
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

The watcher reuses model A's completed result from the active pi session trace.
It then runs models B and C **sequentially through pi**, rather than calling OpenRouter chat
completions for the candidate answers. If the active trace does not match, A
also runs in a fresh pi session and the CLI says so. Pi's traces and JSON event
stream supply each model's result, estimated cost, latency, and errors. A
separate OpenRouter judge scores the result against the same rubric, while
OpenRouter's benchmark API helps shortlist candidates. OpenMerit keeps its
existing choice rule: highest judged quality, then lower price and latency.

This loop supports text and uploaded image tasks with tools disabled during
comparison. Candidate pi runs receive the original image bytes and task text,
but do not share previous answers or file changes. Vision tasks only consider
models whose OpenRouter catalog entry advertises image input. Their raw
sessions remain in pi's session store. Tool-using tasks and exact workspace
replay need further work. Only the latest active pi session is watched at a
time; concurrent pi sessions are not yet tracked independently.

From a clean checkout with Node 22.18+ and pi 0.85.1+ installed:

```bash
npm ci                         # runs the build via prepare
node dist/cli.js init
pi install /absolute/path/to/openmerit
# Put OPENROUTER_API_KEY=... in ~/.openmerit/.env (chmod 600), and log in to
# OpenRouter in pi with /login openrouter or an environment variable.
```

Start the watcher in one terminal before the task:

```bash
node dist/cli.js watch
```

In another terminal, start pi with an OpenRouter model and a task (use
`--no-tools` for the initial comparison). Leave pi open after model A finishes.
The watcher prints A/B/C trial measurements and its choice. The extension polls
for a recommendation bound to that pi session and applies an eligible swap with
`pi.setModel()`. `/openmerit` shows the recommendation and current model; the
next pi turn should use the selected model. If the gate declines an automatic
swap, `/openmerit apply` is still available. The existing `trial` command
remains available for controlled runs from a task JSON file.

When another pi session completes the **same task** (ignoring text case and
whitespace, and matching exact image bytes if present), the extension shows the most recent earlier session's measured
choice and A/B/C quality, price, and latency in a notice and in `/openmerit`.
That history is advice only: it does not become a pending swap in the new
session. The watcher still compares the new session's own run before any
automatic model change. Similar-task matching and context-aware reuse are
future experiments.

### Pinned invoice image example

The existing invoice benchmark provides 10 pinned images and ground-truth JSON.
For an end-to-end pi watcher test, start `node dist/cli.js watch`, then open pi
with a vision-capable OpenRouter model such as `google/gemini-3.8-flash` and
`--no-tools`. Upload
[`invoice_01_row_2.jpg`](benchmark/invoice_ocr/data/invoice_01_row_2.jpg) with
pi's `@path/to/image.jpg` input and paste the exact text from
[`examples/invoice-prompt.txt`](examples/invoice-prompt.txt). Keep that pi
session open while the watcher trials two other vision models. For these exact
image/prompt pairs, the watcher reuses the benchmark's visibility-audited
exact-leaf scorer. Other uploaded invoices use a vision judge that sees the
image and answer, since no ground truth is available. Unlike the standalone
benchmark, pi candidate runs rely on the explicit prompt for JSON structure;
they do not send OpenRouter's strict `response_format` contract, so results
are not directly comparable to the benchmark report.

## State layout (`~/.openmerit/`)

| file | contents |
|---|---|
| `policy.json` | the policy file (gate thresholds, budgets, intervals) |
| `harness-state.json` | written by the pi extension: current model, fallback, latest session and settled task |
| `recommendations.jsonl` | shared append-only channel: session-bound swap recommendations + status updates |
| `trials.jsonl` | every model trial point (source, score, price, latency) |
| `observations.jsonl` | task observations extracted from session traces |
| `catalog/snapshot.json` + `candidates.json` | catalog snapshot (including input modalities) + new-model queue |
| `benchmarks/digest.json` | public-benchmark scores per model (seed + refresh) |
| `ledger.json` | daily trial spend (budget enforcement) |
| `watch/processed.json` | latest task handled by the watcher (including retry status) |

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
