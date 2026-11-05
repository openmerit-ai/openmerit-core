# Release-testing findings

Dated observations from using OpenMerit as Sahra Health, newest release first. Each entry says what we ran, what happened and what a customer would expect.

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
