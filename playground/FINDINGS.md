# Release-testing findings

Dated observations from using OpenMerit as Sahra Health, newest release first. Each entry says what we ran, what happened and what a customer would expect.

## Published 0.4.2: local CLI, setup and Scout Model Binary Search (14 Nov 2026)

We followed "Release testing" steps 1–5 against the registry package `openmerit@0.4.2`. It is on the `next` dist-tag; `latest` is still 0.4.1, so we installed `openmerit@0.4.2` explicitly. The harness was an API key over OpenRouter (`anthropic/claude-sonnet-5.5`, `OPENROUTER_API_KEY`). The Claude Code and ChatGPT harness sign-ins need a person, so we did not test them. The coding agent was a fresh Claude Code 2.1.318 session (`535f9ab8-3ca1-4cd7-b98e-a8aadc3a168e`) running over OpenRouter, rooted at `playground/`, with the `openmerit` MCP server that setup registered. It had never seen OpenMerit source. This is **not release acceptance**. Only the coding agent completed a comparison, the scenario comparison was cut for budget, and it is one release, not two.

**Steps**

| Step | Outcome |
| --- | --- |
| 1. Pin and install | **Passed.** The lockfile resolves `openmerit-0.4.2.tgz` with the registry's sha512 (`XsP2HIOI…FM3Q==`). `npm run check` passed 27/27. |
| 2. Global install and setup | **Passed, with findings 1, 2 and 7.** `npm install -g openmerit@0.4.2` took 51 s and uses 781 MB. Setup asked which harness to use (Claude Code and Codex shown as not signed in), the pi provider, the model (default Sonnet 5.5) and whether to use `$OPENROUTER_API_KEY`. It verified one harness round trip. For Langfuse it asked for the URL and a typed Viewer key pair, then refused our application keys: "This key pair can write to Langfuse". We have no Viewer key, so Langfuse is not connected. It asked whether to add OpenRouter for candidates (key accepted, all models allowed), whether to add OpenAI (no) and the budget (default $10; we set $5). `openmerit daemon status` printed `not running` after setup, as documented, since setup does not use the daemon. After the first Scout call it printed `running: openmerit 0.4.2, pid 7564, 127.0.0.1:6720`. |
| 3. Fresh coding-agent session | **Partly passed.** Unprompted, the agent read `AGENTS.md` and `POLICY.md`, called `openmerit_status` and `openmerit_scout`, asked about the residency gap before any spend, and spotted the scan-scope problem itself. In this monorepo Scout failed at discover (finding 2). In a standalone copy of `playground/` it completed a Scout Model Binary Search for the coding agent (see the table). We did not attempt triage or the other four agents, because of the budget. |
| 4. Model changes and scenarios | **Not done.** We made no model change (see MODEL-DECISIONS.md). One fixture, `clean-gp-visit`, passed 2/2 checks on the 0.4.2 pin: experiment `recorded-run-2026-11-14T21-45-25-834Z`, release `openmerit@0.4.2`, USD 0.0696. The full run and the Langfuse comparison by release were not run, for budget. |
| 5. FINDINGS entry | This entry. |

**Invite-only gate**

| Criterion | Outcome |
| --- | --- |
| Install, setup, harness connection, endpoint and Langfuse key checks | **Passed, with findings.** The harness round trip and the OpenRouter key check passed. The Langfuse check correctly refused a write-capable key. No Viewer key was available, so Langfuse stayed unconnected. **Not applicable from 0.4.2:** OpenMerit account, device approval, connector sync, disconnect. |
| Identify the eval state; obtain a plan; let Sahra's agent implement it | **Passed for coding.** The state was *insufficient*: no eval in Scout's contract, and only four exact coding labels against Scout's five-item screens. The harness's first plan bypassed the meter (finding 3), so Sahra's agent built a metered, coding-only eval instead. It exists only in the standalone copy and is not landed here. |
| Approved comparison on customer-owned evals, one agent at a time, with hard labelled cases kept | **Passed for coding only.** We used 6 items (4 exact-labelled boundary/control claims, plus FICT-CLM-1005 unbundling and FICT-CLM-1022 diagnosis mismatch under the older presence-only label), with 3 repeats each. Four of seven finalists dropped items, so the result is not inconclusive. The sample is small. |
| Import aggregates through the connector; measured reranking; reuse in a new conversation | **Not applicable** for the connector: 0.4.2 has none. The Langfuse per-item path is untested without a Viewer key. Reuse was not tested; approved evals are saved under drifting task names (finding 6). |
| Interrupted or failed sync, missing mappings, revoked credentials | **Not applicable** for sync and mappings. Revoked credentials were not tested. An interrupted (budget-paused) run kept a stale reservation on resume (finding 4). |
| Local Markdown decision record; approved disconnect | **Passed** for the record (MODEL-DECISIONS.md, 14 Nov). Disconnect is **not applicable**. |
| Cleanup | **Passed.** Scout's eval runs wrote nothing to Langfuse, because the eval ran with Langfuse keys blanked. The one smoke experiment is kept as a customer record. Nothing was deleted or paid. |

**Coding agent, Scout run `run-20261114-212008-0118`** (catalogue 2026-11-12; 177 ECI-ranked candidates cheaper than Sonnet; 46 without ECI left out; 16 screens on 5 items, then 7 finalists × 3 runs × 6 items):

| | Model | Passed | Cost/item | Latency/request |
| --- | --- | --- | --- | --- |
| Current | anthropic/claude-sonnet-5.5 | 18/18 | $0.0284 | 2195 ms |
| #1 | z-ai/glm-5.3-flash | 18/18 | $0.00061 | 3105 ms |
| #2 | meta/muse-glimmer-30b | 18/18 | $0.0039 | 4832 ms |
| #3 | openai/o3 | 18/18 | $0.0189 | 1932 ms |
| | qwen/qwen3.6-27b (search pick) | 17/18 | $0.0112 | 9819 ms |
| | minimax/minimax-m2.5 | 16/18 | $0.0031 | 5827 ms |
| | inclusionai/ling-3.1-flash | 16/18 | $0.00083 | 13337 ms |
| | openai/gpt-5.1-codex-mini | 15/18 | $0.0033 | 3215 ms |

The raw result is in `scout-results/2026-11-14-0.4.2-coding-binary-search.json`. Candidates ran through OpenRouter's OpenAI-compatible API behind Scout's proxy, capped at 4,096 output tokens, with intake extractions cached from one real Sonnet run per claim.

### Findings

1. **"Input hidden" key prompts show the key.** In a real terminal (tmux, no pipe), setup's prompts `Langfuse Viewer public key (input hidden; …)` and `… secret key (input hidden; …)` erased their own label and echoed what we typed in clear text. We confirmed it with a dummy secret, `sk-lf-DUMMY-not-a-real-key`, which appeared verbatim on screen. We did not type the real secret. A customer typing a Langfuse secret would leave it on screen and in scrollback. Also, a setup aborted after the public-key prompt had already saved that key to `~/.openmerit/secrets.json`.
2. **A project in a subdirectory of its git repository does not work.** From `playground/`, setup reported "This repository: /home/user/workspace/repo" and wrote `.openmerit/config.json` at the git root. Scout (CLI and MCP with `cwd` set to `playground/`) scanned the whole repository. Its first question offered models from directories that are not ours, and it sent their code to the harness, until we listed every sibling in `scan.exclude`. Discover then failed twice in `run-20261114-205515-37bd`: "The harness proposed a helper outside .openmerit/evals/ (playground/.openmerit/evals/coding-review.ts); refusing it". The harness writes helpers relative to the project, and Scout accepts only the git root's `.openmerit/evals/`. The refusal is safe, but it is a dead end: USD 0.43 of harness spend, no eval. A standalone `git init` copy of `playground/` worked.
3. **The first proposed eval would have bypassed the meter, and the approval did not say so.** The harness proposed running the full claim pipeline per fixture with `--model coding=openrouter/<candidate>`. The Worker would call OpenRouter directly with its own key, never through `OPENAI_BASE_URL`, and the other three agents would run on Sonnet for every candidate. The approval still showed "Budget: $3.00. Requests past it are refused." The README says such an eval "is measured as zero requests, and Scout says so", but nothing said so before approval. We declined. Whether Scout would have flagged zero requests afterwards is unverified.
4. **One request's reservation paused the budget, and resume never released it.** Our agents' framework sends `max_completion_tokens: 128000`, the model's limit. Scout reserved USD 1.286 for one Sonnet request and paused a $2.50 run during its first baseline item, with USD 0.0208 settled (`run-20261114-211024-3024`). Reserving by the request's maximum is documented, but the README does not warn that agent frameworks commonly send the model maximum. After we capped output at 4,096 tokens, `--resume` re-paused at once with identical figures. Only a raise or a new run continues. A finished run (`run-20261114-211621-4047`) still lists USD 0.0937 "reserved for 2 request(s) of unknown cost".
5. **Four items: Scout spent first, then stopped with a clear message.** `run-20261114-211621-4047` ran the baseline three times (USD 0.40). Then it stopped: "The current model passes only 4 items in every run; Scout screens candidates on 5 items it passes. Add labelled items the current model gets right." The message is actionable. However, the approval showed no item count, and the result header still read "screening on 5 items the current model passes".
6. **Task names drift between runs.** The harness named the same usage "Medical coding reviewer", "Medical coding agent", "Coding review agent" and "Coding agent" in four runs. Approved evals are saved in `.openmerit/config.json` under those names, so we got duplicate `evals` entries, and runs do not line up in `openmerit history`.
7. **Configure would have switched all five agents.** Scout asked "Coding agent: anthropic/claude-sonnet-5.5 → z-ai/glm-5.3-flash", then previewed a one-line edit to `src/models.ts` line 15. That line is the shared `SONNET` constant used by enrollment, intake, coding, adjudication and fraud. Nothing warned that four agents Scout never evaluated would change too, or that the `decision` text would go stale. We declined at "Apply this change to Coding agent?"; the two-step confirmation is what saved us.
8. **Minor issues.** `openmerit setup --help` printed "Unknown option '--help'". Setup's Langfuse URL defaults to `https://cloud.langfuse.com` even with `LANGFUSE_BASE_URL` set to the US region. Setup says nothing when it skips MCP registration because neither `claude` nor `codex` is on `PATH`. Ours is in `node_modules/.bin`, and a rerun with it on `PATH` registered and connected.
9. **Not OpenMerit issues.** The orb's npm global bin directory was not on `PATH`. Claude Code's self-reported turn costs did not match OpenRouter's meter, so we report spend from the key.

