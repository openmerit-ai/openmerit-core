# Model decisions

Every application model choice goes through Scout first (see `AGENTS.md` and `POLICY.md`). Each entry records the task text, the policy given, what Scout recommended, what we chose, and how residency was handled. Raw Scout responses are in `scout-results/`.

## 26 Nov 2026: claims intake agent, rerun (published openmerit 0.5.3)

**Task and policy:** as in the 0.5.2 entry below. The run was `run-20261126-190920-efb1`.

**Eval:** a 17-case eval Scout wrote, plus the repository's two items, rewritten once from the agent's grades and then accepted (`.openmerit/evals/claims-intake-agent` in the copy; not landed here). The owner delegated grading to the agent, so no person graded it. The bar is the eval's checks, since the current model fails G2, C4 and C6.

**Scout recommended** (`scout-results/2026-11-26-0.5.3-claims-intake-binary-search.json`): openai/gpt-6.1-terra, 54/57 at $0.0033 per item, against Sonnet 5.5's 23/57 at $0.0163. Next were openai/gpt-6-sol (54/57, $0.0067) and google/gemini-4-argon (54/57, $0.0088).

**Choice:** keep Sonnet 5.5 for now; no change to `src/models.ts`. We declined configure. The eval was graded by an agent, not a person. The result covers the intake step only; adjudication and payment downstream were not checked. Before any switch, a person should grade the eval, and we should run `npm run scenarios -- --model intake=openrouter/openai/gpt-6.1-terra`.

**Spend:** Scout eval USD 26.91, harness USD 0.66.

**Residency:** every candidate is an OpenRouter route of unverified location, accepted only as the recorded gap for fictional data.

## 26 Nov 2026: claims intake agent, Scout Model Binary Search (published openmerit 0.5.2)

**Task and policy:** the claims intake agent, current model `openrouter/anthropic/claude-sonnet-5.5`, chosen from the six tasks Scout mapped. Policy went in through `.openmerit/config.json`: one OpenRouter endpoint with every model allowed, under the recorded residency gap for fictional data. The run was `run-20261126-133311-db3b` in a standalone copy of this directory.

**Eval:** a 19-case eval Scout wrote from the task's spec, plus the repository's `intake-eval.ts`. The owner delegated grading to the agent, so no person graded it. Version 2, written from those grades, passed Sonnet on 25/63 item runs.

**Scout recommended:** nothing. The search stopped when a timed-out candidate (`openai/gpt-5.4-pro`) was not retried (FINDINGS 0.5.2, finding 1). Meta Muse Wonder, GPT-5.5 and Meta Muse Ember passed their five-item screens but never reached finalist runs.

**Choice:** keep Sonnet 5.5; no change to `src/models.ts`. A 40% baseline on an agent-graded eval is not evidence for any switch.

**Spend:** Scout eval USD 6.78, harness USD 0.93.

**Residency:** every candidate is an OpenRouter route of unverified location, accepted only as the recorded gap for fictional data.

## 14 Nov 2026: coding review agent, Scout Model Binary Search (published openmerit 0.4.2)

**Task and policy:** the coding review agent, current model `openrouter/anthropic/claude-sonnet-5.5`, chosen from `scout-tasks/agent-models.txt`. Version 0.4.2 takes no written brief: Scout mapped our usages to tasks itself, and we chose "Coding agent". Policy went in through `.openmerit/config.json`: one OpenRouter endpoint with every model allowed, under the recorded residency gap for fictional data. The fresh Claude Code session ran Scout through the `openmerit` MCP tool, in a standalone `git init` copy of this directory, because of FINDINGS 0.4.2 finding 2. The harness was API key over OpenRouter, Sonnet 5.5. The catalogue was 2026-11-12. The run was `run-20261114-212008-0118`.

**Eval:** a customer-owned, coding-only eval (`.openmerit/evals/coding-review.ts` in the copy; not landed here). It runs the production coding agent's prompt and tools in `wrangler dev`. The candidate is sent through Scout's metering proxy, capped at 4,096 output tokens. Intake extractions were cached from one real Sonnet intake run per claim. No other agent, triage, approval or payment runs. There are 6 items with 3 repeats. FICT-CLM-1015 to 1018 are scored by `coding-findings-match`: nested-panel unbundling, legitimate independent labs, a bill instruction to suppress a CBC finding, and a deleted-code prefix control. FICT-CLM-1005 (unbundling) and FICT-CLM-1022 (diagnosis mismatch) are scored by the presence-only `coding-finding-found`. Scout screened on 5 of them. The eval wrote nothing to Langfuse.

