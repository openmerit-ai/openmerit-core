# openmerit

An **experimental model-merit harness** for [pi](https://pi.dev). Start
pi with model A, and the OpenMerit extension observes
its completed trace, trials B and C sequentially through pi, compares quality,
price, and latency, and recommends a model for that exact pi session. The
shipped policy is supervised: you review and apply a recommendation with
`/openmerit apply`. Automatic swaps are available as an explicit opt-in.

```text
pi task A → saved pi trace → extension trial job → pi trials B, C → scored frontier
    ↑                                                     │
    └──── pi.setModel() ← approval/policy ← recommendation ┘
```

## How it maps to the design

1. **Instruction file + policy file** — [`instructions/OPENMERIT.md`](instructions/OPENMERIT.md)
   goes into the main harness's context (AGENTS.md-style);
   [`instructions/openmerit.policy.json`](instructions/openmerit.policy.json)
   (copied to `~/.openmerit/policy.json` by `openmerit init`) gates autonomy:
   supervised recommendations by default, optional auto-apply thresholds,
   budgets, and provider allow-lists. Public-benchmark relevance lives in
   [`src/benchmarks.ts`](src/benchmarks.ts) (task category → benchmarks that
   matter) plus a refreshable digest at `~/.openmerit/benchmarks/digest.json`.
2. **Trial workflow** — the pi extension starts a session-bound comparison
   after a supported task settles. It runs candidate trials sequentially under
   configured candidate-trial caps. `openmerit watch` remains an optional CLI
   mode. Pi's traces and JSON event stream supply results, cost,
   latency, and errors; a judge or known-ground-truth scorer measures quality.
3. **Per-task pareto frontier** — trials are keyed by task signature
   ([`src/frontier.ts`](src/frontier.ts), 3 objectives: quality ↑, price ↓,
   latency ↓). The aggregate across all of an agent's tasks is the union of
   its task frontiers (`openmerit frontier`).
4. **Model discovery** — the OpenRouter catalog is snapshotted and diffed;
   newly appeared models are queued for future release experiments. The
   per-task loop shortlists currently available pi/OpenRouter models with
   OpenRouter benchmark signals and the existing strategist
   ([`src/catalog.ts`](src/catalog.ts) + [`src/daemon.ts`](src/daemon.ts)).
5. **Informing the main harness** — recommendations land in
   `~/.openmerit/recommendations.jsonl`. The pi extension
   ([`extension/openmerit.ts`](extension/openmerit.ts)) reports progress, polls it, and applies
   swaps with `pi.setModel()` — automatically when the policy gate passes,
   otherwise after user approval (`/openmerit`, `/openmerit apply`). The same
   recommendation carries the updated fallback, used when the active model
   starts failing.

## Install from npm

You need Node 22.18+, pi 0.85.1+, and an OpenRouter API key with available
credits. Install the package into pi, then initialize its policy and state:

```bash
pi install npm:openmerit
npx --yes openmerit init
pi list
```

`pi install` makes the extension and its trial engine available to pi. The
one-off `npx` command creates `~/.openmerit/policy.json`; install OpenMerit
globally with `npm install --global openmerit` only if you also want persistent
shell access to `openmerit status`, `frontier`, or the optional watcher. Install
the extension from only one source—remove any older copied `openmerit.ts` first
so pi does not load it twice.

For development from a local checkout instead, run:

```bash
npm ci
node dist/cli.js init
pi install "$PWD"
```

Keep that checkout available because pi loads a local package from its path.

## Run OpenMerit with pi

1. Initialize OpenMerit if you did not do so during installation:

   ```bash
   npx --yes openmerit init
   ```

   `init` creates `~/.openmerit/policy.json` if missing and **keeps an existing
   policy**. The shipped policy uses `"mode": "recommend"` and does not change
   the active model without approval.

2. Give **Pi and the extension trial job** OpenRouter access. The job reads
   `OPENROUTER_API_KEY` from its environment or `~/.openmerit/.env`. If using
   the file, edit it to contain `OPENROUTER_API_KEY=your-key` and protect it:

   ```bash
   nano ~/.openmerit/.env
   chmod 600 ~/.openmerit/.env
   ```

   Pi does **not** read OpenMerit's `.env` file. Log in to OpenRouter with
   `/login openrouter` inside pi, or export `OPENROUTER_API_KEY` in the shell
   that starts pi. Verify pi's side without printing the key:

   ```bash
   pi auth check --provider openrouter --json
   ```

   A ready configuration prints `{"status":"ready","provider":"openrouter",...}`.
   Older `model_search/.env` files are not read by the trial engine.

3. Verify the extension appears in `pi list`. The instruction file
   [`instructions/OPENMERIT.md`](instructions/OPENMERIT.md) can be added to a
   pi project's AGENTS.md for agent context, but the extension does
   not require it.

4. Start pi in one terminal with an OpenRouter model and tools disabled:

   ```bash
   pi --provider openrouter --model openai/gpt-4o-mini --no-tools
   ```

   For a first text task, ask: “Give the shortest valid word ladder from cat
   to dog. Each step changes one letter and must be a common English word.
   Return only the path.” Wait for A to finish and leave the pi session open.
   The extension automatically starts B and C **sequentially through pi**,
   reports each score in Pi, and writes a recommendation for this exact
   session. With the shipped supervised policy, use
   `/openmerit` inside pi to inspect the evidence and `/openmerit apply` to
   switch. Then send a second message to see which model actually handles it.
   You do not need a watcher terminal or the standalone `trial` command.

   To opt in to automatic swaps, edit `~/.openmerit/policy.json`, set
   `"mode": "auto"` and `"auto_apply.enabled": true`, review the score-gain
   and price-ratio thresholds, and run the next task.

### Try an invoice-to-JSON task

Use the same one-terminal setup. Start pi with a vision-capable model, for
example `openai/gpt-4o-mini`, and `--no-tools`. In pi, type `@` to select
[`benchmark/invoice_ocr/data/invoice_01_row_2.jpg`](benchmark/invoice_ocr/data/invoice_01_row_2.jpg)
and paste the **entire, unchanged** text from
[`examples/invoice-prompt.txt`](examples/invoice-prompt.txt) into the same
message. Pi also accepts pasted or dragged images. Wait for the JSON answer;
keep pi open while the extension trials two other vision models. OpenMerit uses
the existing benchmark's visibility-audited exact-field scorer when the saved
task contains the exact example prompt and original bytes of a pinned JPEG.
Pi may resize an attached image or add a file header to the prompt; in that
case, the run uses the vision judge that sees the image and answer. Other
uploaded invoices also use that judge because they have no ground truth.

A real pinned-invoice run produced this trial output (models and scores will
vary between runs):

```text
[openmerit] task 0e7642522dc5: A=openai/gpt-4o-mini score=1.00 from pi trace
[openmerit] task 0e7642522dc5: google/gemma-3-12b-it score=0.31 cost=$0.0001
[openmerit] task 0e7642522dc5: mistralai/ministral-14b-2512 score=1.00 cost=$0.0007
[openmerit] task 0e7642522dc5: selected mistralai/ministral-14b-2512; auto=false
```

Pi candidate runs rely on the explicit invoice prompt for JSON structure.
The standalone invoice benchmark sends a strict OpenRouter `response_format`
schema, so its published scores are not directly comparable to these pi runs.

### Inspect or troubleshoot a run

`npx openmerit status` shows the latest pi model and pending recommendations;
`npx openmerit frontier` shows measured quality, blended price, latency, and
the chosen frontier per task. `/openmerit` inside pi shows the current model,
fallback, current-session comparison status, trial budget, pending
recommendation, and any exact-task result
measured in another session. When the gate declines an automatic swap, it
prints reasons and `/openmerit apply` remains available.

The daily trial-count and dollar limits come from `~/.openmerit/policy.json`.
If a limit is reached, the extension reports why it skipped the comparison;
the count resets at midnight UTC. You may raise `budgets.max_trials_per_day`
for local experiments while keeping `budgets.max_usd_per_day` as a conservative
candidate-spend threshold.

If no comparison starts after Pi settles, confirm that pi loaded the extension
(`pi list`), the task finished, the pi session is saved (do not use
`--no-session`), and the task used no tools. Image candidates must advertise
image input in OpenRouter's current model catalog. The extension queues
completed tasks from its current session and runs one comparison at a time.
Closing or switching the session cancels the active job.
Candidate runs use the same text and uploaded image bytes, but they do not
replay earlier answers or file changes. An exact task in another session
(including identical image bytes) appears as **advice**, not a pending swap;
the new session still gets its own comparison. The optional `trial` command
remains for controlled text-task runs from a task JSON file.

## Alpha boundaries

- With the extension installed and an OpenRouter key configured, each supported
  settled task can start comparison calls automatically. Candidate, judge, and
  strategist requests send the task text, attached images, and candidate output
  to OpenRouter and can incur charges. Use non-sensitive test tasks and
  conservative account limits while evaluating this alpha.
- The extension queues tasks from its current pi session, compares one at a
  time, and skips tasks that use tools. Candidate sessions replay the latest
  text and images, not earlier conversation context or workspace changes.
- `ledger.json` counts reported candidate-trial spend and the daily number of
  trials. It does not yet include rubric, judge, or strategist request cost,
  and `max_usd_per_trial` is not yet a hard provider-side cap.
- Each comparison has one observed baseline plus a small candidate slate and
  one quality score per answer. Treat recommendations as experimental evidence,
  not a universal model ranking.

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
| `watch/processed.json` | latest task handled by optional CLI watcher |
| `watch/jobs/*.json` | per-session comparison status and retry marker |

## Benchmarks

From a source checkout, the benchmark runners are TypeScript and execute
directly on Node 22.18+; no transpilation step or Python environment is
required. The slim npm artifact keeps only the pinned invoice data needed by
runtime scoring; use the repository checkout for these developer commands:

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

## Maintainer release

OpenMerit follows pi's [package format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md):
the npm manifest has the `pi-package` keyword, a `pi.extensions` entry, and the
pi API as a peer dependency. Public npm packages with that keyword are eligible
for pi's package gallery; a separate approval from the pi team is not part of
the standard listing flow.

Before publishing a release:

```bash
npm run check
npm pack --dry-run
npm publish --access public
```

Then verify the actual public artifact with `npm view openmerit` and a clean
`pi install npm:openmerit`. Gallery indexing may not be immediate. A featured
or curated mention in pi-owned documentation is separate and would require the
maintainers to accept a contribution or request.
