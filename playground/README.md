# Sahra Health playground

Sahra Health is a fictional, AI-native health insurer in Dubai. It is an OpenMerit customer: it installs `openmerit` from npm at a pinned version, consults Scout for every model choice, and records what happens in [FINDINGS.md](FINDINGS.md). Everything here, from members to claims to amounts, is fictional.

The first loop covers outpatient claims under **Sahra Essential**, a fictional plan built on the Dubai Essential Benefits Plan (DHA circular GC 03/2024, Appendix A). Prior authorization, networks and underwriting come later.

## How a claim flows

1. A provider posts an eClaimLink-shaped `Claim.Submission` (DHPO `ClaimSubmission.xsd`: ICD-10-CM diagnoses, CPT and drug activities, amounts) and a free-text itemized bill to `POST /claims`.
2. `ClaimFlow` (a Cloudflare Workflow) runs four agents in order. Each agent is a Durable Object running Pi Durable through the Agents SDK's `PiHarness`, with one instance and one transcript per claim:
   - **intake**: matches the bill to the XML and lists mismatches.
   - **coding**: checks codes against the 2024 code sets, and looks for unbundling and upcoding.
   - **adjudication**: decides pay or deny for each line. `propose_adjudication` computes every amount and refuses decisions that break a hard rule: eligibility, deleted codes, prior approval, exclusions, the pre-existing waiting period, and specialist care without a referral.
   - **fraud**: checks duplicates, frequency and provider patterns.
3. The claim waits in `awaiting_approval` until a person runs `npm run approve -- <claim-id> approve|reject --by <name>`. The ledger pays only claims with a recorded approval, and this is enforced in code, not in a prompt.

Enrollment (`POST /enrollments`) runs a fifth agent. It checks EBP eligibility (Dubai visa, salary of AED 4,000 or less) and reads the health declaration for pre-existing conditions.

State lives in one SQLite Durable Object (`src/ledger.ts`). Benefit math is in `src/domain/` and is unit-tested against amounts worked out by hand.

## Models

Each agent's model is in `src/models.ts`, and every choice must come from a Scout consultation recorded in [MODEL-DECISIONS.md](MODEL-DECISIONS.md). All five agents use Claude Sonnet 5.5 through OpenRouter (4 Nov 2026). Without a recorded choice the model is `null` and the agent refuses to run, so claims end in `error` with `no_model_decision`. [POLICY.md](POLICY.md) requires UAE health-data residency (Federal Law No. 2 of 2019, Art. 13), so that we can see whether Scout respects it.

## Langfuse

Traces go to Sahra's own Langfuse Cloud (US) project over OTLP/HTTP with the v4 ingestion header (`src/tracing.ts`). Each claim or application is a **session**, and each agent run is a **trace**: an `agent` root, plus a `generation` per model call (conversation, tokens, cost) and a `tool` span per tool call, rebuilt from the Pi transcript. Approval and payment form a `settle-claim` trace. Release is `openmerit@<version>` and environment is `playground`.

These evals are Sahra's own, so none of their names carry an `om-` prefix. Scores come at three levels:

