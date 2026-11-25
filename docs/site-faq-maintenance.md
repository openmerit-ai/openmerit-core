# Website FAQ maintenance

## No Claude sign-in in the cloud app — unreleased, 25 November 2026

Reviewed the homepage against the cloud app dropping its Claude sign-in, so a member's own ChatGPT plan is the only subscription that can write their runs' test cases. `site/index.html` makes no claim about subscriptions, sign-ins or who pays for writing cases. No homepage change is needed. The cloud README's Members' subscriptions section describes the behaviour.

## Steadier picks: fixed screening cases, a retried screen and the last pick measured again — unreleased, 24 November 2026

Reviewed the homepage against screens drawing the same cases for the same eval, a screen that misses one of five cases being retried once on five others, and the provisional pick being measured when it lists under the cheapest qualified model. `site/index.html` has no FAQ block and makes no claim about the search, its screening cases, screen size or run-to-run variance. No FAQ change.

## Repositories through GitHub sign-in — unreleased, 24 November 2026

Reviewed the homepage against members adding GitHub repositories through the OpenMerit GitHub App and their GitHub sign-in, with no token stored and Contents read-only. `site/index.html` makes no claim about how the cloud app reaches a repository, GitHub sign-in or the permissions it asks for, so no homepage change is needed. The app's Coding agents, Project settings and Data pages say how it works.

## Task evals in the cloud app — unreleased, 24 November 2026

Reviewed the homepage against each task's eval living in the cloud app, accepted once and fixed until the task changes or someone revises it on the task's Eval tab (runs and the watch pause while a draft waits for review), written to the repository's `.openmerit/evals/<task>/` by the coding agent only when the user agrees, and offered as drafts from repository reviews in a Review evals queue whose approval creates the task without running it. Deleting a task now deletes its eval; Retire keeps it. `site/index.html` makes no claim about where evals live, eval versions, editing cases or the repository copy. No homepage copy change is needed. The cloud README's Evals section and the openmerit-core README describe the behaviour.

## Projects and members' own Claude and ChatGPT subscriptions in the cloud app — unreleased, 24 November 2026

Reviewed the homepage against the cloud app splitting an organization into projects (each with its own tasks, runs, guardrails, GitHub repositories and model endpoints, picked with a switcher in app.openmerit.ai's sidebar) and against members signing in to their own Claude or ChatGPT plan on Account settings, which then writes the test cases of the runs they start. `site/index.html` makes no claim about projects, workspaces, Connections, subscriptions or who pays for writing cases. No homepage copy change is needed. The cloud README's Projects and Members' subscriptions sections describe the behaviour.

## The grading loop in the cloud app — unreleased, 24 November 2026

Reviewed the homepage against the cloud app's grading loop: a person grades sampled answers in their coding agent or on the run's page, the eval is written again on OpenMerit's key where they disagree, an accepted eval is reused by later runs, and a run whose current model's answers a person marks wrong may recommend a pricier model that meets the eval's checks. `site/index.html` has no FAQ block and makes no claim about who grades, what a run keeps or that OpenMerit only recommends cheaper models. No homepage copy change is needed. app.openmerit.ai's Your data page now says a graded run keeps the answers it showed, redacted, with the grades and notes.

## The grading loop and recommending a pricier model — unreleased, 24 November 2026

Reviewed the homepage against Scout's grading loop (a person marks sampled answers Looks good or Doesn't look right, the eval is rewritten where they disagree, and an accepted Eval is saved, versioned) and against recommending the cheapest model that meets an accepted Eval's criteria even when it costs more than the current model. `site/index.html` has no FAQ block. Its copy says Scout helps "find the right models for your task, weighing quality and cost", and never that OpenMerit only recommends cheaper models, so recommending a pricier model that meets the criteria contradicts nothing there. No homepage copy change is needed.

## The cloud review writes task specs — unreleased, 24 November 2026