**Spend.** The OpenRouter key's usage rose USD 13.07 during the check, under the USD 15 cap. That figure is an upper bound: the key is shared, and the account showed other usage earlier in the day. Scout eval spend settled about USD 2.03: 1.7025, 0.401 and 0.0208, plus USD 1.286 still counted as an unknown-cost reservation on the paused run. Harness inference across seven runs was USD 1.49. The scenario smoke run was USD 0.07. The four cached intake runs were not metered and were cents. The rest, about USD 9, was the fresh Claude Code session. Workers AI ran only under `wrangler dev`. There were no deploys, Cloudflare changes or npm changes.

## Published 0.3.10: approved mappings blocked by Metrics quota (6 Nov 2026)

Installed the exact registry release and upgraded the isolated Claude setup;
installation and connected status passed with instruction version 0.3.10. The
first doctor request reported the service unreachable despite connected status;
an unchanged rerun passed all checks, including MCP connectivity. The first
failure's cause is unverified; this is not a clean first-attempt install pass.

The owner approved four saved mappings (existing presence score, exact clinical
quality, USD and seconds) and the Sonnet/GPT aliases. Configuration succeeded,
invalidating the one old import while retaining 15 reported aggregates. The
subsequent sync failed. The authored server diagnostic and a direct aggregate
endpoint response confirmed HTTP 429, not invalid credentials or missing mappings.
Langfuse's `Retry-After` was 18,653 seconds, pointing to approximately 22:05 UTC
on 6 November (02:05 Dubai on 7 November). No new import or reranking is claimed.
No application model changed and no Langfuse record was deleted.

The day's 29 experiment headers contain 27 mapped coding experiments. The old
importer needs 108 metric reads for these four mappings; grouped score-name reads
need 27. These are request-count calculations over real headers, not evidence
that the grouped query succeeded live. Langfuse's Metrics limits are shared across
the organization and can be hourly or daily. A one-minute retry message was wrong.

Candidate server changes group mapped scores within each experiment/trace role,
retain exact attribution, and persist the upstream cooldown. Local regression
tests reproduce the old quota failure and the incorrect retry message; grouped
quality/cost/time import and cooldown denial now pass. Live grouped import and
measured reranking remain unverified until the upstream quota resets.

The latest OpenRouter cumulative usage read was USD 37.256949764. Counting the
previous USD 10.0077634 Team list-price equivalent conservatively leaves USD
2.735286836 under the cap. Account-wide changes since the previous checkpoint
are not attributed to this work. No additional model runs were started here.

## Decision-model triage with published 0.3.9 (6 Nov 2026, catalogue ce269f4d…)

- **Ran:** `openmerit scout "<scout-tasks/claim-triage.txt>" --all-endpoints --json`, then `--results` with measured AUC, Brier score and cost. See MODEL-DECISIONS.md.
- **Worked as expected:**
  - OpenRouter decision models were recommended: four of five candidates use OpenRouter's Decisions API.
  - Scout warned "OpenRouter route retires 2026-11-08" on `inception/mercury-decide`, before and after our results.
  - Residency: every endpoint's processing location was marked unverified, never assumed to be UAE.
  - After our results, Scout ranked the measured best (Decider v1.2) first, so regret went from rank 3 to 0.
- **Cost-first ranking again picked the weakest candidate:** the brief put calibration and missed reviews ahead of cost, and Scout still set `priority: cost`. Its rank 1, Decider Flash v1.2, had AUC 0.840 and Brier 0.220, against 0.975 and 0.059 for its rank 3. In money the gap is fractions of a cent per 1,000 claims, but at a 0.5 threshold Flash missed 10 of 17 claims that need review. This is the 4 Nov "cost-first ranking" finding, now for decision models.
- **Scout's cost estimate:** USD 0.03 per 1,000 claims for Flash, against a measured USD 0.014. Within the expected range.
- **Not an OpenMerit issue:** Perplexity returned `429 No capacity available` on 2 of 31 Decider v1.2 calls. Separately, three scenario runs in parallel exhausted the OpenRouter credit balance (402 `billing_error` counting in-flight requests), so agent results for two runs are invalid. Triage ran first and is unaffected.

## Harder coding controls and published 0.3.9 readiness (6 Nov 2026)

Used registry `openmerit@0.3.9`, not linked source. Fresh Claude sessions passed
the no-eval and insufficient-eval readiness paths three times each: they consulted
Scout, distinguished estimated from measured quality, and proposed customer-owned
evals without executing candidates or creating platform records. These six
planning-only sessions are not six complete release-loop passes.

Added four fictional coding cases: nested metabolic-panel unbundling, legitimate
independent laboratory tests, a bill instruction attempting to suppress a CBC
finding, and a valid diagnosis sharing a deleted code's prefix. The exact
`coding-findings-match` metric requires every labelled clinical finding and rejects
extra clinical findings, including false positives on clean controls. Generic
integrity warnings are outside this metric. No payment or clinical label was
relaxed to make a model pass. The previous presence-only metric remains distinct.

Ran two matched rounds, swapping only coding between recorded Sonnet 5.5 and
Scout's earlier measured-cost pick GPT-6.1 Sol. Other agents, prompts, tools and
approval controls stayed fixed. Each model had eight valid runs over four unique
fixtures. Costs and seconds below are for coding, not the whole claim.

| Model | Exact coding checks | Claim/payment checks | Mean USD per coding run | Mean coding seconds |
| --- | --- | --- | --- | --- |
| Claude Sonnet 5.5 | 8/8 | 8/8 each | 0.01635814 | 9.307625 |
| GPT-6.1 Sol | 8/8 | 8/8 each | 0.01072979 | 11.601625 |

GPT was cheaper and slower. Its observed-fixture cost regret against the cheapest
passing candidate is USD 0 per coding run; keeping Sonnet costs USD 0.00562835 more
per run on this sample. **Quality is not separated:** repeating four fixtures
does not establish equal production quality. Keep application models unchanged.
This is not a new connector-only reranking result.

Two exclusions/corrections are material. An initial metric wrongly counted a
correct generic warning about injected bill instructions as a clinical error.
Preserved the original output, corrected only the two newly created affected
scores, and reran with the clinical metric. A second-round GPT workflow was
interrupted by Wrangler reloading after a package-version edit; its coding check
completed, but adjudication/fraud and usage did not. Retained it as incomplete,
excluded it from the matched table and reran successfully. Neither event is
evidence of a model quality failure.

