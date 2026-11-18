# OpenMerit

OpenMerit finds cheaper models that perform at least as well as the ones your code uses today, measured with your repository's own evals. It is a global npm CLI and a local MCP server. It runs on your machine with no OpenMerit account, login or hosted service.

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
| macOS arm64 (Apple silicon) | Tested in CI the same way, on macOS 26. The daemon also starts with Node 26 |
| Windows | Not supported: Rivet publishes no Windows engine, so Scout and the MCP server cannot start the daemon. WSL 2 is untested |

A global install takes about 790 MB on Linux x64, 770 MB on Linux arm64 and 660 MB on Apple silicon, most of it the engine and the bundled Claude Code (see [Limitations](#limitations)). An install with an empty npm cache downloads 610 to 660 MB.

### Setup

`openmerit setup` is safe to rerun. It verifies what is saved, keeps what still works and offers a retry or reconfiguration for anything that fails. It never switches to another provider on its own.

1. **Harness (global).** Setup runs `openmerit connect` (see [Connect the harness](#connect-the-harness)).
2. **MCP (global).** When the `claude` or `codex` CLI is on your `PATH`, setup registers OpenMerit's stdio server as `openmerit` with Claude Code (user scope) and Codex, through their own `mcp add` commands. An existing `openmerit` entry is left unchanged. When neither CLI is on your `PATH`, or you decline, setup says so and prints the stdio command to register with another client.
3. **Langfuse (this repository; needed when the eval records its results there).** Give a URL (Cloud or self-hosted; the default is your application's `LANGFUSE_BASE_URL` or `LANGFUSE_HOST` when set) and a separate **Viewer** key pair. Setup refuses a key that can write. OpenMerit reads each eval run's per-item scores back from the experiment your eval records, plus aggregate production metrics: generation counts, cost and latency by model for a trace name, and score averages. It never creates datasets, experiments, traces or scores; your eval writes them with your application's own keys.
4. **Candidate endpoints (this repository).** The default offer is OpenRouter with every OpenRouter model eligible. OpenAI and other OpenAI-compatible endpoints work too. Each endpoint has its own key and allowed models: `all`, or a list of IDs. These keys run candidate evals only, and are separate from whatever powers the harness.
5. **Eval budget.** The default is $10 per Scout run.

Settings live in two places:

| File | Holds |
| --- | --- |
| `~/.openmerit/config.json` | The harness choice |
| `~/.openmerit/agent/` | Pi's files: `auth.json` (mode 0600) with the ChatGPT sign-in, and pi-claude-bridge's config and log |
| `<repo>/.openmerit/config.json` | Endpoints, allowed models, Langfuse URL and mappings, evals, budget, scan excludes. Keys appear only as references: `{"env": "OPENROUTER_API_KEY"}` or `{"secret": "<name>"}` |
| `~/.openmerit/secrets.json` (mode 0600) | Keys you type in at the prompt |
| `~/.openmerit/state.db` | SQLite run history for every repository |
| `~/.openmerit/rivet/` | The daemon's Rivet engine data: each run's workflow and its pending question |
| `~/.openmerit/daemon.json` (mode 0600), `daemon.log` | The running daemon's pid, port and access token, and its log |

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

- **Claude Code** runs through pi-claude-bridge with the Claude Agent SDK's bundled Claude Code, so you do not need Claude Code installed. It uses your Claude Code login in `~/.claude`; when you are not logged in, `openmerit connect claude-code` offers `claude auth login`. On a server, set `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or `ANTHROPIC_API_KEY`. Claude Code gets no tools of its own and loads no project `.claude` settings.
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
2. **Choose.** Pick the current model from the catalogue models found. Models the application's own code uses come first; the question counts uses in tests, fixtures, recorded responses, docs and saved results separately. Then answer *"Select which Agents/Tasks do you want OpenMerit to review?"* Each task shows a one-line description and its usages. Tasks whose model is set at run time, such as from an environment variable, follow the chosen model's own tasks: choose one when that variable names the model you picked. To fix the mapping, answer `<usage>=<task>` (such as `u12=reply drafter`) to move a usage to that task or to a new one; the question then asks again.
3. **Pool.** A candidate must be in the allowed pool, have a list price below the current model's, support what the task needs (tool calls, images, structured output) and have an ECI score. Scout ranks the pool by ECI. Models without an ECI are left out, and Scout says how many.
4. **Find the eval.** The harness looks for the task's existing eval and says how to run it per model and item set: the command, any variable mapping such as `CLASSIFIER_MODEL={{model}}`, and, when the eval records its results in Langfuse, the dataset and the per-item score that decides pass or fail. It may propose helper files, only under `.openmerit/evals/`. With no eval, Scout asks you for the command or lets you skip the task; it never invents an eval or labels. A run whose tasks were all skipped finishes, listing each as not reviewed with what is missing.
5. **Approve.** Scout shows the eval command, environment, helper files (as a diff), where per-item results come from, the search's run counts, where eval data goes and the budget. Nothing runs or is written before you approve.
6. **Evaluate: Scout Model Binary Search.** The same eval command runs for every model, so inputs, prompts, tools and scoring stay identical; only the model and the items change.
   - The current model runs every item three times (`repeats` in the repository config). Once fewer than five items have passed in every run so far, it stops early, since more runs cannot add any, and the search stops.
   - Scout draws five items the current model passed in every run. Each screen runs a candidate on those five items. A candidate passes a screen only when it passes all five.
   - Binary search over the ECI ranking: a pass moves to weaker models, a fail to stronger ones. The weakest model that passed is the pick.
   - Neighbours of the pick are screened on the same items, nearest first and weaker first at equal distance, until there are five finalists. Once a weaker neighbour fails, only stronger ones are tried.
   - The finalists run every item three times. Then up to three challengers, stronger models at the same or a lower list price than the leading finalist, are screened, and those that pass run every item too.
   - The metering proxy sends a model call that times out, is rate-limited, fails with a server error (HTTP 408, 429 or 5xx) or gets no answer again up to three times, waiting as long as `Retry-After` says (at most 30 s) or 2, 4 and 8 s. The retries are metered as one request.
   - A candidate whose calls still fail after those retries, or that the endpoint rejects outright (HTTP 400, 402, 404, 413 or 422), is skipped as untested and the search goes on without it. Any other eval failure asks before running again, listing what each failed run already spent and the last lines it printed; declining stops that task's search, or reports a failed finalist as unmeasured.
7. **Compare.** A finalist qualifies when it passes at least as many item runs as the current model and meets the eval's own required pass rate. Qualified finalists rank cheapest first by measured eval cost per item on the same workload. Scout shows the search path, then the **Top 3 beside the current model** with endpoint, passes, cost per item, latency, and the eval runs and Langfuse experiments behind each. Failed and unmeasured finalists are labelled and never count as success. If no screened candidate failed and every finalist matched the current model, the eval did not separate the models, and Scout asks before ranking on cost alone.
8. **Configure.** Scout asks *"Should OpenMerit configure this? Yes / No."* No leaves your application unchanged. Yes previews the narrowest edit: the task's literal model ID, when the app already calls that provider. Scout applies only the previewed lines, and only while each line is unchanged. It never edits a line that other code depends on, since Scout did not evaluate that code: a line the harness mapped to more than one task, or a module-level setting such as `const SONNET = { id: "…" }` or `MODEL = "…"` that more than one other place uses. Those come as instructions to give the task its own model setting, or to change the shared one by hand. Changing the endpoint, or a model read from an environment variable, comes as manual instructions: OpenMerit cannot change your shell's environment.

`openmerit history` lists this repository's runs, including failed, interrupted and budget-paused ones. `openmerit history <run-id>` shows one run's results, eval runs, spend, budget changes, configuration decisions (with the applied diff) and events. Each run records the repository revision, the package and catalogue versions and the harness it used. When `openmerit connect` switched the harness between steps of a run, history lists each harness in order, such as `api:openrouter/anthropic/claude-haiku-5.5 → api:openrouter/anthropic/claude-sonnet-5.5`. A run that fails, such as on a harness error, prints its error and `openmerit scout --resume <run>`, and keeps everything it finished.

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

- **Langfuse.** The eval records the run as a Langfuse experiment named `$OPENMERIT_EXPERIMENT` on the configured dataset, with a per-item score, using your application's own keys. OpenMerit reads the experiment back with the Viewer key, using GET requests only, and waits for Langfuse to ingest every requested item (up to five minutes). An item passes when its score is boolean true or 1, or at least the configured minimum. An item without the score never counts as a pass: the run fails and asks before running again. The experiment must be a Langfuse v4 experiment, as the Langfuse SDKs' experiment runners record it, or the OTLP spans with `langfuse.experiment.*` attributes that those runners send. Legacy dataset runs (`POST /api/public/dataset-run-items`) are not read: Langfuse Cloud removes them on 16 November 2026, and organizations created since 16 September 2026 never had them.
- **The eval's own report.** The eval writes `{"items": [{"id": string, "pass": boolean}]}` to `$OPENMERIT_RESULT`, or prints it as the last JSON line of stdout.

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

- Before forwarding a request, the proxy reserves its expected cost in SQLite: prompt size and the request's maximum output at list price, or 4,096 output tokens when the request sets no maximum. A request that would pass the run's budget is refused before it is sent. The run then pauses and asks to raise the budget for **this run only** or **as the new default**, or to **keep the budget and continue**. The question says how much the refused request needed and for how many output tokens: agent frameworks often send the model's whole output limit (such as `max_completion_tokens: 128000`), and Scout reserves that at list price, so one such request can pause a run that has spent little. Lower the limit in the eval, then continue at the same budget; a request that still does not fit pauses again.
- Declining, or not answering, leaves the run paused. Spending is never silent, and the default never changes without that choice.
- Each settled request records the provider-reported cost (OpenRouter), or a list-price estimate from the reported tokens (OpenAI-style endpoints, marked `~`). An answer that reports no token usage, or that the connection cut off part-way, is estimated from the bytes sent and received at list price (about three bytes a token), not counted at its maximum.
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
- Each step works with the directory and environment of the CLI or MCP server that sent your answers: its endpoint keys, your application's `LANGFUSE_*` keys and `PATH`. The daemon keeps them in memory only, never on disk.
- A daemon that freezes, its process stopped or busy without a break for over 30 s, is replaced too: the daemon refreshes a heartbeat every 5 s, and a client that finds it older than 30 s stops the daemon and starts a new one. Its runs continue with `openmerit scout --resume <run>`.
- `openmerit daemon status` shows whether it runs; `openmerit daemon stop` stops it. After an update, the next command replaces a daemon of the old version.
- The daemon logs its errors to `~/.openmerit/daemon.log`. A daemon that starts moves a log larger than 5 MB to `daemon.log.1`, replacing the one there. The engine writes logs for each start to `~/.openmerit/rivet/.rivetkit/var/logs/rivet-engine/`, and the daemon deletes all but the last five starts' logs.

## Updates

Every `setup`, `scout` and `history` checks npm for a newer `openmerit`:

- In a terminal, OpenMerit asks before installing. Declining, an offline check or a failed install continues on the installed version.
- Without a terminal, OpenMerit prints the update command and continues.
- The MCP server reports updates through the client: in its initialize instructions and as a log notification.

Updating the package refreshes the bundled catalogue; history stays intact. Set `OPENMERIT_NO_UPDATE_CHECK=1` to skip the check.

## Uninstall

```sh
openmerit daemon stop                       # stop the background daemon first
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
| Redacted snippets, file names, package scripts and files the harness opens read-only | The harness provider you chose (Anthropic through Claude Code, OpenAI through your ChatGPT sign-in, or your API provider), when Scout maps usages and finds evals. Evals, which spend money, run only after you approve |
| The ChatGPT sign-in | Your machine, in `~/.openmerit/agent/auth.json` (mode 0600); pi refreshes it with OpenAI |
| Eval inputs and prompts | The candidate endpoints you configured, during approved evals only |
| Langfuse | OpenMerit reads per-item scores of the experiments your eval records, and aggregates, with a Viewer key. It never writes; your eval writes with your application's keys, as it does without OpenMerit |
| Langfuse generations, through [trace sources](#trace-sources) | Read with GET requests into the process that calls `replay()`, which returns them redacted and stores nothing. `tasks()` reads aggregates only |
| Run history | Your machine. SQLite keeps no keys and no dataset contents. Failed eval logs keep their last lines, redacted |
| Daemon | Your machine. The Rivet engine listens on `127.0.0.1` only and keeps each run's progress and pending question under `~/.openmerit/rivet`, never keys or your environment |

## Limitations

- The scanner finds literal model IDs and common dynamic patterns. A model chosen far from where it is used may need a manual task correction.
- The harness maps at most 120 usages to tasks: the application's code first, then examples, scripts and benchmarks, then tests, fixtures and docs, and in each catalogue models before models set at run time. In a larger repository the rest are listed as unmapped: one task per application file, and one for all tests, fixtures and docs.
- Models the bundled catalogue does not list, such as ones OpenRouter has retired, cannot be priced or placed, so Scout cannot review them.
- Eval cost is measured, and the budget enforced, only for requests that go through `OPENAI_BASE_URL`. The approval says so. An eval that sends none there, such as one that calls a provider with its own key or a deployed service, did not run the model under test either: the task stops after one run of the current model, and a candidate whose run sends none is skipped as untested. An eval that sends only some calls there is metered for those only.
- Configure edits only literal model IDs on an already-matching provider. Other changes come as instructions.
- The current model is measured on the candidate endpoint, which may serve it differently from the provider your application calls, such as with reasoning on by default. When its answers stop at the eval's token limit before any text, Scout says so; add the provider your application calls as an endpoint to measure it there.
- Measured quality is only as good as the eval: few items, or an eval every model passes, cannot separate candidates. Screens use five items the current model passes in every run, so a task needs at least five. When the harness counts fewer in the eval it found, Scout asks before running anything, so you can add items, give the command anyway if that count is wrong, or skip the task. A Langfuse dataset with fewer than five items stops the task before any run.
- The binary search assumes that a higher ECI means a model that is at least as capable on the task. It screens about log₂ of the pool size, so a cheaper model that the ranking places out of order can be missed.
- Harness inference through Claude Code or a ChatGPT sign-in is billed by your plan, so its cost is shown as tokens, not dollars.
- pi-claude-bridge drives Claude Code through the Claude Agent SDK with your subscription. Anthropic has changed its stated billing for that use before and may again.
- The install is larger with the bridge: the Claude Agent SDK's bundled Claude Code is about 330 MB on Linux.
- The local Rivet engine makes the install larger: about 300 MB on Linux and 160 MB on macOS. An empty engine store takes about 130 MB on disk.
- Stopping the daemon (or `openmerit daemon stop`) while a step runs interrupts that run; it does not continue on its own.

## Engine

`openmerit/engine` exports the parts of Scout that do not depend on the CLI, for apps that run the same search, such as OpenMerit's cloud app. Not yet in a released version.

- `binarySearch`, `challengers` and `order`: Scout Model Binary Search over any ladder, ordered weakest first. `order` sorts catalogue models by ECI; a vendor's named tiers can be passed in their own order. `ladder` sets apart options without an ECI, such as fine-tunes, and `challengers` measures every one of them.
- The catalogue types, `catalogueIndex` and `requestPrice`, and the Epoch ECI parsers.
- `Ledger`: reserve a model call's expected cost, then settle it with what it cost, or release it. Each call has a key, and repeating an operation on a key changes nothing. Spend is split into OpenMerit-paid and customer-paid. `MemoryLedger` implements it for tests; the CLI's SQLite history implements it behind the eval proxy.
- `resolveGuardrails`: guardrails at the environment, agent and task levels. Constraints (allowed providers, models and endpoints, region, spend caps) can only be narrowed by a lower level; defaults (budget, repeats, pass rates, latency, watch, action policy, agent eval) can be replaced either way. It reports which level set each value, and rejects settings that would widen a constraint.
- `checkAgent`: the agent-eval rule. It checks a task's pick against the whole agent's eval, then the next finalists, then all passing switches together, keeping the largest savings that pass together.
- `redact`: the rules that replace key- and token-shaped text.

## Ranking

`openmerit/ranking` measures a candidate model on a task when OpenMerit, not the application, writes the cases and the grader, as OpenMerit's cloud app does. Not yet in a released version.

- `TaskBundle` describes one model call: its prompt with `{{var}}` placeholders, the tools it offers with a mocked result for each, its output (text, JSON with a schema, or one of a set of labels) and examples. A `Case` is one input with its expected answer. A case from a trace (`origin: "trace"`) holds its recorded request as OpenAI chat messages in `input.messages`, and the recorded assistant message as `expected`.
- `createClient` calls OpenRouter, any OpenAI-compatible API, and Anthropic's Messages API. Each call reserves its expected cost in a `Ledger` (from `openmerit/engine`) under a key, and settles it once with OpenRouter's reported cost, or a list-price estimate from the reported tokens. It retries timeouts, rate limits and server errors as the eval proxy does, and only the answer it keeps is charged.
- `writeCases` puts the bundle's examples first, then has a model write more cases through a completion function the caller passes in. It drops written cases that leave a placeholder empty, give an answer the output cannot have, or repeat another case. With `labelCheck`, it also returns a question that asks the user to confirm the written cases' answers, in the shape `openmerit_scout`'s questions use.
- `runCase` fills the prompt, offers the tools and answers each tool call with the tool's mocked result. A model still calling tools after four results fails the case. A trace case is sent as its recorded messages, in one call.
- Graders: `exactMatch`, `labelMatch`, `jsonSchema` (the schema, and the fields the case expects), `judge` (a rubric graded by one fixed judge model) and `parity` (for a trace case: the same tool calls, or the same answer). `graderFor` picks one from the bundle's output. The judge's calls are metered in the ledger, but not counted as the candidate's cost.
- `createMeasure` returns the measure function the search takes. It returns each case's pass or fail, the candidate's cost and its mean latency per case, never what the model answered. A candidate the endpoint refuses on every case throws `CandidateUnavailable`, so the search skips it as untested. Calls are keyed by job, run, endpoint, model and case, so a workflow step that replays is not charged twice.

`node scripts/spike-ranking.ts` measures one task end to end with real calls on OpenRouter and on OpenAI. It needs `OPENROUTER_API_KEY` and `OPENAI_API_KEY`, spends at most $1, and no check runs it.

## Trace sources

`openmerit/sources` finds tasks in a Langfuse project from the generations the project recorded, so it needs no access to the application's code. It sends GET requests only, so a **Viewer** key pair is enough. It is a library export the CLI does not use. Not yet in a released version.

```ts
import { connectionFromEnv, createLangfuseSource } from "openmerit/sources";

const source = createLangfuseSource(connectionFromEnv(), { days: 30, environments: ["production"] });
const { tasks } = await source.tasks();
const { bundle, cases, samples, skipped } = await source.replay(tasks[0]);
```

- **`tasks()`** groups generations into tasks by trace name, by the Langfuse prompt they link or else their generation name, and by model. It ranks the tasks by recorded cost, then by volume, with each one's calls and cost per month and its share of the project's cost. It reads one aggregate query and no inputs or outputs.
- **`replay(task)`** reads the input and output of the task's latest generations (200 by default) and returns up to 30 replay cases and a task bundle. Failed calls, generations with no input or output, and inputs that are not a chat message list are skipped, and `skipped` counts them by reason. A request recorded twice becomes one case. The sample takes an equal share from each stratum, by prompt version, turn depth (first turn, turns 2–3, turn 4 and later) and output kind (tool call or text), and spreads each stratum's picks over time. The same generations give the same sample.
- **A case is one model call.** `input.messages` is the request the trace recorded, history and earlier tool results included, as OpenAI chat messages in JSON. `expected` is the assistant message the current model returned. Tools are never executed. Text in both is redacted like scan snippets.
- **The bundle** has the task, the current model, the system prompt when every sample shares it, and the output kind. Its tools come from the definitions the trace recorded. When the trace recorded none, the tools are only the names seen in tool calls, with no parameter schema, and `toolDefinitions` is `"inferred"`.

## Development

```sh
npm ci
npm run check            # strict typecheck and tests (mocked endpoints and harness; no paid calls)
npm run test:fast        # the tests without the 90 s daemon crash-recovery test, while iterating
npm run build:catalogue  # maintainers: regenerate data/catalogue.json from OpenRouter and Epoch
npm run build && npm pack
```

The tests' fictional application, `test/fixtures/support-app` (in the repository, not the npm package), has a fuller eval that can also record a Langfuse v4 experiment through OTLP.
