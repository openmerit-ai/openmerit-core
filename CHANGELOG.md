# Changelog

## 0.5.1 — 2026-11-26

- Fix in Scout (0.5.0): when a model call failed in one of a model's full runs and Scout ran that item again, the run counted twice, so the model showed as "not every run finished" with totals such as 84/85, and when it was the current model, no candidate was compared at all. The second attempt now merges into its run.
- The npm package's description now says what OpenMerit picks and how: an eval written from your code, cheaper models that pass it, on your machine with your own keys and never in your request path, with OpenMerit Cloud at openmerit.ai. The package also gets search keywords and openmerit.ai as its homepage.

## 0.5.0 — 2026-11-26

The fixes from real-use testing on 24 November, first stage: stable picks, a judge that sees tool results, run cost next to the saving, and money and security fixes in the cloud app.

- **Picks that hold up on a second run.** An eval of 20 cases or fewer now screens every candidate on every case instead of five, and a model call that fails or times out is run again before it counts, so a candidate whose call fails twice is skipped as untested instead of screened out: one slow call used to send the search the other way, and two runs of one eval picked models 3.7 times apart in price. A model now qualifies only if, case by case, it fails none of the cases the current model passed in every run, not just as many cases in total, and a switch is proposed only when it saves at least 10% per call; otherwise the result is to keep the current model. Results carry `evidence` (cases, runs, reliable cases and screen size) and each model's `regressed` cases. In Scout, the result now reads the pool the search ran on against the criteria, qualifies finalists the same way, and Configure proposes the cheapest switch that saves, not a pricier one.
- **What a run costs, next to what it saves.** `openmerit_recommend` returns an estimate before anything is measured: about how many case runs, how much (never more than the budget per job) and how many minutes. A result's pick has `paybackCalls`, the calls its saving takes to repay what the run cost, and the result, report and run page say it.
- Result notes now match the result. A graded run that switched to the eval's checks names the cases whose current-model answer you graded as not looking right (`grading.barSet`), instead of saying you marked its answers wrong; a measured provisional pick no longer claims that no cheaper model qualified; and the runs list says "costs $0.48 more per 1,000 calls" instead of "saves $-0.48".
- **The judge sees what tools returned.** For a task with tools, the judge now reads the whole run in order: what the model said, each tool call with the tool's result, then the final answer. It used to see only the final text and the calls, so an agent that correctly reported a tool's result was failed as ungrounded, and tool-using tasks ended below the floor. `openmerit_recommend`'s schema now tells the coding agent to write criteria about the final answer and the calls it needs, not about a single response.
- Fixes in Scout's eval budget: a model call that streamed without reporting usage could be counted far beyond what it can cost (one request reserved at $0.0144 was settled at $6.05); an estimate now never counts more than the call's reservation, its maximum possible cost. The proxy aborts a call to the endpoint once the eval gives up on it, instead of keeping it open for up to 10 minutes, and settles every call still open when an eval run ends, so reservations no longer pile up across budget pauses. A model named without its vendor prefix, as OpenAI's Agents SDK sends it, is now taken as the model under test instead of refused, and when the proxy refused every request, Scout says so instead of "the eval made no model requests".
- Fixes in the cloud app: a public report link no longer shows the organization's ID, and a forged one opens nothing (it used to create an account actor for any ID it named); an evaluation beyond the plan whose report to Stripe failed is now reported with the account's next job instead of never; and `openmerit_recommend` takes an `idempotency_key`, so a coding agent that retries a call after a timeout gets the job it started instead of a second paid one.
- **Steadier picks across runs of the same eval.** Screens now draw the same cases for the same eval, placed by a hash of each case's content (`openmerit/engine`'s new `stableSample`), in Scout and the cloud app, instead of new random cases each run. A candidate that misses exactly one of the five screening cases is screened once more on five other cases, since one miss in five is as likely chance as a weak model; against the criteria, a missed guardrail or step check is never retried. And the provisional pick, in the cloud the task's last measured pick, is measured whenever its list price is under the cheapest qualified model's, not only when nothing beats the current model, so a run no longer replaces a cheaper pick that still qualifies with a dearer one it happened to reach. In QA, two runs of one eval picked gemma-3-4b and then qwen3-coder-next, 2.7 times its price, because the second run screened on a case most models miss and never measured gemma-3-4b again.
- Fixes in the cloud app: a job whose start failed partway, such as in a Rivet outage, is marked failed instead of staying queued forever, where it held one of the account's concurrent jobs and made deleting its task refuse with "This task has a run in progress"; jobs left queued that way before are settled by the next start or delete. When the spend ledger cannot record a call's reservation, the step is retried instead of the run ending `baseline_failed` as if the current model never answered, and that result now says the model could not be measured or passed too few cases, rather than that it passed none. A task's Eval tab names the people who accepted, revised or wrote its eval instead of showing their Clerk user IDs.
- At app.openmerit.ai, rows where the model changed get a light green background: on Runs, each run that found a cheaper model; on Tasks, each task that switched to one.
- **The grading loop in the cloud app.** A task's first run, started by a person on cases OpenMerit wrote, now asks them to grade sampled answers after the search, as the CLI's Scout does: in their coding agent, which relays each answer and sends their grades with `openmerit_answer`, or on the run's page at app.openmerit.ai (`POST /api/runs/<job>/answers`). A disagreement writes the eval's criteria, guardrails and written cases again on OpenMerit's key, and the search runs again; agreement on every answer is the review that accepts the eval as version 1, and later runs and watch jobs reuse it unchanged without asking. Marking the current model's own answer wrong measures every model against the eval's checks and recommends the cheapest that meets them, even when it costs more, saying by how much. After three rounds without agreement the run ends `not_accepted`. Below the 80% floor, a person grades instead of the run ending, unless no written case is kept. Reports gain `grading`, and the Your data page says a graded run keeps the answers it showed, redacted.
- Members who sign in to app.openmerit.ai with GitHub can install the OpenMerit GitHub App (Contents read-only) on their account or an organization, choose repositories there, and add them, private ones included, from Coding agents without making a token. Members signed in with Google can link GitHub there. OpenMerit keeps no token for these repositories: each review uses the adding member's GitHub sign-in. Public URLs and fine-grained tokens still work, and adding or reviewing still needs an active plan.
- **Projects in the cloud app.** An organization's tasks, runs, guardrails, GitHub repositories and model endpoints belong to a project, picked with a switcher in app.openmerit.ai's sidebar; Project settings holds its repositories and endpoints. The plan, members and billing stay the organization's. Existing accounts keep everything in their default project, and a coding agent's call lands in the project whose repository it comes from, or the one `openmerit_recommend`'s `project` names.
- **Your own ChatGPT plan writes the cases.** On Account settings a member signs in to ChatGPT (Plus or Pro) and picks it to write the test cases of the runs they start, instead of OpenMerit's key. The cloud app offers no Claude sign-in: Anthropic does not let other apps offer a Claude login or hold its tokens. The judge and the candidates stay as before; when the sign-in cannot be used, the run says so and OpenMerit's key writes the cases.
- **Task evals live in the cloud: reviewed once, then accepted.** A task's first run, with your label-check answers, accepts its eval as version 1, and every later run and watch job measures on it unchanged: no label check, no new cases. The eval reopens for review only when your coding agent sends the task with a different prompt, tools or output, or when you choose **Revise eval** on the task's Eval tab. Until you accept the draft as the next version, the task shows **Needs review**, is listed in **Review evals**, and does not run or watch; a draft is saved in place, with no history of edits. Runs record the version they measured on, and the app warns when runs on different versions are not comparable. Your coding agent writes the eval to `.openmerit/evals/<task>/` with the new `openmerit_eval` tool after asking you, marked with `MANAGED.md`, and Scout runs that copy without reviewing, grading or overwriting it. Evals and task specs a repository review finds wait in **Review evals**; approving one adds the task, not run yet. Deleting a task deletes its eval, and its dialog offers **Retire** instead, which keeps it.
- **The grading loop.** After a run with an eval OpenMerit wrote, Scout shows sampled answers of the current model and the pick, each with OpenMerit's grade, and you mark each **Looks good** or **Doesn't look right**, with an optional note after a colon (`2: <why>` at the terminal). Where you disagree with the eval, the harness rewrites its criteria and guardrails from your grades and the search runs again; when you agree on every answer, the Eval is accepted and saved, versioned (`eval.json`). It is saved only then, no longer at the approval of the paid runs. A person grades: through the MCP server the coding agent asks you.
- **When your current model fails.** Marking the current model's own answer **Doesn't look right** makes the accepted Eval the bar: a model meets it when it passes every guardrail and step check on every case and each criterion on at least 90% of cases (`criteriaPassRate` per task), every model that can run the task is a candidate, and Scout recommends the cheapest that meets it even when it costs more, saying by how much per 1,000 calls. `openmerit/engine` gains `meetsCriteria`, `evaluateTask`'s `criteria` input, `criteriaSummary`, the `criteriaPassRate` guardrail and `basedOnAll`.
- "Based on" names every grader and case source that counted when a generated eval runs, such as the judge's criteria and guardrails beside the repository's eval.
- The cloud app's GitHub repository review now writes a task spec for each task it finds in the application's code (input, steps, criteria, guardrails, prompt, tools and examples), with openmerit-core's review prompt on OpenMerit's OpenRouter key (`OPENMERIT_REVIEWER_MODEL`). Connections shows each spec's checks, the calls in no spec and why, and what the review cost. A review's model calls go into the account's spend ledger as OpenMerit-paid spend, up to $2 a review, and do not count as one of the plan's evaluations. The reviewer reads the copy only through read-only tools and never runs its code.
- Reviewing GitHub repositories in the cloud app needs an active plan, as evaluations do. Without one, adding a repository and Review again refuse with "This account has no active OpenMerit plan. Subscribe at app.openmerit.ai/plan/, then try again.", and nothing is cloned. Repositories added earlier stay listed with their last review. A review does not count as one of the plan's evaluations.
- A GitHub repository's model calls at app.openmerit.ai and in `/api/repos` list only the application's code. Calls in tests, fixtures, docs and saved results are counted ("3 more in tests, fixtures or docs, not listed") and are never reviewed. Examples, scripts and demos stay listed.
- When GitHub's limit for checks without a token is used up, adding a repository at app.openmerit.ai says so and when to try again, using GitHub's reset time; a 429 used to show only "GitHub answered 429". A refused check never counted against the account's hourly reviews, and still does not.
- Scout lists only the application's model calls as tasks. Usages in tests, fixtures, docs and saved results are still counted under their model in the Choose step, but are no longer mapped, offered as the "unmapped: tests, fixtures and docs" task or moved into a task, and `reviewRepo` writes no spec from them. A repository whose model usages are all there stops at the scan.
- **Scout always writes an eval.** For each task it reviews, OpenMerit's harness reads the code and writes the task's spec: its input, steps with their tools and access, output, criteria and guardrails, with the prompt and the tools' real parameters. It then writes typical, edge and guardrail cases from that spec, each with its own tool results, which stand in for real tools. Text answers and every answer's guardrails are graded by a fixed judge, with one check per criterion and per guardrail; labels and JSON are matched against the expected answer. The repository's own eval, when the harness finds one, runs beside it on every model as extra evidence (items `repo:<id>`). When Scout writes no usable case, the repository's eval measures alone. Scout no longer asks for an eval command, or skips a task, when the repository has none. This reverses "never invents an eval".
- An eval Scout writes has a floor: when the current model passes under 80% of it, nothing is screened and the task stops, with the pass rate and up to five failed cases with the grader's reason. You then grade the current model's answers, which says whether the eval or the model is wrong. The repository's eval alone keeps its own threshold, with no floor.
- Once approved, the written Eval is saved in `.openmerit/evals/<task>/` (`bundle.json`, the spec, and `cases.json`), and later runs reuse it without reviewing again. `openmerit eval <dir>` runs it under the eval contract.
- `openmerit/ranking`'s `TaskBundle` examples take `toolResults`, and the case writer writes them for each case. `createClient` takes `retries: false` for calls that already go through a proxy that retries them.

