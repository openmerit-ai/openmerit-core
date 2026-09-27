# Testing

## Standard verification

```sh
npm install
npm test
npm run check
npm run verify
npm pack --dry-run
```

Tests cover protocol contracts, lifecycle decisions, post-build target detection, incumbent identity, baseline sufficiency, durable candidate handoffs, candidate/frontier/swap sequencing, conservative Pareto verification, persistence, audit events, safe evidence identifiers, Pi commands, private intent delivery, evidence requirements, and mutation boundaries.

The routine `packages/pi/test/live-wakeup.test.ts` test uses a disposable project to verify that a due, insufficient baseline is checked and recorded without starting Pi. A prior opt-in live OpenRouter run proved the former harness-driven assessment could issue an intent and call tools, but Pi did not complete it within the bounded test. Candidate discovery and model changes still require a representative headless end-to-end trial before claiming unattended operation.

Automation tests additionally cover task and elapsed cadence, idempotent target-bound signal delivery, durable pending work, catalogue changes, metric regression thresholds, native wakeup requests, unsupported-scheduler fallbacks, delayed post-swap verification, and Pi dispatch from explicit application-task signals. Pi's own settled-turn telemetry is not a product-observation test path.

## Pi load smoke test

```sh
./node_modules/.bin/pi --no-session --no-extensions -e ./packages/pi/src/index.ts --list-models
```

This proves the real Pi runtime loads the extension and enumerates its available catalogue. It does not prove a provider can complete an end-to-end product intent.

CI also packs `openmerit`, installs the tarball in a temporary directory,
imports its public core and protocol entry points, and loads the installed Pi
extension. This checks the published artifact rather than only the workspace.

## Evidence levels

- **Unit verified** — deterministic behavior has automated coverage.
- **Runtime smoke verified** — the actual Pi runtime loads the extension.
- **Product trial verified** — Pi creates evals and observability in a real product and completes an intent with evidence.
- **Production verified** — representative repeated runs support reliability and distribution claims.

The current repository is unit- and runtime-smoke-verified. Product and production claims require target-product evidence.

## Experimental Pi/OpenMerit sandbox demo

This repository includes a disposable, live-provider demo for showing the complete experimental loop. It is not the shipping product workflow and its small evaluation set is not evidence for reliability claims.

Requirements: Node.js 22.19+, Pi 0.87.x with OpenRouter coding-harness authentication, and an OpenRouter application credential available as `OPENROUTER_API_KEY` or in Pi's local `auth.json`. The coding-harness credential is not passed to the generated application; the demo runner supplies the application credential only while making provider calls.

```sh
npm run demo
```

Pi builds a small sentiment-classification app and infers a task/evaluation plan in a temporary directory. The runner validates the plan against available collectors, shows the selected metrics and rationales, smoke-tests the app's configurable route through a live application call, and passes the inferred profile to OpenMerit's coordinator. Task quality is scored only by exact sentiment-label match; rationale plausibility is not graded. The runner collects a baseline, randomly interleaves incumbent/challenger calls over Pi's same three to five representative cases with two repetitions per case, records provider-reported token use and request cost plus measured latency and task outcomes, asks OpenMerit to calculate and verify the Pareto frontier, applies a selected frontier route only in that temporary app, and runs a new post-swap check for every case/repetition. It stops on missing model availability, missing provider usage/cost, invalid output, or a $1 default application-provider spend threshold checked after each response. The saved summary includes its randomization seed.

The default baseline is `openai/gpt-4.1-mini`, with `openai/gpt-4o-mini` as the challenger. Override the selection with `OPENMERIT_DEMO_BASELINE_MODEL` and comma-separated `OPENMERIT_DEMO_CANDIDATE_MODELS`; candidates must be available in the current OpenRouter catalogue. `OPENMERIT_DEMO_PI_MODEL` selects the Pi coding model. `OPENMERIT_DEMO_REPETITIONS` accepts 2–5, `OPENMERIT_DEMO_MAX_SPEND_USD` accepts a cap up to $5, and `OPENMERIT_DEMO_SEED` supplies a repeatable ordering seed.

The temporary directory path is printed at startup and completion. It contains the generated app and inferred plan, `.openmerit/` lifecycle state and redacted event log, per-call `artifacts/application-runs.jsonl`, comparison manifest, and summary. The runner executes application calls serially. Its spend threshold measures application calls only; Pi's coding-model spend is not measured or included. Its tiny task set and sample count are a mechanics demo only: do not present its observed rates, average latency, or frontier as representative reliability, quality, or performance claims.