Reviewed the homepage against the cloud app's GitHub repository review now writing task specs with a reviewer model on OpenMerit's OpenRouter key: the reviewer reads the copy through read-only tools, the account keeps the specs (which quote the call's prompt, tool schemas and examples) as well as the model calls, and the review's spend goes into the account's ledger without counting as an evaluation. `site/index.html` makes no claim about the cloud app reading or keeping code, so no homepage change is needed. The app's Connections and Data pages now say the specs are kept and what they quote.

## Repository reviews need a paid plan — unreleased, 24 November 2026

Reviewed the homepage and app copy against the decision that the cloud has no free plan: adding and reviewing a GitHub repository now need an active plan, as evaluations do, and only the self-hosted CLI is free. `site/index.html` makes no claim about the cloud app, its plans, prices or a free tier. No homepage copy change is needed. In the app, Connections said "Add a GitHub repository and OpenMerit reads its code" with no mention of a plan; it now says "On a plan", and shows a notice linking to Plan and usage when the account has none. The Plan page's no-plan card now says a plan also covers repository reviews.

## Only the application's model calls become tasks — unreleased, 24 November 2026

Reviewed the homepage against Scout no longer mapping, offering or reviewing model usages in tests, fixtures, docs and saved results, which it still counts under their model. `site/index.html` has no FAQ block and makes no claim about which files Scout scans or which usages become tasks. No homepage copy change is needed.

## Scout writes the eval from a review of the code — unreleased, 24 November 2026

Reviewed the homepage against Scout always writing an eval from its review of the code (a task spec with criteria and guardrails, cases with mocked tool results and a fixed judge), running the repository's own eval beside it when there is one, and saving an approved Eval in `.openmerit/evals/<task>/`. This reverses the README's "never invents an eval". `site/index.html` has no FAQ block. Its only mention of evals is that picking a model takes more than an eval, which still holds, and it makes no claim that OpenMerit needs or uses only the customer's own evals. No homepage copy change is needed. The openmerit-core README's Scout steps, data handling table and opening line, and the root README's package summary, now describe the written eval.

## GitHub repositories in the cloud app — unreleased, 24 November 2026

Reviewed the homepage against the cloud app reading GitHub repositories: an account adds a public repository by its URL or a private one with a fine-grained, read-only token; OpenMerit shallow-clones it into a temporary directory, lists its model calls and deletes the copy, and never writes to GitHub. `site/index.html` makes no claim about repository access, GitHub, what OpenMerit reads or whether it sees code. No homepage copy change is needed. app.openmerit.ai's Your data page said "OpenMerit has no repository access"; it now lists the repositories, what is kept and that tokens go only to GitHub. The cloud README's GitHub repositories section describes the behaviour and its limits.

## Task specs, criteria checks and the 80% floor — unreleased, 24 November 2026

Reviewed the homepage against task bundles gaining a spec (input, steps, criteria and guardrails), the judge grading one check per criterion and guardrail, and the cloud app recommending nothing when the current model passes under 80% of its own eval. `site/index.html` has no FAQ block and makes no claim about how evals are written or graded, or about when a recommendation is made; its only mention of evals is that picking a model takes more than one. No homepage copy change is needed. The CLI still never writes an eval itself; the openmerit-core README keeps saying so until it does.

## Langfuse and the cloud app's connections removed; decisions recorded — 0.4.3, 23 November 2026

Reviewed the homepage against removing Langfuse from the CLI (setup's Langfuse step, `OPENMERIT_EXPERIMENT` and `openmerit/sources`), removing the cloud app's Viktor and Langfuse connections, and the cloud app recording the decision a coding agent sends back on a result's change. `site/index.html` makes no claim about Langfuse, Viktor, connected apps, approvals or where per-item results come from. No homepage copy change is needed; the openmerit-core and cloud READMEs describe the new behaviour.

## Fewer Viktor key scopes — unreleased, 21 November 2026

Reviewed the homepage against the cloud app's Viktor connection requiring only the scopes `scripts:execute`, `usage:read`, `threads:create`, `runs:create` and `runs:read`. `site/index.html` makes no claim about Viktor or the scopes a key needs. No homepage copy change is needed; the cloud README's Viktor section lists the scopes.

## Model-key check before a job starts — unreleased, 21 November 2026

Reviewed the homepage against the cloud app refusing a job when OpenMerit's own model key does not work, and showing a run whose current model could not run as failed instead of as a verdict. `site/index.html` makes no claim about OpenMerit's model key, refused runs or how a failed run reads. No homepage copy change is needed.

## Viktor connections without a credit cap — unreleased, 20 November 2026

Reviewed the homepage against the cloud app dropping the Viktor connection's credit cap: evaluations start only on a click that confirms the estimate in credits, and a job stops past twice its estimate. `site/index.html` makes no claim about Viktor, credit caps or what an evaluation costs in a connected app. No homepage copy change is needed.

## Viktor tasks on the Tasks page — unreleased, 20 November 2026

Reviewed the homepage against the cloud app's Tasks page listing a connected Viktor workspace's tasks in their own section, with Evaluate. `site/index.html` makes no claim about the app's Tasks page or connected apps. No homepage copy change is needed.

## More Viktor tasks evaluated in the cloud app — unreleased, 20 November 2026

Reviewed the homepage against the cloud app's Viktor connection evaluating tasks on the workspace's default model, tasks with a condition script and tasks on Viktor's writing presets, and titling its temporary copies `[OpenMerit]: <task title>`. `site/index.html` makes no claim about Viktor, its presets or which tasks a connection evaluates. No homepage copy change is needed; the cloud README's Viktor section describes the ladders and what is skipped.

## Background re-listing of connected apps — unreleased, 20 November 2026

Reviewed the homepage against the cloud app listing a connected Viktor or Langfuse app's tasks again every 15 minutes, marking new tasks New, and Refresh returning before the listing finishes. `site/index.html` makes no claim about connected apps, how often they are read or how Refresh behaves. No homepage copy change is needed; the cloud README describes the schedule and its limits.

## Connection evaluations start only on a click — unreleased, 20 November 2026

Reviewed the homepage against the cloud app evaluating a Viktor or Langfuse task only when a person clicks Evaluate, instead of on connect and Refresh. `site/index.html` makes no claim about connections starting evaluations or about Viktor or Langfuse. No homepage copy change is needed; the cloud README's Viktor and Langfuse sections describe it.
## Viktor listings past Viktor's 64,000-character output — unreleased, 20 November 2026

Reviewed the homepage against the cloud app's fix for Viktor workspaces whose task instructions pass Viktor's 64,000-character script output. `site/index.html` makes no claim about Viktor or about listing limits. No homepage copy change is needed; the cloud README's Viktor section describes it.

## Viktor run labels and readable errors in the cloud app — unreleased, 20 November 2026

Reviewed the homepage against Runs naming Viktor runs by their task and who started them, and failed Viktor jobs showing a sentence with the full error behind Show details. `site/index.html` makes no claim about runs, Viktor or error messages. No homepage copy change is needed; the cloud README's Viktor section describes it.

## The Langfuse connection in the cloud app — unreleased, 20 November 2026

Reviewed the homepage against the cloud app connecting a Langfuse project with a Viewer key, listing its generations as tasks, evaluating them on replayed dataset items and recorded calls, and recording an approval without writing to Langfuse. `site/index.html` has no FAQ block and makes no claim about Langfuse, connected apps or what OpenMerit reads from them. No homepage copy change is needed; the cloud README's Langfuse section describes it, including what it reads.

## Viktor listing, approver names and credits in the cloud app — unreleased, 20 November 2026

Reviewed the homepage against the Viktor connection relisting stale task lists, showing approvers by name, counting only spent credits, and reporting a drafted tool call as an error. `site/index.html` still makes no claim about Viktor, credits or approvals. No homepage copy change is needed; the cloud README's Viktor section describes it.

## The Viktor connection in the cloud app — unreleased, 19 November 2026

Reviewed the homepage against the cloud app connecting a Viktor workspace with an API key: it lists the workspace's scheduled tasks, evaluates cheaper presets on temporary paused copies in Viktor's test mode within a credit cap, and records an approval without changing the task. `site/index.html` has no FAQ block and makes no claim about Viktor, connected apps, credits or approvals. No homepage copy change is needed; the cloud README's Viktor section and the openmerit README's Engine section describe it.

## Evidence, connections and approval in the shared core — unreleased, 19 November 2026

Reviewed the homepage against the change that adds the evidence record, the quality rule, the connector interface and the approval record to `openmerit/engine`, with the CLI's repo scan and eval command and the cloud app's agent bundle as the first connections. `site/index.html` has no FAQ block and makes no claim about connections, graders, evidence or approvals; no new connection (Langfuse, Viktor, GitHub) is released. No homepage copy change is needed; the openmerit README's Engine section and the cloud README describe them.

## Result, pool, provisional pick and edit in the shared core — unreleased, 19 November 2026

Reviewed the homepage against the change that moves the task result, the pool rule, the provisional pick and the proposed edit into `openmerit/engine` for both the CLI and the cloud app. `site/index.html` has no FAQ block and makes no claim about which models are candidates or how an edit is written. No homepage copy change is needed; the openmerit README's Engine section and the cloud README describe them.

## One evaluation policy for the CLI and the cloud — unreleased, 19 November 2026

Reviewed the homepage against the change that moves Scout's task evaluation into `openmerit/engine`'s `evaluateTask`, so the CLI and the cloud app reach the same verdict, with the cloud now running every case three times, drawing samples at random, screening challengers first and listing near misses. `site/index.html` has no FAQ block and makes no claim about repeats, samples, challengers or how many times a case runs. No homepage copy change is needed; the openmerit README's step 6 and the cloud README describe the policy.

## Challengers up to the current model's price — unreleased, 19 November 2026

Reviewed the homepage against Scout's challengers listing up to the current model's price when no qualifying finalist costs less per item than the current model. `site/index.html` has no FAQ block and makes no claim about how challengers are chosen or priced. No homepage copy change is needed; the openmerit README's Scout Model Binary Search step describes the rule.

## Acceptance fixes and real-repository fixes — npm 0.4.3 release preparation, 15 November 2026

Reviewed the homepage against the 0.4.3 changes: a project in a subdirectory of its Git repository is its own project, an eval that sends no request through the metering proxy stops after one run, too-small evals are caught before spending where possible, a budget-paused run can continue at the same budget, Configure gives an instruction instead of editing a model setting other code shares, hidden key prompts no longer echo, `--help` works on every command, and Scout recognizes more model ID forms and file types. `site/index.html` still has no FAQ block and makes no claim about any of these, including the budget guarantee, which the approval text now limits to requests sent through the proxy. No homepage copy changes. The limits noted for 0.4.2 below still apply, and npm's `latest` stays 0.4.1 until a promotion.

## Local CLI, MCP and daemon — npm 0.4.2 release preparation, 14 November 2026

Reviewed the homepage against the whole 0.4.2 package: the four entries below plus daemon start failures that name the busy port, frozen-daemon replacement, error-only daemon logs, failed runs that print their step with the resume command, and the tested platforms (Linux x64 and arm64, macOS arm64 and x64; no Windows). `site/index.html` still has no FAQ block and makes no claim about any of these, so no FAQ copy changes. Remaining limits outside this review: the homepage letter describes the hosted Scout beta ("400+ models … 200+ source feeds", while the bundled catalogue lists 349 models) and its "Try Scout" link opens a sign-in page the CLI does not use; neither is an FAQ claim, and changing them needs a copy decision and a deploy. npm's `latest` stays 0.4.1, a separate Pi-extension build, until 0.4.2 is promoted.

## Scout no longer asks before mapping, and skips data files — npm 0.4.2, 13 November 2026

Reviewed the homepage against Scout sending code context to OpenMerit Harness without a separate question (eval runs still need approval), and skipping JSON data files that name many models plus the repository's `scan.exclude` patterns. `site/index.html` has no FAQ block and makes no claim that Scout asks before code context leaves the machine. No homepage copy changes.

## `openmerit connect` with Claude Code and ChatGPT sign-ins — npm 0.4.2, 13 November 2026

Reviewed the homepage against `openmerit connect`, which powers OpenMerit Harness with Claude Code through pi-claude-bridge and the machine's Claude login, with Codex models through pi's ChatGPT Plus or Pro sign-in (tokens kept in `~/.openmerit/agent/auth.json`), or with an API key. `site/index.html` has no FAQ block and mentions no coding agents, subscriptions, sign-ins or where credentials are kept. No homepage copy changes.

## Local daemon on Rivet — npm 0.4.2, 13 November 2026

Reviewed the homepage against Scout moving into a local background daemon that runs a Rivet engine on `127.0.0.1` and keeps each run as a Rivet Workflow actor, with the CLI and MCP server as its clients. `site/index.html` has no FAQ block and makes no claims about background processes, local services or where run state is kept. The engine makes no outside connections of its own, and OpenMerit still stays out of the live request path. No homepage copy changes.

## Local CLI and MCP — npm 0.4.2, 12 November 2026

Reviewed the homepage against the `openmerit` package becoming a local CLI and MCP server (`setup`, `scout`, `history`) that runs Scout Model Binary Search with the customer's own evals on candidate models through a local metering proxy, within a per-run budget, reads per-item results back read-only from the Langfuse experiments those evals record, and can edit a model ID after approval. `site/index.html` has no FAQ block and makes no claims about commands, accounts, eval execution or configuration edits. Its statement that OpenMerit stays out of the live request path still holds: the proxy exists only during approved evals on the user's machine. No homepage copy changes.

## Dominated candidates, quality tie band and requested benchmark evidence — deployed 9 November 2026

Reviewed the homepage against Scout leaving out unmeasured candidates beaten on both quality estimate and cost, treating unmeasured quality estimates within three points as tied under the quality priority, `get_model_details` returning requested benchmark results, and tied benchmark scores sharing ranks. `site/index.html` has no FAQ block and does not mention ranking order, shortlist length or benchmark ranks. No homepage copy changes.

## Claude Code worktree setup — npm 0.3.9 release preparation, 6 November 2026

Reviewed the homepage against private MCP configuration being shared across linked worktrees by newer Claude Code versions. `site/index.html` makes no worktree or project-scope installation claims and has no FAQ block. No homepage copy change is needed; the Scout setup guide documents the version boundary and the wider MCP scope.

## Refresh an approved Langfuse connection — unreleased instructions, 6 November 2026

Reviewed the homepage against coding agents refreshing an already approved Langfuse connection before recommending, without creating customer-platform records or executing candidate models. `site/index.html` has no FAQ block and makes no promise of implicit connector refresh. No homepage changes are needed; this changes npm guidance, not the server's explicit-sync contract or the customer's approval for eval runs and cleanup.

## Eval readiness and evidence-first cleanup — unreleased instructions, 6 November 2026

Reviewed the homepage against guidance for three eval-readiness paths, local/custom aggregate reporting, customer-owned platform writes and approved temporary-run cleanup after saving local Markdown evidence. `site/index.html` has no FAQ block or claims that OpenMerit hosts evals or deletes records. It still describes a model-selection layer outside the live request path. No homepage copy changes; these instructions need an npm release and fresh-agent acceptance, not a new connector or automated cleanup service.

## Measured-cost tie-break and CLI result limit — deployed 5 November 2026, npm 0.3.4

Reviewed the homepage against measured cost breaking ties under any ranking priority, older reported results counting as quality again, the CLI refusing more than 50 results per call and Claude Code's install wording. `site/index.html` has no FAQ block and does not mention ranking inputs or installer output. No homepage copy changes.

## Measured cost, environment attribution and Claude Code updater fix — deployed 5 November 2026, npm 0.3.3

Reviewed the homepage against reported results gaining a `kind` (quality, usd, seconds), measured cost replacing Scout's estimate, environment-level results no longer dropping a model whose own agent checks match, and the Claude Code install fix for automatic updates. `site/index.html` has no FAQ block and does not mention ranking inputs, cost estimates or installer updates. No homepage copy changes.

## Measured-first ranking, 30-minute device codes and monorepo install — deployed 5 November 2026, npm 0.3.2

Reviewed the homepage against measured results ranking ahead of unmeasured models, 30-minute device codes, the UTC expiry and approval link in the installer's pending output, and the Claude Code install fix for projects inside a larger git repository. `site/index.html` has no FAQ block and does not mention code lifetimes, installer output or ranking order. No homepage copy changes.

## Evaluation plans and measured results — deployed 5 November 2026, npm 0.3.1

Reviewed the homepage against the change that adds an evaluation plan to each Scout task, lets coding agents and the CLI report aggregate results measured with the customer's own evals, and ranks those results above public benchmarks for that account only. `site/index.html` has no FAQ block; its copy says OpenMerit is a model selection layer that stays out of the live request path, which still holds because Scout runs no evaluations and calls no models. No homepage copy changes. The Scout guide and data policy describe the stored results.

## Inference Terminal retirement — npm 0.3.0, 4 November 2026

Reviewed the homepage against removal of the local Inference Terminal (`openmerit dash`, its `--demo` sample and terminal analytics events). `site/index.html` has no FAQ block and does not mention the terminal, `openmerit dash` or local inventory collection; its copy describes Scout and the memo. No homepage edit is required. Older entries below that describe "terminal/Pi" FAQ claims are historical.

## Stale product removal — unreleased source, 3 November 2026

Reviewed the homepage against removal of the evaluation coordinator, protocol package, `openmerit`, `openmerit/core` and `openmerit/protocol` exports, the `npm run demo` sandbox, the hosted terminal sample at `dash.openmerit.ai` and its `/demo` comparison, the `?map=flow` map experiment, and the retired container demos. `site/index.html` has no FAQ block; its navigation links only Scout and the memo, and its copy describes Scout. It mentions none of the removed items, so no homepage edit is required. The source map below no longer points at removed packages.

## Native Scout for Pi — npm 0.1.12 release preparation, 3 November 2026

Reviewed setup, approvals, data handling, background work and readiness against replacement of the Pi 0.87 evaluation extension with the thin Pi 1.5.0 native MCP adapter. Current checkout landing copy describes model selection, not Pi lifecycle commands; it has no FAQ block promising Pi evaluations, scheduling or swaps, so no landing edit is required here. Older FAQ audit entries that describe the Pi lifecycle remain historical, not claims about this adapter. Public setup, troubleshooting, architecture, navigation and limitations now distinguish native Scout from the unchanged standalone evaluation CLI and custom core coordinator. Lifecycle walkthroughs are explicitly historical/core references. Each new client/scope has an independent private key; Pi installs no auto-update hook or LaunchAgent. The logo-first, copy-only Add to Pi action has no deep link and proves neither setup nor invocation. Local packed-install and native-agent acceptance passed; registry publication, website deployment and production account approval require separate release receipts.

## Fireworks Specialized Intelligence Index — source only, 1 November 2026

Reviewed ranking and coverage claims against the change that reads the Fireworks Specialized Intelligence Index's 0–100 headline scores as benchmark evidence. The homepage FAQ names no individual benchmark sources and claims no legal, finance or healthcare coverage, so no FAQ copy changes. The Scout guide's source table has a Fireworks row that states which boards and rows are left out and that Fireworks is itself an inference provider.

## Scout agent covers every model kind — source only, 29 October 2026

Reviewed model-coverage, pricing and data-handling claims against the change that publishes every merged model kind, leaderboard and MTEB results to the Scout agent, adds free-text catalogue search with unit-aware costs, and runs the agent on OpenAI. The homepage FAQ names no model kinds, price units or agent model, so no FAQ copy changes. The Scout page copy on `main` no longer promises five models, so shortlists of fewer, now likelier with a kind constraint, need no copy change. The Scout guide describes the change as not yet deployed, including that agent search queries are embedded with OpenAI.

## Text leaderboards, media boards and Eden AI — source only, 29 October 2026

Reviewed ranking, coverage and pricing claims against the change that reads LiveBench, τ-bench by Sierra, OpenCompass, HELM Arabic, BRIDGE Medical and SuperCLUE as benchmark evidence, stores Open ASR, TTS Arena, 3D Arena, VBench and MMEB results, and imports Eden AI's expert-model prices. The homepage FAQ names no individual benchmark or catalogue sources, counts or price units, and claims no Chinese, Arabic or clinical coverage, so no FAQ copy changes. The Scout guide's source table describes the new sources.

## Scale Labs SEAL boards as evidence — source only, 29 October 2026

Reviewed ranking and coverage claims against the change that reads 11 Scale Labs SEAL boards as benchmark evidence. The homepage FAQ names no individual benchmark sources or counts, so no FAQ copy changes. The Scout guide's source table describes the new source.

## More Artificial Analysis evaluations as evidence — source only, 29 October 2026

Reviewed ranking and coverage claims against the change that reads HealthBench, HealthBench Professional, Humanity’s Last Exam Diamond, CritPt v2 Hard, FrontierCode 2.0 and Code2Video-AA from the Artificial Analysis page Scout already collects. The homepage FAQ names no individual benchmarks or evaluation counts, so no FAQ copy changes. The Scout guide's source table gives the new count.

## Decision-model leaderboards and shortlist tie-break — source only, 28 October 2026

Reviewed ranking and coverage claims against the change that stores the Artificial Analysis Decision Index and JevBench results for decision models and uses them to break equal-cost ties in task-fit shortlists. The homepage FAQ names no benchmark sources, decision models or shortlist ordering, so no FAQ copy changes. The Scout guide describes the tie-break in its task-fit paragraph and the Vercel decision routes row.

## Media leaderboard results store — source only, 28 October 2026

Reviewed ranking and coverage claims against the change that stores final results from Artificial Analysis and Arena image, video, speech, transcription and music leaderboards in the catalogue database. Scout does not use them in recommendations yet, and the homepage FAQ names no benchmark sources or media coverage, so no FAQ or guide copy changes.

## TrueFoundry catalogue source retired — source only, 7 November 2026

Reviewed coverage and pricing claims against the change that retires the TrueFoundry registry after its repository disappeared. The homepage FAQ names no catalogue sources, provider counts or price units, so no FAQ copy changes. The Scout guide's catalogue row no longer lists the source.

## TrueFoundry model registry in the catalogue — source only, 28 October 2026

Reviewed coverage and pricing claims against the change that imports TrueFoundry's MIT-licensed model registry into the D1 catalogue. The homepage FAQ names no catalogue sources, provider counts or price units, so no FAQ copy changes. The Scout guide's catalogue row lists the source and what it leaves out.

## Arena text factuality boards — source only, 28 October 2026

Reviewed benchmark-coverage claims against the change that reads Arena's text factuality board (overall plus medicine and healthcare, legal and government, business and finance). The homepage FAQ names no benchmark sources or counts, so no FAQ copy changes. The Scout guide's Arena row describes the board, its claim-verification weight and that Search and Agent Arena remain unread.

## MTEB final results, hosted Hub discovery and reviewed Portkey media prices — source only, 28 October 2026

Reviewed benchmark, cost, data and coverage claims against the final-score importer, task-independent hosted Hub crawl and three supplemental pricing feeds. MTEB collection excludes benchmark datasets, predictions and per-example outputs, preserves experiment and suite versions, and does not yet contribute to recommendation ranking. Media quotes retain character, input-audio-second or per-image units; unknown denominators and placeholder zeros are not free generation. Hub provider discovery includes personal accounts without widening organisation admission or executable contracts; durable collection preserves prior coverage on failures, and incremental application is not a whole-source atomic swap. Ingestion counts are not new canonical-model counts or proof of executable access. The homepage FAQ describes the unchanged terminal/Pi workflow and needs no copy changes. The Scout guide marks these additions unreleased and separates collection from recommendation support. No deployment or production refresh is included.

## Complete OpenRouter modalities and DeepInfra catalogue source — source only, 28 October 2026

Reviewed provider coverage, pricing and freshness claims against the source change that requests every OpenRouter output modality and imports DeepInfra's own public inventory. Prices retain their documented token, image, character, frame or second unit; conditional structures remain source provenance where no lossless normalized row exists. Novita is deliberately deferred because its public list adds no normalized price or modality coverage over the existing sources. The homepage FAQ names no catalogue providers or route counts, so no FAQ copy changes. The Scout guide records the new coverage and limitations. No deployment or production refresh is included.

## Vercel AI Gateway decision routes in task-fit shortlists — 28 October 2026

Reviewed coverage and pricing claims against the change that adds every decision model Vercel AI Gateway routes, with its current input rate from the catalogue, as a typed choice, score and boolean endpoint in classification and judging shortlists. The homepage FAQ names no typed endpoints, decision providers or candidate counts, so no FAQ copy changes. The Scout guide's source table describes the new routes, their single reviewed contract and the promotional-rate caveat.

## Repeatable searches and task-specific evidence first — 26 October 2026

Reviewed ranking, data-handling and privacy claims against the change that replays an identical search's recorded AI answers for seven days and ranks models measured on the task's own benchmark ahead of models with only general evidence. The homepage FAQ makes no claim about result stability, ranking order or server-side prompt storage beyond the data policy, which this change updates with the new answer cache. No FAQ change is needed.

## Scout compact loading header — source only, 26 October 2026

Removed the repeated prompt excerpt and separate loading heading. Rotating messages now occupy the results-title position with a tiny pulsing orb before the text; reduced motion disables the pulse and text transitions. Timing and result rendering are unchanged. The homepage FAQ makes no affected claims and needs no change. No deployment is included.

## Scout results and loading state — source only, 26 October 2026

Replaced the Assumptions & limitations UI (including its nested supplementary specialist list) with a short verification warning; per-model evidence and API contracts remain unchanged. Removed visible rank numbering and the multi-task reading instruction, renamed the total to Model Choices, and aligned feedback controls to one height. Loading now includes submitted-task context, rotating messages with a short reduced-motion-aware transition, and submission-to-response elapsed time including authentication. Messages are not claimed backend progress, and cache hits can be fast. The homepage FAQ makes no affected claims and needs no change. No deployment is included.

## Scout input focus — source only, 26 October 2026

Removed the task input container's active outline, retaining its focused background and the keyboard focus outlines on other controls. The homepage FAQ requires no change. No deployment is included.

## Model-name matching for "+" names and dated copies — 26 October 2026

Reviewed coverage claims against the change that keeps "+" in model names and links dated catalogue IDs to their undated model. The homepage and the Scout page state no matched-model counts, so no FAQ copy changes. The Scout guide's comparison paragraph describes both rules.

## Scout input examples — source only, 26 October 2026

Moved the example controls into the task field, with a short Try label, 1/2/3 numbering and rounded pills that hide for any nonempty draft. Presets still fill editable text without submitting. Removed visible input-helper copy and the CSS-imposed white background behind the already-transparent Claude Code logo. The homepage FAQ makes no affected claims and needs no change. No deployment is included.

## Parallel research removed; publisher methodology first — 26 October 2026

Reviewed source, freshness and data-handling claims against the change that stops Parallel research and Hub listing discovery. The homepage and the Scout page name no research provider and make no refresh-coverage claims, so no FAQ copy changes. The Scout data policy no longer lists a public-source research provider; the Scout guide and security notes describe the refresh as reading public sources directly.

## Vertical benchmark retrieval and split quality targets — 26 October 2026

Reviewed ranking and availability claims against the change that always assesses the nearest benchmark methodologies and replaces the "could not establish" failure for multi-skill tasks with a warned fallback. The homepage and the Scout page make no claims about evidence selection or failure rates, so no FAQ copy changes. The Scout guide's evidence-assessment paragraph describes both.

## Domain-aware evidence weighting and cross-source benchmark families — 26 October 2026

Reviewed ranking and evidence claims against the change that weights task-domain benchmarks above general proxies and counts copies of one evaluation from several publishers once. The homepage and the Scout page describe ranking only as using measured results, public benchmarks, cost and speed, so no FAQ copy changes. The Scout guide's quality-estimate and evidence-assessment paragraphs now describe the relevance tiers and cross-source families.

## Scout privacy settings page — source only, 26 October 2026

Moved Privacy & analytics to `/scout/privacy/`, linked from Scout's footer and the data policy. The notice and sharing controls are unchanged; sign-in returns to the settings page and existing saved preferences continue to apply to Scout. The old settings fragment forwards to the new page. The homepage FAQ requires no change. No deployment is included.

## Scout footer simplification — source only, 26 October 2026

Removed the Scout page's JSON API, Capabilities and Sources sections and header API navigation, along with their UI-only rendering, copy-request and deep-link code. Privacy & analytics, the data policy and Claude Code setup remain available. Recommendation evidence and limitations, catalogue counts, and API/status/MCP contracts are unchanged; removing public UI is not access control or a claim that these integrations are undiscoverable. The homepage FAQ requires no change. No deployment is included.

## Scout privacy copy and placement — source only, 26 October 2026

Moved the task-logging notice from below Scout's task input into the existing Privacy & analytics disclosure on the current Claude Code setup UI. The controls, dynamic sharing state and data-policy links remain available before and after submitting a task. Public Scout privacy copy and the policy describe service-provider categories rather than implementation vendors; collection, account linkage, retention, opt-outs and deletion limitations are unchanged. The policy retains device-approval, setup/installation correlation and MCP telemetry disclosures, and replaces the superseded source-only setup-default note with the released installer behavior. The homepage and connection page need no vendor-copy changes. Recommended-model/provider names, source attribution and sign-in choices remain functional information; browser assets/network requests can still reveal integrations. Internal implementation guides are unchanged. No deployment is included.

## Vendor-reported benchmark scores — 26 October 2026

Reviewed evidence and provenance claims against the change that adds developer-reported scores from LLM Stats. The homepage and the Scout page make no claim that every score is independently measured, so no FAQ copy changes. The Scout guide's source table now has an LLM Stats row that states the results are vendor-reported, unverified and counted in ranking.

## Vals AI and Arena industry benchmarks — 26 October 2026

Reviewed benchmark-source and coverage claims against the change that adds 27 Vals AI benchmarks and four Arena industry categories. The homepage and the Scout page name no benchmark publishers or vertical coverage, so no FAQ copy changes. The Scout guide's source table now has a Vals AI row and lists the Arena industry categories.

## Arena Vision and WebDev boards; benchmark-row matching through catalogue aliases — 26 October 2026

Reviewed benchmark-coverage claims against the change that matches benchmark rows through catalogue aliases and stripped run settings. The homepage and the Scout page state no matched-model counts, so no FAQ copy changes. The Scout guide's catalogue row now describes alias matching and its precedence rule. The same review covered the new Arena Vision and WebDev sources: the homepage and the Scout page name no Arena boards, so no FAQ copy changes, and the Scout guide's source table now has an Arena row listing the four boards read.

## Artificial Analysis score format — 26 October 2026

Reviewed benchmark-source claims against the parser change for Artificial Analysis's new per-evaluation score format. The homepage and the Scout page name no Artificial Analysis evaluations or counts, so no FAQ copy changes. The Scout guide's source table now lists 27 evaluations and how Elo-style ratings are converted.

## Catalogue identities and models in Scout — 26 October 2026

Reviewed model-coverage and source claims against the change that adds catalogue models to Scout and widens catalogue identity resolution. The homepage and the Scout page state no model or provider counts, so no FAQ copy changes. The Scout guide's source table now says the catalogue also contributes models no other source lists.

## Claude Code automatic instruction updates — source only, 26 October 2026

Reviewed installation, background work, permissions, data handling and activation claims. Source adds default-on asynchronous startup/response-end checks for compatible Scout instructions, with daily cadence, offline retry backoff, opt-out, manual update, integrity verification and edited-file preservation. Downloaded code is not executed; keys, MCP configuration, privacy settings and project policy are unchanged. A new session reliably loads updates. Older clients need an explicit bootstrap upgrade after npm publication; hosted releases do not push local files. Homepage wording needs no changes. Scout/npm/main-site releases remain separate, and no publication is included in this source change.

Failed background checks now emit a non-blocking notice with the “update openmerit” manual fallback; hooks during the 15-minute retry backoff remain silent. Claude Code must process the completed asynchronous output to display it. This changes failure reporting, not background execution or the one-shot exit limitation; homepage wording still needs no changes.

## Catalogue host routes in Scout — 26 October 2026

Reviewed provider, source and pricing claims against the change that adds reviewed hosted routes from the D1 model catalogue to Scout's existing models. The homepage and the Scout page make no provider-coverage claims, so no FAQ copy changes. The Scout guide's source table now lists the catalogue as a source of hosted routes.

## Twice-daily catalogue refresh — deployed, 25 October 2026

Reviewed scheduling and freshness claims. The homepage has no Scout refresh-cadence claim, so no FAQ copy changes. The Scout page's source note, the Scout guide, the data policy and the security guide now say twice daily. The owner-approved publisher and serving deployments are recorded in [Scout architecture](site-scout-architecture.md#twice-daily-refresh-deployed-25-october-2026).

## Scout setup analytics default — source only, 25 October 2026

Reviewed setup and data claims against the requested beta default. The normal
copied command has no analytics prefix, and Scout setup diagnostics default on
in source. Privacy opt-outs and unlinking remain effective; installed MCP
content stays off. Terminal/Pi and evaluation claims are unchanged, and no FAQ
copy change is needed. The installer must be published before the updated
homepage/Scout prompts are deployed. Earlier publication receipts below retain
their historical telemetry-off homepage behavior.

## Homepage scope note removal — published 25 October 2026

At the owner's request, the shared beta scope note is removed below the setup
CTA in both reading modes. This is a copy-only, published change; it adds no
product capability. The supplied prose and Scout beta invitation are unchanged.
The owner-approved deployment and live checks are recorded in
[site design](site-design.md).

## Conversational homepage — published 25 October 2026

The owner requested a single hero with two conversational paragraphs and a
Scout invitation, replacing the thirteen-question FAQ and terminal setup.
Reviewed model-selection, background work, traffic replay, pricing and setup
claims. The hero begins directly with the supplied prose, without an eyebrow;
a visible beta note says continuous traffic replay and decision-based pricing
are direction, not current beta behavior. Scout's recommendations remain
evidence-based candidates, not guaranteed best models or application results.
The CTA hands off a public installer prompt, requires device approval and
starts no evaluation or billing operation from the browser. Homepage setup
is explicitly telemetry-off, with no correlated setup ID. Clipboard and app
launch are distinguished from completed installation. The single CTA copies
the prompt directly, with an inline confirmation or permission-error message
and no separate prompt section. Scout and protected
memo handlers are unchanged. The owner-approved deployment is recorded in
[site design](site-design.md#conversational-homepage--published-25-october-2026).
The mobile-default TL;DR repeats the supplied model-selection and no-router
claims; both reading modes retain the same visible beta scope note and setup
CTA. Switching versions changes presentation only, not product capabilities.

## Coding-agent device sign-in — source only, 23 October 2026

Added a source-only rebuild of coding-agent setup: a secret-free copied prompt, `openmerit install` with browser device approval at the product-level `/connect`, per-device MCP keys and a Scout skill for Claude Code. Nothing is deployed or published. Homepage FAQ claims describe the terminal/Pi workflow and are unaffected; no FAQ edit is needed. Guides label the setup as unreleased until the Scout Worker, D1 tables and an npm preview ship.

## Scout coding-agent reset — serving rollout, 23 October 2026

Removed the Scout installer, MCP/OAuth agent backend, persistent setup instructions and agent activation tracking for a rebuild. The web interface retains only a Claude Code placeholder that cannot install or connect. Browser account sign-in, recommendations, JSON API, Inference Terminal and the separate Pi/evaluation workflows remain unchanged. Guides distinguish this reset from historical hosted receipts, npm releases and remote grant revocation. Homepage FAQ claims still concern the unchanged terminal/Pi workflow and need no edit. The owner authorized restoring verified icon bytes, pushing main and deploying only the Scout serving Worker. Provider settings, stored data, the publisher, root site, router, terminal and npm publication remain outside this rollout. Authorization is not deployment acceptance; verify live assets and removed routes separately.

## PostHog instrumentation — version-5 serving rollout

Reviewed homepage data, background, cost and evaluation claims against the current source upgrade. The FAQ describes released terminal/Pi behavior; optional source-only telemetry does not add inference execution or alter that workflow, so website code needs no edit. Source guides now qualify native public-page lifecycle/CTA events, allowlisted acquisition/UTM/device categories, support-dependent sampled performance, same-tab linked signup/search identity versus request-only unlinking, HTTP-200 logical MCP errors, bounded stage/provider codes and actual attempt tokens. Recommendations are not executions, and unknown costs are not invented. Feedback uses fixed ratings/reasons with trace/retry correlation; CLI version/platform/runtime and sanitized frames remain opt-in. Prompt sharing and retention controls are unchanged.

Replay is a separate inactive spike, not an available capability; no ranking experiment is active. Reviewed, sanitized feedback-derived evaluation cases must precede an offline baseline and any future controlled experiment, without automatic private-content copying or retention expansion. The owner authorized the independent Scout serving rollout, not main-site or npm publication. Alert notifications still need chosen cadence/recipients and release ingestion acceptance. Main-site publication remains blocked by documented source divergence. Dated entries below are historical rollout receipts, not acceptance of this upgrade.

## OpenMerit installation with Scout first — hosted handoff, 23 October 2026

Reviewed setup, authorization, invocation, updates, data and mutation claims against the Claude Code installer and gated Clerk OAuth resource boundary. Clipboard success remains a handoff, not installation or authentication. Only Scout is installed; other clients remain manual setup. Project policy retains confirmed public endpoint IDs, treats an empty inventory as empty and requires consent before broadening. Native authorization and token renewal depend on provider configuration and client acceptance; signed-fixture tests are not a completed human login. Persistent rules do not guarantee invocation or authorize spending, deployments or future capabilities. Existing PostHog setup/connection/search milestones do not prove model adoption or application correctness. Compatible hosted updates retain the connection; local rule updates require a reviewed release and preserve user changes. Homepage FAQ answers concern unchanged terminal/Pi behavior and need no edits. The owner-approved serving rollout publishes the hosted handoff and disabled OAuth boundary, not npm, provider settings or other services. The installer remains source-preview only and native sign-in remains unverified.

## Scout beta evaluation analytics — rollout, 22 October 2026

Reviewed data, consent, identity, retention and readiness claims against the beta analytics rollout. The serving configuration enables `SCOUT_BETA_EVALUATION_LOGGING=true`, alongside `POSTHOG_CAPTURE_CONTENT=true` and complete account-sync/deletion configuration. Browser content defaults on only without a stored choice; saved off, general opt-out, DNT/GPC and unreadable storage keep it off. API/MCP retain explicit content opt-in and CLI content remains off. Prompt/excerpt/five-layer prose belongs only in `$ai_trace.$ai_input_state`, not ordinary search details, with existing redaction bounds and three-task cap.

The policy cites PostHog's documented 30-day AI-property storage separately from normal metadata retention. A synthetic live-project check confirmed storage separation and `retention_days=30`, not expiry, retroactive v3 deletion or exact backup erasure. Browser/request unlinking uses fresh unrelated identifiers without profile/identify or prior browser/trace IDs, still honoring account opt-out/deletion gates. It is not account-wide, does not stop separately consented Clerk lifecycle/profile analytics, unlink past records or propagate to copied agent instructions. It sacrifices cross-request funnels and automatic account-based historical deletion; text can still identify someone. Product evaluation/debugging is not foundation model training, and processors and restricted access remain disclosed.

Homepage FAQ answers describe the unchanged terminal/Pi workflow and need no edits. The policy preserves the verified data-request contact and deletion limits. Beta status establishes no consent/legal basis; the operator retains that responsibility. Deployment is owner-approved. Main-site `/docs/` publication remains blocked by source divergence; the policy is generated from its maintained Markdown at `/scout/data-policy/` and published with the serving Worker. No root website or npm publication is included.

## Scout in-place agent setup — source only, unreleased, 22 October 2026

Reviewed setup, privacy and installation claims against the agent picker, automatic clipboard handoff and footer disclosures. A successful clipboard write copies public instructions, not credentials or the user's task, and does not establish an installation or authenticated connection. Existing token/header requirements and analytics opt-outs remain intact. Manual-copy fallback does not emit a successful-copy receipt. Homepage FAQ answers concern unchanged terminal/Pi integration and require no edits.

## Scout document evidence and shortlist corrections — 22 October 2026

Reviewed evidence and comparison claims against the added IDP Leaderboard source, the labelled general-image fallback for document tasks, the stated-tradeoff priority and the document-evidence applicability fix. The homepage FAQ describes the terminal/Pi workflow and remains accurate; no FAQ change is needed.

## Scout preset tasks — source only, unreleased, 22 October 2026

Reviewed the new editable one-, two- and three-task examples against setup, model-selection and data claims. Selection only fills the prompt; sign-in and explicit submission still apply. Examples use normal ranking, do not execute models, and do not guarantee task counts or five candidates. The click event sends a fixed example ID, not draft text. Homepage FAQ claims about released npm behavior are unchanged.

## Scout coding-agent activation analytics — source only, unreleased, 22 October 2026

Reviewed setup, identity and data claims against explicit setup/choice/copy events and server-confirmed MCP initialization. The new optional selector adds a public agent label, not an installer or a compatibility guarantee. Copies are not conversions; activation requires a successful search with candidates. Browser privacy controls propagate to newly copied URLs, account preferences still gate server events, and no credentials or copied configuration enter analytics. The homepage FAQ still describes unchanged released npm behavior. Scout documentation marks the expanded funnel source-only and distinguishes first observed use from lifetime-first use and model execution.

## Scout coding-agent button — source only, unreleased, 22 October 2026

The new **Add to your coding agent** button opens existing API/MCP setup, including the current short-lived bearer-token and no-automatic-OAuth limitations. Stacked brand marks are navigation decoration, not a claim of tested integration with each client. No ranking, authentication, installation, collection or homepage FAQ behavior changes. The page serves its marks locally; no visitor request goes to a brand's favicon service.

Brand assets were downloaded unchanged from the product sites on 22 October: Claude from `https://assets.claude.com/95a868946ac8a31e5ff832e2899f294aa368b836.png?w=96&h=96` (the Claude Code page's favicon; returned 32×32), Cursor from `https://cursor.com/marketing-static/icon-192x192-light.png`, Amp from `https://ampcode.com/app-icon-192.png?v=4`, OpenCode from `https://opencode.ai/favicon-96x96-v3.png`, and T3 Code from `https://t3.codes/apple-touch-icon.png`. Codex reuses the OpenAI mark from `https://developers.openai.com/favicon.png` (SHA-256 `8d5575ee667ff715cd3e3074d5296edc68d5aadd89720d203e13131b68b22a04`). These marks remain their respective owners' trademarks.

## Scout common quality estimate — source only, unreleased, 22 October 2026

Reviewed comparison, cost, latency and evidence claims against the replacement of per-scope cost-first screening with one cross-benchmark quality estimate, labelled strongest/value/fastest picks, a two-per-provider cap and labelled model-level timing. The homepage answer that OpenMerit does not always choose the cheapest model remains accurate; no FAQ change is needed. The Scout guide distinguishes this unreleased source change from the deployed cost-first policy.

## Unified analytics — Scout deployed, 22 October 2026

Reviewed user identity, input collection, local storage, optional telemetry and readiness claims. The deployed Scout release consolidates new search metadata/errors into PostHog, with separate opt-in for text and no historical export. New local terminal/map telemetry remains off by default and excludes local identifiers/content; CLI planning explicitly disables content capture. Public website navigation events do not inspect task input or protected pages and remain unpublished. The homepage data FAQ describes released npm behavior, which is unchanged; the source-only telemetry exceptions are documented in the terminal/security guides. Scout adds native privacy controls but no ranking/layout redesign. Local verification and hosted browser checks passed; anonymous visits and a rejected request were confirmed in PostHog storage, with opt-out controls absent. Authenticated acceptance, dashboard updates, retention configuration and npm publication remain pending. Main-site deployment is blocked by production-source/asset divergence and was left unchanged.

## Clerk profile synchronization — deployed, 22 October 2026

Reviewed account identity, privacy, background processing and readiness claims. Signed Clerk webhooks add current-profile sync and distinct signup/session lifecycle events to PostHog, gated by authenticated analytics preferences and deletion configuration. Profiles are limited to name, verified primary email, signup time and connected providers; the historical Cloudflare prompt archive remains unjoined. Durable state stores pseudonyms, preferences, bounded receipts/pending lifecycle metadata and deletion tombstones, not another profile directory. Deletion requests include historical PostHog events but require asynchronous completion checks. OAuth provider attribution is limited to session-correlated evidence, never inferred from linked accounts. The approved deployment installed the signing secret, a project-315509-only `person:write` key and account-state migration. Real Clerk deliveries, profile updates and production deletion remain unverified. Homepage terminal/Pi FAQ wording remains valid; no published npm or billing behavior changes.

## PostHog delivery correction — published, 21 October 2026

PostHog-side inspection initially found test events only. The deployed Worker silently rejected `redirect: 'error'`, so the earlier first-party HTTP 204 checks did not establish outbound delivery. A local Cloudflare-runtime reproduction sent zero requests before the fix and one afterwards. The approved deployment uses manual redirects to preserve the no-forwarding rule. PostHog storage now confirms production visits, sign-in opening, rejected API/MCP requests and opt-in source-CLI lifecycle events; six browser/API opt-out identities produced no events. The eight-chart operator dashboard excludes test/development environments, distinguishes requests from search attempts, and labels authenticated-session, search and result-interaction verification as pending. Metrics remain unapproved proposals. No Scout UI, consent, prompt archive or homepage terminal/Pi behavior changes; no npm or main-site documentation publication.

## PostHog product analytics — hosted deployment, 21 October 2026

Reviewed data, background, consent and readiness claims. Optional PostHog events are distinct from the existing private Cloudflare prompt archive: no prompts or raw exceptions enter PostHog, verified accounts use pseudonyms, browser opt-outs propagate to server-side events, and local CLI telemetry is default-off with a process-only identity. One server-side event counts each accepted search, not each task or each frontend rendering. No autocapture, session replay, full exception tracing, model execution or automatic CLI authentication is added. Hosted Scout now has the EU integration configured and deployed; real browser event delivery and opt-outs passed checks. PostHog-side ingestion, complete authenticated-session tracking and dashboards remain unverified or pending. CLI source has not been published to npm, and the main-site documentation deployment is unchanged. Homepage terminal/Pi FAQ answers describe released package behavior and need no change.

## Scout account sign-in — published, 21 October 2026

Reviewed Clerk sign-in, account data, cookies, transient prompt drafts, bearer-token requirements and edge rate limits against the deployed integration. The production instance has Google/GitHub enabled and organizations/Billing disabled; the public desktop/mobile modal and outgoing provider authorization redirects passed checks with identity/email scopes only. Anonymous API/MCP requests now return HTTP 401; public page/status and old alpha redirects remain available. Complete human OAuth acceptance and authenticated searches remain unverified. Clerk handles identity separately from Scout's prompt/evidence analytics, which still omit account/session IDs. No Clerk Billing, subscriptions, durable account budgets, saved-search history or automatic agent OAuth is included. Homepage terminal/Pi claims need no edits; the source Scout/security guides document the new hosted contract without a privacy, latency or universal-login guarantee. The separate main-site documentation deployment is unchanged.

## Canonical Scout promotion — published, 21 October 2026

Reviewed the former alpha's promotion to `/scout/`: the public page, API and MCP use the same multi-task matcher and cost-first quality-screen policy. Old alpha links redirect; there is no new capability, accuracy claim or speed improvement. The hourly publisher, research budget, retention and existing analytics dataset remain unchanged. Homepage terminal/Pi claims need no edits. Canonical one-, two- and three-task browser checks and an MCP call through the former alpha URL passed; candidate counts remained variable and all three searches exceeded five seconds. The guide records these limits. The main site and terminal were unchanged; the dated alpha-only records below retain their historical scope.

## Scout task sequences — published alpha, 21 October 2026

Reviewed comparison, evidence and readiness claims for the side-by-side task table. Headers use verified verbatim prompt excerpts; an invalid excerpt falls back to an unquoted interpretation without blocking search. This adds `tasks[].sourceText` to the existing decomposition response, not a new provider call. Rows align independent per-task ranks in prompt order, not jointly tested combinations or verified execution dependencies; no total workflow accuracy, cost or latency is claimed. Reference workloads, unknown metrics, collection and retention remain unchanged. Homepage terminal/Pi FAQ answers need no edits. Alpha publication passed fresh one-, two- and three-task browser checks plus MCP, using interpreter 37 and the hosted catalogue. Candidate counts remained variable and all three browser searches exceeded five seconds; the public guide records those limits. Stable Scout, the main site and domain routing were unchanged.

## Scout cost-first selection — published alpha, 21 October 2026

Reviewed evidence, comparison, cost and readiness claims against the published alpha ordering change. Cost leads only after a relative two-point proxy quality screen; latency breaks price ties. The guide explicitly distinguishes that screen from a task-accuracy threshold, keeps unverified discovery lists provisional, and discloses reference-workload pricing rather than exact dataset charges. The alpha-only rollout passed targeted hosted HTTP/MCP checks; shorter lists, interpretation variability and searches over five seconds remain disclosed. No verified minimum accuracy, global optimum or new collection run is claimed. Homepage terminal/Pi FAQ answers remain unchanged and need no edit.

## Scout direct model lists — published alpha, 21 October 2026

Reviewed the homepage's evidence, comparison, background, data, cost and readiness answers. They describe the terminal/Pi workflow and need no changes. Alpha resolves missing task details internally and returns one ranked shortlist per task, without follow-up questions. The five/ten/fifteen-candidate target still respects explicit restrictions, verified evidence and available Pareto tradeoffs; it is not a promise to fabricate five eligible models. Analytics retains the existing task/slot envelope and retention policy. No latency improvement, exact task accuracy or collection deployment is claimed.

## Scout multi-task discovery — published alpha, 21 October 2026

Reviewed the homepage's evidence, comparison, background, data, cost and readiness answers against Scout alpha. They describe the terminal/Pi workflow and require no copy change. The separate `/scout/alpha/` deployment adds five-layer decomposition, independent role shortlists and a shared 30-second matching deadline; stable Scout and its hourly publisher remain unchanged. Its guide identifies the response-shape change and per-role private analytics, and records the initial failed recommendation checks and subsequent timeout mitigation rather than claiming successful under-five-second search. Broader collection categories remain unreleased and unvalidated by paid research runs. The prompt toolbar, task-count hint and header freshness line are removed without changing task limits, status API freshness or source-date disclosures. No complete source coverage, jointly evaluated model combinations or exact task accuracy is claimed.

The published timeout mitigation permits 30 seconds of server matching and 35 seconds in the browser, rather than treating the five-second goal as a failure deadline. Four targeted hosted checks succeeded without result-cache hits: image classification, invoice extraction, two independent tasks and image classification through MCP. The guide distinguishes those results from the unmet latency target and still-failing local nine-role semantic check. It does not claim universal success or a speed improvement, or weaken evidence checks. Homepage answers still require no change.

## Scout task relevance — hosted beta publication, 17 October 2026

Reviewed evidence, ranking, latency, data handling and scheduling claims. The candidate retains verified methodology in hourly retrieval documents, excludes rejected or unverified task applicability from quality ranking, considers benchmark evidence before unmeasured classification contracts, and uses the existing clarification response for ambiguous output representations. Source parsing is independent of component-property names. Metadata extraction supplies downstream work to Decisions, keeping selection activities out of capability interpretation while retaining the six-second deadline. These changes do not establish whole-catalogue optimality or authorize transferring timing between endpoints. The fresh 38-request execution gate failed on bird identification and invoice extraction despite valid outputs; the Scout guide records those failures and the owner-authorized beta scope. The original gate compared average accuracy across unequal pools, rather than supported Pareto tradeoffs; no accuracy or global-optimum improvement is claimed. The public guide records the owner-authorized beta publication and its 9/11 public first-pass acceptance, including unresolved SVG and code-evidence issues. The hourly schedule and UI are unchanged; terminal/Pi homepage FAQ behavior requires no copy changes.

## Scout matching repair — hosted beta, 17 October 2026

Reviewed evidence, latency, background work and readiness claims. Primary quality targets remain separate from endpoint requirements; prepared memberships backstop bounded vector retrieval before batched scored-ability assessment. Metadata/embedding work overlaps task interpretation, and prefetched model observations still require semantic approval before ranking. Contradictory task fields receive one bounded semantic reconciliation. Final production acceptance passed 203 VM assertions and eight filter/ambiguity cases; earlier failures remain disclosed. Hourly research, UI, retention and request contracts are unchanged. This establishes neither exact task accuracy nor exhaustive methodology retrieval or a latency guarantee. npm preview.4 and stable latest remain unchanged. Homepage FAQ copy requires no changes.

## Prompt metadata filters — not released, 16 October 2026

Reviewed the metadata-preparation and Decisions-only selection prototype. Current hosted free-text creator/family/context/date restrictions are not reliable; explicit API inventories remain authoritative. The local implementation now collects metadata independently of native API adapters, validates transfers and claim compatibility through Decisions during refresh, and builds complete fact posting lists before retrieval caps. Hourly scheduling, data-handling boundaries, server-side credentials and the UI are unchanged. The latest 25-case real-provider prototype run passed 20 cases and failed five: known date/compound matches were omitted, a rolling-date condition admitted an older model, and an allowed preference became a filter. Structural unit tests do not establish semantic correctness. Do not publish filtering or readiness claims until semantic acceptance passes. No Worker, website or npm publication has been made for this prototype.

## Scout guides and npm preview.3 — published, 16 October 2026

Published `0.1.7-preview.3` under `preview`; stable `latest` remains `0.1.6`. The packaged guides now describe the sole hosted `/scout/` service and its independently deployed hourly research/matching behavior. Runtime files match preview.2, and internal site maintenance notes are excluded from the package. The fresh registry installation in the local Ubuntu ARM64 Lima VM passed artifact, HTTP/MCP and installed CLI planning acceptance, as recorded in the public testing guide. No agent execution or new hourly refresh is claimed by this release test. Homepage stable-package, approval, budget, background scheduling and UI claims remain accurate and unchanged. The npm release does not deploy the website.

## Scout naming and secret storage — 16 October 2026

Reviewed the removal of preview routes, the single `/scout/` entry point and Cloudflare secret bindings. Hourly refresh, matching semantics and the UI are unchanged. The public guide documents the canonical endpoints and server-side secret storage. Homepage terminal/Pi FAQ claims need no changes. npm publication remains deferred.

## Scout default consolidation — published, 16 October 2026

Reviewed the single-runtime promotion, exact calibration serialization, semantic uncertainty, concurrency and hourly-research claims. The UI and homepage terminal/Pi FAQ need no changes. Existing endpoint and inventory contracts remain. The preview passed 187 semantic requests, 12 request-validation checks and eight concurrent searches before promotion. Median preview latency was 0.89 seconds and p95 1.70 seconds; these are observations, not guarantees. The researched catalogue now serves the default route and the original Worker is deleted. Post-promotion verification is recorded in the internal operations guide. Instant responses and exhaustive model coverage are not promised; npm publication remains deferred.

The public FAQ lives in `site/index.html`. Its answers describe implemented behavior verified against main and the published package, including known limitations. Appearance differences between npm 0.1.6 and the hosted/source interface are identified separately in the terminal guide.

## Scout isolated preview — 16 October 2026

Reviewed the new `/scout/v2/` service against scheduling, source freshness, evidence, data handling and performance claims. Known-feed refresh remains hourly; Parallel discovery is incremental, with an explicit job limit and recheck interval. Visitor prompts never enter Parallel research. Decisions interprets semantics; validation, publication, inventory enforcement and comparison arithmetic remain code. The public guide identifies approximate candidate retrieval and external-call latency rather than promising exhaustive coverage or instantaneous execution. The original service, the UI and terminal/Pi homepage FAQ claims are unchanged. npm publication remains deferred. Publication receipts and acceptance results belong in the architecture operations guide after deployment.

## Semantic benchmark interpretation — hosted beta, 15 October 2026

Reviewed evidence, hourly scheduling, data handling and provider-usage claims. Benchmark capabilities and families are prepared with Decisions from source metadata and methodology, cached independently of score/price updates, and read locally during searches. Unknown or failed interpretations cannot grant capability evidence; existing source status exposes failures. Public methodology goes to Decisions during refresh, without user prompts. Existing prompt/specialist interpretation calls and the UI remain unchanged. Homepage terminal/Pi FAQ copy needs no changes. npm remains deferred; publication and validation are recorded separately in the internal Scout guide.

## Semantic specialist matching — hosted beta, 15 October 2026

Reviewed evidence, scheduling, data handling and provider-usage claims. Decisions replaces Hub domain/language keyword matching and partial label overlap. Public repository metadata is analyzed during hourly preparation, with revision/metadata cache reuse. Relevant searches add batched compatibility checks against prepared profiles; the initial 21-question interpreter and deterministic evidence ranking remain. Refresh now needs a provider key for changed specialist metadata. Semantic compatibility does not establish performance. UI and homepage terminal/Pi FAQ copy remain unchanged. The hosted interpreter version 14 passed all 107 local and live HTTP/MCP semantic cases, including four fresh specialist holdouts. Publication details are recorded in the internal Scout guide; npm remains deferred.

## Scout semantic formats and SQL interpretation — hosted beta, 15 October 2026

Reviewed matching, evidence, data handling and scheduling claims. Interpreter version 13 combines removal of the two prompt keyword scans with an operation-based SQL definition that does not require schema details in a task description. Uncertain format answers do not impose a hard requirement or inherit narrow measured evidence. Query-writing capability does not imply database execution or measured accuracy on the user's query. The existing UI, hourly refresh, input contract, request count and data destinations remain unchanged. Homepage terminal/Pi FAQ copy needs no changes. The guide records 91 passing local and live HTTP/MCP semantic cases without claiming universal accuracy. Hosted deployment and npm publication remain separate; npm is deferred.

## Scout identification matching — hosted beta, 15 October 2026

Reviewed the distinction between open identification and supplied-label classification against endpoint contracts, interpreter validation, visual benchmark eligibility and calibration scope. The Scout guide describes the hosted update and preserves the limits of proxy visual evidence. The homepage's terminal/Pi evidence, budget, data and readiness answers remain accurate; no FAQ edit is needed. UI files, data destinations, refresh scheduling and the number of interpretation calls are unchanged. This work does not authorize npm publication.

## Scout matching corrections — hosted beta, 15 October 2026

Reviewed homepage evidence, comparison, data, budget and readiness claims against the four Scout fixes: shared endpoint eligibility, null-preserving prices, endpoint-scope specialist exclusion and latency-aware route selection. These changes affect the separate Scout service; terminal/Pi FAQ wording remains accurate and needs no edit. The Scout guide describes the hosted-beta corrections, conservative text-output catalogue eligibility and unknown quality and timing. No UI, inference-provider call, data destination, paid evaluation or schedule change is introduced. Catalogue preparation remains hourly and request matching remains local after task interpretation. This publication updates the Scout Worker and generated documentation through the preserved-main-application workflow; npm publication remains deferred until user testing.

## Current factual review — 14 October 2026

Reviewed main against the published `openmerit@0.1.6` artifact and the hosted dashboard/demo. Stable installation includes `openmerit dash`; Pi is optional for the separate comparison workflow. The homepage now introduces the standalone terminal and links the demo guide, which distinguishes fictional hosted samples from the recorded player retained in main.

Updated background scheduling, durable pause, challenger-budget accounting, and terminal data-handling claims. The macOS LaunchAgent requires confirmed persistent execution and infrastructure permission, a logged-in user, and headless Pi authentication. Pause gates automatic work but does not cancel active intents or disable explicit commands. Budget admission and result validation use reported challenger costs; they are not provider billing controls. The terminal indexes supported source/configuration declarations, reads existing application evidence, and retains selected metadata in memory. It does not invoke the coordinator, make inference calls, or mutate model configuration.

Removed obsolete 0.1.5 comparisons and preview release chronology from current public guides. Retained uncertainty, incomplete coverage, supervised-validation limits, and npm-versus-hosted appearance disclosure. The following dated entries are historical records, not the current release contract. The docs and website were subsequently published on 14 October; npm was not changed. Direct root-configuration deployments still require production-source reconciliation.

## Historical reviews

Last factual review: 2026-09-23, against npm `openmerit@0.1.5`, the Pi 0.87 adapter, and the current source. The FAQ contains 13 questions. The earlier audit reproduced a task-triggered assessment while `/openmerit status` reported paused and confirmed the same dispatch path in the published package.

Source review on 2026-09-27: unreleased post-build target detection, harness-inferred user-confirmed metric sampling plans, incumbent and comparison handoffs, setup-time model leads, deterministic core baseline-window checks, macOS Pi LaunchAgent provisioning, and durable pause are under development. The homepage intentionally continues to describe published npm `openmerit@0.1.5`; update it only when a release containing those changes is published and verified.

The experimental `npm run demo` sandbox (since removed) was a repository-local live-provider demonstration, not a released package workflow. Its end-to-end result and tiny pilot sample do not change the homepage's shipping-behavior or reliability claims.

## Sources to review when behavior changes

The 16 October 2026 Scout reliability changes affect the hosted research/matching service and its source-backed guide: publication recovery, per-source freshness and bounded Decisions retries. Homepage approval, budgets, background-agent scheduling, and published npm behavior are unchanged. No homepage FAQ claim is strengthened by these service tests.

The current homepage has no FAQ block. The earlier source map pointed at the removed coordinator, protocol, Pi 0.87 adapter and standalone eval package. If an FAQ returns, check each claim against the remaining sources: `packages/terminal` and `docs/inference-terminal.md`; `packages/pi` and `docs/pi-extension.md`; `scout/`, `docs/scout.md` and `docs/scout-data-policy.md`; `docs/security.md`, `docs/testing.md` and `docs/roadmap.md`; and `LICENSE` with the published npm metadata for availability and cost. `docs/agent-evaluations.md` records retirement rather than a supported runner.

## Review during releases and website updates

1. Check the current published npm version and compare its behavior with the answers above. Keep unreleased behavior clearly labeled; update version-specific caveats only when the relevant release is available.
2. Review affected answers whenever setup, data handling, evidence sources, budget handling, or readiness change. Read implementation and meaningful test evidence before strengthening a claim.
3. Keep the linked operational documentation consistent.
4. Check the expanded disclosures at desktop and narrow mobile widths, including keyboard operation, links, and JavaScript-disabled reading. Verify the served FAQ after publishing.
5. Record the reviewed version, date, and any remaining limits here.

## Wording boundaries

- Separate issuing a request from the harness successfully executing it.
- Distinguish structured-result and comparison validation from independent proof that evidence is authentic.
- Describe a budget as a harness constraint until metering and spending cutoffs exist.
- Describe verification as post-swap evaluation, not a guarantee that a change is safe before it is applied.
- Claim local storage only for the relevant OpenMerit files; account for Pi session history and configured external systems.
- Keep ordinary coding checkpoints distinct from task-specific product measurements.

## Inference Terminal — unreleased source, 7 October 2026

Reviewed the homepage evidence, background, data, cost, and readiness claims against the new terminal. It reads existing project metadata and loopback runtime inventory on a bounded interval and samples whole-machine CPU/memory. It makes no inference calls, routes no traffic, runs no evaluations, and stops collecting when its CLI exits. Sample data is labeled and separate. Credential-variable detection reveals provider names only; it never uses credentials for provider calls.

Deployments, reported path hops, shared pools, additional hosts, sites, and racks come from explicit configuration or bounded exports. Source timestamps determine freshness. Agent/task names come only from recorded metadata; source code alone does not establish execution. Full local hostnames are system-reported. Missing identities and readings remain explicit. No network discovery, model verification, routing enforcement, available-headroom guarantee, or per-agent resource attribution is implied.

Top navigation, shared dropdowns, model/service images, path colors, chart interactions, and denser source rows change presentation only. Images and animation libraries are bundled locally. This remains an unreleased command; published package behavior and homepage FAQ claims are unchanged. No homepage wording changes are needed before release.

## Hosted terminal sample — 7 October 2026

Removed from source on 3 November 2026; this record is historical.

The separate `dash.openmerit.site` preview serves generated fictional data and terminal assets only. It has no collector, filesystem access, provider credentials, inference endpoint, upload path, or connection to a visitor's local environment. Public access is by link; noindex is a search-engine request, not authentication. The root site's FAQ and published npm claims remain unchanged. The deployment uses its own Worker and exact custom domain, and does not redeploy the main site or its demo/memo services.

The hosted preview’s dedicated sharing card and `Inference Terminal by OpenMerit` title change presentation only. Its social description still identifies the environment as fictional; homepage FAQ and package claims are unchanged.

## Inference service identity — unreleased source, 8 October 2026

Baseten and Cerebras credential-name detection joins Groq and the existing services. Known HTTPS endpoint overrides identify configuration independently of SDK vendor; unknown overrides suppress credential-name attribution. Only inherited variables are checked, and no credential values or raw URLs reach the snapshot. No cloud calls, account access, source-code scanning, `.env` loading, or physical hardware inference is introduced. Model creators, deployment modes, and accelerator vendor/kind come from explicit metadata. Configured services remain distinct from observed requests. The hosted sample uses fictional examples; package and homepage claims remain unchanged.

## Services inventory — unreleased source, 8 October 2026

Reviewed the new Services view against evidence, background, data, and readiness claims. It reorganizes existing metadata into a service inventory and a secondary environment map. Model creators alone never establish service connections; registry roles are subordinate to explicit roles. Selected-window service counts are nonadditive and configured-only entries remain distinct from activity. Recognized endpoint hostnames can now appear as evidence; deployment identifiers, URL paths, queries, and credential values remain excluded. Collection stays passive. This does not release the CLI or change the homepage FAQ's published-package claims.

## Automatic terminal discovery — unreleased source, 8 October 2026

Reviewed data, evidence, approval, background, and readiness claims. The terminal now checks four fixed project declaration files and bounded known loopback API candidates automatically. SDK presence never establishes usage. Optional Pi session-format-3 metadata needs explicit CLI consent saved outside the repository and tied to canonical project/source paths; session files containing conversation text are parsed only after consent, and only usage metadata is retained. Revocation clears it on the next poll. Activity exports, Pi history, and audit summaries use precedence rather than additive totals. There are no cloud usage calls or general filesystem/process scans. This supersedes the earlier source-only note that `.env` and home history were never read. Published-package behavior, hosted-sample isolation, and homepage claims remain unchanged; no FAQ wording change is needed before release.


## Native-history request counts — unreleased source, 8 October 2026

Reviewed evidence and readiness claims after the dedicated Linux VM run. Overview and model request counts now recognize approved Pi history and retained requests from partially covered sources. Collection and permissions are unchanged. The real run is bounded local-model test evidence, not a claim of universal discovery or production readiness. Published-package and homepage FAQ claims remain unchanged.


## Pi connection names — unreleased source, 9 October 2026

Reviewed evidence and data claims. Pi's existing assistant-message provider ID now supplies its recorded connection name; classification uses the existing unambiguous inventory/runtime matcher. Generic serving-provider fields still do not establish routes, and physical deployments, hidden hops, timing, and agent names remain uninferred. No additional files, credentials, inference calls, or permissions are introduced. Published-package and homepage FAQ claims remain unchanged.


## Environment map coverage — unreleased source, 9 October 2026

Reviewed evidence and readiness claims. The map now selects representatives around every recorded entry connection in the selected window or agent scope. It no longer drops connections behind workload or model layout caps. Larger maps scroll, and represented request/workload coverage remains explicit. This changes presentation only; no inference, discovery, permission, billing, or published-package behavior changes. Homepage FAQ wording is unchanged.


## Complete environment map — unreleased source, 9 October 2026

The map no longer selects representative workloads or models. It groups all retained activity by identical recorded entry connections and lets users expand every member. Request counts and relationships stay complete in collapsed and expanded views. Compact stacks preserve the original map scale and show a real member name with a count of remaining members. Model nodes display reported services and explicitly matched deployment information; absent deployment identities are explained in inspectors. No source scanning, inferred topology, new permissions, or inference calls are introduced. Homepage FAQ claims about the published package remain unchanged.


## Optional graph component experiment — unreleased source, 9 October 2026

Removed from source on 3 November 2026; this record is historical.

The `map=flow` URL flag enables a separately bundled React Flow + ELK renderer over the same retained metadata. The existing map remains the default, with immediate return through Original map. Search and member highlighting change presentation only; grouping, request totals, source collection, permissions, and sample/live separation are unchanged. This is an opt-in experiment, not a claim of production scale or released package behavior. Homepage FAQ wording remains unchanged.


## Existing activity audit — unreleased source, 9 October 2026

Reviewed homepage evidence, data, background, approval, and readiness claims against automatic bounded project JSONL readers and multi-source reconciliation. The terminal now reads supported existing request logs inside the selected project and combines their metadata with approved native Pi usage and explicit feeds. Shared recorded identities prevent double counting; unresolved overlaps and conflicting measurements are disclosed. Pi's bounded file selection increases to 128 sessions; permission scope and revocation are unchanged. No inference calls, provider account ingestion, arbitrary process/database scanning, or framework-wide automatic support is implied. Published package and homepage FAQ claims remain unchanged. VM acceptance evidence is recorded in the internal terminal notes only after the run succeeds.


## Application-only terminal scope — unreleased source, 9 October 2026

Reviewed evidence, data, approval, and readiness claims. The terminal now excludes coding-harness usage: the Pi history reader, saved-grant lookup, and access prompts are removed. Prior history-related entries in this audit are historical and superseded. Application agents, jobs, evaluations, supported request logs, and OpenMerit product-task evidence remain in scope. Explicit development-scoped records are rejected, but unmarked request data cannot be classified by purpose automatically. Runtime inventories and whole-machine measurements remain shared infrastructure evidence, not project-exclusive usage. Published package and homepage FAQ wording remain unchanged; the terminal is still unreleased.


## Terminal test installation — preview, 9 October 2026

Reviewed setup, background, data, and readiness claims. A prebuilt test package on the existing sample domain supports a single global npm install, followed by `openmerit dash` in the selected application directory. The CLI opens the default desktop browser, keeps a printed URL for headless sessions, and falls back to a free loopback port only when no explicit port was requested. Collection scope, file access, and consent boundaries are unchanged. This does not publish or change the stable npm release; homepage FAQ claims remain about the published package. Platform URL-handler code is tested separately from actual desktop acceptance, and preview verification must not be presented as broad production readiness.


## npm terminal preview delivery — published, 9 October 2026

The terminal prerelease is published in the existing `openmerit` npm package as `0.1.6-preview.0` under the `preview` tag. Registry metadata and integrity match the tested package; `latest` remains `0.1.5`. Registry-install acceptance is recorded in the terminal preview deployment record. The compiled package retains core/protocol/Pi exports and uses an explicit dist-directory allowlist so a sample-site build cannot accidentally add hosted assets or a nested installer archive. The standalone domain-hosted packaging path is removed from the source build. This changes delivery only: collection behavior, browser launch, consent, and application scope remain unchanged. Homepage stable-package claims are unchanged.


## Historical terminal activity — published preview, 9 October 2026

Reviewed retention, source coverage, and readiness claims. Published `0.1.6-preview.1` removes the 24-hour age cutoff and offers 7d, 30d, and default All time with earliest/latest retained request dates. Existing byte, file, and record caps remain; All time describes available evidence, never a guaranteed project-lifetime archive. It neither queries provider accounts nor adds persistent collection. Registry metadata and integrity match the tested artifact, and a direct npm installation passed the existing-application and dormant-log acceptance checks in the isolated VM. The `preview` tag now resolves `0.1.6-preview.1`; `latest` remains `0.1.5`. Homepage stable-package claims remain unchanged.


## Project-linked runtime inventory — unreleased source, 9 October 2026

Reviewed application scope, data access, automatic discovery, and compute claims. The source correction removes unconditional Ollama and standard-port probes. A project declaration or explicit terminal configuration must identify the local endpoint before inventory is requested; installed SDKs, inherited shell endpoints, and historical runtime names alone do not establish it. Once linked, the runtime’s available models remain shared inventory, with usage separately sourced from request records. Local compute omits this machine unless an endpoint or explicit deployment links it; declared hardware exports remain supported. The legacy machine snapshot is labeled whole-machine context. npm `0.1.6-preview.1` still has the previous automatic probes until another preview is published. Homepage stable-package claims are unchanged.

### Evidence integrity corrections — unreleased source, 9 October 2026

Reviewed project scope, usage accuracy, passive collection, hardware placement, and completeness claims. The terminal now ignores inherited shell services, requires explicit host links for endpoint placement, retains task summaries separately from all request metrics, preserves unknown status/currency/cost basis, discloses inventory count limits with partial coverage and omitted counts, and distinguishes missing request evidence from a measured zero. These corrections are source-only until another preview is published; npm `0.1.6-preview.1` retains the earlier behavior. Main-site FAQ claims describe the stable package and remain unchanged. No deployment or npm publication is implied by verification.


## Evidence corrections — published preview.2, 9 October 2026

Published `0.1.6-preview.2` with the project-scope and evidence-integrity corrections above; this supersedes the earlier source-only status of those corrections. The release guide and changelog describe this version explicitly; earlier previews retain their documented behavior. The existing VM acceptance preserved 240 original request records and all 125 original project files; two separate, real local Ollama calls were picked up from an application log during passive refresh. A project without declarations exposed no runtime inventory, while an explicit host link matched the VM hostname and Ollama residency response. Registry metadata and artifact integrity were verified, and a direct npm update in the VM retained all 242 current requests and 126 project files across passive refresh. The `preview` tag resolves `0.1.6-preview.2`. The stable `latest` channel and homepage FAQ remain about `0.1.5`; no homepage wording or website deployment is needed for this preview release.


## Terminal review corrections — unreleased source, 10 October 2026

Reviewed homepage evidence, data, background, and readiness claims against the log continuity, request outcome, multi-host residency, and model-detail coverage corrections. Collection remains passive and project-local. Bounded checkpoint verification adds up to 8 KiB of reads per cached JSONL file per poll and retains hashes, not another raw-content cache. It does not guarantee detection of every in-place edit to a large file; the terminal guide states the sampled-region limitation. Conflict reporting preserves source precedence, residency still requires fresh exported evidence, and missing usage stays unavailable. These fixes are source-only; npm `0.1.6-preview.2`, the hosted sample, and stable-package homepage claims remain unchanged. No FAQ wording change is needed.


## Hugging Face endpoint discovery — unreleased source, 10 October 2026

Reviewed evidence, data, background, and readiness claims. Selected-project endpoint declarations can identify Hugging Face dedicated endpoints and its inference router separately. Generic Hub credentials, SDK presence, downloaded models, and inherited shell settings do not establish inference use. Dedicated endpoint subdomains and URL paths/queries are excluded from the snapshot. Detection makes no remote requests or account-history calls and creates no request, model, hardware, or deployment measurements. Recorded names retain their original attribution. The official service mark is bundled locally. These changes are source-only; npm `0.1.6-preview.2`, the VM installation, the hosted sample, and stable homepage claims are unchanged. No FAQ wording change is needed.

## Expanded endpoint discovery — unreleased source, 10 October 2026

Reviewed evidence, data, background, and readiness claims for the shared 39-service endpoint registry. Only selected-project literal declarations are indexed; provider-specific credential names establish configuration, and general cloud credentials or SDK dependencies alone do not establish inference. Endpoint overrides suppress SDK-vendor fallback. Dedicated resource labels and all path/query/fragment data are excluded from snapshots. The service inventory uses the same identity registry, while explicit roles, reported paths, model creators, and actual request metadata remain authoritative. The change adds no cloud calls, account history access, source-code execution, or guessed usage. Custom domains and unlisted forms remain coverage gaps. This is unreleased source work; npm preview.2 and homepage published-behavior wording remain unchanged.


## Endpoint coverage release preparation — 10 October 2026

Prepared `0.1.6-preview.3` to include the three source-only changes above. The public terminal guide now describes this version explicitly, while registry publication remains pending verification. The latest source build passed 47 focused Linux tests in the isolated VM, preserved all 242 saved requests, 41 agent IDs, and 122 task IDs across passive refresh, and left all 126 project files unchanged. Separate endpoint fixtures did not enter the real dashboard. No new inference calls were made. Stable `latest` and homepage FAQ wording remain about `0.1.5`; neither the main site nor hosted sample is deployed by this package release.


## Endpoint coverage — published preview.3, 10 October 2026

Published `0.1.6-preview.3` and verified its npm integrity and `preview` dist-tag, superseding the source-only and release-preparation status above. Direct registry installation on the VM retained all 242 requests, 41 agent IDs, 122 task IDs, and 126 unchanged application files through passive refresh. Endpoint fixtures remained separate from actual history; no inference calls were made. Stable `latest` remains `0.1.5`; no homepage FAQ wording or site deployment changed.


## Repository index — unreleased source, 10 October 2026

Reviewed data handling, evidence, background collection, and readiness claims. The terminal now reads bounded Python/JS/TS and structured configuration syntax within the selected project, including nested dotenv declarations. No code execution, cloud calls, or network probes are added by the index. Local snapshots expose narrow identifiers and relative file/line evidence; a separate opt-in diagnostics command outputs counts only. Declarations, examples, candidates, aliases, and unresolved references remain distinct from actual application usage. Existing activity adapters and runtime-probe authorization remain unchanged. The guide explicitly marks this as unreleased source; npm preview.3 and the stable-package homepage FAQ keep their published scope. No main-site or hosted-sample deployment is implied by local verification.


## Repository index release preparation — 10 October 2026

Prepared `0.1.6-preview.4` to deliver repository indexing and counts-only diagnostics through the existing npm preview channel. The public guide identifies the minimum version and retains the boundaries on static references, recorded usage, supported syntax, and bounded scans. Registry publication and registry-install verification are pending. The VM source-build acceptance retained the existing 242 records; a separate real HF smoke workload added three successful requests and one credit-related failure. Its provider and route metadata were explicitly logged by the test application, not reconstructed from network traffic. Stable-package homepage FAQ claims remain unchanged; no website deployment is included.


## Repository index — published preview.4, 10 October 2026

Published and verified `0.1.6-preview.4`, superseding the unreleased/preparation status above. The npm package integrity matches the tested archive and `preview` points to this version. Direct registry installation and the restarted VM dashboard preserve all 246 real request records and 128 application files across passive refresh, with counts-only diagnostics and package-export checks passing. The release acceptance makes no inference calls; the separate earlier HF test supplied its provider/route identifiers explicitly. Static declarations remain distinct from actual usage. Stable `latest` is still `0.1.5`; homepage FAQ wording and site deployments are unchanged.


## Phased repository indexing — unreleased source, 10 October 2026

Reviewed startup, background collection, data handling, coverage and readiness claims. The source build opens the local dashboard before initial collection and indexes declarations in a dedicated worker. Repository-wide coverage limits become continuing batch budgets; per-file and parser protections remain, along with a worker memory ceiling. Fingerprints and sanitized parser metadata live only in process memory; no project files or persistent source cache are created. Rechecks start 60 seconds after a completed pass, while request/runtime collection keeps its existing interval and limits. Progress and failures remain explicit. The guide separates this unreleased behavior from published preview.4. No homepage FAQ wording, npm publication, or site deployment is implied.


## Phased indexing release preparation — 10 October 2026

Prepared `0.1.6-preview.5` for the existing npm preview channel. The source build passed all 281 verification tests. A separate 5,001-file synthetic repository on the four-core, 4 GiB VM exposed 25,001 references: URL ready in 43 ms, first declarations at about 1 second, full index at 4.1 seconds. An edit/deletion pass reused 4,998 files, read about 9 KiB, and completed in 1.27 seconds. These are fixture measurements, not a universal performance guarantee. The private VM source build preserved all 246 real request records and all 128 application files through passive refresh. Registry publication and installation verification are pending. The guide identifies behavior by minimum version; stable `latest`, homepage FAQ claims, and site deployments are unchanged.


## Phased repository indexing — published preview.5, 10 October 2026

Published and verified `0.1.6-preview.5`, superseding the unreleased/preparation status above. The npm integrity matches the tested archive and `preview` points to this version; stable `latest` remains `0.1.5`. A direct `npm install -g openmerit@preview` on the VM succeeded, and the persistent dashboard now runs that global registry package instead of the temporary source-build override. All 246 real records and 128 application files remain unchanged across passive refresh. Counts-only diagnostics, full JSON output, package exports, and all 61 packaged code/asset/metadata file hashes passed; served browser assets match the release. No inference calls were made. The existing activity/runtime limits and static-declaration evidence boundaries remain documented. Homepage FAQ wording and site deployments are unchanged.


## Hosted sample synchronization — 10 October 2026

Deployed the fictional sample at `dash.openmerit.site` with the preview.5 browser assets and current sample generator. The public data disclosure and sample-only API boundary remain intact; repository scanning, local runtime collection, and phased indexing do not run on visitors' environments. Historical range controls describe the available sample records, not a complete project-lifetime archive. The main-site FAQ and deployment remain unchanged. Live assets, sample counts, read-only API behavior, and desktop/mobile browser checks passed. The hosted sample was removed on 3 November 2026.

## Hosted enterprise comparison — 10 October 2026

Reviewed evidence, pricing and readiness claims. The hosted comparison uses fictional workload volumes and published token rates, clearly labels model assignments as illustrative, and makes no measured quality or latency claim. Unknown costs remain unknown. No changes to local collection, consent, routing, evaluations, billing or the published npm preview are implied. The main homepage FAQ requires no change.


## Insurance comparison evidence and preferences — 10 October 2026

Reviewed the hosted demo's quality, price, privacy and model-selection claims. Replacements now require the selected public benchmark screen and a cost or paired-latency improvement. Publisher point estimates are distinct from application evaluations; missing evidence retains the baseline. Preference conflicts remain visible, including unresolved open-weight baselines under the closed-only option. ZDR is endpoint/account-specific and developer origin is separate from residency. Fictional insurance names and fixed token volumes remain explicit. No local discovery, runtime routing, evaluation-engine, npm or homepage FAQ behavior changes. Deployment verification is recorded separately.


## Expanded comparison selection — 10 October 2026

Reviewed the hosted preference behavior against the public guide. The dated catalog searches 25 offers across six configured services and distinguishes model identity from endpoint pricing and ZDR. A hard no-open-weights conflict blocks the complete After plan and its projected cost. Soft biases can produce identical selections; the UI exposes matches and equality with Default instead of implying arbitrary changes. Benchmarks remain public screening signals, not measured application-quality or endpoint-latency evidence. The main homepage FAQ and published npm behavior require no changes.


### Incomplete comparison plans — 10 October 2026

Reviewed hosted comparison claims after replacing the whole-plan block with a visible partial plan. The closed-weight requirement remains enforced per assignment: unresolved workflows have no After assignment or usage. Qualifying workloads remain inspectable, their subset coverage is disclosed, and complete-plan savings remain unavailable. No local collection, real routing, npm or homepage FAQ claims change.


## Hosted preference comparison expansion — source, 10 October 2026

Reviewed homepage FAQ claims against the expanded fictional comparison. The new application workloads, benchmark cohorts, fixed token profiles and preference-dependent costs affect only the hosted demonstration. They do not establish live model-routing performance, production discovery coverage or a new npm release. Existing public FAQ claims remain unchanged; detailed assumptions and limits are maintained in `inference-terminal.md`.


## Preference overrides — source, 10 October 2026

Reviewed comparison, evidence, approval and regression claims. This change is confined to the fictional hosted comparison: a selected preference may override benchmark and efficiency criteria, with explicit exceptions and truthful prices. It never weakens the live evaluation engine, routing approvals, endpoint compatibility or source collection. No real inference or insurance decision is made. The main homepage FAQ and published npm release remain unchanged. Hosted publication and verification are recorded separately.


## Comparison visual hierarchy — source, 10 October 2026

Reviewed the hosted comparison's presentation. The leading dark panel makes stage controls, fixed token costs and their modeled difference more prominent while keeping override disclosures and evidence visible. Selection and pricing rules are unchanged. No homepage FAQ, npm or live routing claim changes.


## Primary domain migration — preparation, 12 October 2026

The `.ai` migration changes hostnames and mail configuration, not product behavior or readiness. Existing homepage FAQ claims remain unchanged. The protected memo, OTP limits, reader data, and interactive demo must be preserved from the deployed Worker because this checkout lacks parts of the current production source. See [migration operations and verification](site-domain-migration.md) for cutover status; DNS preparation alone does not establish successful publication or email delivery.

## Automatic light and dark appearance — unreleased source, 14 October 2026

Reviewed homepage FAQ claims against the appearance-only change. Device-driven colors affect website reading surfaces, demos, and the Inference Terminal, including charts and overlays. They add no saved theme preference, inference calls, collection, routing, permissions, or billing behavior. No FAQ wording change is required. The terminal guide separates the unreleased source appearance from published preview.5. Website/npm publication is not implied by local builds; see [palette ownership](site-design.md#automatic-appearance--published-14-october-2026) and [deployment boundaries](site-deployment.md).

## Second cleanup — unreleased, November 2026

The current homepage still has no FAQ block. The terminal and Scout agent/MCP remain; the standalone eval CLI, legacy recommendation API and unpublished docs shell are retired in source. README, commands and product guides carry the retirement boundary. No new homepage claim or production acceptance is implied.

## Scout — unreleased branch preview, 14 October 2026

Reviewed evidence, comparisons, data, background checks, cost, and readiness claims. Scout adds a separate prompt-only shortlist API and `/scout/` page; it does not change Pi approvals, evaluations, automatic swaps, terminal collection, or the published npm package. Its preview guide explains fixed ranking defaults, source/configuration differences, old visual evidence, missing speed, HTTP-only vision source transport, token-price assumptions, in-memory prompt handling, and hourly refresh lifetime. The homepage gains a navigation link; existing FAQ answers continue describing the terminal and Pi workflow and need no behavioral rewrite. Local checks do not establish a hosted deployment or state-of-the-art recommendation quality.

## Scout launch preparation — 14 October 2026

Reviewed freshness, real-data, privacy, price, speed and recommendation claims against the five-source importer and prompt-only API/MCP tool. The guide now documents independent source recovery, archived measurements, OmniDocBench's actual table version, uncertainty adjustment, and the limits of phrase matching. The page starts with a real empty input. Scout is a separate beta and does not establish SOTA task accuracy. No Pi/npm approval, budget or routing behavior changes. Hosted publication is verified separately.

## Scout publication — 14 October 2026

Scout's page, JSON API and MCP tool are now hosted, with an hourly Worker trigger and independently refreshed real public sources. The homepage navigation and generated documentation were published while preserving the deployed main application. Existing FAQ answers still describe the terminal/Pi workflow; no edits to those behavior claims were required. Publication and verification boundaries are recorded in [the Scout launch record](site-scout.md).

## Scout comparison table — 14 October 2026

Reviewed evidence, comparison, data handling and readiness claims for the semantic results table and bundled provider favicons. This changes presentation and evidence disclosure controls only; ranking, API/MCP responses and prompt handling remain unchanged. Icons use a curated local registry, with no remote favicon requests from the browser. No homepage FAQ wording change is required. Publication and browser verification are recorded separately in [the Scout launch record](site-scout.md).


## Scout Decisions integration — release preparation, 14 October 2026

Reviewed data handling, inference cost, evidence, scheduling and readiness claims. Scout now makes one server-side OpenAI Decisions call per prompt; its page and guide disclose this before submission. BFCL adds explicit tool-calling and external-memory evidence, with strict eligibility and source limitations. Fixed cost/quality/speed weights remain unchanged. The homepage FAQ continues to describe terminal/Pi behavior, so no FAQ copy change is required. This does not change terminal approvals, provider budgets, the npm package or local routing. Live publication is recorded separately in the Scout launch record.


## Scout ranking revision — 14 October 2026

Checked homepage FAQ claims against the proposed ranking revision. FAQ answers still describe the terminal/Pi workflow; Scout does not change its budgets, approvals or routing contracts. The Scout guide and table now disclose same-benchmark pairwise ordering, prompt-shaped reference cost, first-answer completion timing, tradeoff defaults, and incomplete comparison coverage. Reference estimates must not be described as measured task accuracy, actual endpoint latency or exact per-task charges. No general SOTA claim is established by the small task evaluations. Deployment and measured evaluation outcomes are recorded separately in the Scout publication notes.


## Scout measured-task ranking — 14 October 2026

Reviewed evidence, data, costs, scheduling and readiness claims for the Scout change. The separate Scout service uses calibration-only aggregates for narrow matching tasks, and public benchmark comparisons elsewhere. Held-out results are not loaded into ranking. Evaluation requires an explicit offline run; the existing hourly job still only refreshes six public feeds. No user task execution, saved prompt history, extra runtime inference, or database is introduced. Small samples and the selected candidate pool do not establish SOTA or a perfect ordered top five. Homepage FAQ claims concern the terminal/package and need no changes. Publication and test outcomes are recorded in `site-scout.md`.


## Scout interface refinement — 14 October 2026

Checked comparison, evidence and data-handling claims for the terminal-style Scout interface. Ranking and API/MCP contracts are unchanged. The page retains its OpenAI prompt-processing notice, measurement scope and limitations. Bundled provider marks replace boxed favicons; missing assets use text-only names. No homepage FAQ wording change is needed.

## Scout compact controls — 15 October 2026

Reviewed index coverage, evidence and data-handling claims. The header counts indexed models, distinct model creators, benchmark series and source feeds; it does not equate series with independent publishers or creators with hosting routes. Row disclosures retain benchmark and measured evidence, while sample/workload context moves into the existing limitations disclosure. The prompt-processing sentence is removed from the form at the user's request; the public Scout guide retains the OpenAI data-flow and retention description. Ranking, persistence and terminal/Pi behavior are unchanged. No homepage FAQ copy change is needed; publication is recorded separately in the Scout notes.

## Scout execution evidence — 15 October 2026

Reviewed evidence, comparisons, cost, latency, memory and data claims. The ranking extends the existing offline calibration path to specified code, dependent tool actions and external memory, with explicit execution/retention matching and full-episode cost/time. It adds no runtime provider evaluation, extra inference call, model-specific bonus or persistence of user prompts. The previous broad audit becomes development data; new held-out cases remain excluded. Failed candidate profiles are withheld, and missing action-pool coverage is filled through separate calibration before another fresh check. Selected pools and small samples cannot prove a universally correct ordered five. Homepage FAQ answers still describe terminal/Pi behavior and need no copy changes. Publication and fresh validation are recorded in the Scout notes.


## Agent evaluation loop — unreleased source, 15 October 2026

Reviewed harness support, evaluations, costs, budgets, data and scheduling. The new standalone eval commands are separate from terminal collection and Pi application evaluation. Source docs mark them unreleased; published npm 0.1.6 and homepage FAQ claims are unchanged. Project instructions are opt-in through init, not install hooks. Watch is foreground-only, cumulative reservations are admission controls rather than billing caps, unknown usage/cost stays unknown, and Scout eligibility filtering happens before ranking. No performance guarantee or automatic production model swap is introduced.


## Scout model detail cleanup — 15 October 2026

Reviewed evidence and comparison claims after removing the prose summary from every expanded model row. Measurement scope remains in Assumptions & limitations and source-linked evidence remains in the details. Ranking and API/MCP metadata are unchanged; homepage FAQ wording requires no change.


## Agent evaluation npm preview — 15 October 2026

Prepared the `0.1.7-preview.1` npm preview with explicit installation and setup instructions. The stable `latest` tag remains `0.1.6`. Reviewed homepage readiness, evaluation, budget and data claims: they describe stable terminal/Pi behavior and require no copy changes. The preview retains explicit initialization, connection scope, local execution and budget limitations; no install-time automation is claimed.

## Agent evaluation accounting — unreleased source, 15 October 2026

Reviewed evidence, comparisons, budgets, data and readiness against the source corrections. Native cost estimates and partial charges remain distinct from provider billing; reservations are not released by estimates. Recognized budget/environment blocks are unscored and stop comparisons. The Linux Codex sandbox probe is a local preflight action with no inference call or permission bypass. There is no provider-account ingestion in the product, production model swap or new background process. The guide distinguishes these changes from npm `0.1.7-preview.1`; stable homepage FAQ wording remains unchanged.

## Agent evaluation budget selection — unreleased source, 15 October 2026

Reviewed budget, approval, scheduling and readiness claims. Source planning now asks for an explicit $10, custom or no-fixed-cap allowance after model scope; no option is selected automatically. New project instructions reuse the saved choice, and reservations stay internal. Cumulative accounting survives replanning and limit changes. No fixed cap retains task/repetition/time limits and native permissions, but a foreground watcher can incur further charges until stopped. Provider billing limits remain independent. These changes are documented separately from published `0.1.7-preview.1`; the stable homepage FAQ still describes terminal/Pi behavior and needs no wording change.

## Agent evaluation preview.2 release preparation — 15 October 2026

Prepared `0.1.7-preview.2` for the existing npm preview channel, combining corrected accounting and execution-block handling with explicit budget selection. The public guide now describes these versioned behaviors together and keeps earlier VM findings historical. Stable `latest` remains `0.1.6`; homepage FAQ claims still describe terminal/Pi behavior and require no copy changes. Registry publication and fresh-install VM acceptance are recorded separately; a successful local build alone does not establish either.

## Agent evaluation preview.2 — published, 15 October 2026

Published and verified `0.1.7-preview.2`, superseding the release-preparation status above. A fresh VM registry install matched the package integrity and all 124 files. Real Claude Code and OpenCode before/after watcher runs completed three attempts each per revision; native budget stops were unscored and Codex's unsupported VM sandbox stopped before inference. Budget choices and prior reservations persisted. These results establish the tested integration paths, not universal model quality or reconciled per-attempt pricing. Stable `latest` remains `0.1.6`; no homepage FAQ rewrite or website deployment was required. Detailed acceptance evidence is in [testing](testing.md#published-preview2-acceptance-15-october-2026).


## Scout endpoint catalogue — 15 October 2026

Reviewed evidence, setup, data and model-selection claims against the independent provider catalogue and typed/specialist endpoint shortlist. Classification and spatial vision choices are explicitly task-fit candidates with unknown quality, not a proven five-model performance ranking. Price and latency belong to the selected route; self-hosted compute is unknown. Jev is a recommended task candidate, not the ranker. The hosted guide describes new endpoint scope without claiming npm clients execute new protocols automatically. Homepage terminal/Pi FAQ wording is unaffected. Fresh routing and image execution results and their limits are recorded in the public Scout guide; deployment acceptance is recorded separately.


## Scout publisher icons — 15 October 2026

Reviewed the provider identity and data-handling claims after adding TypeSafe and Hub publisher marks. Icons remain bundled, same-origin assets; there is no browser-side avatar lookup or third-party favicon service. A fallback Hugging Face mark denotes the repository platform, not authorship or endorsement. Ranking, endpoint access and budgets are unchanged; homepage FAQ copy needs no changes.


## Scout source spacing — 15 October 2026

Reviewed the compact source-disclosure layout. Only spacing changes: source coverage, methods, limitations, refresh dates and links remain available on expansion. Ranking, data handling, refresh scheduling and budget behavior are unchanged; homepage FAQ wording needs no change.


## Scout search analytics — 15 October 2026

Reviewed data handling, history, evidence and account claims. Hosted Scout now adds allowlisted task-category-plus-shortlist events to Analytics Engine for API and MCP recommendation attempts. No raw prompts, hashes, user identifiers, request metadata or requested project inventories are recorded. Three-month sampled retention and persistent private local exports are disclosed. Maintainer authentication does not require visitor login. Metrics describe recommendations, not actual task success. Ranking and endpoint selection are unchanged; homepage terminal/Pi FAQ wording requires no change. Deployment and live verification are recorded separately.

Scout admin review (15 October 2026): the protected team report adds no visitor login or identifier to Scout recommendation events. Homepage/Pi/terminal data and approval claims remain unchanged. Public Scout and security guides distinguish anonymous analytics from team authentication records.


## Scout private prompt records — 15 October 2026

The owner requested original task input alongside the ordered five. Version 2 search analytics now includes that validated text in the same Cloudflare sampling unit, while excluding separately collected visitor identifiers and request metadata. Public Scout/security guides replace the earlier no-prompt-storage claim, disclose potentially sensitive prompt content, and retain three-month sampled retention plus private export lifetime. Older records cannot be backfilled. The private report shows prompt text safely escaped; no visitor-facing history is added. Homepage FAQs still describe terminal/Pi collection and need no behavioral rewrite. Live publication is recorded separately.


## Scout storage-only observability — 15 October 2026

At the owner's request, the report generator, HTML export, dashboard/auth handlers and staging utility are removed. Private Analytics Engine storage remains, now attaching a snapshot of benchmark/calibration/endpoint/pricing evidence to the prompt and ordered five in one sampling unit. No user-facing history, analytics sign-in or public query route remains. Account-authenticated ad hoc queries use the documented schema; legacy data remains intact. The public data-handling and security guides disclose unredacted prompt text, source evidence, best-effort collection and sampled retention. Homepage terminal/Pi FAQ behavior is unchanged. Earlier report/dashboard audit entries are historical and superseded.


## Scout ambiguity audit — unreleased source, 15 October 2026

Reviewed matching, evidence and scheduling claims after the local ambiguity audit. Mixed answer types require generative candidates, uncertain operation/output interpretations cannot inherit narrow calibration, and low-confidence document guesses no longer narrow ordinary photos to OCR evidence. The existing UI and hourly refresh are unchanged; the matcher still uses one interpretation call. The public Scout guide identifies these changes as unreleased and records the remaining binary-label confidence limitation. No candidate inference, deployment or npm publication occurred in this audit. Homepage terminal/Pi FAQ claims remain accurate and need no copy changes.


## Scout task framing — hosted beta, 15 October 2026

Reviewed interpretation, evidence, data handling and scheduling claims. All prompts receive the same JSON-quoted task context; confidence thresholds, API/MCP inputs, analytics records, hourly refresh and request count are unchanged. The earlier mixed-output and calibration corrections are included. Local and live HTTP/MCP acceptance passed 25 routing cases, including arbitrary labels and explicit negation. No model-answer accuracy or universal interpretation guarantee is claimed. The existing Scout UI and homepage FAQ copy need no changes; hosted deployment and npm publication remain separate actions.


## Scout category/content distinction — hosted beta, 15 October 2026

Reviewed evidence, model selection, input and scheduling claims. Conversational categories are interpreted from the requested distinction, while reading capability depends on the requested content. Task-fit quality remains unknown; representative benchmarks are not claimed as classification accuracy. Two existing questions change; no object-name rules, new requests, source fetches, UI controls or new data collection are introduced. The public guide records 43 passing local and live HTTP/MCP semantic checks and keeps hosted deployment separate from npm publication. Homepage terminal/Pi FAQ copy requires no changes.


## Scout hybrid evidence implementation — unreleased, 16 October 2026

Reviewed recommendation, data, scheduling and comparison claims. Local changes introduce small-model constraint extraction, exact typed metadata comparisons, public-evidence embeddings and a provisional Pareto shortlist. Discovery archives are distinct from verified endpoints; benchmark similarity is not measured task accuracy. Missing objectives cannot establish a global frontier. OpenAI also receives prompts for structured interpretation and query embeddings; visitor query vectors are not persisted in Vectorize. Existing private prompt analytics remain unchanged. UI and homepage terminal/Pi FAQ wording need no changes. Deployment remains conditional on semantic and operational acceptance; no npm publication is included.


## Scout hybrid evidence publication — 16 October 2026

Reviewed matching, source, data handling and scheduling claims after hosted activation. Exact model restrictions and a provisional Pareto shortlist replace the bounded model pool. OpenAI receives prompts for Decisions, structured metadata extraction and transient query embeddings; public methodology vectors enter Vectorize. Calibration contributes scoped quality rather than replacing only some reference charges/timings. Source coverage remains incremental and large-scale performance is not established. The memory fix and staged publication retain the previous complete catalogue on failure. UI and homepage terminal/Pi FAQ copy require no changes. No npm publication is included.

## Scout latency implementation — hosted beta, 17 October 2026

Reviewed homepage evidence, speed, scheduling and data handling claims. This change affects hosted Scout serving only: hourly specialist packs, compact/cacheable interpretation reference data, bounded exact-result memory reuse and fixed diagnostic timings/status codes. The UI, hourly research interval, exact metadata eligibility and numerical selection remain unchanged. No instantaneous-result or global-best-model claim is added. Provider, family, context, date, model identity and ambiguous-prompt gates passed before Worker deployment; post-deployment transport checks are recorded separately. npm publication is excluded. Homepage terminal/Pi FAQ behavior needs no edit.

## Scout beta publication follow-up — 17 October 2026

Reviewed evidence, freshness, background work and readiness claims after preview.4 publication. Stable `latest` remains `0.1.6`; Scout deploys independently. Exact stable research identities are updated on rediscovery, while semantic interpretation still governs cross-identity links. Publication validation preserves the last committed catalogue on failure. This does not expand coverage or establish task accuracy, universal semantic reliability or instantaneous matching. Homepage FAQ wording remains unchanged.

## Preview.5 package publication — 17 October 2026

Reviewed setup, readiness, evidence and scheduling claims for packaging the hosted matching-repair guides. Preview.5 is published to the preview channel, with stable latest retained at 0.1.6; runtime bytes, legal metadata, terminal/Pi approvals, budgets and routing are unchanged. All 679 repository tests passed before publication and the fresh registry installation passed 203/203 VM HTTP/MCP/CLI assertions afterward. Scout remains independently deployed with hourly preparation and bounded matching. These integration samples do not establish exact task quality or universal latency. Existing homepage FAQ copy needs no changes; detailed results and retained limitations are in the testing guide.

## Stable 0.1.7 release preparation — 24 October 2026

Reviewed setup, permissions, data, evaluations and budget claims against the stable package. Explicit device approval installs Claude Code's MCP server and Scout skill; npm installation alone does not configure an agent. Evaluation commands retain native permissions, explicit scope and budget, and unknown billing. Terminal analytics remain default-off and the terminal still reads evidence without routing or inference. These preserve the homepage FAQ's terminal/Pi claims; no FAQ wording change is required. Scout, npm and main-site documentation deploy independently; publication and real Desktop acceptance are verified separately.

## Scout startup instructions — 0.1.8 release preparation, 24 October 2026

Reviewed setup, approval, model-selection and readiness claims. The 0.1.8 installer adds an owned startup rule alongside the on-demand skill, covering implicit application-model choices including pretrained/local/browser models. It changes agent guidance, not enforcement, catalogue coverage, inference execution, provider permissions or budgets. Missing policy requires asking; unavailable Scout or unsuitable evidence requires pausing the model choice. Older npm 0.1.7 installations remain skill-only until upgraded, and a new Claude Code session must load the rule. The Scout and security guides distinguish these states and no longer imply that skill availability proves automatic invocation. Homepage FAQ answers concern terminal/Pi comparisons and need no wording change. npm, Scout and main-site documentation publication remain separate actions.

## Scout lifecycle telemetry — released 0.1.9, 24 October 2026

Reviewed setup, data handling, errors and readiness claims. Consent-gated setup and installation milestones join permitted browser clicks to device approval, verified installation and observed MCP invocations; discovery, launch requests, recommendation results and downstream execution remain distinct. MCP logical errors no longer count as success merely because HTTP returns 200. Request-only analytics refusals do not silently change saved account preferences. Delivery retries remain bounded and best effort, without transcripts, credentials, paths, replay or guaranteed skipped-call detection. The approval page describes key authorization rather than asserting installation. Homepage FAQs still describe terminal/Pi behavior and need no copy changes. Stable npm 0.1.9 and the matching Scout serving build are released; existing agents require installer reruns. PostHog confirms correlated browser/installation, real approval/key collection, native Desktop invocation/task results, cache-hit/miss and HTTP-200 logical-error receipts. Six separate feature tests triggered Scout automatically; the consented native telemetry diagnostic used an explicit test-server request. The original account privacy gate remains respected, and the isolated test key was revoked. The [operations receipt](site-scout-architecture.md#lifecycle-monitoring-repair--24-october-2026) records verification boundaries. Main-site publication remains separate.