- `openmerit/ranking`'s `TaskBundle` takes a task spec: `input`, `steps` (with each step's tools and access), `criteria` and `guardrails`. The case writer writes from it and tags each written case `typical`, `edge` or `guardrail`. The judge's rubric is now the task itself, with one check per criterion and per guardrail, instead of a line of metadata; a right label or JSON answer is also judged on the guardrails. Failed cases keep the grader's redacted one-sentence reason.
- `openmerit/engine`'s `evaluateTask` has a floor: when the current model passes under 80% of its own eval, the result is `below_floor`, nothing is screened and no model is recommended, since the eval cannot tell models apart. The CLI turns it off, because the customer's own eval keeps its threshold; its behaviour does not change.
- The cloud app's `openmerit_recommend` bundle takes the same task spec. A run whose current model falls under the floor ends with "Eval can't tell models apart", no pick and no approval question, and lists the current model's failed cases with their reasons and its pass rate per kind of case, in `openmerit_result`, `GET /api/runs/<job>` and on app.openmerit.ai's run page. A run that recommended a switch on an eval its current model barely passed, such as 29 of 60, now recommends nothing.
- The cloud app reads GitHub repositories, read-only. On app.openmerit.ai's Connections page, or with `POST /api/repos`, an admin adds a public repository by its URL, or a private one with a fine-grained token (Contents: Read-only on the repositories they choose), which is stored encrypted. Adding one checks access with GitHub's free API and says what to fix. OpenMerit then shallow-clones the default branch into a temporary directory, within a size and time limit, lists the code's model calls with openmerit-core's repository scan, and deletes the copy. It keeps where each model call is and the model it names, not the code, and never pushes or opens a pull request. Task specs from the code review come in a later change. See the cloud README's GitHub repositories section.
- `openmerit/ranking` runs every case in Pi: its clients call OpenRouter, OpenAI-compatible APIs and Anthropic through Pi's model layer, and `runCase` runs each case in Pi's agent loop, single calls and agents alike. Tools keep their parameter schemas, which Pi checks, and answer from mocked results, which a case can now set per tool (`Case.toolResults`). A task's `constraints.maxTurns` sets how many model calls one case may take, 5 by default, which replaces the fixed four tool results (`MAX_TOOL_ROUNDS` is now `DEFAULT_MAX_TURNS`). `runCase` returns every tool call in order and the Pi transcript, graders get both, and `createMeasure`'s `onCase` passes them on; the measure still keeps no output. Ledger reservations, idempotency keys, retries, timeouts and `CandidateUnavailable` are unchanged. The new `flow` grader passes an agent's case when its answer passes and no tool call was refused.
- The cloud app checks an agent's pick on its whole flow: when the bundle offers tools, the agent eval runs the task's cases again in Pi for the pick and the next cheaper qualified models, and a model that calls a tool the task does not offer, or with arguments its schema refuses, fails it.
- `flow` now depends on what was refused. A call to a tool the task does not offer still fails the case. A call whose arguments the schema refuses goes back to the model as the tool's error, and the case can pass if the model then calls that tool again correctly within `maxTurns`; `runCase`, `onCase` and graders get each refused call in `refused`. A case with no mocked result for a tool is the eval's defect: `invalidCases` lists it, `createMeasure` will not run it, and the cloud app leaves it out for every model with a notice, an `ask_agent` fix and the result's `invalidCases`.
- A mocked tool result can be a list of `{ when?, result }`, matched on the call's arguments, so a tool called once per code answers each code; the first entry without `when` is the fallback.
- The task spec's `steps` take `required` and `after` (1-based numbers of earlier steps that must come first). `flow` checks them on each case's tool calls as S1 and up, and the cloud app's `basedOn` names them beside the judge's C… and G… checks; a step with no tools is reported, not checked.