The runner now posts known per-agent USD and seconds as numeric Langfuse scores;
unknown values are omitted and measured zeros are retained. Read back all 24
second-round coding quality/cost/time scores from Langfuse and checked their
values against the saved run outputs. The customer connector still requires
explicit score/model mapping approval; no saved mapping was changed. The account
retains mixed historical reported and imported evidence.

At 13:10 UTC, OpenRouter cumulative usage was USD 33.773298445 (USD 3.26195974
above the recovery baseline). Conservatively counting an additional USD
10.0077634 Team list-price equivalent leaves USD 6.218938155 of the USD 50 cap.
Team list price is not verified cash, and account-wide OpenRouter changes may
include other activity. Incomplete Langfuse usage must not be treated as free.

Remaining gates: approved clinical/cost/time mappings and aggregate reranking;
the complete fresh-agent suitable-eval loop; scoped lifecycle/cleanup acceptance;
Pi approval; the requested scope/constraint/priority/catalogue work; and two
consecutive complete published-release passes. This checkpoint is **not stable
release acceptance**. No existing customer records were deleted or paid.

## Invite-only gate: published 0.3.8 and candidate worktree repair (6 Nov 2026)

Installed exact registry package `openmerit@0.3.8` and refreshed the lockfile.
Downloaded tarball SHA-1 `c4aa6c4a6e92cd951e911bd7068574623341818e` and
SHA-512 matched registry metadata. The installed package metadata, instruction
bundle and close-the-loop guide matched those tarball files byte for byte.
The customer project's typecheck and all 14 deterministic tests passed.

The remaining worktree setup failure is version-dependent: Claude Code 2.1.63
introduced shared project configuration across git worktrees. Our older global
Claude 2.1.7 uses this worktree's root; pinned Claude 2.1.318 uses the main
checkout root. The candidate 0.3.9 installer follows the active CLI's version.
Its public-CLI regression detects an existing unowned MCP entry at the expected
scope for 2.1.62, 2.1.63 and 2.1.318; the 2.1.63 case failed before the fix.
No existing MCP entries were migrated or deleted.

Operator-side verification used that candidate installer, not the published
0.3.8 installer, with the real pinned Claude and an isolated Claude configuration.
Install, `status --check` and `doctor` passed; Claude's own `mcp list` found Scout
connected. A packed 0.3.9 candidate also reported installed/matching/connected.
No shared Claude login or the other checkout's files were changed.

Three fresh Claude sessions then used normal MCP discovery, **without an
explicit MCP configuration override**. Each loaded the installed Scout skill,
requested `sync: "langfuse"`, sent no manual results and received one structured
coding recommendation. Conversations: `8c52f113-b702-4cac-8103-8c1605116480`,
`2a57f770-6a88-4808-8b4a-d28fac8a4077`, and
`c6c492d0-86fa-4725-84df-9993b30e76f9`. These sessions reported USD 2.2240298
list-price equivalent on Team, not an independently verified cash charge.

This closes the focused default-discovery check on the candidate installer,
not clean published 0.3.9 acceptance or a complete release-loop pass. Sync can
use its ten-minute cache, and the account still has mixed historical reported
and connector-imported evidence. No new claim comparison ran, so new comparative
regret is **not measurable**. Readiness-path acceptance, harder comparisons,
scoped cleanup/recovery and two full published-release passes remain open.

## Invite-only gate: fresh-agent aggregate refresh (6 Nov 2026, candidate instructions)

The owner completed Anthropic sign-in for the isolated Claude configuration.
Ran fresh Claude Code 2.1.318 sessions rooted in this customer project, with no
session persistence, hooks disabled, read-only file tools and only Scout's
recommendation MCP tool. Those sessions did not read OpenMerit implementation
source. The identical request asked for a coding-review model choice,
the project policy and existing evals, permitting whole-catalogue search but no
file changes, new spend, customer-platform writes or deletion.

- With published 0.3.7 instructions, all three sessions loaded the Scout skill
  and consulted Scout, but **0/3 requested Langfuse sync**. One offered to refresh
  the already connected aggregates only after another approval.
- Installed the candidate instruction change with the source installer into the
  isolated test setup. With the same request, **3/3 requested `sync: "langfuse"`**
  on their first Scout call, sent no manual results and received structured
  recommendations. Conversations: `3f44d967-5b13-44af-9d1f-2737ec4097a4`,
  `e7aaa76c-3d7f-4e6b-b99a-dabc4e5c97fb`, and
  `e8a3c243-0d84-4190-b751-07205450dd81`.
- Three fresh control sessions explaining the existing payment-approval code
  made **zero Scout calls** and read only this customer project.

Connection status confirmed a newer sync timestamp, one mapped experiment and
no unmapped models. Successful sync may use the documented ten-minute cache;
these are not three independent upstream imports. Full `npm run verify` passed.
This proves the focused instruction behavior with a real agent and deployed
Scout, not a full published-release or model-quality acceptance pass.

Two setup limitations were kept visible. First, the Mac's older global Claude
CLI registers private local MCP configuration under this worktree, whereas the
pinned CLI resolves it to the main checkout. The test used an explicit isolated
MCP configuration with the approved device key injected through the environment;
it does not pass the clean worktree-installer gate. Second, an initial restricted
CLI run did not discover the installed skill, so it was discarded from the
instruction comparison. That run reported 15 aggregate measurements from the
existing customer decision notes. They remain alongside the one imported
aggregate (16 total); they are not three new claim comparisons, and this is not
proof of connector-only ranking. No raw records were reported or deleted.

All ten agent runs, including the discarded run and controls, reported a total
USD 3.8952514 list-price equivalent under the authenticated Team subscription,
not an independently verified cash charge. No paid claim rerun, application-model
change, payment approval, connection revocation or Langfuse record deletion was
performed. The other readiness paths, clean installer acceptance, comparative
regret, scoped cleanup/recovery and two full published-release passes remain open.

## Invite-only gate: published 0.3.7 setup (6 Nov 2026)

Installed exact registry package `openmerit@0.3.7` and refreshed this project's
lockfile. The downloaded tarball's SHA-1 and SHA-512 matched registry metadata;
SHA-1 was `864e235232c79d10c5a4183801bdea5b57232703`. The first install hit
cached pre-publication metadata and returned ETARGET; `--prefer-online` fetched
current metadata and succeeded. Typecheck and all 14 deterministic tests passed.

The published CLI returned five structured tasks in conversation
`ca0bb4be-8f0e-4db3-b8ba-3fd6a01232c0`, without a results file. All five summaries
named their final first model. The saved Langfuse connection still held one
aggregate from one experiment. This is a package/recommendation smoke check, not
a new claim comparison or a full release-loop pass.

Fresh Claude project setup first reported a conflict with the Mac's existing
user-scope MCP server. Rather than remove or update another session's connection,
used an isolated `CLAUDE_CONFIG_DIR` and disabled automatic instruction updates.
The owner approved the new device request; the published installer completed
with `connection: connected`. The isolated Claude configuration still needs its
own Anthropic authentication before fresh-agent readiness tests can run. No
shared Claude login or existing Scout connection was replaced.

The three customer-readiness cases, comparative regret, approved destructive
recovery/cleanup checks and two consecutive full published-release passes remain
open. No application model changed, new claim comparison ran, payment was
approved or platform data was deleted during this checkpoint.

## Invite-only gate: structured reuse passes (6 Nov 2026, published openmerit 0.3.6)

Scout serving version `fe34446b-528c-4b90-b0a0-60946caa0d78` deployed at
09:38 UTC after PR #83 and merged-commit CI passed. Cloudflare's deployment
metadata API initially returned HTTP 503; the guarded release stopped before
upload. A later attempt succeeded, with the new version serving 100% of traffic.
Landing, Scout, connection, status and version health checks returned HTTP 200.

Repeated the same published-package command serially three times, each creating
a new conversation and sending no results file:

`node_modules/.bin/openmerit scout "$(cat scout-tasks/agent-models-0.3.1.txt)" --all-endpoints --json`

- `173fc90a-22d0-46b8-bfb8-9d818a6327e3`: recommended, five structured tasks.
- `9ea5f307-53e3-48a4-94b6-6ec559884923`: recommended, five structured tasks.
- `254ab173-fc7f-42f1-9839-b832762649fa`: recommended, five structured tasks.

All three reused the existing Langfuse coding aggregate without resending it;
Sonnet 5.5 ranked first for medical coding review with `quality.measured: true`
and "Your eval" evidence naming one sample. All 15 task summaries named their
actual final first model. Coding summaries retained the one-sample and unknown
UAE-processing caveats. The model's quality estimates varied (85, 90, 91); those
are not measured accuracy. Before this deployment, both recorded fresh reuse
attempts returned prose rather than structured recommendations (0/2); after it,
these three returned structured recommendations (3/3).

