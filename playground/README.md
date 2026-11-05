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

Traces go to Langfuse Cloud (US) over OTLP/HTTP with the v4 ingestion header (`src/tracing.ts`). Each claim or application is a **session**, and each agent run is a **trace**: an `agent` root, plus a `generation` per model call (conversation, tokens, cost) and a `tool` span per tool call, rebuilt from the Pi transcript. Approval and payment form a `settle-claim` trace. Release is `openmerit@<version>` and environment is `playground`. The scenario runner posts boolean scores, such as `line-decisions-correct` and `fraud-recommendation-correct`, on the scored agent's trace.

**Residency caveat:** Workers AI, Durable Objects and Langfuse US all process data outside the UAE. This setup is acceptable only because the data is fictional. A real Sahra Health could not run this way.

## Run it

Node.js 22.19 or newer, from `playground/`:

```sh
npm ci
cp .dev.vars.example .dev.vars          # fill in Langfuse and OpenRouter keys and any PLAYGROUND_TOKEN
npm run check                           # typecheck and deterministic tests (CI runs this)
npm run dev                             # wrangler dev; Workers AI calls are billed to the account
PLAYGROUND_TOKEN=... npm run scenarios  # seed, submit every fixture, score the agents
PLAYGROUND_TOKEN=... npm run approve -- FICT-CLM-1001 approve --by "<your name>"
```

`npm run scenarios -- --model openrouter/<id> --out run.json` runs every agent on one model and writes the scores, cost and latency. Run scenarios one at a time: each run reseeds the one shared ledger, so a run started while another's workflows are still going corrupts both. Restart `wrangler dev` to drop leftover workflows.

Cloudflare resources are named `playground-` (Worker `playground-claims`; Workflows `playground-claim-flow` and `playground-enrollment-flow`). Deploying, and setting secrets with `wrangler secret put`, needs the owner's approval each time.

## Release testing

For each new `openmerit` release:

1. Pin the new version exactly in `package.json` and run `npm install`.
2. Rerun `npx openmerit@<version> install --client claude-code --scope project` and `--client pi`, then `openmerit status --check` and `openmerit doctor` for each client. Installer output under `.claude/` and `.pi/` is per device and gitignored; `.openmerit/scout.json` is the committed policy.
3. In a fresh coding-agent session rooted here, one that has never seen OpenMerit source, ask for the model decisions in `scout-tasks/`. Note whether the agent consults Scout unprompted, how it handles the policy and residency, and what it recommends.
4. Apply model changes, run `npm run scenarios`, and compare the run's scores, cost and latency in Langfuse by release.
5. Add a dated entry to [FINDINGS.md](FINDINGS.md).

## Sources

- DHA circular GC 03/2024, Essential Benefits Plan table of benefits: https://www.isahd.ae/content/docs/GC%2003%202024.pdf
- DHA circular GC 06/2025, 2024 code sets from 1 April 2026: https://www.isahd.ae/content/docs/GC%2006-2025%20Circular%20on%20Update%20of%20Code%20Sets,%20DRG%20Payment%20Parameters%20and%20Grouper%20Version%20%E2%80%93%20Effective%201%20April%202026.pdf
- eClaimLink `Claim.Submission` schema: https://www.eclaimlink.ae/dhd/claim_submission.html
- UAE Federal Law No. 2 of 2019 (ICT in health fields): https://uaelegislation.gov.ae/en/legislations/1209
- Cloudflare Agents SDK, Pi harness: https://developers.cloudflare.com/agents/harnesses/pi