## 0.4.3 — 2026-11-23

Removes Langfuse and the cloud app's Viktor and Langfuse connections, adds the `openmerit/engine` and `openmerit/ranking` exports, and fixes from running the self-hosted flow on 29 open-source repositories that call models and from the 0.4.2 customer acceptance check.

- **Removed:** Langfuse. Setup no longer asks for a Langfuse URL and Viewer key, and `--langfuse-*` options are gone; the eval no longer gets `OPENMERIT_EXPERIMENT` or `{{experiment}}`, and reports its per-item results itself, as `{"items": [{"id", "pass"}]}` in `$OPENMERIT_RESULT` or the last JSON line of stdout. Scout no longer reads experiment scores or production metrics from Langfuse. The `openmerit/sources` export (Langfuse trace sources) is removed. A repository config's `langfuse` settings are ignored.
- **Removed:** the cloud app's Viktor and Langfuse connections, from app.openmerit.ai's Connections tab, the Tasks page, Runs, `openmerit_tasks` and `openmerit_result`, with their `/api/connections/*` routes and **Approve change**. Tasks reach the cloud app only from a coding agent, through `openmerit_recommend`.
- The cloud app records the user's decision on a result's change. `openmerit_result` tells the coding agent to ask the approval question, apply the edit if the user says yes, and send the answer back with `openmerit_answer` and `{"configure_<task>": true}` or `false`. The decision is recorded once per run, with who answered and when, and shows in `openmerit_tasks`, `openmerit_result` and on app.openmerit.ai's Tasks and run pages. An approval moves the watched task onto the pick, so its next watch run measures the pick as the current model; a decline changes nothing but the record.
- The cloud app checks its own model key before a job starts, with OpenRouter's free key lookup. When OpenRouter refuses the key, Run again in the app, `openmerit_recommend` and a task's watch are refused with "OpenMerit's model key is not working, so this evaluation did not start": nothing runs, nothing is spent and no evaluation is counted. A run whose current model could not run at all, such as when that key had expired, now reads "the run did not finish" with why and **Run again**, instead of "no switch … keep the model in use now"; a current model that ran but passed too few cases still reads "no switch".
- A run's page at app.openmerit.ai asks for the run again while the cloud app wakes after a deploy, instead of failing at once.
- `openmerit/engine` exports the evidence record and its quality rule (`mergeEvidence`, `strongest`, `basedOn`), the connector interface with its Measure and Change ports, and the approval record (`approve`, `approvalQuestion`). The CLI's repo scan and eval command, and the cloud app's agent bundle, are the first connections; both hosts' Configure edit and approval question now come from them. The CLI's behaviour does not change; its saved comparisons gain a `basedOn` list. The cloud app's `openmerit_result`, its report and `GET /api/runs/<job>` add `basedOn`, such as "Grader: the expected labels of your examples, from agent-bundle", and `approval`, the question to ask before applying the edit. A conformance test runs Scout and the cloud job on the same fixture tickets and fake models and checks they measure the same models, rank the same Top 3, ask the same question and spend the same.
- The cloud app's results say how to fix some of their notes: raise the task's budget and run again, run again, add an endpoint or review a guardrail at app.openmerit.ai, or an instruction for the coding agent. `openmerit_recommend` takes a past `job_id` instead of a bundle to run that task again, with `budget_usd` to raise its budget first, and app.openmerit.ai shows each fix as a button beside its note.
- `openmerit/engine` exports the task's result (`taskResult`), the pool rule (`eligible`), the provisional pick (`provisionalPick`) and the proposed edit (`proposeEdit`). The CLI's pool and Configure edit, and the cloud app's pool, provisional pick, result and edit, now use them. The CLI's behaviour does not change. In the cloud app, a catalogue model without a list price, or a free one, is no longer a candidate, as in the CLI; a model's note says why it did not qualify, such as "passed 64/66 vs the current model's 66/66"; and an edit keeps a literal's `provider:` prefix (`openai:gpt-4.1`).
- The CLI and the local MCP server send anonymous usage data to OpenMerit's PostHog project: one `cli_command_run` event per command and per MCP tool call, with the command or tool name, whether it succeeded, its duration, and the OpenMerit, OS, architecture and Node.js versions, under a random install ID in `~/.openmerit/telemetry.json`. Never arguments, paths, repository names, model IDs, errors or output. The first command that sends prints a notice. Turn it off with `OPENMERIT_TELEMETRY=0` or `DO_NOT_TRACK=1`; it is always off when `CI` is set. Only an installed package sends to the production project; running from source sends only to the project `OPENMERIT_POSTHOG_TOKEN` names. Sending gives up after about 1 s and never changes output or exit codes. See the README's Telemetry section.
- `openmerit/ranking`'s `createMeasure` takes `onCase`, called as each case finishes. The cloud app uses it to show a run's progress case by case at app.openmerit.ai.
- `openmerit/engine` exports `evaluateTask`, Scout's task evaluation: the current model's repeated runs, the samples, the search, the finalists' runs, the challengers and the Top 3. The CLI and the cloud app now both run it, so a task gets the same verdict from either. The CLI's behaviour does not change. The cloud app used to run each case once, take the first five cases the current model passed as samples, lead with the cheapest qualifier and run challengers on every case without a screen; it now runs every case three times (the `repeats` guardrail), draws the samples at random, and screens challengers first, as the CLI does. A run that put a model at 22/22 had put it at 21/22 in the run before.
- The cloud app's result lists near misses: models within one case per run of the current model's pass count, with their passes and cost per call.
- Scout's challengers can now list up to the current model's price when no qualifying finalist costs less per item than the current model. Challengers used to be capped at the leading finalist's list price, so when the finalists were cheap by list price but answered at length, a stronger model priced between the two was never tried, and the result offered no saving. The cap stays at the leading finalist's price whenever a qualifying finalist is already cheaper, and challengers must still be stronger than it, untried, and at most three. `openmerit/engine`'s `challengers()` takes the ceiling as `maxPrice`; the cloud app applies the same rule.
- CI no longer tests Intel Macs (macOS x64); the supported platforms list no longer includes them.
- CI no longer tests Apple silicon Macs for now; the README lists them as supported but not currently tested in CI.
- The package exports `openmerit/engine`: Scout's search over any ordered ladder, the catalogue types, a spend `Ledger` with reserve, settle and release by key, the guardrail resolver for environment, agent and task levels, the agent-eval rule and the `redact` rules. The CLI runs its search and eval budget through it; its behaviour does not change. See the README's Engine section.
- The package exports `openmerit/ranking`: the task bundle and case types, clients for OpenRouter, OpenAI-compatible APIs and Anthropic's Messages API that meter every call in the engine's `Ledger`, a case writer with an optional label check, a single-call runner that mocks tool results and replays trace cases, graders (exact match, label, JSON schema, a judge model and trace parity) and `createMeasure`. The CLI does not use it yet. See the README's Ranking section.
- Scout recognizes catalogue models as SDKs and clouds write them: `openai:gpt-4.1` and `google_genai:gemini-3.5-flash-lite` (LangChain, pydantic-ai), `azure/gpt-4o`, `models/gemini-2.5-flash`, Bedrock IDs such as `us.anthropic.claude-sonnet-4-5-20250929-v1:0`, and dated snapshots such as `claude-haiku-4-5-20251001`. Until now these were unknown, so applications written this way could not be reviewed. A Configure edit keeps the `provider:` prefix. The scan also reads Elixir, Scala, Dart, Lua, Vue, Svelte, Astro, Groovy, Gradle, Kotlin script, R, Julia, Clojure, F#, Java `.properties` and Azure Bicep files, finds models written without quotes in configuration (`default-model: gpt-4o`, `OPENAI_MODEL=gpt-4o-mini`), skips YAML and TOML files that name more than 20 models as data, as it does JSON files, and no longer takes an environment variable's name, such as `AZURE_OPENAI_CHATGPT_MODEL`, for a model.
- The model question puts models the application's own code uses first, and counts uses in tests, fixtures, recorded responses, docs and saved results apart. Ranking by every use put test and benchmark-result models first. The harness now sees the application's usages first, then examples and scripts, then tests, and catalogue models before models set at run time, and what it leaves out of tests, fixtures and docs is one "unmapped" task instead of one per file: in large repositories the production code used to fall past the first 120 usages and the task question listed dozens of unmapped test files.
- The task question also offers tasks whose model is set at run time, such as from an environment variable, after the chosen model's own tasks. They could not be chosen before. Unmapped usages are listed last, and minified JavaScript is not scanned.
- A later run reuses an approved eval even when the harness names the task differently, such as "scope guard" for "Scope guard": the mapping step asks for the saved tasks' names, and the lookup ignores case. The eval used to be looked for, and proposed for approval, again.
- A run whose selected tasks all have no eval finishes, listing each task as not reviewed with what the harness found missing and how to add an eval. It used to fail with a resume command that failed the same way.
- When the current model passes too few items to screen candidates because its answers stopped at the request's output token limit before any text, Scout says so. This happens when the endpoint has the model reason first, as OpenRouter does for `deepseek/deepseek-v4-flash`, while the application's own provider does not; Scout used to say only that the current model passed 0 items.
- The current model's runs stop as soon as fewer than five items have passed in every run so far, since a later run cannot add any and the search would stop anyway. Scout used to finish all three runs first: on one repository the current model, `openai/gpt-5`, passed none of 8 items in its first run, and the two runs after it cost $0.33 of the run's $0.50 budget.
- The harness is told that the eval must send the task's own model calls to the model under test, such as a judge task's judge calls, and that the eval command must not install dependencies. It had proposed an MT-bench eval that varied the answering model for the judge task, and a PHP eval that ran `composer install` before every run.
- `openmerit setup` and `openmerit connect` name the settings file they wrote under `OPENMERIT_HOME` when it is set, instead of always `~/.openmerit/config.json`.
- When an eval fails, the retry question and `openmerit history <run>` show the last lines it printed, such as a missing dependency, instead of only its exit code. A comparison whose current model's eval failed says to run `openmerit scout` again rather than to resume the finished run.
- From the 0.4.2 customer acceptance check: a key typed at an "input hidden" prompt, such as `openmerit connect`'s API key or setup's endpoint keys, is no longer shown on the terminal. In 0.4.2 it was echoed as you typed it, although it was stored correctly.
- Also from the 0.4.2 acceptance check: `openmerit <command> --help` prints the usage instead of "Unknown option '--help'"; and setup says when it does not register the MCP server, with the command to register by hand.
- A project in a subdirectory of its Git repository, such as one package of a monorepo, is now a project of its own (acceptance finding 2). Between the working directory and the Git root, OpenMerit uses the nearest directory with `.openmerit/config.json`, else the nearest with a project file such as `package.json`, `pyproject.toml` or `go.mod`, else the Git root. Setup saves that project's settings in its own `.openmerit/` and says it is part of a larger repository, Scout scans and sends the harness only its files, eval helpers go under its `.openmerit/evals/`, and only its changes mark a run `+dirty`. In 0.4.2 setup and Scout always used the Git root: from `playground/` they scanned the whole repository and refused the harness's eval helper in `playground/.openmerit/evals/`. A repository already set up at its root stays one project from anywhere inside it. We chose the nearest project over the Git root because it sends less code to the harness; run from the Git root to review the whole repository.
- Configure no longer edits a model setting that code Scout did not evaluate also uses (acceptance finding 7). In 0.4.2, a Yes for the playground's coding agent previewed an edit to its shared `SONNET` constant, which would have switched all five agents. A line the harness mapped to more than one task, or a module-level setting (`const NAME = …`, `NAME = …`, including an object literal around the model ID) used in more than one other place, now comes as an instruction to give the task its own setting or change the shared one by hand. We chose an instruction over a wider edit, because the other uses were never measured; a setting used once elsewhere, such as a default parameter, is still edited.
- A run paused on its budget can continue at the same budget (acceptance finding 4). The budget question offers "Keep the budget and continue", and says how much the refused request needed and for how many output tokens. Scout reserves each request at its `max_tokens` before sending it, and agent frameworks often send the model's whole limit. In 0.4.2 one Sonnet request with `max_completion_tokens: 128000` reserved $1.29 and paused a $2.50 run that had spent $0.02. Lowering the eval's limit did not help, because a resume only continued after a raise. An answer that reports no token usage, or that is cut off part-way, is now estimated from its size at list price. In 0.4.2 it stayed counted at its full reservation, which is how a finished run still listed $0.09 "reserved for 2 request(s) of unknown cost". We kept reserving the request's maximum, because that is what makes the budget a guarantee, and left the choice to continue to the user rather than shrinking reservations automatically.
- An eval that sends no model request through OpenMerit's proxy now stops its task after one run of the current model (acceptance finding 3). Such an eval did not run the model under test, and the budget cannot cap what it spends. A candidate whose run sends none is skipped as untested. The approval now says that only requests sent to `OPENAI_BASE_URL` are metered and capped, and the harness is told that every model call of the task must go there. In 0.4.2 the harness proposed an eval that ran the whole claim pipeline through the playground's own OpenRouter key, the approval still promised the budget cap, and the README's "measured as zero requests" note came only after the runs. We chose to stop after one run, because detecting this needs one run, and continuing would spend unmetered on every candidate.
- An eval that is too small to screen on is caught before spending where possible (acceptance finding 5). When the harness counts fewer than five labelled items in the eval it found, Scout asks for the eval command instead of the approval, so you can add items, give the command anyway if the count is wrong, or skip the task. An eval whose size only the run shows still stops after the current model's first run (see above). History and the comparison no longer say "screening on 5 items" for a search that stopped before screening. In 0.4.2 a four-item eval spent $0.40 on three runs of the current model before Scout said it needs five. We chose a question over a hard stop, because the harness's count can be wrong.

