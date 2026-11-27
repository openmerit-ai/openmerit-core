# OpenMerit

OpenMerit finds cheaper models that perform at least as well as the ones your code uses today, measured with an eval OpenMerit writes from a review of your code, and your repository's own evals when it has them. It is a global npm CLI and a local MCP server. It runs on your machine with no OpenMerit account, login or hosted service, and it is free. Website: **[openmerit.ai](https://openmerit.ai)**, where [OpenMerit Cloud](https://openmerit.ai/contact-sales/) also runs it for you.

- **OpenMerit Harness**, built on [Pi](https://pi.dev), does Scout's reasoning: it maps model usages to tasks and finds each task's eval and how to run it per model. Claude Code (through [pi-claude-bridge](https://pi.dev/packages/pi-claude-bridge) and your Claude login), Codex models (through a ChatGPT Plus or Pro sign-in) or an API key powers it. `openmerit connect` chooses which.
- **Scout** is the first workflow: scan → choose a model and tasks → find the eval → Scout Model Binary Search → compare → optionally configure. Tuner, for prompt optimization and fine-tuning, comes later.
- **The model catalogue** ships in the package (`data/catalogue.json`): OpenRouter's model list with list prices and capabilities, and the [Epoch Capabilities Index](https://epoch.ai/benchmarks/eci) (CC BY 4.0) with ScoutBM's estimates for models Epoch does not score. Scout never downloads a catalogue.

## Install and set up

```sh
npm install -g openmerit        # Node.js 22.19 or newer
cd your-repo
openmerit setup
```

### Supported platforms

OpenMerit needs Node.js 22.19 or newer and the local Rivet engine that runs Scout (see [Daemon](#daemon)). The engine comes as a binary per platform, installed with the package:

| Platform | Status |
| --- | --- |
| Linux x64 | Tested in CI with Node 22.19.0 on Ubuntu 26.04: a global install with an empty npm cache, then setup, Scout, history and MCP, plus a Scout run that survives the daemon being killed at every question |
| Linux arm64 | Tested in CI the same way, on Ubuntu 24.04 |
| macOS arm64 (Apple silicon) | Supported, but not currently tested in CI |
| Windows | Not supported: Rivet publishes no Windows engine, so Scout and the MCP server cannot start the daemon. WSL 2 is untested |

A global install takes about 440 MB on Linux x64, most of it the local engine (see [Limitations](#limitations)), and fills about 490 MB of an empty npm cache. Connecting Claude Code adds about 30 MB for its bridge; it uses the Claude Code you installed.

### Setup

`openmerit setup` is safe to rerun. It verifies what is saved, keeps what still works and offers a retry or reconfiguration for anything that fails. It never switches to another provider on its own.

1. **Harness (global).** Setup runs `openmerit connect` (see [Connect the harness](#connect-the-harness)).
2. **MCP (global).** When the `claude` or `codex` CLI is on your `PATH`, setup registers OpenMerit's stdio server as `openmerit` with Claude Code (user scope) and Codex, through their own `mcp add` commands. An existing `openmerit` entry is left unchanged. When neither CLI is on your `PATH`, or you decline, setup says so and prints the stdio command to register with another client.
3. **Candidate endpoints (this repository).** The default offer is OpenRouter with every OpenRouter model eligible. OpenAI and other OpenAI-compatible endpoints work too. Each endpoint has its own key and allowed models: `all`, or a list of IDs. These keys run candidate evals only, and are separate from whatever powers the harness.
4. **Eval budget.** The default is $10 per Scout run.

Settings live in two places:

| File | Holds |
| --- | --- |
| `~/.openmerit/config.json` | The harness choice |
| `~/.openmerit/agent/` | Pi's files: `auth.json` (mode 0600) with the ChatGPT sign-in, and pi-claude-bridge's config and log |
| `<repo>/.openmerit/config.json` | Endpoints, allowed models, evals, budget, scan excludes. Keys appear only as references: `{"env": "OPENROUTER_API_KEY"}` or `{"secret": "<name>"}` |
| `~/.openmerit/secrets.json` (mode 0600) | Keys you type in at the prompt |
| `~/.openmerit/state.db` | SQLite run history for every repository |
| `~/.openmerit/rivet/` | The daemon's Rivet engine data: each run's workflow and its pending question |
| `~/.openmerit/daemon.json` (mode 0600), `daemon.log` | The running daemon's pid, port and access token, and its log |
| `~/.openmerit/telemetry.json` | The random install ID [telemetry](#telemetry) sends, and when its notice was shown |

### Projects in a subdirectory

`<repo>` is the project OpenMerit works on. From a directory inside a Git repository, that is the nearest directory up to the Git root that has `.openmerit/config.json`, else the nearest with a project file (`package.json`, `pyproject.toml`, `requirements.txt`, `go.mod`, `Cargo.toml` and the like), else the Git root. So in a monorepo, `openmerit setup` and `openmerit scout` run from `packages/api/` (with its own `package.json`) keep the settings in `packages/api/.openmerit/`, scan only `packages/api/` and send the harness only its code; setup says so. Run them from the Git root to review the whole repository. The MCP tools take the same directory as `cwd`.

Set `OPENMERIT_HOME` to move `~/.openmerit`. For scripts, `openmerit help` lists flags such as `--harness codex --device-code --endpoint openrouter:OPENROUTER_API_KEY --allowed-models a,b --budget 5 --yes`.

### Commit `.openmerit/` or ignore it

Setup leaves `<repo>/.openmerit/` untracked; OpenMerit never commits or ignores it for you. It holds `config.json` and any eval helper files you approved under `.openmerit/evals/`, and never a key's value, so it is safe to commit.

- **Commit it** when your team should share the same endpoints, allowed models, evals and budget. Use `{"env": "..."}` key references in a shared file: a `{"secret": "<name>"}` reference resolves only on the machine whose `~/.openmerit/secrets.json` stored it. Expect diffs: rerunning setup rewrites each entry's `verifiedAt` time, and Scout saves each eval you approve and any budget raise you make the new default.
- **Ignore it** (add `.openmerit/` to `.gitignore`) when the settings are yours alone.

Each run records the repository revision. Uncommitted changes in the project mark it `+dirty` in `openmerit history`, except changes under `.openmerit/`, whether you commit it or not.

### Connect the harness

```sh
openmerit connect                 # keep the working connection, or choose one
openmerit connect claude-code     # Claude Code with your Claude login
openmerit connect codex           # Codex models with your ChatGPT Plus or Pro sign-in
openmerit connect codex --device-code --yes   # the same on a server without a browser
openmerit connect api --api-provider anthropic --api-model claude-sonnet-5-5 --api-key-env ANTHROPIC_API_KEY
```

`openmerit connect` signs in where needed, makes one round trip through the harness and saves the connection only when that works. A failed check keeps the previous connection. `--model <id>` picks the model for Claude Code (default `claude-sonnet-5-5`) or Codex. Which Codex models a ChatGPT account may use depends on its plan, so without `--model` `openmerit connect codex` tries them from the highest catalogue ECI down and saves the first one the plan accepts.

- **Claude Code** runs your own installed Claude Code (`claude` on your `PATH`, or the path in `OPENMERIT_CLAUDE_BIN`) through pi-claude-bridge, which `openmerit connect claude-code` installs into `~/.openmerit/claude-bridge/` (about 30 MB) on first use. OpenMerit no longer bundles a copy of Claude Code. It uses your Claude Code login in `~/.claude`; when you are not logged in, `openmerit connect claude-code` offers `claude auth login`. On a server, set `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or `ANTHROPIC_API_KEY`. Claude Code gets no tools of its own and loads no project `.claude` settings.
- **Codex** uses pi's ChatGPT Plus or Pro sign-in, the same one pi's own `/login` offers. It is a browser sign-in, or a code you enter at `auth.openai.com/codex/device` from any device with `--device-code`, which also works on a server. You do not need the Codex CLI installed. Pi keeps the tokens in `~/.openmerit/agent/auth.json` (mode 0600) and refreshes them; OpenMerit does not read the Codex CLI's own login.
- **An API key** uses any provider pi knows, with a key from an environment variable or typed in and stored in `~/.openmerit/secrets.json`.

Whichever powers it, the harness reads the repository only through pi's read-only tools (read, grep, find and ls), and they refuse any path outside the repository.

## Scout

```sh
openmerit scout                    # interactive
openmerit scout --resume <run-id>  # continue a paused, interrupted or failed run
```

In a terminal, a step that prints nothing for a few seconds, such as a long eval, shows a spinner with how long it has been quiet.

1. **Scan.** Scout reads files Git does not ignore, without changing them. It lists model and endpoint usages with file and line, marks dynamic ones (an environment variable, a variable) and redacts anything shaped like a key.
   - It recognizes catalogue models as SDKs and clouds write them: `openai:gpt-4.1` (LangChain, pydantic-ai), `azure/gpt-4o`, `models/gemini-2.5-flash`, Bedrock IDs such as `us.anthropic.claude-sonnet-4-5-20250929-v1:0`, and dated snapshots such as `claude-haiku-4-5-20251001`. In configuration files it also finds models written without quotes, such as `default-model: gpt-4o` or `OPENAI_MODEL=gpt-4o-mini`.
   - A JSON, YAML or TOML file that names more than 20 models is data, such as a model catalogue, saved results or recorded responses, and is skipped. Scout says which files it skipped.
   - To skip other files, add glob patterns relative to the project root to `.openmerit/config.json`, such as `"scan": {"exclude": ["playground/**", "scripts/old"]}`. A directory name skips everything under it.
2. **Choose.** Pick the current model from the catalogue models found. Models the application's own code uses come first; the question counts uses in tests, fixtures, recorded responses, docs and saved results (any directory whose name ends in `results`, such as `scout-results/`) separately. Those uses make no task, spec or eval, since no production task runs there: a repository whose model usages are all in them stops at the scan. Then answer *"Select which Agents/Tasks do you want OpenMerit to review?"* Each task shows a one-line description and its usages. Tasks whose model is set at run time, such as from an environment variable, follow the chosen model's own tasks: choose one when that variable names the model you picked. To fix the mapping, answer `<usage>=<task>` (such as `u12=reply drafter`) to move a usage to that task or to a new one; the question then asks again.
3. **Pool.** A candidate must be in the allowed pool, have a list price below the current model's (except against an accepted Eval's criteria, step 7), support what the task needs (tool calls, images, structured output) and have an ECI score. Scout ranks the pool by ECI. Models without an ECI are left out, and Scout says how many.
4. **Write the eval.** For each task, OpenMerit's harness reviews the code and writes the task's spec: what the call receives, its steps with the tools and access each uses, its output, its criteria (what a right answer does) and its guardrails (what it must never do), with the prompt and the tools' real parameters. From that spec it writes cases, typical, edge and guardrail ones, with the expected answer of each, as `openmerit/ranking`'s case writer does for the cloud app. Label and JSON answers are graded against the expected answer; text answers, and every answer's guardrails, by a fixed judge (`anthropic/claude-sonnet-5.5` when an endpoint may run it, else the current model), with one check per criterion and per guardrail. For a task with tools the judge reads the whole run in order, each tool call with what it returned, then the final answer. A case the judge's provider refuses to read (a content filter, as some guardrail cases trigger) cannot be graded: it is left out for every model in the run, the current one included, and history says so. Tools answer with the results each case gives them, never real ones.
   - The harness also looks for the task's existing eval and says how to run it per model and item set: the command and any variable mapping such as `CLASSIFIER_MODEL={{model}}`, with helper files only under `.openmerit/evals/`. When it finds one, that eval runs beside the generated one as extra evidence, on every model, and its items are counted as `repo:<id>`.
   - When the harness writes no usable case, the repository's eval measures alone, if it has at least five items; otherwise the task is listed as not reviewed, with why.
   - Once you accept it in the grading loop (step 7), the generated Eval is saved as `.openmerit/evals/<task>/bundle.json` (the spec), `cases.json` and `eval.json` (its version, the bar it measures against and when you accepted it), and later runs reuse it with the repository's eval beside it, without reviewing or grading again. Edit or delete those files to change it. `openmerit eval .openmerit/evals/<task>` runs it under the eval contract below. A folder with a `MANAGED.md` is a copy of the task's eval on app.openmerit.ai, which your coding agent writes when you agree, with the app's version in `eval.json`: Scout runs it as it is, never reviews, grades or writes over it, and you edit it in the app.
5. **Approve.** Scout shows the generated eval (its case counts by kind, criteria, guardrails and judge), the repository's eval command, environment, helper files (as a diff), where per-item results come from, the search's run counts, where eval data goes and the budget. Nothing runs or is written before you approve.
6. **Evaluate: Scout Model Binary Search.** The same eval command runs for every model, so inputs, prompts, tools and scoring stay identical; only the model and the items change. The policy below is `openmerit/engine`'s `evaluateTask`, which OpenMerit's cloud app runs too, so a task gets the same verdict from either; the cloud measures on its own cases instead of your eval command, runs them three times unless the `repeats` guardrail says otherwise, and records its screening items inside a workflow step.
   - The current model runs every item three times (`repeats` in the repository config). When it passes under 80% of the item runs of an eval OpenMerit wrote, the eval cannot tell models apart: nothing is screened, no model is recommended, and you grade the current model's answers next, which says whether the eval or the model is wrong. The repository's own eval alone has no floor; its threshold decides. Once fewer than five items have passed in every run so far, it stops early, since more runs cannot add any, and the search stops.
   - A screen runs a candidate on every item the current model passed in every run (against the criteria, every item), or on 20 of them drawn from a larger pool; a candidate that misses exactly one is screened once more on that item, since one miss can be chance. The draw is the same for the same eval, so its runs screen on the same items and search the same way. Against the criteria (step 7), a missed guardrail or step check is never retried.
   - An item whose model call failed or timed out, as the eval reports it, is not an answer: it runs once more before it counts. A candidate whose call fails again is skipped as untested instead of failing its screen, so one slow call cannot turn the search; the current model's second failure counts as a miss.
   - Binary search over the ECI ranking: a pass moves to weaker models, a fail to stronger ones. The weakest model that passed is the pick.
   - Neighbours of the pick are screened on the same items, nearest first and weaker first at equal distance, until there are five finalists. Once a weaker neighbour fails, only stronger ones are tried.
   - The finalists run every item three times. Then up to three challengers, stronger models at the same or a lower list price than the leading finalist, are screened, and those that pass run every item too. When no qualifying finalist costs less per item than the current model on the eval, which happens when they answer at more length, the challengers may list up to the current model's price instead: a stronger model priced in between can still cost less in use.
   - The metering proxy sends a model call that times out, is rate-limited, fails with a server error (HTTP 408, 429 or 5xx) or gets no answer again up to three times, waiting as long as `Retry-After` says (at most 30 s) or 2, 4 and 8 s. The retries are metered as one request.
   - A candidate whose calls still fail after those retries, or that the endpoint rejects outright (HTTP 400, 402, 404, 413 or 422), is skipped as untested and the search goes on without it. Any other eval failure asks before running again, listing what each failed run already spent and the last lines it printed; declining skips a candidate whose screen failed and the search goes on, reports a failed finalist as unmeasured, or stops the task when the current model's run failed.
7. **Grade.** For an eval OpenMerit wrote, Scout shows up to six answers of the current model and six of the pick (or the best finalist), failed ones first, each with its input, tool calls and OpenMerit's grade, and asks *"Does it look right?"* Answer **Looks good** or **Doesn't look right**, optionally with a note after a colon: `2: <why>` at the terminal, `bad: <why>` through the MCP server. A person grades, not a coding agent: through the MCP server the agent asks you.
   - Where you and the eval disagree (an answer it passed does not look right, or one it failed looks good), the eval is wrong: the harness rewrites its criteria and guardrails from your grades and notes, writes the cases again, and the search runs again on this new version. After three rounds that still disagree, the task stops without a recommendation.
   - When you agree on every answer, you have accepted the eval: it is saved, versioned, in `.openmerit/evals/<task>/`.
   - When you mark the current model's own answer **Doesn't look right**, the accepted Eval becomes the bar instead of the current model: every model that can run the task is a candidate whatever it costs, no floor applies, and the search runs once more. A model meets the criteria when it passes every guardrail and step check on every case, and each criterion on at least 90% of cases (`criteriaPassRate` on the task's entry in `.openmerit/config.json`). The search path in the result and `openmerit history` says its candidates are at any price. Scout then recommends the cheapest model that meets them, even when it costs more than the current one, and says so: *"Your current model fails 2 of your checks (C1, G2); the cheapest model that passes them is Y, at $0.40 more per 1,000 calls."*
8. **Compare.** A finalist qualifies when it passes at least as many item runs as the current model, fails none of the items the current model passed in every run in most of its own runs (compared item by item, so a model cannot trade a case the current model always gets right for one it misses), and meets the eval's own required pass rate; or, against the criteria, when it meets them. Qualified finalists rank cheapest first by measured eval cost per item on the same workload. Scout proposes a switch only to one that costs at least 10% less per item than the current model; a smaller saving is within what the measurement can tell apart, so the current model stays. Scout shows the search path, then the **Top 3 beside the current model** with endpoint, passes, cost per item, latency, and the eval runs behind each. Failed and unmeasured finalists are labelled and never count as success. If no screened candidate failed and every finalist matched the current model, the eval did not separate the models, and Scout asks before ranking on cost alone.
9. **Configure.** Scout asks *"Should OpenMerit configure this? Yes / No."* No leaves your application unchanged. Yes previews the narrowest edit: the task's literal model ID, when the app already calls that provider. Scout applies only the previewed lines, and only while each line is unchanged. It never edits a line that other code depends on, since Scout did not evaluate that code: a line the harness mapped to more than one task, or a module-level setting such as `const SONNET = { id: "…" }` or `MODEL = "…"` that more than one other place uses. Those come as instructions to give the task its own model setting, or to change the shared one by hand. Changing the endpoint, or a model read from an environment variable, comes as manual instructions: OpenMerit cannot change your shell's environment.

`openmerit history` lists this repository's runs, including failed, interrupted and budget-paused ones. `openmerit history <run-id>` shows one run's results, eval runs, spend, budget changes, configuration decisions (with the applied diff) and events. Each run records the repository revision, the package and catalogue versions and the harness it used. When `openmerit connect` switched the harness between steps of a run, history lists each harness in order, such as `api:openrouter/anthropic/claude-haiku-5.5 → api:openrouter/anthropic/claude-sonnet-5.5`. A run that fails, such as on a harness error, prints its error and `openmerit scout --resume <run>`, and keeps everything it finished.

### Eval contract

OpenMerit runs the eval command once per model and item set, through a metering proxy on `127.0.0.1`. The command gets these environment variables:

| Variable | Value |
| --- | --- |
| `OPENMERIT_MODEL` | The model, as the endpoint names it (`gpt-5-nano` on OpenAI, `openai/gpt-5-nano` on OpenRouter) |
| `OPENAI_BASE_URL`, `OPENAI_API_KEY` | The proxy, also as `OPENMERIT_BASE_URL` and `OPENMERIT_API_KEY` |
| `OPENMERIT_ITEMS` | Comma-separated dataset item IDs to run; empty means every item |
| `OPENMERIT_RESULT` | A file path for the result |

`{{model}}` and `{{items}}` in the command, or in a mapped variable such as `CLASSIFIER_MODEL={{model}}`, become the same values. The eval sees only the proxy's one-run token, never the endpoint key. Its other environment passes through unchanged.

The eval reports per-item results itself: it writes `{"items": [{"id": string, "pass": boolean}]}` to `$OPENMERIT_RESULT`, or prints it as the last JSON line of stdout.

A non-zero exit, or no result for a requested item, marks the run failed.

A minimal eval that reports its own results, run as `node evals/classify.mjs`. It reads labelled tickets such as `{"id": "t1", "text": "I was charged twice this month.", "queue": "billing"}` from `evals/tickets.jsonl`:

```js
import { readFileSync, writeFileSync } from "node:fs";

const only = (process.env.OPENMERIT_ITEMS ?? "").split(",").filter(Boolean);
const tickets = readFileSync("evals/tickets.jsonl", "utf8").trim().split("\n").map(line => JSON.parse(line))
  .filter(ticket => only.length === 0 || only.includes(ticket.id));

const items = [];
for (const ticket of tickets) {
  const response = await fetch(`${process.env.OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENMERIT_MODEL,
      messages: [{ role: "user", content: `Answer billing, bug or other: which queue gets this ticket?\n\n${ticket.text}` }],
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`); // exits non-zero: the run fails
  const answer = (await response.json()).choices[0].message.content.trim().toLowerCase();
  items.push({ id: ticket.id, pass: answer === ticket.queue });
}
writeFileSync(process.env.OPENMERIT_RESULT, JSON.stringify({ items }));
```

### Eval budget

- Before forwarding a request, the proxy reserves its expected cost in SQLite: prompt size and the request's maximum output at list price, or 4,096 output tokens when the request sets no maximum. A request that would pass the run's budget only because other requests are still reserved at their maximum waits for them to settle, since they usually cost far less. One that would pass it with nothing else in flight is refused before it is sent. The run then pauses and asks to raise the budget for **this run only** or **as the new default**, or to **keep the budget and continue**. The question says how much the refused request needed and for how many output tokens: agent frameworks often send the model's whole output limit (such as `max_completion_tokens: 128000`), and Scout reserves that at list price, so one such request can pause a run that has spent little. Lower the limit in the eval, then continue at the same budget; a request that still does not fit pauses again.
- Declining, or not answering, leaves the run paused. Spending is never silent, and the default never changes without that choice.
- Each settled request records the provider-reported cost (OpenRouter), or a list-price estimate from the reported tokens (OpenAI-style endpoints, marked `~`). An answer that reports no token usage, or that the connection cut off part-way, is estimated at list price from the bytes sent and the bytes the model wrote, its text, reasoning and tool-call arguments without the stream's framing (about three bytes a token),, and never counts more than its reservation, the most the request could cost.
- A model call lasts only as long as the eval's request: when the eval gives up on it (its own timeout, or it exits), the proxy aborts the call to the endpoint and settles it, and every call still open when an eval run ends is aborted and settled too. Nothing is left reserved across a budget pause.
- The proxy refuses (HTTP 403) a model the repository does not allow on that endpoint. A model named without its vendor prefix, as OpenAI's Agents SDK sends `gpt-4.1-mini` for `openai/gpt-4.1-mini`, is taken as the model under test. When the proxy refused every request an eval run sent, Scout says so and names the models the eval asked for. When it refused only some, the eval may still exit 0 with those calls as failed items: Scout records it in history and in that model's note, and in the stop message when it is the current model.
- A request cut off because OpenMerit itself stopped, such as a killed daemon, stays counted at its reservation, as in-flight spend of unknown cost.
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

`openmerit_scout` returns structured `questions` (missing input, task choice, eval approval, budget, configuration) instead of prompting. The client asks the user and calls the tool again with `answers`. A run started in the CLI can continue through MCP and the other way round. The daemon works on a run one step at a time.

## Daemon

Scout runs in a background process, the OpenMerit daemon. `openmerit scout` and `openmerit mcp` are its clients: the first one that needs it starts it, and it keeps running after they exit. `openmerit setup` and `openmerit history` do not use it.

- Each Scout run is a Rivet Workflow actor in a local Rivet engine that ships in the package. The engine listens on `127.0.0.1` only: port 6720, with the next port (6721) for its peer API and the port 10 above (6730) for metrics. `OPENMERIT_DAEMON_PORT` moves all three: `7720` uses 7720, 7721 and 7730. It makes no connections of its own outside the machine, and it accepts only requests that carry the token in `~/.openmerit/daemon.json`, which is new at every start.
- A run waiting for your answer keeps waiting when the daemon stops, crashes or the machine restarts: the next command starts the daemon again and the run continues from its question.
- When the daemon stops answering (no reply in 30 s, or the connection drops), the CLI and MCP server say the connection was lost and reconnect, starting a new daemon if needed. After three failed attempts they stop and print `openmerit scout --resume <run>`. A daemon that cannot start is not a lost connection: they stop at once with its reason, such as a port in use, and the same resume command.
- A step cut off in the middle, such as an eval in progress, stops the run as interrupted. `openmerit scout --resume <run>` continues it and asks before running an interrupted eval again; its earlier requests stay counted against the budget.
- Each step works with the directory and environment of the CLI or MCP server that sent your answers: its endpoint keys, your application's environment and `PATH`. The daemon keeps them in memory only, never on disk.
- A daemon that freezes, its process stopped or busy without a break for over 30 s, is replaced too: the daemon refreshes a heartbeat every 5 s, and a client that finds it older than 30 s stops the daemon and starts a new one. Its runs continue with `openmerit scout --resume <run>`.
- `openmerit daemon status` shows whether it runs; `openmerit daemon stop` stops it. After an update, the next command replaces a daemon of the old version.
- The daemon logs its errors to `~/.openmerit/daemon.log`. A daemon that starts moves a log larger than 5 MB to `daemon.log.1`, replacing the one there. The engine writes logs for each start to `~/.openmerit/rivet/.rivetkit/var/logs/rivet-engine/`, and the daemon deletes all but the last five starts' logs.

## Updates

Every `setup`, `scout` and `history` checks npm for a newer `openmerit`:

- In a terminal, OpenMerit asks before installing. Declining, an offline check or a failed install continues on the installed version.
- Without a terminal, OpenMerit prints the update command and continues.
- The MCP server reports updates through the client: in its initialize instructions and as a log notification.

Updating the package refreshes the bundled catalogue; history stays intact. Set `OPENMERIT_NO_UPDATE_CHECK=1` to skip the check.

## Telemetry

OpenMerit sends anonymous usage data to OpenMerit's PostHog project: one `cli_command_run` event for each command you run and each tool call to the local MCP server. The first command that sends one prints a notice to stderr; OpenMerit never asks.

- **What is sent:** the command or tool name (such as `scout` or `openmerit_status`), whether it ran in the CLI or the MCP server, whether it succeeded, how long it took, and the OpenMerit version, OS, CPU architecture and Node.js version. The ID is a random install ID kept in `~/.openmerit/telemetry.json`; it is not linked to you or to an account.
- **What never is:** arguments, answers, code, file paths, repository names, model IDs, endpoint details, keys, error messages and output.
- **Turning it off:** set `OPENMERIT_TELEMETRY=0` (or `false` or `off`) or `DO_NOT_TRACK=1`. It is always off when `CI` is set. For the MCP server, set it in the environment your client starts `openmerit mcp` in.

Sending never changes a command's output or exit code. It gives up after about 1 s, so an offline machine waits at most that long when a command ends.

## Server

`openmerit server start` runs the OpenMerit server, the same server openmerit.ai runs, on this machine for one person, in the background. It is new and separate from Scout for now: `openmerit scout` and `openmerit mcp` still use the daemon above.

- It listens on `127.0.0.1` only, on port 7330 (`--port` or `OPENMERIT_PORT`). Its local Rivet engine takes the next two ports and the port 11 above, and its metrics the port 3 above: 7330 uses 7330 to 7333 and 7341.
- It keeps its tasks, runs, ledger, token and log in `~/.openmerit/server` (`OPENMERIT_DATA_DIR`). No account, plan or Clerk sign-in; the spend caps still apply.
- It serves the web app at its own address. `start` prints a sign-in link for it, which works once, for ten minutes; `openmerit server link` prints a new one. The link opens a browser session of 30 days, which ends when the server restarts.
- Coding agents and scripts sign in with the token in `~/.openmerit/server/token`, sent as `Authorization: Bearer <token>`. The web app's Runs page shows the `claude mcp add` command with it. A critical request sent with the token, such as a higher budget, grades or a decision on a switch, waits until you confirm it in the web app: the token cannot confirm.
- `openmerit server status` shows whether it runs; `openmerit server stop` stops it. Its log is `~/.openmerit/server/server.log`.

## Uninstall

```sh
openmerit daemon stop                       # stop the background daemon first
openmerit server stop                       # and the server, if you started one
claude mcp remove --scope user openmerit    # if setup registered the MCP server with Claude Code
codex mcp remove openmerit                  # and with Codex
npm uninstall -g openmerit
rm -rf ~/.openmerit                         # or your $OPENMERIT_HOME
```

Removing `~/.openmerit` deletes the harness connection and ChatGPT sign-in, the keys you typed in, the run history of every repository, the daemon's engine store and its log. Besides the files in the [settings table](#setup), it holds SQLite's `state.db-wal` and `state.db-shm`, and `daemon.lock` while a daemon starts. Each repository keeps its own `.openmerit/`; delete it there unless you committed it. Model changes you applied in Configure stay in your code.

To free disk space without uninstalling, stop the daemon with `openmerit daemon stop`, then:

- Delete `~/.openmerit/rivet/`. The engine store takes about 130 MB even when empty, and the next command recreates it. Do this only when no run is paused or interrupted: the store holds each run's workflow and pending question. `openmerit history` lives in `state.db` and stays.
- Delete `~/.openmerit/daemon.log` and `daemon.log.1`. Together they stay under about 10 MB.

## Troubleshooting

**Scout says the daemon could not start, or that the connection to it was lost.** A common cause is another process on one of the daemon's three ports (6720, 6721 and 6730 by default). The daemon checks them before it starts, and Scout stops within seconds with the ports that are taken and a free port to use instead, for example `Port 6721 on 127.0.0.1 is already in use by another program, possibly another user's OpenMerit daemon. … Set OPENMERIT_DAEMON_PORT to another port, such as 6820.`, followed by `openmerit scout --resume <run>`. For any other cause the message quotes the daemon's error. When Scout instead says the connection was lost and it could not reconnect, the daemon's log, `~/.openmerit/daemon.log`, shows why. To find what holds the ports and move the daemon:

```sh
lsof -nP -iTCP:6720 -iTCP:6721 -iTCP:6730 -sTCP:LISTEN
export OPENMERIT_DAEMON_PORT=7720           # the daemon then uses 7720, 7721 and 7730
openmerit scout --resume <run>
```

The first client that finds no daemon starts it, so set `OPENMERIT_DAEMON_PORT` everywhere OpenMerit runs: in your shell profile, and in the environment your MCP client starts `openmerit mcp` in.

**Several users on one machine.** Each user has their own `~/.openmerit` and daemon, but every daemon defaults to port 6720, so only the first one starts; the others stop with the port message above. Give each user their own `OPENMERIT_DAEMON_PORT`, 20 apart (such as 6740, 6760) so that no two users' three ports overlap.

**A daemon that seems stuck.** `openmerit daemon status` shows whether it answers, with its version, pid and port; a frozen daemon shows as `not running`. `openmerit daemon stop` stops it, at once when it is frozen; the next command starts a new one, and interrupted runs continue with `openmerit scout --resume <run>`. A daemon of an older version, or one frozen for over 30 s, is replaced on its own.

**More detail in `daemon.log`.** The log has the daemon's errors only. To also log Rivet's warnings, stop the daemon and set `RIVET_LOG_LEVEL=warn` (or `info`) in the environment of the next command that starts it. The same setting shows the warnings of the CLI's and MCP server's own Rivet client, such as each retry while reconnecting, which they otherwise leave out. Warnings such as `SQLite transaction is unnamed` appear in successful runs too and do not mean a run failed.

**Windows.** Not supported; see [Supported platforms](#supported-platforms).

## Data handling

| Data | Where it goes |
| --- | --- |
| Redacted snippets, file names, package scripts and files the harness opens read-only | The harness provider you chose (Anthropic through Claude Code, OpenAI through your ChatGPT sign-in, or your API provider), when Scout maps usages, finds evals, reviews a task and writes its cases. Evals, which spend money, run only after you approve |
| The ChatGPT sign-in | Your machine, in `~/.openmerit/agent/auth.json` (mode 0600); pi refreshes it with OpenAI |
| Eval inputs and prompts | The candidate endpoints you configured, during approved evals only; a generated eval's cases and answers also go to its judge, on one of those endpoints |
| A generated Eval | Your repository, in `.openmerit/evals/<task>/` (its spec, cases and version), once you accept it in the grading loop |
| Sampled answers you grade | Your terminal or coding agent, redacted, and the run's local state; the Pi transcripts are discarded after grading. Where you disagree with the eval, your grades, notes and those answers go to the harness provider to rewrite the eval |
| Run history | Your machine. SQLite keeps no keys and no dataset contents. Failed eval logs keep their last lines, redacted |
| Daemon | Your machine. The Rivet engine listens on `127.0.0.1` only and keeps each run's progress and pending question under `~/.openmerit/rivet`, never keys or your environment |
| Usage data | OpenMerit's PostHog project: command and tool names, success, duration and versions, with a random install ID, unless you turn it off. See [Telemetry](#telemetry) |

## Limitations

- The scanner finds literal model IDs and common dynamic patterns. A model chosen far from where it is used may need a manual task correction.
- The harness maps at most 120 usages to tasks: the application's code first, then examples, scripts and benchmarks, and in each catalogue models before models set at run time. Usages in tests, fixtures, docs and saved results are not mapped. In a larger repository the rest are listed as unmapped, one task per application file.
- Models the bundled catalogue does not list, such as ones OpenRouter has retired, cannot be priced or placed, so Scout cannot review them.
- Eval cost is measured, and the budget enforced, only for requests that go through `OPENAI_BASE_URL`. The approval says so. An eval that sends none there, such as one that calls a provider with its own key or a deployed service, did not run the model under test either: the task stops after one run of the current model, and a candidate whose run sends none is skipped as untested. An eval that sends only some calls there is metered for those only.
- Configure edits only literal model IDs on an already-matching provider. Other changes come as instructions.
- The current model is measured on the candidate endpoint, which may serve it differently from the provider your application calls, such as with reasoning on by default. When its answers stop at the eval's token limit before any text, Scout says so; add the provider your application calls as an endpoint to measure it there.
- Measured quality is only as good as the eval: few items, or an eval every model passes, cannot separate candidates. Screens use every item the current model passes in every run, or 20 of them when it passes more, and a task needs at least five. When the harness counts fewer in the eval it found, Scout asks before running anything, so you can add items, give the command anyway if that count is wrong, or skip the task.
- The binary search assumes that a higher ECI means a model that is at least as capable on the task. It screens about log₂ of the pool size, so a cheaper model that the ranking places out of order can be missed.
- Harness inference through Claude Code or a ChatGPT sign-in is billed by your plan, so its cost is shown as tokens, not dollars.
- pi-claude-bridge drives Claude Code through the Claude Agent SDK with your subscription. Anthropic has changed its stated billing for that use before and may again.
- The local Rivet engine makes the install larger: about 300 MB on Linux and 160 MB on macOS. An empty engine store takes about 130 MB on disk.
- Stopping the daemon (or `openmerit daemon stop`) while a step runs interrupts that run; it does not continue on its own.

## Engine

`openmerit/engine` exports the parts of Scout that do not depend on the CLI, for apps that run the same search, such as OpenMerit's cloud app.

- `evaluateTask`: Scout's whole task evaluation, as step 6 and 7 describe it: the current model's repeated runs with the early stop, the samples, the search, the finalists' runs, the leader, the challengers (screened first) and the qualified Top 3, plus `nearMisses`, the models that missed the current model's score by at most one item per run. With `floor` (`EVAL_FLOOR`, 0.8, by default) it returns `below_floor` and screens nothing when the current model passes less than that share of its item runs, since the eval cannot then tell models apart; the CLI passes `floor: null`, because the customer's own eval decides with its own threshold. `kinds` maps items to their kind for `baseline.byKind`, the current model's pass rate per kind, and `floorNote` words the verdict. The caller supplies `measure`, its only side effect, and `sample`, so a replay draws the same items. The CLI and the cloud app both run it.
- The task's result and its change, built the same way for the CLI and the cloud app: `taskResult` (the baseline, every candidate with why it did or did not qualify, the Top 3, the near misses and the pick, the cheapest Top 3 model that costs less per item than the current model), `eligible` (the pool rule: a priced, non-free catalogue model cheaper than the current one that supports the task's tools, images and structured output), `provisionalPick` (the cheapest pool model the catalogue rates at least as capable as the current one, named before anything is measured) and `proposeEdit` (replaces only the string literal that names the model, keeping its quotes, a `provider:` prefix and the code around it, and gives instructions for a ref with no literal, a fallback literal or a move to another endpoint). The CLI's Configure step and the cloud app's result both use `proposeEdit`.
- Evidence and connections: `mergeEvidence` gathers what each connection knows about a task (graders, cases, priority and code refs), each piece naming the connection it came from, and `strongest` is the quality rule: the strongest grader (the customer's own eval, expected outputs, parity with recorded answers, confirmed labels, then a judge), real cases before written ones, and recorded spend before a request. `basedOn` writes the report's "Based on" lines, and `basedOnAll` names every grader and case source after the strongest, for a run in which all of them counted, as Scout's generated eval beside the repository's eval does. `meetsCriteria` and `evaluateTask`'s `criteria` measure against an accepted Eval's checks (decision 7 of the plan), and `taskResult`'s `summary` words that result. A `Connector` declares the ports it fills (`list`, `evidence`, `measure`, `change`) and whether it may write; `MeasurePort` is `evaluateTask`'s `measure` and `sample`, and `ChangePort` proposes the change for a pick. `approve` records who approved a change and when; nothing is applied by it. `approvalQuestion` is the Configure question both hosts ask. The first connections live in openmerit-core's `src/connectors/`: the repo scan (the CLI's tasks, code refs and Configure edit), the eval command (the CLI's eval as the customer's grader and Measure port) and the agent bundle (the cloud app's `openmerit_recommend` bundle). They are not package exports.
- `binarySearch`, `challengers` and `order`: Scout Model Binary Search over any ladder, ordered weakest first. `order` sorts catalogue models by ECI; a vendor's named tiers can be passed in their own order. `ladder` sets apart options without an ECI, such as fine-tunes, and `challengers` measures every one of them.
- The catalogue types, `catalogueIndex` and `requestPrice`, and the Epoch ECI parsers.
- `Ledger`: reserve a model call's expected cost, then settle it with what it cost, or release it. Each call has a key, and repeating an operation on a key changes nothing. Spend is split into OpenMerit-paid and customer-paid. `MemoryLedger` implements it for tests; the CLI's SQLite history implements it behind the eval proxy.
- `resolveGuardrails`: guardrails at the environment, agent and task levels. Constraints (allowed providers, models and endpoints, region, spend caps) can only be narrowed by a lower level; defaults (budget, repeats, pass rates, latency, watch, action policy, agent eval) can be replaced either way. It reports which level set each value, and rejects settings that would widen a constraint.
- `checkAgent`: the agent-eval rule. It checks a task's pick against the whole agent's eval, then the next finalists, then all passing switches together, keeping the largest savings that pass together.
- `redact`: the rules that replace key- and token-shaped text.

## Ranking

`openmerit/ranking` measures a candidate model on a task when OpenMerit, not the application, writes the cases and the grader, as OpenMerit's cloud app does.

- `TaskBundle` describes one task: its prompt with `{{var}}` placeholders, the tools it offers with their parameter schemas and a mocked result for each, its output (text, JSON with a schema, or one of a set of labels), examples, and in `constraints.maxTurns` the most model calls one case may take (5 by default). A task that offers tools is an agent: it can take several calls. Its optional task spec says what a review of the code found: `input` (what the call receives), `steps` (what the model does, with the tools and access of each), `criteria` (what a right answer does) and `guardrails` (what the call must never do). A step can be `required` (it must happen in every case: one of its tools is called and answers) and can list in `after` the 1-based numbers of earlier steps that must happen first, only where the order matters. A `Case` is one input with its expected answer, and `toolResults` can give it its own mocked result per tool, by name. A mocked result may be a list of `{ when?, result }` entries, matched on each call's arguments: the first entry whose `when` fields all equal the call's, else the first entry without `when`; a call no entry matches is answered with an error, as a lookup that finds nothing. A case from a trace (`origin: "trace"`) holds its recorded request as OpenAI chat messages in `input.messages`, and the recorded assistant message as `expected`.
- `createClient` calls OpenRouter, any OpenAI-compatible API, and Anthropic's Messages API, through [Pi](https://pi.dev)'s model layer (`@earendil-works/pi-ai`). For a JSON task it asks for the answer in the bundle's schema, as OpenAI's `response_format` (`json_schema`), on OpenRouter and OpenAI-compatible endpoints; Anthropic's API has no such field. Each call reserves its expected cost in a `Ledger` (from `openmerit/engine`) under a key, and settles it once with the cost the endpoint reports, such as OpenRouter's, or a list-price estimate from the reported tokens. The reservation is made once Pi has built the request and before it is sent. It retries rate limits and server errors as the eval proxy does, and only the answer it keeps is charged. Each attempt waits at most 120 s for an answer (`timeoutMs` changes it), and an attempt that gets none is not retried.
- `writeCases` puts the bundle's examples first, then has a model write more cases through a completion function the caller passes in. It drops written cases that leave a placeholder empty, give an answer the output cannot have, or repeat another case. The writer sees the task spec and gives each written case a `kind`: `typical`, `edge` (about a quarter) or `guardrail` (about a quarter, when the spec has guardrails); `caseKind` returns it, or the origin for examples and traces. With `labelCheck`, it also returns a question that asks the user to confirm the written cases' answers, in the shape `openmerit_scout`'s questions use.
- `runCase` runs one case in Pi's agent loop (`@earendil-works/pi-agent-core`), for single calls and agents alike: it fills the prompt, offers the tools, and answers each tool call with the case's mocked result for that tool, else the tool's own, never a real system. A single call is the same loop with no tools. Pi checks each call's arguments against the tool's schema. A model still calling tools at the task's `maxTurns` fails the case. It returns the final output, every tool call in order, the Pi transcript, which is the case's trace, and the calls it refused (`refused`: a tool the task does not offer, arguments the schema refuses, arguments no `when` matches, or no mocked result), each also a tool result in the transcript; it keeps none of them. `invalidCases` lists the cases the eval cannot run because one of the task's tools has no mocked result for them: that is the eval's defect, so they count for no model, and `createMeasure` refuses to measure them. A trace case is sent as its recorded messages, in one call.
- Graders: `exactMatch`, `labelMatch`, `jsonSchema` (the schema, and the fields the case expects), `judge` (a rubric graded by one fixed judge model, which also reads the tool calls), `parity` (for a trace case: the same tool calls, or the same answer) and `flow` (an agent's whole transcript: a call to a tool the task does not offer fails the case; a call the tool's schema or mocked result refused went back to the model as the tool's error, as a real API's would, and fails the case only if the model never calls that tool again successfully; every step check passes; and the answer passes another grader). The step checks, S1 and up by step number (`stepChecksFor`), are the spec's required steps and its `after` orders, checked on the tool calls that answered; a step that lists no tools cannot be checked and is reported, never failed. `checksBasedOn` names the C…, G… and S… checks for a report's "Based on". `graderFor` picks one from the bundle's output. Graders get the case's tool calls and Pi transcript. The judge's rubric defaults to the task itself (`rubricFor`: its description and input), and it answers one check per criterion and per guardrail (`checksFor`); any failed check fails the answer. When the spec has guardrails and a judge is given, a label or JSON answer that matches is also judged on the guardrails alone. A failing grade carries a one-sentence `reason`, redacted and at most 200 characters. A judge whose provider filters the case throws `Ungradable`, and `createMeasure` reports that case with `failure: "ungradable"`; `evaluateTask` leaves a measurement's `ungradable` items out for every model, including runs measured before, and lists them in `ungradable`. The judge's calls are metered in the ledger, but not counted as the candidate's cost.
- `createMeasure` returns the measure function the search takes. It returns each case's pass or fail, with the grader's reason for a failed case, the candidate's cost and its mean latency per case, never what the model answered. `onCase` gets each case's output, tool calls, refused calls and Pi transcript as it finishes, for the caller's run artifact. A candidate the endpoint refuses on every case throws `CandidateUnavailable`, so the search skips it as untested. Once one of a candidate's calls gets no answer, its remaining cases are not sent and count as not answered, so a silent model ends its measure within one timeout. Calls are keyed by job, run, endpoint, model and case, so a workflow step that replays is not charged twice.

`node scripts/spike-ranking.ts` measures one task end to end with real calls on OpenRouter and on OpenAI. It needs `OPENROUTER_API_KEY` and `OPENAI_API_KEY`, spends at most $1, and no check runs it.

## Development

```sh
npm ci
npm run check            # strict typecheck and tests (mocked endpoints and harness; no paid calls)
npm run test:fast        # the tests without the 90 s daemon crash-recovery test, while iterating
npm run build:catalogue  # maintainers: regenerate data/catalogue.json from OpenRouter and Epoch
npm run build && npm pack
```

The tests' fictional application, `test/fixtures/support-app` (in the repository, not the npm package), has a fuller eval.