This passes the focused structured-completion/account-reuse check, not a full
fresh-coding-agent or two-release acceptance pass. These commands ran in the
existing coordinator session, not a new agent isolated from implementation
knowledge. No claim/model comparison, application-model change, payment approval,
connection deletion or customer-platform cleanup occurred. Cost regret remains
**not measurable** from this one-sample, one-model import. Live revocation and
disconnect/cleanup still require scoped consent and a safe reconnect path.

## Invite-only gate: first automatic import (6 Nov 2026, openmerit 0.3.6)

PR #80 deployed playground version `0779fd69-3a77-4dd5-aa89-21a8d92e5f2e`
from merged commit `ba93b1cb8841deb598e473295baf0d33f69ba947`. Its public
version endpoint reported registry package 0.3.6. No active claim workflows were
present before starting the one serial run.

`npm run scenarios -- --only unbundled-lab-panel --out <local evidence file>`
ran `run-2026-11-06T08-38-39-159Z` on the unchanged recorded Sonnet 5.5 models.
All 3 checks passed; the proposed payment was AED 224.00, matching the label.
The claim remains at human approval; no payment was approved. All four agents'
usage was complete: intake USD 0.0150592, coding 0.0216270, adjudication
0.0219827, fraud 0.0230311. Total USD 0.0817; summed agent time 41.945 seconds.
OpenRouter total key usage rose from USD 30.429638705 to 30.511338705,
independently matching the bill. Conservatively counting all historical usage
against USD 50 leaves USD 19.488661295 for further comparisons.

Published CLI `connect langfuse --sync --json` imported **1 aggregate from
1 experiment**, with 1 mapping, 1 model alias and 0 unmapped models; MCP status
confirmed the same result. The saved Viewer key stayed on Scout. No raw traces
were converted into aggregates locally or reported manually. The coding quality
mapping imported `coding-finding-found = 1`, one sample, for Sonnet 5.5.

Conversation `e3253de4-fb9e-4287-bb1c-7c2f93da6f0c` reranked Sonnet from third,
unmeasured, to first with the imported evidence; the other four agents remained
unmeasured. **Bug:** the summary still called Opus the lead, contradicting that
final order. A new conversation `2a14d5e9-8f31-4b81-8987-8b3bb3de0c73` received
and cited the same aggregate without resending results, proving account-level
reuse, but returned a prose message instead of a validated structured shortlist.
That is not a clean cross-conversation recommendation acceptance pass.

**Summary correction deployed:** PR #81 merged with all PR/main checks green.
Scout serving version `86d43d6c-e60f-4989-be50-9461d48f37cf` went live at 08:54
UTC. Repeating the published CLI's `--sync langfuse` recommendation returned five
structured tasks; every summary named its actual first model, and the coding
summary retained its one-sample caveat. Landing, Scout, connection, status and
version endpoints all returned HTTP 200. This check did not rerun the claim or
change models, credentials or platform records.

A second fresh conversation `f1febf1a-157b-42e2-9202-159ff7c15cdc` again cited the
imported coding aggregate without receiving a results file but returned prose.
Thus account-level evidence reuse works, while fresh structured completion has
failed twice and remains a release blocker. The existing conversation's successful
structured rerank does not override those failures.

This is plumbing evidence, not a model comparison or quality win: there is one
sample and no competing model in this run. Regret is not measured here. No
existing Langfuse records or connection credentials were deleted. Disconnect
acceptance, recovery/revocation tests, all three customer readiness paths,
fresh-agent usability and two consecutive full release passes remain pending.

An existing-trace control recovered 3 generations at USD 0.0113691 and 8.204
seconds with the new reader. The old field selection also returned latency on
that trace: explicit metrics selection is not evidence that latency was broken.
The demonstrated cost repair is waiting for complete generation counts/prices
and representing unknown costs as unknown rather than zero.

## Invite-only gate: setup checkpoint (6 Nov 2026, openmerit 0.3.6)

Upgraded this customer project from registry 0.3.5 to registry 0.3.6, never linked
OpenMerit source. The matching hosted settings update lets the published CLI
configure non-secret mappings using the already connected encrypted Viewer key.
The same settings-only API request failed HTTP 400 before the serving update.
The recovered application tracing key was Full access (invalid permission probe
returned 400), so it was not substituted for the customer's Viewer connection.

Before new model spend, OpenRouter's key-usage endpoint reported USD 30.429638705
total usage and zero daily usage. Counting all of it against the owner's USD 50
allowance leaves a conservative USD 19.570361295 ceiling for this continuation;
that is not a claim that all historical use belongs to this approval window.
No application model was changed; the fresh Scout baseline and retained choice
are in MODEL-DECISIONS.md.

**Cost-summary repair:** the scenario runner used to treat empty observations or
unpriced generations as zero and did not request the latency field group. It now
waits for the agent root's recorded generation count and all prices, with a
two-minute deadline including rate-limit waits. Incomplete costs stay null;
genuine zero-priced generations remain valid. Deterministic checks cover delayed,
partial, unpriced and unavailable observations plus a zero-cost control. A
read-only request against an existing trace confirmed that root generation count,
cost and latency are available with the chosen fields.

**Still pending:** fresh mapped import, measured reranking, cross-conversation
reuse, disconnect acceptance, fresh-agent usability and two consecutive release
passes. This setup checkpoint is not a completed automatic loop.

## Langfuse aggregate connection (6 Nov 2026)

The hosted connector authenticated and read 25 experiments but imported zero
aggregates. Read-only Metrics v2 queries found 133 `coding-finding-found` scores
on `review-coding` and 83 `enrollment-decision-correct` scores on
`assess-enrollment`; adding `experiment:<id>` filters for those experiments
returned zero. Aggregate tag groups contained only `sahra-health` and the role,
not experiment IDs. Native experiment item links alone did not satisfy the
connector's explicit tag attribution contract.

The local tagging fix adds the experiment tag to every agent trace in future
experiment runs. A deterministic test exercises both workflows and the real
OTLP exporter with simulated agents, two different experiment IDs and a
non-experiment control. It checks intermediate agents as well as final agents,
and preserves final-item linkage. No inference or historical backfill is part of
that validation. A deployment alone does not make old untagged data importable;
mapping configuration and fresh-run import acceptance remain separate checks.

## Scout f9c8c494 (5 Nov 2026, openmerit 0.3.4)

The Scout serving release adds a per-call workload estimate and calibrates it from measured cost (`cost.calibration`). When cost is measured, only the cheapest measured model earns `best: ["cost"]`. The npm package is unchanged at 0.3.4.

No models were run. New conversation `f217f536-68bd-4ee9-b8a4-a084f49a4967`, with the same brief as 0.3.4 (`scout-tasks/agent-models-0.3.1.txt`, priority quality) and the same 69 agent-level results (`scout-results/2026-11-05-f9c8c494-*.json`).

### Scout asked two questions first

- **Questions:** for the first time with this brief, Scout returned `needs_answers`. It asked whether we could share per-model results from our Langfuse experiments, and whether providers other than Workers AI and OpenRouter are allowed with a flagged residency gap.
- **Answers:** we took both from `POLICY.md` and the task, not guesses. Shortlist from benchmarks first, and we report results afterwards. Other providers are allowed only as a flagged gap, each with owner approval.
- **Results reported** one call per agent, with the task titles renamed to match the new response ("Claims intake agent call" and so on).

### Uncalibrated per-call guesses are now 1.5–3 times too high, not 7–17 times

Before any results, Scout's per-call workload estimates against the Sonnet 5.5 baseline traces (`run-2026-11-05T13-42-09-533Z`, deployed Worker), as mean input and output tokens per model call from Langfuse:

| Agent | Scout input | Measured input | Ratio | Scout output | Measured output | Ratio |
|---|---|---|---|---|---|---|
| Enrollment | 3,500 | 1,298 | 2.7× | 300 | 162 | 1.9× |
| Intake | 4,500 | 1,510 | 3.0× | 450 | 230 | 2.0× |
| Coding | 5,000 | 2,091 | 2.4× | 500 | 243 | 2.1× |
| Adjudication | 5,500 | 3,634 | 1.5× | 450 | 196 | 2.3× |
| Fraud | 6,000 | 2,765 | 2.2× | 500 | 300 | 1.7× |