## 0.4.2 — 2026-11-14

The first release of the local CLI and MCP server. npm's 0.4.0 and 0.4.1 were a separate Pi-extension build and are not listed here.

- Scout now runs in the OpenMerit daemon, a background process that the CLI and the MCP server start when they need it (`openmerit daemon status` and `openmerit daemon stop` manage it). Each run is a Rivet Workflow actor in a local Rivet engine shipped in the package, listening on `127.0.0.1:6720` behind a per-start token, with data in `~/.openmerit/rivet`. A run waiting for an answer survives a daemon crash or restart. When the daemon stops answering, the client reconnects up to three times, then prints the resume command. A step cut off in the middle stops the run as interrupted, and resuming asks before running an interrupted eval again. The install grows by about 300 MB on Linux.
- A daemon that cannot start fails within seconds instead of after about six minutes of reconnects. The daemon checks its three ports before it starts and names the ones in use, with `OPENMERIT_DAEMON_PORT` and a free port to set it to; it reports an engine that exits while starting; and it no longer uses an engine that another OpenMerit home, such as another user's, runs on the same port. The CLI and MCP server treat a start failure as such, not as a lost connection, and print its reason with the resume command. On macOS, a daemon now starts again after a crash: the engine the crashed daemon left running refused the new daemon's token, and the daemon now stops that engine first, as rivetkit already did on Linux.
- The daemon's log, `~/.openmerit/daemon.log`, keeps only errors: Rivet's warnings, such as one for every unnamed SQLite transaction, are left out (`RIVET_LOG_LEVEL` brings them back). A daemon that starts moves a log larger than 5 MB to `daemon.log.1` and deletes all but the last five starts' engine logs. A daemon that freezes is now replaced: it refreshes a heartbeat every 5 s, and a client that finds the heartbeat older than 30 s kills it and starts a new one. Until now the engine, a separate process, kept answering the health check, and clients reconnected to the frozen daemon until they gave up. `openmerit daemon status` reports a frozen daemon as not running, and `openmerit daemon stop` kills it at once instead of waiting 20 s for it to exit. The CLI and MCP server no longer print Rivet's `level=warn` retry lines while they reconnect.
- Replace the `openmerit` package's commands with the single-user local CLI: `openmerit setup`, `openmerit scout`, `openmerit history` and `openmerit mcp` (a stdio MCP server with `openmerit_status`, `openmerit_scout` and `openmerit_history`). `run`, `candidates`, `status`, `login`, `pi` and the Pi extension export are removed. No OpenMerit account or hosted service.
- OpenMerit Harness runs on Pi, powered by Claude Code (through pi-claude-bridge and the machine's Claude login), Codex models (through pi's ChatGPT Plus or Pro sign-in, in a browser or with a device code on a server; without `--model`, the most capable model by ECI that the plan accepts) or an API provider and key. `openmerit connect [claude-code|codex|api]` signs in, verifies with one round trip and saves the connection, with no silent fallback; `openmerit setup` runs it. Every connection reads the repository only through pi's read-only tools, which refuse paths outside it. Setup registers the MCP server with the Claude Code and Codex CLIs on `PATH`.
- Scout scans the repository's model and endpoint usages and maps them to tasks. It no longer asks before sending code context to the harness; evals still need approval. The scan skips JSON files that name more than 20 models as data, and skips the glob patterns in the repository's `scan.exclude`. Scout's progress lines and questions are short, the task question lists each task once and takes mapping corrections as `<usage>=<task>`, the model question offers only catalogue models, OpenMerit's own `catalogue:` references in saved results are not counted as usages, a quiet step shows a spinner in the terminal, the comparison is shown before the question whether to configure its result, setup's endpoint questions are shorter, and a run starts with "Scanning codebase for models and endpoints…". After approval it runs Scout Model Binary Search with the task's existing eval over the repository's allowed, ECI-ranked models that are cheaper than the current model. The current model runs every item three times. Candidates are screened on five items it passes, five finalists and up to three challengers run every item, and the metering proxy retries a model call that times out, is rate-limited or fails with a server error three times, and candidates whose calls still fail, or that the endpoint rejects, are skipped as untested. When a search stops, the finalists it measured still show how they compared with the current model instead of all reading "below baseline". Scout shows the search path and the three cheapest finalists at least as good as the current model by measured cost per item. A Yes to configure applies only the previewed model-ID edit.
- The eval gets `OPENMERIT_ITEMS` and `OPENMERIT_EXPERIMENT`. It records each run as a Langfuse experiment with the application's own keys, and Scout reads the per-item scores back with a Viewer key using GET requests only; or the eval reports `{"items": [{"id", "pass"}]}` itself. The earlier `{"score", "samples"}` report is gone.
- A local metering proxy enforces a per-run eval budget (default $10) before each paid request, with run-only or saved-default raises. Runs, eval results, spend, approvals and configuration decisions are kept in SQLite under `~/.openmerit/`.
- The Langfuse connector is read-only: Viewer keys only, reading experiment results and aggregate metrics. The earlier dataset, experiment and score writes are removed.
- The model catalogue (OpenRouter models, Epoch ECI and ScoutBM estimates) ships in the package as `data/catalogue.json`; no catalogue is fetched at run time. Every invocation checks npm for a newer version and asks before updating.
- The harness asks once more when a reply is not a JSON object with the schema's required keys, as when a model echoes the schema's `type` and `properties` around its answer. Harness token counts include cached prompt tokens. `openmerit connect api --api-provider <provider>` without `--api-model` uses that provider's default model instead of `claude-sonnet-5-5`.
- A run that fails, such as when the harness does not reply with JSON, prints its failed step with the error and `openmerit scout --resume <run>`, and `scout --json` returns that step with `"status": "failed"`. The CLI used to print only the error. `openmerit history <run>` lists every harness a run used, in order, when `openmerit connect` switched it between steps, and records the switch as an event. Its header reads `(done)` or `(failed at discover)` instead of `(done, done)`, sections with nothing to show say so, the Budget section shows the run's budget when nothing reached or changed it, and changes under `.openmerit/` no longer mark the revision `+dirty`.
- Linux arm64 and Intel Macs are now tested: CI installs the packed package globally with an empty npm cache and runs setup, Scout, history and MCP on Linux x64 and arm64 and on macOS arm64 and x64, and the daemon crash-recovery test on Linux and Apple silicon. Both platforms worked without changes.

