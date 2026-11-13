# OpenMerit

> **Unreleased.** This README describes the local CLI on `main`. The published npm package (`openmerit@0.4.1`) still has the earlier `run`, `candidates`, `status` and `login` commands; they are gone from this version.

OpenMerit finds cheaper models that perform at least as well as the ones your code uses today, measured with your repository's own evals. It is a global npm CLI and a local MCP server. It runs on your machine with no OpenMerit account, login or hosted service.

- **OpenMerit Harness**, built on [Pi](https://pi.dev), does Scout's reasoning: it maps model usages to tasks and finds each task's eval and how to run it per model. Claude Code or Codex powers it through their own non-interactive modes, or an API key does.
- **Scout** is the first workflow: scan → choose a model and tasks → find the eval → Scout Model Binary Search → compare → optionally configure. Tuner, for prompt optimization and fine-tuning, comes later.
- **The model catalogue** ships in the package (`data/catalogue.json`): OpenRouter's model list with list prices and capabilities, and the [Epoch Capabilities Index](https://epoch.ai/benchmarks/eci) (CC BY 4.0) with ScoutBM's estimates for models Epoch does not score. Scout never downloads a catalogue.

## Install and set up

```sh
npm install -g openmerit        # Node.js 22.19 or newer
cd your-repo
openmerit setup
```

`openmerit setup` is safe to rerun. It verifies what is saved, keeps what still works and offers a retry or reconfiguration for anything that fails. It never switches to another provider on its own.

1. **Harness (global).** Setup detects Claude Code and Codex and asks which one powers OpenMerit Harness, or takes an API provider, model and key instead. It then makes one round trip through the harness and saves the choice only when that works. OpenMerit runs `claude -p` or `codex exec` read-only, with no MCP servers and no session files. It never reads their credential files: log in with `claude auth login` or `codex login` first.
2. **MCP (global).** Setup registers OpenMerit's stdio server as `openmerit` with Claude Code (user scope) and Codex, through their own `mcp add` commands. An existing `openmerit` entry is left unchanged.
3. **Langfuse (this repository; needed when the eval records its results there).** Give a URL (Cloud or self-hosted) and a separate **Viewer** key pair. Setup refuses a key that can write. OpenMerit reads each eval run's per-item scores back from the experiment your eval records, plus aggregate production metrics: generation counts, cost and latency by model for a trace name, and score averages. It never creates datasets, experiments, traces or scores; your eval writes them with your application's own keys.
4. **Candidate endpoints (this repository).** The default offer is OpenRouter with every OpenRouter model eligible. OpenAI and other OpenAI-compatible endpoints work too. Each endpoint has its own key and allowed models: `all`, or a list of IDs. These keys run candidate evals only, and are separate from whatever powers the harness.
5. **Eval budget.** The default is $10 per Scout run.

Settings live in two places:

| File | Holds |
| --- | --- |
| `~/.openmerit/config.json` | The harness choice |
| `<repo>/.openmerit/config.json` | Endpoints, allowed models, Langfuse URL and mappings, evals, budget. Keys appear only as references: `{"env": "OPENROUTER_API_KEY"}` or `{"secret": "<name>"}` |
| `~/.openmerit/secrets.json` (mode 0600) | Keys you type in at the prompt |
| `~/.openmerit/state.db` | SQLite run history for every repository |

Set `OPENMERIT_HOME` to move `~/.openmerit`. For scripts, `openmerit setup --help` lists flags such as `--harness codex --endpoint openrouter:OPENROUTER_API_KEY --allowed-models a,b --budget 5 --yes`.

## Scout

```sh
openmerit scout                    # interactive
openmerit scout --resume <run-id>  # continue a paused, interrupted or failed run
```

1. **Scan.** Scout reads files Git does not ignore, without changing them. It lists model and endpoint usages with file and line, marks dynamic ones (an environment variable, a variable) and redacts anything shaped like a key.
2. **Disclose.** Before any code context leaves the machine, Scout names where the harness sends it and asks.
3. **Choose.** Pick the current model, review the agents/tasks the harness mapped it to (and correct them), then answer *"Select which Agents/Tasks do you want OpenMerit to review?"*
4. **Pool.** A candidate must be in the allowed pool, have a list price below the current model's, support what the task needs (tool calls, images, structured output) and have an ECI score. Scout ranks the pool by ECI. Models without an ECI are left out, and Scout says how many.
5. **Find the eval.** The harness looks for the task's existing eval and says how to run it per model and item set: the command, any variable mapping such as `CLASSIFIER_MODEL={{model}}`, and, when the eval records its results in Langfuse, the dataset and the per-item score that decides pass or fail. It may propose helper files, only under `.openmerit/evals/`. With no eval, Scout asks you for the command or lets you skip the task; it never invents an eval or labels.
6. **Approve.** Scout shows the eval command, environment, helper files (as a diff), where per-item results come from, the search's run counts, where eval data goes and the budget. Nothing runs or is written before you approve.
7. **Evaluate: Scout Model Binary Search.** The same eval command runs for every model, so inputs, prompts, tools and scoring stay identical; only the model and the items change.
   - The current model runs every item three times (`repeats` in the repository config).
   - Scout draws five items the current model passed in every run. Each screen runs a candidate on those five items. A candidate passes a screen only when it passes all five.
   - Binary search over the ECI ranking: a pass moves to weaker models, a fail to stronger ones. The weakest model that passed is the pick.
   - Neighbours of the pick are screened on the same items, nearest first and weaker first at equal distance, until there are five finalists. Once a weaker neighbour fails, only stronger ones are tried.
   - The finalists run every item three times. Then up to three challengers, stronger models at the same or a lower list price than the leading finalist, are screened, and those that pass run every item too.
   - A model the endpoint rejects outright (HTTP 400, 402, 404, 413 or 422) is skipped as untested and the search goes on without it. Any other failure asks before running again; declining stops that task's search, or reports a failed finalist as unmeasured.
8. **Compare.** A finalist qualifies when it passes at least as many item runs as the current model and meets the eval's own required pass rate. Qualified finalists rank cheapest first by measured eval cost per item on the same workload. Scout shows the search path, then the **Top 3 beside the current model** with endpoint, passes, cost per item, latency, and the eval runs and Langfuse experiments behind each. Failed and unmeasured finalists are labelled and never count as success. If no screened candidate failed and every finalist matched the current model, the eval did not separate the models, and Scout asks before ranking on cost alone.
9. **Configure.** Scout asks *"Should OpenMerit configure this? Yes / No."* No leaves your application unchanged. Yes previews the narrowest edit: the task's literal model ID, when the app already calls that provider. Scout applies only the previewed lines, and only while each line is unchanged. Changing the endpoint, or a model read from an environment variable, comes as manual instructions: OpenMerit cannot change your shell's environment.

`openmerit history` lists this repository's runs, including failed, interrupted and budget-paused ones. `openmerit history <run-id>` shows one run's results, eval runs, spend, budget changes, configuration decisions (with the applied diff) and events. Each run records the repository revision and the package and catalogue versions it used.

### Eval contract

OpenMerit runs the eval command once per model and item set, through a metering proxy on `127.0.0.1`. The command gets these environment variables:

| Variable | Value |
| --- | --- |
| `OPENMERIT_MODEL` | The model, as the endpoint names it (`gpt-5-nano` on OpenAI, `openai/gpt-5-nano` on OpenRouter) |
| `OPENAI_BASE_URL`, `OPENAI_API_KEY` | The proxy, also as `OPENMERIT_BASE_URL` and `OPENMERIT_API_KEY` |
| `OPENMERIT_ITEMS` | Comma-separated dataset item IDs to run; empty means every item |
| `OPENMERIT_EXPERIMENT` | A fresh name for this run's Langfuse experiment (dataset run) |
| `OPENMERIT_RESULT` | A file path for the result |

`{{model}}`, `{{items}}` and `{{experiment}}` in the command, or in a mapped variable such as `CLASSIFIER_MODEL={{model}}`, become the same values. The eval sees only the proxy's one-run token, never the endpoint key. Its other environment, including your application's `LANGFUSE_*` keys, passes through unchanged.

Per-item results come one of two ways:

- **Langfuse.** The eval records the run as a Langfuse experiment named `$OPENMERIT_EXPERIMENT` on the configured dataset, with a per-item score, using your application's own keys. OpenMerit reads the experiment back with the Viewer key, using GET requests only, and waits for Langfuse to ingest every requested item (up to five minutes). An item passes when its score is boolean true or 1, or at least the configured minimum. An item without the score never counts as a pass: the run fails and asks before running again. The experiment must be a Langfuse v4 experiment, as the Langfuse SDKs' experiment runners record it, or OTLP spans with `langfuse.experiment.*` attributes like the fixture's eval. Legacy dataset runs (`POST /api/public/dataset-run-items`) are not read: Langfuse Cloud removes them on 16 November 2026, and organizations created since 16 September 2026 never had them.
- **The eval's own report.** The eval writes `{"items": [{"id": string, "pass": boolean}]}` to `$OPENMERIT_RESULT`, or prints it as the last JSON line of stdout.

A non-zero exit, or no result for a requested item, marks the run failed. The test fixture `test/fixtures/support-app` is a minimal example of both.

### Eval budget

- Before forwarding a request, the proxy reserves its expected cost in SQLite: prompt size and the request's maximum output at list price, or 4,096 output tokens when the request sets no maximum. A request that would pass the run's budget is refused before it is sent. The run then pauses and asks to raise the budget for **this run only** or **as the new default**.
- Declining, or not answering, leaves the run paused. Spending is never silent, and the default never changes without that choice.
- Each settled request records the provider-reported cost (OpenRouter), or a list-price estimate from the reported tokens (OpenAI-style endpoints, marked `~`).
- A request cut off by an interruption stays counted at its reservation, as in-flight spend of unknown cost.
- Usage, budget changes and approvals survive restarts. A finished eval run is never repeated. Failed or interrupted runs are repeated only after you approve it, with their earlier cost shown.
- After a budget raise, a paused eval run starts again from its beginning, because an eval command cannot resume halfway. The question says so.
- This is OpenMerit's ledger, not a cap your provider enforces.
- Harness inference is reported separately and does not count against the eval budget.

## MCP

`openmerit mcp` is a stdio MCP server; setup registers it for you. Its stdout carries only protocol messages. Its tools are:

| Tool | Hint | Does |
| --- | --- | --- |
| `openmerit_status` | read-only | Setup state, package and catalogue versions, available updates |
| `openmerit_scout` | not read-only | The same workflow and state as the CLI |
| `openmerit_history` | read-only | Runs, or one run in detail |

`openmerit_scout` returns structured `questions` (missing input, disclosure, eval approval, budget, configuration) instead of prompting. The client asks the user and calls the tool again with `answers`. A run started in the CLI can continue through MCP and the other way round. One process works on a run at a time.

## Updates

Every `setup`, `scout` and `history` checks npm for a newer `openmerit`:

- In a terminal, OpenMerit asks before installing. Declining, an offline check or a failed install continues on the installed version.
- Without a terminal, OpenMerit prints the update command and continues.
- The MCP server reports updates through the client: in its initialize instructions and as a log notification.

Updating the package refreshes the bundled catalogue; history stays intact. Set `OPENMERIT_NO_UPDATE_CHECK=1` to skip the check.

## Data handling

| Data | Where it goes |
| --- | --- |
| Redacted snippets, file names, package scripts and files the harness opens read-only | The harness provider you chose (Anthropic, OpenAI or your API provider), after you approve |
| Eval inputs and prompts | The candidate endpoints you configured, during approved evals only |
| Langfuse | OpenMerit reads per-item scores of the experiments your eval records, and aggregates, with a Viewer key. It never writes; your eval writes with your application's keys, as it does without OpenMerit |
| Run history | Your machine. SQLite keeps no keys and no dataset contents. Failed eval logs keep their last lines, redacted |

## Limitations

- The scanner finds literal model IDs and common dynamic patterns. A model chosen far from where it is used may need a manual task correction.
- Eval cost is measured only for requests that go through `OPENAI_BASE_URL`. An eval that calls providers directly is measured as zero requests, and Scout says so.
- Configure edits only literal model IDs on an already-matching provider. Other changes come as instructions.
- Measured quality is only as good as the eval: few items, or an eval every model passes, cannot separate candidates. Screens use five items the current model passes in every run, so a task needs at least five.
- The binary search assumes that a higher ECI means a model that is at least as capable on the task. It screens about log₂ of the pool size, so a cheaper model that the ranking places out of order can be missed.
- Harness inference through Claude Code or Codex is billed by your plan, so its cost is shown as tokens, not dollars.

## Development

```sh
npm ci
npm run check            # strict typecheck and tests (mocked endpoints and harness; no paid calls)
npm run build:catalogue  # maintainers: regenerate data/catalogue.json from OpenRouter and Epoch
npm run build && npm pack
```