- **Comparison with 0.3.1:** there Scout assumed 16k–26k input tokens per call.
- **Calls per run:** they match our brief: 3 for intake, 4 for the others.
- **Prompt caching:** the measured input includes prompt-cache reads and writes (Anthropic via OpenRouter), which are billed below the list price. So the cost gap is wider than the token gap, about 4 times for Sonnet: for example intake estimated USD 40.5 per 1k runs, against 10.37 measured.

### Calibrated estimates are close; one factor per task can't capture each model

- **Factor and sources:** after results, every claim-agent candidate has `cost.calibration` with a `factor` and the five `measured:` results it came from. The factors are intake 0.256, coding 0.257, adjudication 0.340 and fraud 0.299. Enrollment has none, because we have no measured enrollment cost.
- **Accuracy:** calibrated estimates are within 0.67–1.6 times of measured cost, where 0.3.4 showed estimates 12–15 times too high next to `cost.measured`. The factor appears to be fitted to the middle of the group: Sonnet and Opus 5.5 come out almost exact.
- **The remaining error is per model.** GPT-6.1 Sol is overestimated 1.4–1.6 times, and Opus 5 underestimated to 0.67–0.78 times, because the models use different numbers of tokens for the same work. Models with the same list price get identical estimates: GPT-6.1 Sol, Gemini 4 Argon and Sonnet 5.5 all show USD 10.37 for intake. For an unmeasured candidate, a calibrated estimate can therefore still be off by about 1.5 times either way.

### Cheapest label and ranking

- **One cheapest per task:** after results, `best: ["cost"]` goes to exactly one model per claim agent, the measured cheapest, GPT-6.1 Sol. Before results it still went to two models per task whose estimates tied (Gemini 4 Argon and Sonnet 5.5 at the same list price). Enrollment, with no measured cost, gives it to unmeasured Gemini 3.8 Flash by estimate.
- **Ranking unchanged from 0.3.4:** each claim agent's five measured models share one quality score (85, 86, 90 and 88), `quality.measured: true`, ordered by measured cost with GPT-6.1 Sol first. Regret of the first pick at 300 claims a day stays 0.

## openmerit 0.3.4 (5 Nov 2026)

What changed, per the package's CHANGELOG and the release note:
- `--results` refuses a file of more than 50 results before sending it.
- The Claude Code install message names the MCP server, startup rule and skill.
- **Scout serving release `a4d46878`:**
  - Models tied under the conversation's priority, including `quality`, are ordered by measured cost.
  - Measured results that don't separate models give them the same quality estimate.
  - Results stored before `kind` existed count as quality again.

No models were run. Every result reported here is the aggregate measured on 5 Nov (MODEL-DECISIONS.md, 0.3.1).

### Installs: clean, and the Claude Code wording is fixed

- **Claude Code:** `install --client claude-code --scope project` exits 0 and ends "Start a new session to load the MCP server, startup rule and skill." `status --check` reports `Automatic instruction updates: on · hooks: ready · instruction version: 0.3.4`. `doctor` is green, including the updater.
- **Pi:** exits 0. `status --check` and `doctor` are green.
- **No device approval was needed:** both clients reused their keys, so the 30-minute codes are still untested from our side.

### Measured cost now breaks quality ties without being asked

- **Setup:** new conversation `3c93de23-05c1-49d9-a935-1a998a3aa792` with the same brief as 0.3.3's `1ef2bdc0-…` (`scout-tasks/agent-models-0.3.1.txt`, "rank for the best quality", so `priority: quality`). We reported the same 69 agent-level results: each agent's own checks plus `kind: "usd"` and `kind: "seconds"`. One call per agent; no follow-up.
- **Before results:** the shortlist had changed since 0.3.3. Opus 5 ranked first everywhere, and unmeasured Claude Sonnet 5, GPT-5.6 Sol and Gemini 3.8 Flash appeared, while GPT-6.1 Sol and Opus 5.5 did not. After the results, the five measured models replaced the unmeasured ones on every claim agent.
- **After results:** every claim agent's shortlist is ordered strictly by measured cost per agent run, GPT-6.1 Sol first:

  | Agent | Order (measured USD per 1k agent runs) |
  |---|---|
  | Intake | GPT-6.1 Sol 6.50, Gemini 4 Argon 8.70, Sonnet 5.5 10.37, Opus 5.5 22.78, Opus 5 33.51 |
  | Coding | GPT-6.1 Sol 10.98, Gemini 4 Argon 14.25, Sonnet 5.5 15.39, Opus 5.5 36.72, Opus 5 57.85 |
  | Adjudication | GPT-6.1 Sol 13.44, Sonnet 5.5 17.99, Gemini 4 Argon 22.01, Opus 5.5 42.11, Opus 5 71.65 |
  | Fraud | GPT-6.1 Sol 13.59, Gemini 4 Argon 18.52, Sonnet 5.5 20.33, Opus 5.5 50.77, Opus 5 65.35 |

- **Same quality scores, so the tie-break works:** within each claim agent all five measured models share one score (85 for intake, coding and fraud; 87 for adjudication), all with `quality.measured: true`. Opus 5 on fraud, measured on 13 claims after the 402, is tied too.
- **Enrollment:** Sonnet 5.5, GPT-6.1 Sol, Opus 5.5 and Opus 5 tie at 85; Gemini 4 Argon is below the bar for its invented tool field. With no measured enrollment cost, the order there is not cost-based.

### Regret

Against the best equally correct choice (GPT-6.1 Sol on all four claim agents, USD 44.51 per 1k claims, about USD 13.35 a day at 300 claims):

| Scout's first picks | Extra per day |
|---|---|
| 0.3.3, new conversation, no follow-up | USD 50.78 |
| **0.3.4, new conversation, no follow-up** | **0** |
| 0.3.4, old conversation `d16cba5a` after a new turn | 0 |

### Older conversation counts as measured again

- Reading `d16cba5a-…` with `--conversation` and no prompt replays its stored 0.3.3 turn, still with `quality.measured: false`. That is easy to mistake for the fix not working.
- After one new turn ("recommend again using the results already reported"), every model shows `quality.measured: true`. The claim agents tie at one score each, and are ordered by measured cost with GPT-6.1 Sol first, as in the new conversation. Opus is no longer scored lower for the downstream misses.

### `--results` limit checked locally

- A 69-result file is refused before sending (exit 1): "holds 69 results; Scout accepts at most 50 per call (200 per conversation). Split them into files of up to 50…". In 0.3.3 this was an HTTP 413.

### Still wrong

- **Estimates beside measured cost:** the catalogue estimate in `cost.usdPer1kAgentRuns` is still 12 to 15 times the measured cost (GPT-6.1 Sol intake: 99 estimated, 6.50 measured). The ranking now ignores it, but a reader comparing columns sees two very different numbers.
- **`best: ["cost"]`** is still given to three models per claim agent (GPT, Gemini and Sonnet), not only the measured cheapest.
- **Summaries:** they say "unchanged" after the first report and mention the Gemini enrollment failure in every claim agent's summary.
- **Reading a conversation:** it shows a stale turn until the next turn, with no hint that the server has changed since.

## openmerit 0.3.3 (5 Nov 2026)

What changed, per the package's CHANGELOG:
- The Claude Code install no longer fails with `ENOENT … updates.ts`.
- Reported results take an optional `kind` (`quality`, `usd` or `seconds`), and measured `usd` replaces Scout's cost estimate.
- The installed instructions tell the agent to report each agent's own checks at the agent level, because end-to-end results also measure the agents it did not swap.
- The matching Scout serving release is deployed.

### Installs: both clean, auto-updates on

- **Claude Code:** `install --client claude-code --scope project` exits 0. It says the MCP server applies to the whole git repository and writes `.claude/openmerit-updater.mts` with SessionStart/Stop hooks. `status --check` reports `Automatic instruction updates: on · hooks: ready · instruction version: 0.3.3`. `doctor` is green, including `updater: Automatic instruction hooks installed`.
- **Pi:** exits 0. `status --check` and `doctor` are green.
- **No device approval was needed:** both clients reused their device keys, so the 30-minute codes and UTC expiry are still untested from our side.
- **Nit:** the Claude Code success message says "Start a new session to load the extension, instructions and skill". Claude Code has no extension; that is Pi's wording.

### Measured cost: Scout uses it, but only orders by it when asked

We reran no models. We resent the per-agent-run USD and seconds measured on 5 Nov (MODEL-DECISIONS.md, 0.3.1) as `kind: "usd"` and `kind: "seconds"` at the agent level. Enrollment has no measured cost: the runner's cost summary read Langfuse before ingestion finished (known playground bug).