## 0.3.11 — 2026-11-09

- The repository moved to `github.com/openmerit-ai/openmerit-core`. Package metadata (repository, homepage and issues) and the troubleshooting guide's issue link point there. No CLI, installer or MCP behavior changes.
- Bring the bundled Scout guides up to date with hosted Scout. They describe the shortlist rules deployed on 9 November (unmeasured candidates beaten on both quality estimate and cost are left out; under the quality priority, unmeasured estimates within three points rank by cost) and the agent's requested benchmark evidence. OpenRouter decision models listed beside Vercel AI Gateway's, host route matching across version and lab spellings, and grouped Langfuse metric queries with `Retry-After` cooldowns are described as deployed on 6 November.

## 0.3.10 — 2026-11-06

- Refocus the Scout guide on supported setup, model selection, customer-owned evals and data handling. Preserve historical operator receipts in an internal archive excluded from npm, retain existing section links, remove repository-development instructions from the package README, and distinguish released Langfuse guidance from old preparation notes. This does not change model selection, credentials or permissions.
- Align the data policy's opening aggregate-results description with its existing per-user, cross-conversation connection contract. Hosted policy publication requires the separate Scout-serving deployment; npm publication alone does not update it.

## 0.3.9 — 2026-11-06

- Fix Claude Code project setup, status and conflict detection in linked git worktrees. Claude Code 2.1.63 and newer share private project MCP configuration under the main checkout; older versions use the linked worktree root. The installer follows the Claude CLI on PATH, leaves the project's skill and rule in place, and does not migrate or delete existing MCP entries.