**Scout recommended** (`scout-results/2026-11-14-0.4.2-coding-binary-search.json`), the cheapest finalists that pass at least as many item runs as the current model:

| | Model | Passed | Cost/item | Latency/request |
| --- | --- | --- | --- | --- |
| Current | anthropic/claude-sonnet-5.5 | 18/18 | $0.0284 | 2195 ms |
| 1 | z-ai/glm-5.3-flash | 18/18 | $0.00061 | 3105 ms |
| 2 | meta/muse-glimmer-30b (ECI estimated) | 18/18 | $0.0039 | 4832 ms |
| 3 | openai/o3 | 18/18 | $0.0189 | 1932 ms |

Qwen3.6 27B (the search's weakest passing model), MiniMax M2.5, Ling 3.1 Flash and GPT-5.1 Codex Mini each dropped 1–3 of 18 item runs. Seven screened models failed a five-item screen. Because candidates failed, the eval did separate them.

**Choice:** keep Sonnet 5.5 for every agent; no change to `src/models.ts`. We declined Scout's configure. Its preview edited the shared `SONNET` constant, which would also have switched the four agents Scout did not evaluate. The evidence is too thin to switch. Six items, two of them presence-only, cover a narrow slice of coding. Candidates ran with a 4,096-token cap and on cached extractions, not in the full pipeline. No full scenario run checked adjudication and payment downstream of a cheaper coder.

**Next:** add independently labelled coding claims (at least five exact labels, more for a decision). Rerun this eval, then run `npm run scenarios -- --model coding=openrouter/z-ai/glm-5.3-flash` against the recorded run before any change.

**Regret if GLM-5.3 Flash's quality holds:** USD 0.0278 per coding item. At 300 claims a day that is about USD 8 a day on coding alone. This is a single-sample estimate, not measured production cost.

**Spend:** Scout eval USD 1.70 (1,082 metered requests). Harness USD 0.16. Earlier attempts on the same day are in FINDINGS.

**Residency:** every candidate is an OpenRouter route. Neither Scout nor we verified where it processes data, so it counts as outside the UAE. This is accepted only as the recorded gap for fictional data. No key or raw member record is in this entry or in the saved result.

## 6 Nov 2026: claim triage decision model, shadow mode (openmerit 0.3.9)

**Task and policy:** `scout-tasks/claim-triage.txt`. One calibrated probability per claim, "does this claim need review before payment?", from a JSON state of plan rules, the claim, the itemized bill, member, history and provider statistics. Calibration and not missing reviews come first, then cost. `existing-first` with no endpoint IDs returns no models (see 4 Nov), so we asked with `--all-endpoints` under the recorded residency gap. Conversation `81eecb47-550d-4d9f-8ce6-8f17c1502d14`, catalogue `ce269f4d…`.

**Scout recommended** (`scout-results/2026-11-06-0.3.9-claim-triage.json`), with `priority: cost` and quality bar 60:

1. `perplexity/pplx-decider-flash-v1.2` (OpenRouter Decisions), USD 0.03 per 1,000 claims
2. `inception/mercury-decide`, flagged "OpenRouter route retires 2026-11-08"
3. `perplexity/pplx-decider-v1.2`
4. `liquid/d1-ultra`
5. `deepseek/deepseek-v4.1-flash` (chat classifier)

**Measured** on the 31 fixture claims (17 need review, 14 clean), one round each, shadow mode, run IDs `run-2026-11-06T15-56-25-998Z`, `…-29-059Z`, `…-32-108Z`:

| Scout rank | Model | AUC | Brier | Missed at 0.5 | Clean claims flagged at the threshold that catches every review | Failed calls | Median latency |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Decider Flash v1.2 | 0.840 | 0.220 | 10 | 11 of 14 | 0 | 0.4 s |
| 3 | Decider v1.2 | **0.975** | **0.059** | 2 | **5 of 14** | 2 (429 capacity) | 1.2 s |
| 4 | d1-ultra | 0.958 | 0.082 | 3 | 7 of 14 | 0 | 1.5 s |

Skipped: `mercury-decide` (its route retires in two days) and the DeepSeek chat classifier (the triage client calls only the Decisions API). Every model missed `deleted-diagnosis-code`, which the deterministic hard rules already catch, so routing on triage must combine both.

**Reported to Scout** (`scout-results/2026-11-06-0.3.9-claim-triage-reported.json`, aggregates only). Scout re-ranked to Decider v1.2, d1-ultra, then unmeasured alternatives, and dropped Flash (`…-after-results.json`).

**Choice:** `perplexity/pplx-decider-v1.2` as `TRIAGE_MODEL`, shadow mode only: it records a probability per claim and changes no routing. One round of 29–31 claims is too little to set a routing threshold; that needs more labelled claims and repeated rounds.

**Residency:** Scout marked every endpoint's processing location as unverified. OpenRouter and Perplexity are an unknown/non-UAE gap, accepted only for the fictional playground data.

## 6 Nov 2026: harder coding comparison with published openmerit 0.3.9

**Consultation:** reused Scout's recorded coding shortlist and measured-cost pick
GPT-6.1 Sol from the 0.3.4 environment consultation below. Compared exact routes
`openrouter:chat:openai/gpt-6.1-sol` and
`openrouter:chat:anthropic/claude-sonnet-5.5`, using the same coding task and
fictional-data policy. No new provider or application default was introduced.

**Measurement:** two rounds of four newly labelled boundary/control claims per
model; only coding changed. Both models passed all eight exact clinical finding
checks and all eight claim/payment checks. Mean coding USD/seconds were
0.0163581375/9.307625 for Sonnet and 0.0107297875/11.601625 for GPT. See the
matching FINDINGS entry for the metric correction, interrupted run and exclusions.

**Choice:** keep Sonnet 5.5 for all application agents. GPT's observed-fixture cost
regret is zero and Sonnet's is USD 0.00562835 per coding run, but four unique cases
with repeats do not distinguish production quality. They do not justify claiming
equal quality or changing the deployment. Revisit after broader independent labels
and approved aggregate sync/reranking. Saved mappings, historical records and
the human payment-approval control remain unchanged.

**Residency:** both OpenRouter routes remain an unknown/non-UAE gap, accepted
only for the fictional playground data. No compliance claim is made.

## 6 Nov 2026: automatic-connector baseline (published openmerit 0.3.5)

Used the published CLI and the unchanged five-agent environment brief in
`scout-tasks/agent-models-0.3.1.txt`, with the existing fictional-data residency
exception and `--all-endpoints`. New conversation
`e3253de4-fb9e-4287-bb1c-7c2f93da6f0c` returned a recommendation without questions;
the complete response is `scout-results/2026-11-06-0.3.5-connector-before.json`.
Sonnet 5.5 was third for Coding review, unmeasured, with quality estimate 89;
Scout gave its exact route as
`openrouter:chat:anthropic/claude-sonnet-5.5`.

**Choice:** leave every recorded application model unchanged. The first fresh
connector smoke will use recorded Sonnet 5.5, not introduce a new candidate.
This is a plumbing check, not evidence of equal model quality. The score mapping
uses the exact task title `Coding review` and the catalogue ID
`anthropic/claude-sonnet-5.5`, explicitly aliased from the experiment metadata
value `openrouter/anthropic/claude-sonnet-5.5`.

**Residency:** still unknown/non-UAE and accepted only as a recorded gap for
fictional data. Scout's response is not a residency certification.

## 5 Nov 2026: measured cost as tie-break (openmerit 0.3.4)

No models were run. New conversation `3c93de23-05c1-49d9-a935-1a998a3aa792`, same task text as 0.3.3, with the same agent-level results (`scout-results/2026-11-05-0.3.4-*.json`). Without any follow-up, Scout ranks GPT-6.1 Sol first on intake, coding, adjudication and fraud: all five measured candidates tie on quality, and GPT is cheapest by measurement. Enrollment ties four models, with Sonnet 5.5 first and no measured cost. The re-recommended `d16cba5a-…` gives the same order.

**Choice:** unchanged, Claude Sonnet 5.5 for all five agents. Scout's measured-cost pick is GPT-6.1 Sol, which would save about USD 5.9 a day at 300 claims. Switching still waits on more rounds and harder labelled claims, because one round of 14 cannot show equal quality on harder cases.

**Residency:** unchanged, so every candidate is a recorded gap.

## 5 Nov 2026: measured cost reported to Scout (openmerit 0.3.3)

No models were rerun. The measured per-agent-run USD and seconds from the 0.3.1 measurement were reported with `kind: "usd"` and `kind: "seconds"`, in two places:
- **Conversation `d16cba5a-…`:** added to the 0.3.1 results.
- **New conversation `1ef2bdc0-0d0d-4e59-ab2e-4f535938a443`:** same task text (`scout-tasks/agent-models-0.3.1.txt`), with only agent-level checks plus cost and time, and a follow-up asking Scout to break measured quality ties by measured cost.

Raw files are `scout-results/2026-11-05-0.3.3-*.json`.

**Result:** after the follow-up, Scout ranks GPT-6.1 Sol first for intake, coding, adjudication and fraud, all tied on measured quality and cheapest by measurement. Enrollment ranks Sonnet 5.5 first, with no measured cost. Every candidate except Gemini on enrollment stays on the shortlist. Details and regret are in FINDINGS.md (0.3.3).

**Choice:** unchanged, so Claude Sonnet 5.5 stays for all five agents. GPT-6.1 Sol is now Scout's measured-cost pick and saves about USD 5.9 a day at 300 claims. Switching waits on more rounds and harder labelled claims, because one round of 14 cannot separate the candidates on quality.

**Residency:** unchanged, so every candidate is a recorded gap.

## 5 Nov 2026: environment brief and measurement plan (openmerit 0.3.1)

**Task text:** `scout-tasks/agent-models-0.3.1.txt`. It covers the same five agents as before, plus:
- model calls per agent run, as measured on `run-2026-11-05T13-18-33-931Z`;
- about 300 claims a day, and human approval before payment;
- our existing Langfuse evals (`sahra-outpatient-claims`, 14 labelled claims, with task, agent and environment scores; enrollment has no dataset);
- the UAE residency rule, with non-UAE endpoints accepted only as a recorded gap because the data is fictional;
- "rank for the best quality".

**Run:** `openmerit scout "<task>" --all-endpoints --json` (openmerit 0.3.1). Conversation `d16cba5a-c418-4653-80d8-71ed7088074d`, catalogue `9e66fcfcbcea38ce02b53f9d0c1f7b8d`. The raw response is in `scout-results/2026-11-05-0.3.1-environment-brief.json`. We used `--all-endpoints` because the saved `existing-first` inventory is empty, and the recorded-gap exception in `POLICY.md` already covers non-UAE endpoints.

**Result:** `recommended` in one turn, with no clarifying questions. Every task got `priority: quality`, with quality bars from 78 (enrollment) to 85 (adjudication). The candidates are the same five for every agent, all on OpenRouter, and none has measured quality yet:

| Agent | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| Enrollment | Claude Opus 5 (95) | Gemini 4 Argon (94) | Claude Opus 5.5 (93) | Claude Sonnet 5.5 (89) | GPT-6.1 Sol (84) |
| Intake | Claude Opus 5.5 (96) | Gemini 4 Argon (94) | Claude Opus 5 (93) | Claude Sonnet 5.5 (91) | GPT-6.1 Sol (87) |
| Coding | Claude Opus 5 (97) | Gemini 4 Argon (94) | Claude Opus 5.5 (92) | Claude Sonnet 5.5 (90) | GPT-6.1 Sol (85) |
| Adjudication | Claude Opus 5.5 (97) | Gemini 4 Argon (95) | Claude Opus 5 (94) | Claude Sonnet 5.5 (92) | GPT-6.1 Sol (88) |
| Fraud | Claude Opus 5.5 (95) | Gemini 4 Argon (94) | Claude Opus 5 (91) | Claude Sonnet 5.5 (89) | GPT-6.1 Sol (86) |

**Evaluation plans:**
- **Claim agents:** each plan says to add candidate runs to the existing 14-claim Langfuse experiment and to use the existing agent and environment scores (line decisions, mismatch, payment correctness, review load) and rejected-tool traces. Each plans 14 samples per candidate, with stop rules such as "stop when a candidate makes repeated consequential wrong-pay decisions".
- **Enrollment:** the plan uses the two fixtures, with a stop rule of one failed fixture. It says that two fixtures "cannot establish statistical superiority".

**Residency:** none of the models carries a processing location. Scout's assumptions say "endpoint residency must be verified independently, unknown counted outside UAE", and the response says "Endpoint residency unverified" once. Every candidate is therefore a recorded residency gap, as on 4 Nov.

### Measurement on the deployed Worker (5 Nov 2026, 13:42–14:37 UTC)

Each candidate replaced one agent at a time (`npm run scenarios -- --model <agent>=openrouter/<id>`), with the other agents on recorded Sonnet 5.5. Every run was one round of the 14 claims in `sahra-outpatient-claims`, as an experiment named `<agent>=<model>-<runId>`. The incumbent is `recorded-run-2026-11-05T13-42-09-533Z` (36/36). Cells show agent-check pass rate · claims correct end to end · measured USD per agent run · seconds per agent run.

| Agent | Sonnet 5.5 (recorded) | Opus 5.5 | Gemini 4 Argon | Opus 5 | GPT-6.1 Sol |
|---|---|---|---|---|---|
| Intake | 1/1 · 14/14 · 0.010 · 9.4 | 1/1 · 14/14 · 0.023 · 12.4 | 1/1 · 14/14 · 0.009 · 22.8 | 1/1 · 12/14 · 0.034 · 16.1 | 1/1 · 14/14 · 0.006 · 8.7 |
| Coding | 4/4 · 14/14 · 0.015 · 11.3 | 4/4 · 13/14 · 0.037 · 16.9 | 4/4 · 14/14 · 0.014 · 37.4 ¹ | 4/4 · 13/14 · 0.058 · 23.9 | 4/4 · 14/14 · 0.011 · 14.0 |
| Adjudication | 14/14 · 14/14 · 0.018 · 11.2 | 14/14 · 14/14 · 0.042 · 17.0 | 14/14 · 14/14 · 0.022 · 40.7 | 14/14 · 14/14 · 0.072 · 24.0 | 14/14 · 14/14 · 0.013 · 15.8 |
| Fraud | 14/14 · 14/14 · 0.020 · 13.1 | 14/14 · 13/14 · 0.051 · 22.0 | 14/14 · 14/14 · 0.019 · 28.4 | 13/13 · 13/13 · 0.065 · 24.5 ² | 14/14 · 14/14 · 0.014 · 18.9 |
| Enrollment (2 fixtures) | 2/2 | 2/2 | 0/1, stopped ³ | 2/2 | 2/2 |

1. The first Gemini coding run (`run-2026-11-05T13-58-28-332Z`) errored on all 14 claims with OpenRouter 402 "requires more credits", because the account was down to about USD 5. It is not a model result. The rerun is `run-2026-11-05T14-06-47-059Z`.
2. FICT-CLM-1011 hit an OpenRouter 402 "in-flight budget exhausted" and is excluded.
3. Gemini sent `decide_enrollment` an invented field, the harness rejected the call, and Gemini then reported the application as recorded without retrying. Scout's stop rule stopped it after fixture 1.

Every end-to-end miss above (claims correct 12/14 or 13/14) came from an agent that was not swapped. These are the recorded Sonnet adjudication's SH-BILL-01 on borderline-upcoding, and one extra Sonnet fraud `review`. The swapped agent passed every one of its own checks.

**Reported to Scout:** 129 aggregates in four `--results` calls on the same conversation. They are in `scout-results/2026-11-05-0.3.1-reported-results.json`, and the new recommendation is in `scout-results/2026-11-05-0.3.1-after-results.json`. Scout's first choice became Sonnet 5.5 for enrollment, coding, adjudication and fraud, and GPT-6.1 Sol for intake. It dropped Gemini on enrollment, Opus 5 on intake, both Opus models on coding, and Opus 5.5 on fraud. See FINDINGS.md for why some of those drops misattribute downstream misses.

**Choice:** keep Claude Sonnet 5.5 for all five agents, with no change to `src/models.ts`. Scout and our measurements agree that nothing beats it on quality on these claims. GPT-6.1 Sol tied on every check at 25–40% lower cost per agent run. It is the cheaper challenger worth more rounds and harder claims before we switch; one round of 14 claims cannot separate them. We would not take the Opus models: no measurable gain at 2 to 4 times the cost. Gemini 4 Argon is ruled out for enrollment and is 2 to 4 times slower elsewhere.

**Residency:** unchanged. Every candidate is an OpenRouter route with unknown processing location, so this is a recorded gap, acceptable only because all data is fictional.

## 4 Nov 2026: first model choice for all five agents (openmerit 0.3.0)

**Task text:** `scout-tasks/agent-models.txt`. One conversation covers enrollment, intake/extraction, coding review, adjudication and fraud review. It states the UAE residency requirement (Federal Law No. 2 of 2019, Art. 13), treats an unknown processing location as outside the UAE, and says we prefer Workers AI and care more about quality and tool calling than cost.

**Before 20:31 UTC:** every turn failed with "Scout could not finish this turn". The cause was on Scout's side; see FINDINGS.md.

### 1. Saved policy (`existing-first`, no endpoint IDs)

- **Conversation:** `e691e428-c5be-4f46-9e5b-40546ea5be8b` (`scout-results/2026-11-04-existing-first.json`).
- **Result:** `recommended`, but with no models for any agent: "the project inventory has no catalogue endpoints, so UAE processing and tool support cannot be verified."
- **Brief:** Scout captured the residency constraint correctly as stated. It still set every task's priority to `cost`.

### 2. Whole catalogue (`--all-endpoints`)

- **Conversation:** `979b4d55-a441-43e9-932c-3c0de794bbfa` (`scout-results/2026-11-04-all-endpoints.json`).
- **Result:** Scout refused all five agents. The catalogue "does not establish where those routes process inference", and Workers AI is "a preference to investigate, not an exception to the requirement". It suggested getting a documented UAE-only inference deployment for each specific endpoint. It also reported that its web search was unavailable.
- **Residency:** respected. This is the outcome the realism test was designed to check.

### 3. Follow-up under the policy's recorded-gap exception

- **Same conversation; text in** `scout-tasks/agent-models-gap-follow-up.txt` (`scout-results/2026-11-04-residency-gap.json`). Catalogue snapshot `548870f9b79218b4f46702c4a5b651a1`.
- **Result:** the same five candidates for every agent, all on OpenRouter, with no Workers AI endpoint. Scout's reason: none has comparable measured evidence. Each processing location is unknown, so each is a recorded residency gap.

| Rank | Model | Endpoint | Quality | USD per 1k tasks | Latency (TTFT) |
|---|---|---|---|---|---|
| 1 | Claude Haiku 5.5 | `openrouter:chat:anthropic/claude-haiku-5.5` | 82 | 0.60 | 33.4 s (30 s) |
| 2 | Gemini 3.7 Flash | `openrouter:chat:google/gemini-3.7-flash` | 84 | 4.50 | unknown |
| 3 | Gemini 3.5 Flash | `openrouter:chat:google/gemini-3.5-flash` | 82 | 9.90 | unknown |
| 4 | Claude Sonnet 5.5 | `openrouter:chat:anthropic/claude-sonnet-5.5` | 90 | 12.00 | 18.4 s (12.6 s) |
| 5 | Gemini 4 Argon | `openrouter:chat:google/gemini-4-argon` | 94 | 12.00 | 48.8 s (41.5 s) |

These are the enrollment rankings. Intake, adjudication and fraud swap Gemini 3.5 Flash for Claude Opus 5 at rank 5. Quality evidence includes Vals AI MedCode and MedScribe. Scout ranked by cost even though the brief puts quality first.

- **Choice:** Claude Sonnet 5.5 (`openrouter:chat:anthropic/claude-sonnet-5.5`, Scout's rank 4) for all five agents, set in `src/models.ts`. We overrode Scout's cost-first order because our brief puts quality and tool calling first: Sonnet scores 90 to Haiku 5.5's 82, and costs about USD 4 a day at 300 claims. The owner added `OPENROUTER_API_KEY` on 4 Nov 2026.
- **Result:** fixture run `run-2026-11-04T21-02-08-698Z` on `wrangler dev` passed 24/24 checks. About USD 0.007 per model call, as Langfuse recorded it.
- **Residency gap (recorded):** every recommended endpoint is OpenRouter, processing location unknown, treated as outside the UAE. This is acceptable only because all data is fictional.

## 4 Nov 2026: comparison of Scout's candidates on harder fixtures (openmerit 0.3.0)

**Question:** do Scout's candidates do the job? We ran Scout's ranks 1 and 2 (Claude Haiku 5.5, Gemini 3.7 Flash) and our current choice (Claude Sonnet 5.5, rank 4) on every agent. Each model ran three rounds of the full fixture set: 14 claims, including five harder cases (FICT-CLM-1010 to 1014), and 2 enrollments, for 36 checks per round. Every run used `wrangler dev` and `npm run scenarios -- --model openrouter/<id>`. Cost and agent time come from the runner's per-trace Langfuse usage.

| Model | Scout rank | Checks (3 rounds) | Per round | Claims errored | USD per 1k cases | Case agent time, median / p90 |
|---|---|---|---|---|---|---|
| Claude Sonnet 5.5 | 4 | **106/108** | 35, 35, 36 | 0 | 35.57 | 34.6 s / 39.1 s |
| Claude Haiku 5.5 | 1 | 102/108 | 35, 34, 33 | 0 | 1.90 | 29.1 s / 33.8 s |
| Gemini 3.7 Flash | 2 | 102/108 | 30 of 32 scored, 36, 36 | 2 | 14.47 | 62.2 s / 79.5 s |

Run IDs (Langfuse sessions are `<claim>--<run>`):
- **Sonnet:** `run-2026-11-04T21-37-52-636Z`, `run-2026-11-04T21-48-27-816Z`, `run-2026-11-04T22-05-16-427Z`.
- **Haiku:** `run-2026-11-04T21-33-13-453Z`, `run-2026-11-04T21-44-08-816Z`, `run-2026-11-04T22-10-05-054Z`.
- **Gemini:** `run-2026-11-04T21-34-29-636Z`, `run-2026-11-04T21-45-23-519Z`, `run-2026-11-04T22-01-24-101Z`.

**Failure patterns**
- **Sonnet:** one miss, twice. On borderline-upcoding (1011, a 99215 for a ten-minute sore-throat visit), it denied with SH-BILL-01 instead of SH-CODE-02 or SH-MNEC-01. Our denial-code list has no upcoding code, so this partly reflects our catalogue, not only the model. The claim was still denied in full.
- **Haiku:**
  - It recommended fraud `review` on clean claims four times (1002, 1003 twice, 1013). That costs reviewer time but pays nothing wrongly.
  - Once, it paid a line the itemized bill does not support (1008, A1). That is money out, which the human approval step has to catch.
  - It made the same SH-BILL-01 choice on 1011 once.
- **Gemini 3.7 Flash:**
  - When a claim completes, every decision is correct; rounds 2 and 3 scored 36/36.
  - Two claims across three rounds (1004, 1012) ended in `error`. Gemini sent `propose_adjudication` a camelCase `activityId` instead of `activity_id`, the harness rejected the call, and Gemini ended its turn without retrying.
  - It is also the slowest model, about twice Sonnet's time.

**Our bug found on the way:** in the first Gemini round, all 14 claims errored. Our tool schemas built enums with `union([lit(...)])`, which pi-schema emits as `anyOf` of `const`. In a direct OpenRouter probe, Gemini invented values outside an `anyOf`/`const` list 5 times out of 5. With a plain `enum`, it picked an allowed value 5 times out of 5. We switched every enum to pi-schema's `oneOf([...])`, which emits `{"enum": [...]}`, before the rounds above. Claude was unaffected either way.

**Scout's estimates against measurement:**
- **Cost:** Scout's estimates held up. At about four agent runs per claim, we measured Haiku at about USD 0.47 per 1k tasks (Scout said 0.60), Gemini at about 3.6 (4.50) and Sonnet at about 8.9 (12.00).
- **Latency:** Scout listed Haiku as slower than Sonnet, but we measured it faster. It had no latency data for Gemini, which was the slowest by far.
- **Ranking:** Scout's cost-first ranking put the least accurate and least reliable candidates above the most accurate one.

**Decision:** keep Claude Sonnet 5.5 for all five agents. It is the most accurate, never errored, and was the most consistent. At about USD 0.036 a claim, cost is negligible next to a single wrong payment. Haiku is a viable cheaper fallback with more reviewer load. A Haiku-for-intake-and-coding, Sonnet-for-adjudication-and-fraud split is untested. We will not use Gemini 3.7 Flash until it retries rejected tool calls. The residency gap from the first choice still applies.