**A. Same conversation (`d16cba5a-…`)**, which already held the 0.3.1 results, including environment-level ones. We added 40 results (`scout-results/2026-11-05-0.3.3-measured-cost-same-conversation.json`).
- **`cost.measured`:** appears on every claim-agent candidate, and its `usdPer1kAgentRuns` equals what we reported (for example 6.4975 for GPT-6.1 Sol on intake).
- **Opus kept:** no Opus model is dropped any more. Scout's summaries say the 13/14 end-to-end misses are "not proven coding-agent errors" and need "trace attribution before calling it a model failure". Opus still gets a lower quality score from them (intake Opus 5 87 vs 95; coding both Opus 89 vs 95; fraud 90–91 vs 95), so they rank last.
- **Order:** the order is not by measured cost. First picks are GPT-6.1 Sol for intake and adjudication, and Sonnet 5.5 for coding and fraud, even though GPT is cheaper on both. Within ties Gemini (cheaper than Sonnet on intake and fraud) ranks below Sonnet.
- **Regression:** every model now shows `quality.measured: false`, although its evidence is all "Your eval: …". After the 0.3.1 report it was `true`.
- **`best: ["cost"]`** is given to two or three models per task, including Sonnet where GPT is cheaper.

**B. New conversation (`1ef2bdc0-0d0d-4e59-ab2e-4f535938a443`), as the 0.3.3 skill describes.** Same brief. We reported only each agent's own checks at the agent level, plus `usd` and `seconds`, with no environment-level results.
- **New shortlist:** before results it named Claude Fable 5.1 and GPT-5.6 Sol, which we have not measured, and put Opus 5 or Opus 5.5 first everywhere.
- **413 on one call:** sending all 69 results in one call failed with `Scout returned HTTP 413: Request is too large..` (exit 1). The docs allow 50 per call, and the CLI does not check the count before sending or explain the limit. One call per agent (9 to 15 results each) worked.
- **After results:** every measured candidate is `quality.measured: true` and tied within each task, and no model is dropped. Only Gemini on enrollment falls below the bar, correctly.
- **But measured cost did not order the tie.** The benchmark order stayed, so the most expensive model ranks first: Opus 5 first on intake, coding and adjudication; Opus 5.5 first on fraud. GPT-6.1 Sol ranks last or fourth, even though every summary calls it "the provisional lower-cost choice". This contradicts the release note that Scout ranks the group by measured cost when every compared model has it. Our brief said "rank for the best quality", so `priority` was `quality` and measured cost was apparently not the tiebreak.
- **Follow-up:** "Within a measured quality tie, rank by the measured cost we reported." Scout then ranked all four claim agents strictly by measured cost: GPT-6.1 Sol, then Gemini 4 Argon or Sonnet 5.5, then Opus 5.5, then Opus 5. All five were kept, and Opus 5 on fraud went back to the tie (92).
- **Estimates still too high:** `cost.usdPer1kAgentRuns` still shows the estimate next to the measured figure, and it is 15 to 25 times too high (for example USD 150 against a measured 6.50 per 1k intake runs).

### Regret

Measured USD per 1,000 claims (intake, coding, adjudication and fraud runs) for each choice, at about 300 claims a day. The best equally correct choice is GPT-6.1 Sol on all four agents: USD 44.51 per 1k claims, about USD 13.35 a day.

| Scout's first picks | Per 1k claims | Extra per day |
|---|---|---|
| 0.3.1, benchmarks only (Opus 5 or 5.5) | 213.78 | 50.78 |
| 0.3.1, after our results | 60.20 | 4.71 |
| 0.3.3, same conversation with measured cost (A) | 55.65 | 3.34 |
| 0.3.3, new conversation, agent-level results (B) | 213.78 | 50.78 |
| 0.3.3, B after asking to break ties by measured cost | 44.51 | 0 |
| Our current choice (Sonnet 5.5 everywhere) | 64.08 | 5.87 |

- **Compared with 0.3.1:** the misattribution is fixed. Opus is no longer dropped for downstream misses, and B shows that agent-level-only reporting gives clean ties.
- **Measured cost:** Scout now takes measured cost and shows it, but it ordered by it only when we asked. Following the 0.3.3 skill exactly (B) left Scout's first pick as costly as benchmarks alone.
- **Takeaway:** with "rank for the best quality" in the brief, a customer who stops at the first answer pays about USD 50 a day more for the same measured quality on these claims.
- **Limits:** one round of 14 claims, few labelled intake and coding findings, so these ties are not evidence of equal quality on harder claims.

## openmerit 0.3.2 (5 Nov 2026)

What changed, per the package's CHANGELOG:
- The Claude Code project install now works for a project inside a larger git repository.
- Device-code expiry prints in UTC with the minutes left, and exit code 10 includes the approval link (`--json` adds `approvalUrl`, `userCode` and `expiresAt`).
- The installed instructions tell the agent to show the link and expiry to the person approving.
- The matching Scout release extends codes from 10 to 30 minutes.

### The subfolder fix works

- **Claude Code:** after rerunning `install --client claude-code --scope project` from `playground/`, `status --check` reports `installed · MCP server: matches · connection: connected`. `doctor` is all green. Under 0.3.1 they reported `MCP server: missing` and `Installation incomplete`. The MCP entry is still under the git root (`projects["/home/user/workspace/repo"]`), which the CHANGELOG says is now expected.
- **Pi:** the install updated cleanly. `status --check` and `doctor` are green.
- **Approval links:** neither install needed a new device approval, because the device keys from 0.3.1 were reused. So the UTC expiry, the link on exit 10 and the 30-minute codes were not exercised. The new "show the approval link and its UTC expiry" line is in the installed skill for both clients.

### Claude Code install exits 1: the package is missing `updates.ts`

- **Ran:** `npx openmerit@0.3.2 install --client claude-code --scope project`, with the default automatic updates and again with `--auto-update off`.
- **Happened:** both exit 1 with `ENOENT: no such file or directory, open '…/node_modules/openmerit/dist/terminal/src/updates.ts'`. `dist/terminal/src/updates.js` reads `./updates.ts` to write the owned updater (`.claude/openmerit-updater.mts`), and the published tarball ships only `updates.js`. `npm pack openmerit@0.3.2` confirms it. The only `.ts` file in the tarball is `dist/pi/src/index.d.ts`.
- **Effect:** the MCP server, skill and rule are written, and `status` and `doctor` report a complete install. But the installer reports failure, and automatic updates stay off (`instruction version: bootstrap required`).
- **Also:** `--auto-update off` should not need the updater source at all, and its banner reads "updates off (…; disable with openmerit update --auto off)".
- **Expected:** exit 0, with the updater written from a file that ships in the package.

## openmerit 0.3.1 (5 Nov 2026)

What changed, per the package's CHANGELOG and `docs/scout.md`: `openmerit scout --conversation <id> --results <file.json>` reports aggregate results from our own evals, and Scout ranks them above public benchmarks for our recommendations only. Each recommended task now carries an `evaluation` plan (task, agent and environment checks, samples per candidate, a stop-early rule). The installed Scout instructions tell the coding agent to measure candidates as extra runs of the project's existing evals, never a second eval, and to report aggregates only.

### Baseline on 0.3.1 with recorded models

- **Deployed Worker:** run `run-2026-11-05T13-42-09-533Z` (experiment `recorded-run-…`): 36/36 checks, claims correct 14/14, payment correct 14/14, review load 0, USD 0.92, median case 42.5 s. This is the incumbent in the measurements below.
- **Earlier on `wrangler dev`:** run `run-2026-11-05T13-18-33-931Z`, experiment `recorded-run-2026-11-05T13-18-33-931Z` on `sahra-outpatient-claims`. 35/36 checks, claims correct 13/14, payment correct 14/14, review load 0, USD 0.85 over 58 agent runs, median case 34.6 s. The miss is the known SH-BILL-01 on borderline-upcoding. A 0.3.0 run earlier the same day (`run-2026-11-05T08-11-32-706Z`) passed 36/36, so that case is a coin flip for Sonnet 5.5.

### Installs: Pi works; Claude Code's subdirectory bug is still there