## 0.3.8 — 2026-11-06

- The Scout skill tells coding agents to refresh an already approved Langfuse connection on the first consultation and before a final model decision, without asking for new candidate-spend or customer-platform-write approval for that read. Old project notes are not a substitute for connector refresh; failed sync must be disclosed as stale evidence. The server still requires an explicit sync request, and candidate runs, platform writes and deletion still require approval.

## 0.3.7 — 2026-11-06

- The installed Scout skill distinguishes no eval setup, insufficient evals and suitable existing evals. Langfuse is the default customer-owned platform suggestion, not a requirement; local/custom evals can report aggregates. The customer's coding agent implements evals, while OpenMerit remains Viewer-only. Instructions require a local Markdown decision record before proposing explicitly approved cleanup of newly created comparison runs; existing records and reusable fixtures/definitions stay intact. This adds guidance, not an eval runner, automatic deletion or another platform connector. Fresh-agent acceptance remains a release gate.

## 0.3.6 — 2026-11-06

- Distinguish a connected Langfuse key from incomplete score-import setup. Connection status exposes only score-mapping and model-alias counts, and the web UI explains when either is missing. The CLI preserves those counts when the server provides them. Requires the corresponding Scout deployment and npm patch; does not change credentials, mappings or experiment attribution.
- Update an existing Langfuse connection's non-secret settings through CLI, MCP or API without retrieving or re-entering its Viewer key. Omit both Viewer credentials; Scout reuses and reverifies the encrypted key internally. New connections still require a protected Viewer pair, and partial pairs are rejected. Settings changes invalidate imported aggregates; sync again afterwards. Requires the matching Scout deployment.

## 0.3.5 — 2026-11-05

- Add optional headless Langfuse setup through the CLI, HTTP API and `scout_connection` MCP tool. A separately approved `scout:connections` key manages the authenticated user's connection and evaluation data; recommendation keys retain their existing permission. Viewer credentials enter through protected CLI input or trusted client configuration, never model-visible tool arguments. The web connection UI remains available, with revised spacing, mobile controls and the official Langfuse logo. Hosted features require a matching Scout deployment; saving Langfuse credentials also requires its dedicated encryption secret. Publishing this package does not deploy or enable the hosted connector.

## 0.3.4 — 2026-11-05

- `openmerit scout --results` refuses a file with more than 50 results before sending it, instead of failing with HTTP 413; split larger reports into files of up to 50.
- Claude Code's install success message names the MCP server, startup rule and skill instead of Pi's extension.

## 0.3.3 — 2026-11-05

- Fix `openmerit install --client claude-code` exiting with `ENOENT … dist/terminal/src/updates.ts` (0.3.1 and 0.3.2). Setting up automatic Scout instruction updates copied the updater from its TypeScript source, which the package does not ship; it now copies the module that is running. The MCP server, skill and rule were already written, but automatic updates stayed off and the installer reported failure.
- `openmerit scout --help` and the installed Scout instructions describe the new optional `kind` field for reported results (`quality`, `usd` or `seconds`), so measured cost replaces Scout's estimate, and tell the agent to report each agent's own checks at the agent level because end-to-end results also measure the agents it did not swap. Terminal output shows measured cost per 1,000 agent runs or tasks. The matching Scout serving release is deployed.

## 0.3.2 — 2026-11-05

- Fix Claude Code project-scope installation for a project inside a larger git repository, such as a monorepo package. Claude Code keeps its private MCP entry under the repository root, so the installer reported "Claude Code did not save the openmerit MCP server", `status` reported it missing and a rerun clashed with it. The installer now reads the entry where Claude Code keeps it and says that the MCP server applies to the whole repository; the skill and rule stay in the project.
- Make device approvals easier to relay. The installer prints the code's expiry in UTC with the minutes left instead of an unlabelled local time. When it returns with exit code 10, the message includes the approval link and expiry, `--json` adds `approvalUrl`, `userCode` and `expiresAt`, and the installed Scout instructions tell the agent to show the link and expiry to the person approving. The matching Scout serving release extends device codes from 10 to 30 minutes.

## 0.3.1 — 2026-11-05

- `openmerit scout --conversation <id> --results <file.json>` reports aggregate results you measured with your own evals. Scout then ranks them above public benchmarks for your recommendations only. Terminal output shows each task's evaluation plan, its agent and calls per run, and marks quality that rests on measured results.
- The installed Scout instructions for Claude Code and Pi tell the agent to measure shortlisted candidates as extra runs of the project's existing evals, never a second eval, and to report aggregates only. This needs the matching hosted Scout release, whose `scout_models` tool returns `tasks[].evaluation` and accepts `results`.

## 0.3.0 — 2026-11-04

- **Breaking:** retire the standalone `openmerit eval` CLI, including `init`, `doctor`, `plan`, `run`, `watch` and `report`. Existing local evaluation files are not deleted. The hosted `/scout/api/recommend` retirement ships separately with the Scout serving Worker.
- **Breaking:** retire the local Inference Terminal. `openmerit dash` and all of its options, including `--demo`, `--json` and `--diagnostics`, are removed, along with repository indexing, request-log and activity-export import, runtime and hardware discovery, the browser interface and its opt-in terminal analytics events. Existing `.openmerit/terminal.json`, `.openmerit/inference.jsonl` and application logs are not deleted. Scout setup, `openmerit scout` and `openmerit update` are unchanged.
- Drop the terminal-only runtime dependencies (`@iarna/toml`, `@lezer/python`) and browser bundle dependencies.

## 0.2.0 — 2026-11-04

- Add `openmerit scout`, a conversation with Scout from the terminal: clarifying questions answered with `--brief` or `--skip`, then up to five models per task, cheapest first among models that reach Scout's quality bar. When you ask for the fastest or newest model, the output names that order and shows each model's time per task or release date. It uses this device's Claude Code or Pi key and limits new conversations to the endpoint IDs in `.openmerit/scout.json`.
- The installed Scout instructions for Claude Code and Pi tell the agent to relay Scout's questions to the user and to read `tasks[].models`. This needs the matching hosted Scout release, whose `scout_models` MCP tool now runs the Scout agent.
- **Breaking:** remove the `openmerit`, `openmerit/core` and `openmerit/protocol` package exports, along with the evaluation coordinator, harness protocol, Pareto conformance rules and the repository's `npm run demo` sandbox. The package keeps `openmerit/pi` and the `openmerit` command: `openmerit dash`, `openmerit scout`, Scout setup commands and `openmerit eval`.
- Remove the hosted Inference Terminal sample at `dash.openmerit.ai`, its `/demo` before/after comparison and the opt-in `?map=flow` map experiment. The local terminal, including its fictional sample (`--demo`), is unchanged.
- Remove the retired demo guides and the guides that documented only the coordinator: architecture, adapter development, Pareto specification, first trial, metrics and evidence, comparisons and swaps, automatic checks, budgets and permissions, and project files and logs.

## 0.1.12 — 2026-11-03

- Replace the obsolete Pi 0.87 evaluation adapter with native Scout support for Pi 1.5.0. Share browser device approval, private client/scope/project credentials, installer lifecycle and Scout instructions with Claude Code; keep Pi's native MCP, tools, model, permissions and session ownership intact.
- Add targeted Pi setup, status, diagnostics, login, logout and removal, preserving edited files and independent credentials. Install a self-contained automatically discovered extension; updates require an explicit installer rerun and a new session. No legacy evaluation commands, scheduler, LaunchAgent or auto-update hooks remain in the Pi adapter.
- Add the logo-first Add to Pi action below Claude Code, with copy-only setup and a clipboard-denied fallback. Scout serving and npm publication remain separate releases.
- Keep the standalone evaluation CLI and core coordinator; move the prepared demo transport out of the removed Pi adapter and declare its Pi runtime dependency explicitly.