| Level | Score | Type | Posted by, on |
| --- | --- | --- | --- |
| Task | `model-calls` | numeric | the Worker, on every agent trace's root observation |
| Task | `rejected-tool-calls` (tool results starting `<harness>` or `[error]`: argument validation or harness errors) | numeric | the Worker, same |
| Task | `result-recorded` (the agent recorded its extraction, review, adjudication, assessment or decision) | boolean | the Worker, same |
| Agent | `line-decisions-correct`, `fraud-recommendation-correct`, `bill-mismatch-found`, `coding-finding-found`, `enrollment-decision-correct`, `declared-conditions-found` | boolean | the scenario runner, on the scored agent's trace |
| Environment | `claim-correct` (every agent check for the claim passes), `payment-correct` (proposed payment equals the fixture's), `review-load` (fraud recommended review or hold on a claim whose only acceptable recommendation is pay) | boolean | the scenario runner, on the root observation of the claim's **final agent trace** |
| Environment | `enrollment-correct` (every agent check for the application passes) | boolean | the scenario runner, on the root observation of the application's enrollment agent trace |

A claim's final agent trace is its `assess-fraud` trace, or, when the pipeline stopped early, the trace of the agent that did not record its result. An application has one agent trace, `assess-enrollment`. Scores carry `metadata.level` (`task` or `environment`). The settlement trace is not used for scores: scenario runs end at human approval, so it does not exist yet.

**Dataset and experiments.** The runner upserts the dataset `sahra-outpatient-claims` with one item per claim fixture: item ID is the claim ID, input is the fixture name, description, submitted `Claim.Submission` XML and itemized bill, and expected output is the fixture's `expected`. Each scenario run is an experiment (dataset run) named `<model label>-<runId>`, for example `intake+coding=claude-haiku-5.5-run-2026-11-05T11-19-04-305Z` (`claude-haiku-5.5-…` when every agent runs one model, `recorded-…` without `--model`), with metadata `openmerit_version` and `model_<agent>` for each agent. Each claim's final agent trace is its experiment item, so the environment scores show per item in Langfuse's experiment comparison. Traces are linked with Langfuse's OpenTelemetry experiment attributes (`langfuse.experiment.*`, set by the Worker from the `experiment` field of `POST /claims`), because `POST /api/public/dataset-run-items` is deprecated and Langfuse Cloud stops serving it on 16 November 2026. Enrollments work the same way on a second dataset, `sahra-enrollments`: item ID is the application ID, input is the fixture name and application (with its health declaration), and expected output is the fixture's `expected`. Each run is also an experiment there, with the same name and metadata, and each application's enrollment agent trace is its experiment item.

**Aggregate import attribution.** After the tagging fix is deployed, every agent
trace in an experiment also carries `experiment:<experiment.id>`, alongside its
existing Sahra and role tags. This includes intermediate agents, not only the
final dataset-item trace. The tag uses the experiment ID, not the workflow run
ID; ordinary runs without an experiment get no experiment tag. Native experiment
item linkage and human payment approval are unchanged. Scout's aggregate
connector still needs explicit score mappings and model aliases. Historical
untagged traces are not rewritten by this release; they need attributable
aggregate reporting or a separately approved tagging backfill.

**Residency caveat:** Workers AI, Durable Objects and Langfuse US all process data outside the UAE. This setup is acceptable only because the data is fictional. A real Sahra Health could not run this way.

## Run it

Node.js 22.19 or newer, from `playground/`:

```sh
npm ci
cp .dev.vars.example .dev.vars          # fill in Langfuse and OpenRouter keys and any PLAYGROUND_TOKEN
npm run check                           # typecheck and deterministic tests (CI runs this)
npm run dev                             # wrangler dev; Workers AI calls are billed to the account
set -a; . ./.dev.vars; set +a          # in the runner's shell: PLAYGROUND_TOKEN and Langfuse keys
npm run scenarios                       # seed, submit every fixture, score the run, link the experiment
npm run approve -- FICT-CLM-1001 approve --by "<your name>"
```

`npm run scenarios -- --model openrouter/<id> --out run.json` runs every agent on one model and writes the checks, claim outcomes, cost and latency. To compare models per agent, name only the agents to change; the others keep `src/models.ts`:

```sh
npm run scenarios -- --model intake=openrouter/anthropic/claude-haiku-5.5,coding=openrouter/anthropic/claude-haiku-5.5
```

The runner sends the overrides as `models` (agent → `{ provider, id }`) on `POST /claims` and `POST /enrollments`. Without Langfuse keys in its environment it still checks the run but sends no scores, dataset or experiment. Run scenarios one at a time: each run reseeds the one shared ledger, so a run started while another's workflows are still going corrupts both. Restart `wrangler dev` to drop leftover workflows.

**Delayed cost ingestion:** after scoring, the runner waits up to two minutes for
each agent root's declared generation count and every generation's cost. Missing
or unpriced observations remain `cost: null, complete: false` in `--out`, not zero.
The console labels the total incomplete and shows only the known subtotal. Real
zero-cost generations remain valid. Latency uses the API's explicit metrics field
group and stays unknown when unavailable. These reads belong to Sahra's runner;
OpenMerit's Viewer connector still reads only aggregate metrics, not observations.

Cloudflare resources are named `playground-` (Worker `playground-claims`; Workflows `playground-claim-flow` and `playground-enrollment-flow`). Deploying, and setting secrets with `wrangler secret put`, needs the owner's approval each time.

## Release testing

For each new `openmerit` release:

1. Pin the new version exactly in `package.json` and run `npm install`.
2. Rerun `npx openmerit@<version> install --client claude-code --scope project` and `--client pi`, then `openmerit status --check` and `openmerit doctor` for each client. Installer output under `.claude/` and `.pi/` is per device and gitignored; `.openmerit/scout.json` is the committed policy.
3. In a fresh coding-agent session rooted here, one that has never seen OpenMerit source, ask for the model decisions in `scout-tasks/`. Note whether the agent consults Scout unprompted, how it handles the policy and residency, and what it recommends.
4. Apply model changes, run `npm run scenarios`, and compare the run's scores, cost and latency in Langfuse by release, using the experiments on the `sahra-outpatient-claims` dataset.
5. Add a dated entry to [FINDINGS.md](FINDINGS.md).

### Invite-only release gate (approved 6 November 2026)

Do not count green CI or a connected key as a completed customer loop. Two
consecutive published releases must pass from a fresh coding-agent session using
only the published package, its shipped docs and Scout, without a hand-written
aggregate-conversion script or undocumented operator help:

- Install and authorize; record fresh-approval and key-reuse outcomes separately.
- Identify whether Sahra has no eval setup, insufficient evals or suitable evals.
  For missing evidence, obtain a task-specific plan and let Sahra's coding agent
  implement it. Langfuse is the first connector; local/custom evals can report
  aggregates. Do not claim other platform connectors exist.
- Run approved comparisons on customer-owned evals, changing one agent at a time.
  Retain hard labelled boundary cases; all candidates passing is inconclusive.
- Import nonzero, correctly attributed aggregates through the connector. Verify
  measured reranking and reuse in a new conversation without resending results.
- Verify interrupted/failed sync preserves the previous complete import, missing
  mappings are actionable, and revoked credentials fail safely.
- Preserve a local Markdown decision record with versions, aggregate results,
  controls, sample counts, spend, limitations and regret. Exclude keys and raw
  customer records. Then verify approved disconnect removes imported results.
- Clean up only explicitly approved comparison runs, after evidence is saved;
  retain reusable fixtures/eval definitions and never delete existing customer
  records. OpenMerit remains Viewer-only; the customer controls platform writes.

Ship focused checkpoints, then rerun the applicable playground checks. Record
actual outcomes and remaining gaps in FINDINGS; a plumbing smoke test is not
proof of model quality, fresh-agent usability or the two-release gate.

## Sources

- DHA circular GC 03/2024, Essential Benefits Plan table of benefits: https://www.isahd.ae/content/docs/GC%2003%202024.pdf
- DHA circular GC 06/2025, 2024 code sets from 1 April 2026: https://www.isahd.ae/content/docs/GC%2006-2025%20Circular%20on%20Update%20of%20Code%20Sets,%20DRG%20Payment%20Parameters%20and%20Grouper%20Version%20%E2%80%93%20Effective%201%20April%202026.pdf
- eClaimLink `Claim.Submission` schema: https://www.eclaimlink.ae/dhd/claim_submission.html
- UAE Federal Law No. 2 of 2019 (ICT in health fields): https://uaelegislation.gov.ae/en/legislations/1209
- Cloudflare Agents SDK, Pi harness: https://developers.cloudflare.com/agents/harnesses/pi