- **Pi:** `install --client pi --scope project` finished (`Connection check: connected`). `status --check` and `doctor` are all green.
- **Claude Code:** after approval, `install --client claude-code --scope project` exited 1 with `Claude Code did not save the "openmerit" MCP server`, exactly as on 0.3.0. Claude Code saved it under the git root (`projects["/home/user/workspace/repo"]`), and `claude mcp list` shows `openmerit` connected. `status --check` reports `not installed · MCP server: missing`, and `doctor` reports `Installation incomplete`. The skill and rule were written. Automatic instruction updates stayed off ("bootstrap required"), although the install plan said they would be on.
- Pi's `status` also reports `instruction version: bootstrap required`, although Pi has no automatic updates. It reads like a problem and isn't one.
- The installed rule says to update with `npx -y openmerit@latest update`, which bypasses a project's exact version pin.

### Installed instructions: measure with existing evals, ask before spending

- The 0.3.1 skill (Claude Code and Pi) has a new "Measuring candidates" section. It offers to run each task's `evaluation` before committing, using "the evals the project already has … add the shortlisted candidates as extra runs of those evals. Do not build a second eval or copy their datasets." When there is no eval, it says to propose a minimal one "built from its existing traces" and create it "only where and how the user agrees". It also says to ask before spending or writing to an eval platform, and to report aggregates only.
- This matches what we wanted. It is in the on-demand skill, not the always-loaded rule. A fresh agent sees it only after it loads the skill, which the rule requires before any model choice.
- Not tested: a fresh Claude Code or Pi session acting on these instructions unprompted. This orb has no Anthropic key for `claude -p`, so the consultation below was run by this release-testing agent following the skill.

### Scout's evaluation plans fit our evals

- With a brief that names our Langfuse dataset, scores, calls per run and volume (conversation `d16cba5a-…`, MODEL-DECISIONS.md), every claim-agent plan says to "add candidate runs to the existing 14-claim Langfuse experiment" with our existing agent and environment scores. Samples per candidate are 14, our whole dataset, so Scout did not ask for more labelled claims than we have.
- **Enrollment:** Scout planned on our two fixtures, said that two "cannot establish statistical superiority", and pointed at "already recorded human corrections … rather than creating another eval". It did not propose a minimal eval dataset. Only the installed skill tells the agent to do that.
- **Ranking:** "rank for the best quality" in the brief gave every task `priority: quality`. On 4 Nov, "quality … matter[s] more than cost" did not. Opus 5 or Opus 5.5 now ranks first, Gemini 4 Argon second, our current Sonnet 5.5 fourth.
- **Cost estimates are much too high for multi-call agents.** Scout assumes 16k to 26k input tokens per model call. At Scout's own Sonnet 5.5 prices, it estimates USD 0.20 per intake run and USD 0.35 per fraud run (`usdPer1kAgentRuns` 198 and 348). Our run measured USD 0.008 and USD 0.020, 18 to 24 times less. On 4 Nov, with a brief that gave no calls per run, Scout's estimates were within about 30%.
- **Residency:** no candidate carries a processing location. The response says "Endpoint residency unverified", so every candidate is a recorded gap, as on 4 Nov.

### Measuring Scout's candidates with our existing evals (deployed Worker)

- **What we ran:** following the installed skill and Scout's plans. Each run swaps one agent to one shortlisted candidate (`npm run scenarios -- --model <agent>=openrouter/<id>`) and keeps the others on recorded Sonnet 5.5. Every run is another experiment on `sahra-outpatient-claims`, scored with the existing scores. No new dataset or eval was created.
  - Claim agents: four candidates × four agents, one round of 14 claims each.
  - Enrollment: each candidate on its two fixtures, with Scout's stop rule (stop after a failure on either fixture).
  - Spend: owner-approved at USD 15–20. Langfuse recorded about USD 18.4 across 18 claim runs (one invalid, below) and 7 enrollment runs.
  - Full table: MODEL-DECISIONS.md.
- **Measured:** every candidate that ran got 100% on its own agent-level checks (line decisions, fraud recommendation, bill mismatch, coding findings, enrollment decision).
  - **End-to-end misses (5 of 17 claim runs):** each had one or two. Except the 402 in the next item, they came from the agents not under test: the known SH-BILL-01 on borderline-upcoding (Sonnet adjudication) and one extra fraud `review` (Sonnet fraud).
  - **Not model results:** two OpenRouter billing errors. A first Gemini-on-coding run errored on all 14 claims with 402 "requires more credits", because the account balance had fallen to about USD 5. One Opus 5 fraud call hit a 402 "in-flight budget exhausted". We reran the first and left the affected claim out of the second.
  - **The one real model failure:** Gemini 4 Argon on enrollment sent `decide_enrollment` an invented field (`সিদ্ধান্ত_placeholder`). The harness rejected the call, and Gemini then told the user the application was "recorded as enrolled" without retrying. Scout's stop rule ended it after one fixture.
  - **Differences:** with quality tied, the candidates differed only in cost and time. GPT-6.1 Sol was cheapest on every claim agent, USD 0.006–0.014 per agent run against Sonnet's 0.010–0.020. Opus 5 and 5.5 cost 2 to 4 times Sonnet and took 1.3 to 2.1 times as long. Gemini 4 Argon was 2 to 4 times slower.

### Reporting results changes Scout's ranking, and the gap to Scout's first pick

- **Reporting:** four `openmerit scout --conversation d16cba5a-… --results <file>` calls sent 129 aggregates: per model and metric, at agent and environment level, plus measured USD and seconds per agent run. All were accepted in about 35 seconds per call. Every reported model came back `quality.measured: true`, with evidence named "Your eval: …".
- **Ranking:** the ranking changed completely.

  | Agent | Scout's first pick before | After results |
  |---|---|---|
  | Enrollment | Claude Opus 5 | Claude Sonnet 5.5, then Opus 5, Opus 5.5, GPT-6.1 Sol (Gemini dropped) |
  | Intake | Claude Opus 5.5 | GPT-6.1 Sol, then Sonnet 5.5, Opus 5.5, Gemini 4 Argon (Opus 5 dropped) |
  | Coding | Claude Opus 5 | Sonnet 5.5, Gemini 4 Argon, GPT-6.1 Sol (both Opus dropped) |
  | Adjudication | Claude Opus 5.5 | Sonnet 5.5, then GPT-6.1 Sol, Opus 5.5, Gemini 4 Argon, Opus 5 |
  | Fraud | Claude Opus 5.5 | Sonnet 5.5, GPT-6.1 Sol, Gemini 4 Argon, Opus 5 (Opus 5.5 dropped) |

  Scout's summaries say the measured ties "supersede" or "reverse the benchmark-only Opus lead". They recommend keeping Sonnet, with GPT-6.1 Sol as a cheaper challenger.
- **Gap between Scout's first pick and the measured best:** none on quality, since every first pick scored 100% on its agent's checks. The gap is cost and time. Measured per agent run, Scout's first picks cost 3 to 5 times GPT-6.1 Sol, the cheapest equally correct candidate: intake USD 0.023 vs 0.006, coding 0.058 vs 0.011, adjudication 0.042 vs 0.013, fraud 0.051 vs 0.014. They also took 1.1 to 1.7 times as long. A benchmark-only, quality-first ranking would have cost Sahra about four times more for no measurable gain on these claims.
- **Misattribution:** Scout dropped models "below bar on measured claim correctness" for a single 13/14 end-to-end score: both Opus models on coding, Opus 5 on intake, Opus 5.5 on fraud. In each case the miss came from an agent that was not swapped. Each result's `scope` said "other agents on Claude Sonnet 5.5". One round of 14 claims cannot separate a one-claim difference from noise. Scout's plans gave no minimum sample count or repeat rounds before it acts on an environment-level difference.
- **Measured cost not used:** Scout kept its own estimates (for example USD 198 per 1k intake runs for Sonnet and GPT-6.1 Sol) after we reported a measured `usd-per-agent-run` of USD 0.006–0.010. Its text calls GPT "resource-efficient", so it read the results, but the cost numbers it shows did not change.
- **Garbled summaries:** some summaries mention unrelated swaps ("Fraud-only swaps do not establish enrollment quality", and the same about intake and coding).

### Our evals are too small to separate these candidates (our gap, not Scout's ask)

- Scout never asked for more labelled examples than our 14 claims. Its plans matched our dataset size.
- But only 1 claim labels an intake mismatch and 4 label coding findings, and every candidate passed all of them. With all candidates at 100% on agent checks, our dataset cannot rank them on quality. It can only rule out failures. More, harder labelled claims would be needed, and we did not invent any.
- **Enrollment has no dataset.** Scout's plan for it said two fixtures "cannot establish statistical superiority" and pointed at "already recorded human corrections … rather than creating another eval". It did not propose a minimal eval. The installed skill tells the agent to propose one and ask first. We proposed a `sahra-enrollments` Langfuse dataset. The owner agreed, and it now exists. The scenario runner upserts one item per application, and each run is an experiment there, scored with `enrollment-correct` at environment level. It was first run as `recorded-run-2026-11-05T14-47-28-631Z`: 2/2 items correct.
- **Privacy slip, ours:** the `source` label of one reported result names a fictional claim ID (`FICT-CLM-1011`), to explain the excluded 402. The CLI accepted it without warning, although the docs say to send aggregates only.