## 0.1.11 — 2026-11-01

- Refresh packaged Scout guides and include the Saga articles maintained in Markdown.
- Recognize the Claude Code instruction updater when invoked through a symbolic link, so linked hook entry points run their update checks.
- Preserve the existing CLI, Claude Code instruction-update contract, Pi integration and public exports. Scout, Saga and homepage source changes require separate website deployments; this npm release does not publish them.

## 0.1.10 — 2026-10-26

- Add default-on Claude Code background checks for compatible Scout skill/startup-rule updates, with daily checks, 15-minute failure backoff, non-blocking failure notices with the “update openmerit” fallback, manual `openmerit update`, persistent opt-out and a natural-language update instruction.
- Verify npm package integrity and read a bounded instruction bundle without executing downloaded code. Preserve edited files, credentials, MCP configuration, privacy settings and project policy; serialize maintenance and recover interrupted instruction writes.
- Disclose setup behavior, retain other Claude hooks/settings and require a new session to reliably load updated instructions. Existing installations need a one-time installer rerun after publication; incompatible releases require a reviewed manual upgrade. Hosted Scout and npm remain separate releases.
- Enable Scout setup usage/installation diagnostics by default, honoring telemetry, DNT and account-unlink opt-outs. Terminal/evaluation analytics remain opt-in; MCP prompt-content capture remains off.

## 0.1.9 — 2026-10-24

- Add opt-in coding-agent installation milestones, component/connection diagnostics and consent-gated setup/installation correlation retained across resumed approval and upgrades. Carry browser usage and unlink choices into setup; keep standalone CLI analytics default-off and MCP prompt-content capture off.
- Add bounded installation-event retries with stable delivery IDs. Report verification and remote revocation failures even when existing local command exit semantics remain successful.
- Coordinate the independently released Scout browser/device/MCP lifecycle telemetry, correct HTTP-200 logical-error accounting, and distinguish key authorization from verified installation. These are observed events, not skipped-call detection, guaranteed delivery or downstream model-execution tracking.
- Preserve existing package exports, model-decision guidance and legal metadata. Existing installations need an installer rerun; npm publication does not deploy Scout or the main website.

## 0.1.8 — 2026-10-24

- Install an owned startup rule requiring Scout before explicit or implicit application-model choices, including pretrained/local/browser models, weight downloads and SDK defaults. Keep detailed access-policy and search instructions in the skill. These instructions are guidance, not hard enforcement.
- Upgrade unchanged skill-only installations without another device approval; include rule ownership, conflict detection, interrupted-update recovery, status, diagnostics and safe removal.
- Require a new Claude Code session after setup or upgrade; reconnecting `/mcp` alone does not reload startup instructions. Pause model selection when Scout is unavailable or lacks suitable candidates rather than falling back to a remembered model.

## 0.1.7 — 2026-10-24

- Release coding-agent device sign-in, Claude Code MCP/Scout skill installation, status, diagnostics, removal and project endpoint policy on the stable `latest` channel. Setup requires browser approval; it never requests a pasted key.
- Use `openmerit@latest` in setup and installed skill commands. Scout's independently deployed button opens a prefilled Claude Desktop Code session; the user sends the prompt.
- Promote the agent-evaluation CLI, explicit scope/budget selection and corrected accounting from the preview channel. Provider billing, native permissions and unknown costs remain separate from local reservations.
- Include automatic light/dark terminal appearance and optional, default-off CLI/terminal analytics with bounded diagnostics. Do Not Track overrides opt-in; prompts, credentials, local names and raw errors are excluded.
- Preserve existing package exports and legal metadata. The hosted Scout service and website deploy independently; npm installation does not start hourly research or execute recommended models.

## 0.1.7-preview.5 — 2026-10-17

- Update packaged Scout documentation for the independently deployed matching repair: shared evidence targeting, retrieval coverage and bounded semantic consistency checks.
- Keep earlier failed acceptance and task-execution results visible; matching checks do not establish task accuracy or globally optimal recommendations.
- Preserve the package runtime, CLI commands, exports and legal metadata. Target the `preview` channel; stable `latest` remains unchanged.

## 0.1.7-preview.4 — 2026-10-17

- Update the packaged Scout guide for the independently deployed task-relevance beta, including metadata filters, existing ambiguity responses, measured-evidence preference and bounded matching.
- Document retained execution-test failures, incomplete coverage and provisional Pareto comparisons; no improvement in exact task accuracy or globally optimal membership is claimed.
- Preserve the package runtime, CLI commands, exports and legal metadata. Publish to `preview`; stable `latest` remains unchanged.

## 0.1.7-preview.3 — 2026-10-16

- Update packaged Scout API/MCP and agent-evaluation guides for the sole `/scout/` service and current request, inventory, data-handling and reliability contracts.
- Keep the hosted hourly research and matching service separate from npm installation. Hosted publication recovery, per-source freshness, bounded Decisions retries and reduced overlapping pool reads were deployed independently.
- Exclude internal website and deployment maintenance notes from the npm artifact. Keep existing commands, exports, legal metadata and stable `latest` behavior unchanged.

## Scout semantic benchmark interpretation — hosted beta, 2026-10-15

- Replace benchmark capability/name rules and family-name regexes with hourly Decisions interpretation of source definitions and methodology.
- Cache unchanged interpretations; leave unsupported or failed scopes unclassified and preserve evidence provenance.
- Keep prompt matching local to prepared benchmark metadata, with unchanged UI, prompt/specialist calls and hourly schedule. All 24 semantic benchmark cases, 107 local/live HTTP/MCP matching cases and 546 automated checks passed. npm publication remains deferred.
- Store compressed analytics payloads as gzip bytes to avoid base64 overhead on larger evidence records; retain legacy decoding and complete-record size limits.

## Scout semantic specialist matching — hosted beta, 2026-10-15

- Replace Hugging Face domain/language keyword dictionaries and partial label overlap with Decisions compatibility checks.
- Prepare and cache specialist profiles during the hourly refresh; batch only relevant compatibility checks when a prompt arrives.
- Require all applicable domain, language and fixed-label checks to pass. Preserve unknown metrics and ordinary results if specialist checking fails.
- Keep the UI unchanged. All 107 cases passed locally and through live HTTP/MCP; 526 automated tests passed. npm remains deferred.

## Scout semantic formats and SQL interpretation — hosted beta, 2026-10-15

- Remove prompt keyword scans from strict-format and structured-data interpretation; use the existing Decisions answers, including described record layouts and non-English requests.
- Recognize read-only SQL query writing and repair without requiring schema details in the task description. Keep query source distinct from executing it, its result format, prose explanation and data modification.
- Keep uncertain format answers visible and exclude them from narrow calibration matching. Preserve response validation, general consistency checks, confidence thresholds, one interpretation request, hourly collection and the UI.
- All 91 semantic cases passed locally and through live HTTP/MCP, including the previously failing SQL request and four fresh SQL holdouts. All 511 automated tests passed. npm publication remains deferred.

## Scout category and content interpretation — hosted beta, 2026-10-15

