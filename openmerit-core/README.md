# OpenMerit

> **Unreleased.** This README describes the local CLI on `main`. The published npm package (`openmerit@0.4.1`) still has the earlier `run`, `candidates`, `status` and `login` commands; they are gone from this version.

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
| Linux x64 | Tested with Node 22.19.0: install, setup, Scout, history and MCP |
| macOS arm64 (Apple silicon) | Tested with Node 22.19.0: the same. The daemon also starts with Node 26 |
| Linux arm64, macOS x64 (Intel) | Engine binaries exist; untested |
| Windows | Not supported: Rivet publishes no Windows engine, so Scout and the MCP server cannot start the daemon. WSL 2 is untested |

A global install takes about 780 MB on Linux and 660 MB on macOS, most of it the engine and the bundled Claude Code (see [Limitations](#limitations)).

### Setup

`openmerit setup` is safe to rerun. It verifies what is saved, keeps what still works and offers a retry or reconfiguration for anything that fails. It never switches to another provider on its own.

1. **Harness (global).** Setup runs `openmerit connect` (see [Connect the harness](#connect-the-harness)).
2. **MCP (global).** When the `claude` or `codex` CLI is on your `PATH`, setup registers OpenMerit's stdio server as `openmerit` with Claude Code (user scope) and Codex, through their own `mcp add` commands. An existing `openmerit` entry is left unchanged.
3. **Langfuse (this repository; needed when the eval records its results there).** Give a URL (Cloud or self-hosted) and a separate **Viewer** key pair. Setup refuses a key that can write. OpenMerit reads each eval run's per-item scores back from the experiment your eval records, plus aggregate production metrics: generation counts, cost and latency by model for a trace name, and score averages. It never creates datasets, experiments, traces or scores; your eval writes them with your application's own keys.
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

Set `OPENMERIT_HOME` to move `~/.openmerit`. For scripts, `openmerit help` lists flags such as `--harness codex --device-code --endpoint openrouter:OPENROUTER_API_KEY --allowed-models a,b --budget 5 --yes`.

### Commit `.openmerit/` or ignore it

Setup leaves `<repo>/.openmerit/` untracked; OpenMerit never commits or ignores it for you. It holds `config.json` and any eval helper files you approved under `.openmerit/evals/`, and never a key's value, so it is safe to commit.

- **Commit it** when your team should share the same endpoints, allowed models, evals and budget. Use `{"env": "..."}` key references in a shared file: a `{"secret": "<name>"}` reference resolves only on the machine whose `~/.openmerit/secrets.json` stored it. Expect diffs: rerunning setup rewrites each entry's `verifiedAt` time, and Scout saves each eval you approve and any budget raise you make the new default.
- **Ignore it** (add `.openmerit/` to `.gitignore`) when the settings are yours alone.

Each run records the repository revision, and an untracked or uncommitted `.openmerit/` marks it `+dirty` in `openmerit history`. A committed or ignored `.openmerit/` does not.

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
   - A JSON file that names more than 20 models is data, such as a model catalogue or saved results, and is skipped. Scout says which files it skipped.
   - To skip other files, add glob patterns relative to the repository root to `.openmerit/config.json`, such as `"scan": {"exclude": ["playground/**", "scripts/old"]}`. A directory name skips everything under it.
2. **Choose.** Pick the current model from the catalogue models found, then answer *"Select which Agents/Tasks do you want OpenMerit to review?"* Each task shows a one-line description and its usages. To fix the mapping, answer `<usage>=<task>` (such as `u12=reply drafter`) to move a usage to that task or to a new one; the question then asks again.
3. **Pool.** A candidate must be in the allowed pool, have a list price below the current model's, support what the task needs (tool calls, images, structured output) and have an ECI score. Scout ranks the pool by ECI. Models without an ECI are left out, and Scout says how many.
4. **Find the eval.** The harness looks for the task's existing eval and says how to run it per model and item set: the command, any variable mapping such as `CLASSIFIER_MODEL={{model}}`, and, when the eval records its results in Langfuse, the dataset and the per-item score that decides pass or fail. It may propose helper files, only under `.openmerit/evals/`. With no eval, Scout asks you for the command or lets you skip the task; it never invents an eval or labels.
5. **Approve.** Scout shows the eval command, environment, helper files (as a diff), where per-item results come from, the search's run counts, where eval data goes and the budget. Nothing runs or is written before you approve.
6. **Evaluate: Scout Model Binary Search.** The same eval command runs for every model, so inputs, prompts, tools and scoring stay identical; only the model and the items change.
   - The current model runs every item three times (`repeats` in the repository config).
   - Scout draws five items the current model passed in every run. Each screen runs a candidate on those five items. A candidate passes a screen only when it passes all five.
   - Binary search over the ECI ranking: a pass moves to weaker models, a fail to stronger ones. The weakest model that passed is the pick.
   - Neighbours of the pick are screened on the same items, nearest first and weaker first at equal distance, until there are five finalists. Once a weaker neighbour fails, only stronger ones are tried.
   - The finalists run every item three times. Then up to three challengers, stronger models at the same or a lower list price than the leading finalist, are screened, and those that pass run every item too.
   - The metering proxy sends a model call that times out, is rate-limited, fails with a server error (HTTP 408, 429 or 5xx) or gets no answer again up to three times, waiting as long as `Retry-After` says (at most 30 s) or 2, 4 and 8 s. The retries are metered as one request.
   - A candidate whose calls still fail after those retries, or that the endpoint rejects outright (HTTP 400, 402, 404, 413 or 422), is skipped as untested and the search goes on without it. Any other eval failure asks before running again, listing what each failed run already spent; declining stops that task's search, or reports a failed finalist as unmeasured.
7. **Compare.** A finalist qualifies when it passes at least as many item runs as the current model and meets the eval's own required pass rate. Qualified finalists rank cheapest first by measured eval cost per item on the same workload. Scout shows the search path, then the **Top 3 beside the current model** with endpoint, passes, cost per item, latency, and the eval runs and Langfuse experiments behind each. Failed and unmeasured finalists are labelled and never count as success. If no screened candidate failed and every finalist matched the current model, the eval did not separate the models, and Scout asks before ranking on cost alone.
8. **Configure.** Scout asks *"Should OpenMerit configure this? Yes / No."* No leaves your application unchanged. Yes previews the narrowest edit: the task's literal model ID, when the app already calls that provider. Scout applies only the previewed lines, and only while each line is unchanged. Changing the endpoint, or a model read from an environment variable, comes as manual instructions: OpenMerit cannot change your shell's environment.

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

`openmerit_scout` returns structured `questions` (missing input, task choice, eval approval, budget, configuration) instead of prompting. The client asks the user and calls the tool again with `answers`. A run started in the CLI can continue through MCP and the other way round. The daemon works on a run one step at a time.

## Daemon

Scout runs in a background process, the OpenMerit daemon. `openmerit scout` and `openmerit mcp` are its clients: the first one that needs it starts it, and it keeps running after they exit. `openmerit setup` and `openmerit history` do not use it.

- Each Scout run is a Rivet Workflow actor in a local Rivet engine that ships in the package. The engine listens on `127.0.0.1` only: port 6720, with the next port (6721) for its peer API and the port 10 above (6730) for metrics. `OPENMERIT_DAEMON_PORT` moves all three: `7720` uses 7720, 7721 and 7730. It makes no connections of its own outside the machine, and it accepts only requests that carry the token in `~/.openmerit/daemon.json`, which is new at every start.
- A run waiting for your answer keeps waiting when the daemon stops, crashes or the machine restarts: the next command starts the daemon again and the run continues from its question.
- When the daemon stops answering (no reply in 30 s, or the connection drops), the CLI and MCP server say the connection was lost and reconnect, starting a new daemon if needed. After three failed attempts they stop and print `openmerit scout --resume <run>`.
- A step cut off in the middle, such as an eval in progress, stops the run as interrupted. `openmerit scout --resume <run>` continues it and asks before running an interrupted eval again; its earlier requests stay counted against the budget.
- Each step works with the directory and environment of the CLI or MCP server that sent your answers: its endpoint keys, your application's `LANGFUSE_*` keys and `PATH`. The daemon keeps them in memory only, never on disk.
- `openmerit daemon status` shows whether it runs; `openmerit daemon stop` stops it. After an update, the next command replaces a daemon of the old version.

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
- Delete `~/.openmerit/daemon.log`, which grows without rotation.

## Troubleshooting

**Scout says the connection to the daemon was lost, or that it did not start.** Read `~/.openmerit/daemon.log` first. A common cause is another process on one of the daemon's three ports (6720, 6721 and 6730 by default). The daemon does not report that the port is taken: after about a minute its log says `RivetKit registry did not register with the Engine within 60000ms` and `Engine health check failed after 64 attempts`. The CLI prints `Connection to the OpenMerit daemon lost. Reconnecting…`, then `The OpenMerit daemon did not start within 90 s` for each of three attempts, and gives up after about six minutes with `openmerit scout --resume <run>`. To find what holds the ports and move the daemon:

```sh
lsof -nP -iTCP:6720 -iTCP:6721 -iTCP:6730 -sTCP:LISTEN
export OPENMERIT_DAEMON_PORT=7720           # the daemon then uses 7720, 7721 and 7730
openmerit scout --resume <run>
```

The first client that finds no daemon starts it, so set `OPENMERIT_DAEMON_PORT` everywhere OpenMerit runs: in your shell profile, and in the environment your MCP client starts `openmerit mcp` in.

**Several users on one machine.** Each user has their own `~/.openmerit` and daemon, but every daemon defaults to port 6720, so only the first one starts. Give each user their own `OPENMERIT_DAEMON_PORT`, 20 apart (such as 6740, 6760) so that no two users' three ports overlap.

**A daemon that seems stuck.** `openmerit daemon status` shows whether it answers, with its version, pid and port. `openmerit daemon stop` stops it; the next command starts a new one, and interrupted runs continue with `openmerit scout --resume <run>`. A daemon of an older version is replaced on its own.

**Warnings in `daemon.log`.** Rivet logs `SQLite transaction is unnamed` warnings during runs. They appear in successful runs too and do not mean a run failed.

**Windows.** Not supported; see [Supported platforms](#supported-platforms).

## Data handling

| Data | Where it goes |
| --- | --- |
| Redacted snippets, file names, package scripts and files the harness opens read-only | The harness provider you chose (Anthropic through Claude Code, OpenAI through your ChatGPT sign-in, or your API provider), when Scout maps usages and finds evals. Evals, which spend money, run only after you approve |
| The ChatGPT sign-in | Your machine, in `~/.openmerit/agent/auth.json` (mode 0600); pi refreshes it with OpenAI |
| Eval inputs and prompts | The candidate endpoints you configured, during approved evals only |
| Langfuse | OpenMerit reads per-item scores of the experiments your eval records, and aggregates, with a Viewer key. It never writes; your eval writes with your application's keys, as it does without OpenMerit |
| Run history | Your machine. SQLite keeps no keys and no dataset contents. Failed eval logs keep their last lines, redacted |
| Daemon | Your machine. The Rivet engine listens on `127.0.0.1` only and keeps each run's progress and pending question under `~/.openmerit/rivet`, never keys or your environment |

## Limitations

- The scanner finds literal model IDs and common dynamic patterns. A model chosen far from where it is used may need a manual task correction.
- Eval cost is measured only for requests that go through `OPENAI_BASE_URL`. An eval that calls providers directly is measured as zero requests, and Scout says so.
- Configure edits only literal model IDs on an already-matching provider. Other changes come as instructions.
- Measured quality is only as good as the eval: few items, or an eval every model passes, cannot separate candidates. Screens use five items the current model passes in every run, so a task needs at least five.
- The binary search assumes that a higher ECI means a model that is at least as capable on the task. It screens about log₂ of the pool size, so a cheaper model that the ranking places out of order can be missed.
- Harness inference through Claude Code or a ChatGPT sign-in is billed by your plan, so its cost is shown as tokens, not dollars.
- pi-claude-bridge drives Claude Code through the Claude Agent SDK with your subscription. Anthropic has changed its stated billing for that use before and may again.
- The install is larger with the bridge: the Claude Agent SDK's bundled Claude Code is about 330 MB on Linux.
- The local Rivet engine makes the install larger: about 300 MB on Linux and 160 MB on macOS. An empty engine store takes about 130 MB on disk.
- Stopping the daemon (or `openmerit daemon stop`) while a step runs interrupts that run; it does not continue on its own.

## Development

```sh
npm ci
npm run check            # strict typecheck and tests (mocked endpoints and harness; no paid calls)
npm run test:fast        # the tests without the 90 s daemon crash-recovery test, while iterating
npm run build:catalogue  # maintainers: regenerate data/catalogue.json from OpenRouter and Epoch
npm run build && npm pack
```

The tests' fictional application, `test/fixtures/support-app` (in the repository, not the npm package), has a fuller eval that can also record a Langfuse v4 experiment through OTLP.