### Device approval keeps blocking the loop

- Four device codes (two on 0.3.0 and, again on 0.3.1, `TZK6-MX7X` and `6TBV-XJFJ`) expired today before the owner could approve them. A third pair (`WNJ8-K62W`, `DKR6-23QL`, issued 13:35 UTC) had to be relayed to the owner through another channel. Each needs a person signed in to openmerit.ai to click Approve within 10 minutes. The help and docs describe no way for an unattended release-testing run, or a CI job, to sign in. `install` and `login` accept `--setup-id UUID`, but neither the help nor the docs we read says what it is for. For a customer automating Scout, this is the main friction.
- `install --no-open` still prints "Approve this device in your browser (opening it now)", then exits 10 after 30 seconds. The flag says not to open a browser.
- The expiry time ("expires 1:26:13 PM") has no time zone. It is UTC; in Dubai it read as four hours early.
- The Pi installer again printed `Could not reach https://openmerit.ai` (exit 30) once while its code was pending (0.3.0, 08:44 UTC). The next attempt resumed the same code. This is the second time; see the 0.3.0 entry.

### Published docs read as operator notes

- `docs/scout.md` in the package is 639 lines, mostly dated operator release notes. It has 14 passages marked "source only", "unreleased" or "not deployed", which a customer cannot act on. The new measuring section is easy to miss among them.
- Three links point at files the package does not ship: `site-documentation.md`, `site-domain-migration.md` and `site-scout-architecture.md`.
- `README.md` still has a "Development" section about `packages/terminal`, `npm run verify` and deployment maintenance, none of which ship. Its Pi section still leads with "OpenMerit 0.1.12 adds…".

## openmerit 0.3.0 (4 Nov 2026)

### Claude Code project install fails when the project is a subdirectory of a git repository

- **Ran:** `npx openmerit@0.3.0 install --client claude-code --scope project --no-open` from `playground/`, which lives inside a larger git repository. The device approval succeeded.
- **Happened:** the installer exited 1 with `Claude Code did not save the "openmerit" MCP server`. Claude Code had saved it, but under the git root (`projects["/home/user/workspace/repo"]` in `~/.claude.json`), and `claude mcp list` from `playground/` shows it connected. The installer looks under the working directory (`projects["…/playground"]`). Rerunning then fails with `MCP server openmerit already exists in local config`, so the installer conflicts with its own entry. `openmerit status` reports `MCP server: missing`, and `openmerit doctor` reports `Installation incomplete`. The skill and rule were written to `playground/.claude/`, but automatic updates are off ("bootstrap required").
- **Side effect:** the MCP entry now applies to Claude Code sessions anywhere in the parent repository, not only in `playground/`.
- **Expected:** a monorepo package can install Scout at project scope, or the installer explains that Claude Code's project scope is the git root and installs there.

### Scout fails every turn (4 Nov 2026, about 20:10 UTC)

- **Ran:** `openmerit scout "<task>" --json` four times from `playground/`, with the saved `existing-first` policy and with `--all-endpoints`, including a trivial one-line prompt. Conversations `cb63a3ce-22ee-42da-b740-59d0415714d9`, `8e2b560c-d778-4f1c-8ff9-59ddeed316e1`, `818fc3c5-b37f-4598-99b5-3a6df205e42f` and `037fa0d5-1a33-4741-a9f1-54ef34722301`.
- **Happened:** every turn returned `{"status":"error","error":"Scout could not finish this turn. Please try again."}` within about 4 seconds. Re-reading the conversation returns the same error. `openmerit status --client pi --scope project --check` reports `connection: connected`, and `https://openmerit.ai/scout/` returns 200, so the status check does not reveal that Scout cannot answer.
- **Effect:** model choices are paused, as the Scout skill instructs. The error gives no reason or retry time.
- **Cause (from the operator side, not visible to a customer):** the OpenAI API key behind Scout's own agent model (`openai/gpt-6-sol`) had expired. Each turn ended `model_error` before any tool call. The Worker logged only the reason code, not the provider error. The key was rotated at 20:31 UTC and the next turn succeeded in 30 s. The CLI and `status --check` gave no sign that the outage was server-side.

### Scout respects UAE residency strictly; recommendations need an explicit exception

- See MODEL-DECISIONS.md. Under `existing-first` with no endpoints, Scout returned no models. With the whole catalogue, it refused every agent because the catalogue has no processing-location data, and it would not treat Workers AI as an exception. Only an explicit recorded-gap exception produced rankings. This is correct and cautious behavior. The gap: Scout can never say that an endpoint **does** process data in a given region, so data-residency customers always end up on an exception.
- Scout reported "web search was unavailable" during that turn.

### Cost-first ranking let weaker models through the quality bar

- The brief stated "quality and reliable tool calling matter more than cost", and Scout captured it in `criteria`. Every task still got `priority: "cost"`, and the ranking puts Claude Haiku 5.5 (quality 82) above Claude Sonnet 5.5 (90) and Gemini 4 Argon (94).
- Per the published guide this is by design: Scout ranks cheapest first among models that reach its quality bar, and ranks by quality only when you explicitly ask for the best quality. Our wording did not count as that. The real gap is the bar: Scout's benchmark-based estimates put Haiku and Gemini 3.7 Flash above it, and our own comparison (below) showed they were weaker on our claims.

### Suspicious latency data

- Claude Haiku 5.5 is listed at 33.4 s total with 30 s to first token, slower than Claude Sonnet 5.5 (18.4 s, 12.6 s). That is implausible for the smaller model and may be a data error. All rankings came from catalogue snapshot `548870f9…`, which the operator's `deploy:status` reported as stale and degraded at the time.

### First fixture run with Scout's candidates (4 Nov 2026, 21:02 UTC)

- Claude Sonnet 5.5 (Scout's rank 4, via OpenRouter) passed 24/24 checks across 9 claims and 2 enrollments on `wrangler dev`, in about 2 minutes. An earlier run passed 22/24. Both misses were our own seed-data flaws: an upcoded "original" visit, and one implausible bulk drug claim. The agents flagged both correctly.
- Not an OpenMerit issue, but worth knowing: Cloudflare's Pi extensions page imports `Type` from `@earendil-works/pi-ai`, which Pi 1.5 does not export. We used the `@earendil-works/pi-schema` builders instead.

### Model comparison: Scout's cost-first order picked the weaker candidates (4 Nov 2026, 22:10 UTC)

- **Setup:** three rounds over 14 claims, including five harder cases, plus 2 enrollments. Full table in MODEL-DECISIONS.md.
- **Results:**
  - Claude Sonnet 5.5, Scout's rank 4, passed 106/108 checks with no errored claims.
  - Scout's rank 1, Claude Haiku 5.5, passed 102/108. It over-flagged fraud and once paid an unsupported line.
  - Scout's rank 2, Gemini 3.7 Flash, passed 102/108, with 2 claims errored on unretried tool-validation failures. It was twice as slow.
- **Cost:** Scout's per-task cost estimates were within about 30% of measured cost.
- **Latency:** Scout's latency data had Haiku and Sonnet in the wrong order; see "Suspicious latency data".
- **What Scout could not see:** tool-calling reliability under our schemas. The quality scores it cited (Vals AI MedCode, MedScribe) do not measure that. The brief named reliable tool calling as a priority.

### An existing-first inventory cannot be declared without knowing endpoint IDs

- The skill asks for "public catalogue endpoint IDs" the project can reach. We already use Workers AI, but nothing in the package lists the catalogue's endpoint IDs; the docs say they come back in Scout's recommendations. So we saved `existing-first` with zero IDs, which per the skill allows no endpoints, and existing Workers AI access cannot be expressed up front.

### Pi project install: transient "could not reach" while approval was pending

- The first `install --client pi --scope project` printed `Could not reach https://openmerit.ai` while its code was pending. Later reruns worked, and the final install succeeded with `Connection check: connected`. Seen once; not reproduced.

### Device codes expire before slow approvals

- Each code lasts 10 minutes, and a rerun resumes the same code until it expires. Two rounds of codes lapsed before the owner could approve. That is working as documented, but it is friction when the person approving is not the one running the installer.