- Recognize conversationally supplied categories without requiring a formal label list; keep subtype and individual-identity discovery open-ended.
- Require document understanding for requested written/table content, including mixed outputs, without inferring it merely from a photographed object.
- Update two existing semantic questions with unchanged confidence thresholds, UI, hourly refresh and request count. Local and live HTTP/MCP acceptance passed 43 cases; an opt-in semantic audit preserves those cases for future interpretation changes. npm publication remains deferred.

## Scout task interpretation and ambiguous matching — hosted beta, 2026-10-15

- Frame every task description as quoted data for requirement analysis, preserving supplied-label and negation semantics without prompt-specific exceptions or lower confidence thresholds.
- Keep decision-plus-prose or extraction requests on generative endpoints, reject narrow calibration for uncertain operations/outputs, and ignore weak document-layout guesses for ordinary photos.
- All 25 routing cases passed locally and through live HTTP/MCP, including the prior binary-label failure. UI, hourly refresh and the single interpretation request are unchanged. npm publication remains deferred.

## Scout identification matching — hosted beta, 2026-10-15

- Distinguish open identification from supplied-label classification within the existing interpretation call. Open or uncertain identification uses evidence-ranked generative endpoints; fixed-choice APIs and label-dependent classifiers require supplied choices.
- Require relevant visual benchmark evidence for visual requests, preserve classification label scope in calibration matching, and use ordinary output-length estimates for generated names. UI and hourly refresh are unchanged; no npm release is included.

## Scout hosted beta — 2026-10-15

- Apply shared modality, output-format, tool and operation requirements across Scout recommendation paths. Catalogue refresh now retains explicit text-output contracts and excludes mixed media output from general text candidates.
- Preserve unknown and partial token prices as `null`; keep genuine advertised zero rates distinct.
- Suppress separate specialist discovery for endpoint-scoped requests, including empty inventories.
- Honor latency priority when choosing a model's endpoint, using only timing tied to that route. UI, hourly scheduling and interpretation calls are unchanged. These four service corrections were deployed separately from npm.

## 0.1.7-preview.2 — 2026-10-15

- Ask for a $10, custom or no-fixed-cap evaluation budget after model scope; save the explicit choice, handle reservations internally, and preserve cumulative usage across reruns and budget changes. Add `eval plan --budget <USD|unlimited>` for coding agents and noninteractive setup.
- Separate native budget and environment blocks from task scores in agent evaluations; probe the Codex Linux sandbox before making model requests.
- Recover partial Claude usage, retain partial cost estimates, keep missing native pricing unknown, and preserve budget reservations independently of estimated charges. Report version 2 separates these accounting rules from earlier comparisons.

## 0.1.7-preview.1 — 2026-10-15

- Add `openmerit eval init/doctor/plan/run/watch/report`: Scout shortlists, explicit model scope, Claude Code/Codex/OpenCode adapters, fresh task attempts, local graders, balanced adaptive 3–10 repetitions, revision comparisons and cumulative budget accounting.
- Bundle project agent instructions without install-time hooks. Missing usage/cost remains unknown and partial comparisons are disclosed. Terminal/Pi behavior is unchanged.
- Use the hosted Scout HTTP/MCP `modelIds` filter to select eligible candidates before ranking. This API change was deployed separately on 15 October 2026.

## 0.1.6-preview.5 — 2026-10-10

- Open the terminal before initial collection, then index repository declarations in a background worker with visible discovery, indexing, and linking progress. Replace repository-wide scan caps with continuing work batches.
- Reuse unchanged source/configuration metadata across scans, re-resolve changed dotenv bindings, and remove deleted declarations. Keep activity collection independent and disclose skipped files or interrupted indexing.
- Reuse unchanged reference catalogs in the browser and report complete issue counts alongside the bounded detail list. Request-history and runtime inventory limits are unchanged.
- Preserve ordinary function names containing `task_` instead of mistaking their suffix for a credential prefix.

## 0.1.6-preview.4 — 2026-10-10

- Index supported application code, nested configuration, custom endpoints, and conservative model/call-site references automatically during `openmerit dash`, with file-and-line evidence.
- Separate static declarations, aliases, examples, benchmarks, candidates, fallbacks, and unresolved references from recorded inference usage. Retain custom service identities without guessing vendors or hardware.
- Add a searchable code/configuration view, coverage notes, and a counts-only `openmerit dash --diagnostics` report for troubleshooting without repository access.

## 0.1.6-preview.3 — 2026-10-10

- Expand passive project endpoint discovery to 39 service identities across model APIs, inference clouds, managed cloud endpoints, and gateways; share classification with the service inventory and preserve unknown/custom endpoint boundaries.

- Recognize project-declared Hugging Face dedicated endpoints and the inference router as separate services, without cloud calls or token-based inference assumptions.

- Detect changed JSONL checkpoints before resuming incremental reads, including same-inode truncation followed by growth between polls.
- Disclose conflicting completed/failed outcomes when reconciling copies of a request.
- Prefer fresh model residency over stale reports from other exported hosts.
- Preserve unavailable usage in model details when no request source is connected.

## 0.1.6-preview.2 — 2026-10-09

- Require selected-project declarations for service and runtime discovery; remove unconditional Ollama/standard-port probes and inherited shell service detection.
- Keep endpoint identity separate from physical placement. A loopback URL does not prove that inference runs on this machine; local compute requires explicit host links.
- Retain OpenMerit task summaries separately from request counts, models, tokens, and spend.
- Preserve unknown request status, currency, and cost basis. Missing activity evidence no longer appears as measured zero usage or failures.
- Disclose bounded inventory omissions and partial source coverage.

## 0.1.6-preview.1 — 2026-10-09

- Retain historical application requests beyond 24 hours; add 7d, 30d, and default All time with calendar labels, available-history dates, and explicit partial-coverage disclosure. Existing source/read limits still apply.

## 0.1.6-preview.0 — 2026-10-09

A test prerelease of the existing `openmerit` npm package, installed with `npm install -g openmerit@preview`. Includes the compiled Inference Terminal, automatic browser opening, and a free loopback-port fallback. `latest` remains `0.1.5`.

- Add the Inference Terminal: `openmerit dash` serves a local, read-only view of models, request metadata, connections, capacity, and compute, sampled every 10–30 seconds. Agent and task identities come from supplied metadata; the terminal does not intercept inference or discover every call automatically.
- Bind task profiles, metrics, assessments, frontier artifacts, swaps, and
  automation signals to a confirmed application LLM target; Pi's own model
  telemetry cannot satisfy application evidence or become a swap target.
- Make Pi's automatic setup conditional on bounded source detection of an
  application LLM call. Projects without a detected target remain idle until
  `/openmerit setup` is requested.

## 0.1.5 — 2026-09-23

OpenMerit now ships as one npm package with a Pi extension, a reusable
coordinator, and a harness-neutral protocol.

### Changed

- Pi issues typed, bounded work to the coding harness and checks structured
  results and durable evidence before advancing the model-improvement lifecycle.
- Project state, audit events, and evidence manifests live under `.openmerit/`
  in the product repository.
- Baseline assessment, candidate trials, frontier verification, supervised
  swaps, post-swap verification, and rollback follow a confirmed project policy.
- The package exposes `openmerit/core`, `openmerit/protocol`, and `openmerit/pi`.
- Node.js 22.19 or newer and Pi 0.87 are required for the Pi integration.

### Removed from the 0.1.4 package

- The background watcher, direct provider clients, standalone CLI, and
  session-bound route comparison flow.
- Automatic use of the earlier home-directory state. The new project-local
  state starts with a confirmed task profile and leaves older files untouched.

See [the README](README.md) for installation and the current command surface.
