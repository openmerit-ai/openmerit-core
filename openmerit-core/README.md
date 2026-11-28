# OpenMerit

OpenMerit finds the cheapest model that does each task in your code as well as the one it uses today, measured on cases written from the task and checked by a person. Your coding agent is the main user: it sends a task over MCP or the CLI, relays OpenMerit's questions, and applies the switch you approve. Website: **[openmerit.ai](https://openmerit.ai)**.

The `openmerit` package holds the OpenMerit server, the same one openmerit.ai runs, and its clients:

- **`openmerit server start`** runs the server on your machine for one person, with its web app, free and without an account.
- **`openmerit login`** signs the CLI in to openmerit.ai instead.
- **`openmerit mcp`** and the CLI's tool commands (`openmerit recommend` and the rest) call whichever server the CLI uses.

## Install and set up

```sh
npm install -g openmerit        # Node.js 22.19 or newer
openmerit setup                 # register `openmerit mcp` with Claude Code and Codex
openmerit server start          # run the server here; or `openmerit login` for openmerit.ai
```

Then ask your coding agent to find a cheaper model for a task: it calls `openmerit_recommend`.

`openmerit setup` registers `openmerit mcp` as `openmerit` with Claude Code (user scope) and Codex, through their own `mcp add` commands, when their CLI is on your `PATH`. An existing `openmerit` entry is left unchanged. Otherwise it prints the stdio command to register with another client. It is safe to rerun.

### Supported platforms

| Platform | Status |
| --- | --- |
| Linux x64 and arm64 | Tested in CI: a global install with an empty npm cache, then `server start`, a job and `openmerit mcp` |
| macOS arm64 (Apple silicon) | Supported, but not currently tested in CI |
| Windows | Not supported: Rivet publishes no Windows engine, which `openmerit server start` needs. The client commands and `openmerit mcp` against openmerit.ai work. WSL 2 is untested |

A global install takes about 450 MB on Linux x64, most of it the local Rivet engine the server runs on.

### Files

| File | Holds |
| --- | --- |
| `~/.openmerit/login.json` (mode 0600) | The CLI's sign-in: openmerit.ai's OAuth tokens, or which self-hosted server and token file |
| `~/.openmerit/server/` | A self-hosted server's data: its engine store (tasks, runs, ledger), `token` and `key` (mode 0600), `server.json` and `server.log` |
| `~/.openmerit/config.json` | The harness choice (see [Connect the harness](#connect-the-harness)) |
| `~/.openmerit/agent/` | The harness's files: `auth.json` (mode 0600) with the ChatGPT sign-in, and pi-claude-bridge's config and log |
| `~/.openmerit/secrets.json` (mode 0600) | Keys you type in at the prompt |
| `~/.openmerit/telemetry.json` | The random install ID [telemetry](#telemetry) sends, and when its notice was shown |

Set `OPENMERIT_HOME` to move `~/.openmerit`.

### Connect the harness

```sh
openmerit connect                 # keep the working connection, or choose one
openmerit connect claude-code     # Claude Code with your Claude login
openmerit connect codex           # Codex models with your ChatGPT Plus or Pro sign-in
openmerit connect codex --device-code --yes   # the same on a server without a browser
openmerit connect api --api-provider anthropic --api-model claude-sonnet-5-5 --api-key-env ANTHROPIC_API_KEY
```

On a self-hosted server, the harness writes each task's cases, and rewrites them from your grades, on your own Claude or ChatGPT plan or API key, so writing an eval costs OpenMerit nothing. The server reads the connection when a job writes cases, so a new `openmerit connect` applies to the next job without a restart.

`openmerit connect` signs in where needed, makes one round trip through the harness and saves the connection only when that works. A failed check keeps the previous connection. `--model <id>` picks the model for Claude Code (default `claude-sonnet-5-5`) or Codex. Which Codex models a ChatGPT account may use depends on its plan, so without `--model` `openmerit connect codex` tries them from the highest catalogue ECI down and saves the first one the plan accepts.

- **Claude Code** runs your own installed Claude Code (`claude` on your `PATH`, or the path in `OPENMERIT_CLAUDE_BIN`) through pi-claude-bridge, which `openmerit connect claude-code` installs into `~/.openmerit/claude-bridge/` (about 30 MB) on first use. OpenMerit no longer bundles a copy of Claude Code. It uses your Claude Code login in `~/.claude`; when you are not logged in, `openmerit connect claude-code` offers `claude auth login`. On a server, set `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or `ANTHROPIC_API_KEY`. Claude Code gets no tools of its own and loads no project `.claude` settings.
- **Codex** uses pi's ChatGPT Plus or Pro sign-in, the same one pi's own `/login` offers. It is a browser sign-in, or a code you enter at `auth.openai.com/codex/device` from any device with `--device-code`, which also works on a server. You do not need the Codex CLI installed. Pi keeps the tokens in `~/.openmerit/agent/auth.json` (mode 0600) and refreshes them; OpenMerit does not read the Codex CLI's own login.
- **An API key** uses any provider pi knows, with a key from an environment variable or typed in and stored in `~/.openmerit/secrets.json`.

Whichever powers it, the harness reads the repository only through pi's read-only tools (read, grep, find and ls), and they refuse any path outside the repository.

## MCP

`openmerit mcp` is a stdio MCP server for Claude Code, Codex and other clients; setup registers it for you. It forwards every message to the `/mcp` of the server the CLI uses (see [Client commands](#client-commands)): openmerit.ai after `openmerit login`, or the server `openmerit server start` runs. So the coding agent gets the server's tools (`openmerit_recommend`, `openmerit_result` and the rest), its confirmations and its results, signed in as the CLI, without a token in the client's configuration. Its stdout carries only protocol messages.

- It looks up the server for each message, so `openmerit login` or `openmerit server start` takes effect without restarting the client.
- Until there is a server, it still lists the tools, and each tool call answers that the user should run `openmerit login` or `openmerit server start`.
- A client that speaks MCP over HTTP can connect to `https://openmerit.ai/mcp`, or a self-hosted server's `/mcp`, directly instead.

In a task's first run on cases OpenMerit wrote, and in a run after the task changed, a person grades the eval before any model is searched. The job runs the current model on every case, and one cheaper model from the pool once (`trialOption`), then asks for a grade of sampled answers of each, instead of a check of the written cases' expected answers. Where the person and the eval disagree, OpenMerit writes the eval again from the grades and runs the trial again, up to three rounds. Where they disagree, only the cases they disputed are written again; every other case stays as it was. Once they agree on every answer, the search runs on the eval, reusing the trial's runs. Before the pick is recommended, the person grades 4 of its answers: one that looks wrong means the eval let a weaker model pass, so that case is fixed and the search runs again (within the same 3 rounds). Then the eval is accepted as version 1, with the answers the person graded.

Later runs and watch runs measure on the accepted eval and ask for no grades. Each such run has the judge grade the kept answers again, and says so, with a link to review the eval, when it disagrees with the person. When the coding agent sends the task with a different prompt, tools or output, the eval reopens as a draft: a run started for it grades the draft the same way and accepts it as the next version, while the watch waits until it is accepted, there or in the app.

## Server

`openmerit server start` runs the OpenMerit server, the same server openmerit.ai runs, on this machine for one person, in the background.

- It listens on `127.0.0.1` only, on port 7330 (`--port` or `OPENMERIT_PORT`). Its local Rivet engine takes the next two ports and the port 11 above, and its metrics the port 3 above: 7330 uses 7330 to 7333 and 7341.
- It keeps its tasks, runs, ledger, token and log in `~/.openmerit/server` (`OPENMERIT_DATA_DIR`). No account, plan or Clerk sign-in; the spend caps still apply.
- It writes each task's cases with the harness `openmerit connect` set up; without one, on OpenRouter with `OPENROUTER_API_KEY` from the environment `server start` runs in. That key also judges text answers and runs candidates on OpenRouter. Without either, a task measures on its examples and your own eval only. When the harness fails, such as a lapsed sign-in, the job says so and falls back to OpenRouter.
- Your own endpoints (`openmerit_recommend` measures on the models you allow on them) keep their keys encrypted with a key the server writes to `~/.openmerit/server/key` (mode 0600) on first start, or with `OPENMERIT_KEY_ENCRYPTION_KEY`. Keep the file: without it the server cannot open the endpoint keys it saved.
- It serves the web app at its own address. `start` prints a sign-in link for it, which works once, for ten minutes; `openmerit server link` prints a new one. The link opens a browser session of 30 days, which ends when the server restarts.
- Coding agents and scripts sign in with the token in `~/.openmerit/server/token`; `openmerit mcp` and the CLI read it for you. A critical request sent with the token, such as a higher budget, grades or a decision on a switch, waits until you confirm it in the web app: the token cannot confirm.
- `openmerit server status` shows whether it runs; `openmerit server stop` stops it. Its log is `~/.openmerit/server/server.log`.

## Client commands

The CLI is also a client of an OpenMerit server, with one command for each of the server's MCP tools, so a script or a coding agent without MCP gets the same tools and fields.

- `openmerit login` signs in to openmerit.ai in your browser (OAuth with PKCE, on a loopback port). When the browser runs on another machine, paste the address it ends on. `openmerit login --server <url>` signs in to a self-hosted server with its token file (`--token-file`, default `~/.openmerit/server/token`). The sign-in is kept in `~/.openmerit/login.json` (mode 0600), and the access token refreshes on its own. `openmerit logout` forgets it.
- Without a login, the commands use the server `openmerit server start` runs on this machine. `OPENMERIT_SERVER` with `OPENMERIT_TOKEN` overrides both, for scripts and CI.
- `openmerit whoami [--json]` names the server, organization and role.
- `openmerit recommend`, `result`, `answer`, `confirmation`, `eval-command`, `tasks`, `eval` and `retire` call `openmerit_recommend` and the rest. Each argument is a flag (`job_id` is `--job-id`); objects and arrays take JSON, `@file` or `-` for stdin, and `--input` takes every argument as one JSON object. They print the tool's text, or with `--json` its structured result. `openmerit <command> --help` lists the arguments.
- A critical request, such as a higher budget, grades or a decision on a switch, answers `needs_confirmation` with a link, as it does over MCP: you confirm it in the web app, never with a CLI flag.

## Eval contract

On a self-hosted server, `openmerit eval-command` (MCP `openmerit_eval_command`) makes a task's own eval command what measures each model, once you confirm it in the web app. The server runs the command once per model and item set, through a metering proxy on `127.0.0.1`. The command gets these environment variables:

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

## Updates

`openmerit setup` and `openmerit connect` check npm for a newer `openmerit`. In a terminal they ask before installing; otherwise they print the update command and continue. `openmerit mcp` reports an update to the client as a log notification. Set `OPENMERIT_NO_UPDATE_CHECK=1` to skip the check.

## Telemetry

OpenMerit sends anonymous usage data to OpenMerit's PostHog project: one `cli_command_run` event for each command you run and each tool call through `openmerit mcp`. The first command that sends one prints a notice to stderr; OpenMerit never asks.

- **What is sent:** the command or tool name (such as `whoami` or `openmerit_recommend`), whether it ran in the CLI or the MCP server, whether it succeeded, how long it took, and the OpenMerit version, OS, CPU architecture and Node.js version. The ID is a random install ID kept in `~/.openmerit/telemetry.json`; it is not linked to you or to an account.
- **What never is:** arguments, answers, code, file paths, repository names, model IDs, endpoint details, keys, error messages and output.
- **Turning it off:** set `OPENMERIT_TELEMETRY=0` (or `false` or `off`) or `DO_NOT_TRACK=1`. It is always off when `CI` is set. For the MCP server, set it in the environment your client starts `openmerit mcp` in.

Sending never changes a command's output or exit code. It gives up after about 1 s, so an offline machine waits at most that long when a command ends.

## Uninstall

```sh
openmerit server stop                       # if you started one
claude mcp remove --scope user openmerit    # if setup registered the MCP server with Claude Code
codex mcp remove openmerit                  # and with Codex
npm uninstall -g openmerit
rm -rf ~/.openmerit                         # or your $OPENMERIT_HOME
```

Removing `~/.openmerit` deletes the CLI's sign-in, the harness connection and ChatGPT sign-in, the keys you typed in and a self-hosted server's tasks, runs and engine store (about 130 MB even when empty).

## Troubleshooting

**`openmerit server start` says the server did not start.** Its log, `~/.openmerit/server/server.log`, says why. A common cause is another program on one of its ports (7330 to 7333 and 7341 by default): start it with `--port` set to another port, such as 7430.

**A tool call says there is no OpenMerit server.** Run `openmerit server start`, or `openmerit login` for openmerit.ai; `openmerit mcp` picks it up without restarting your coding agent. `openmerit whoami` shows which server the CLI uses.

## Data handling

| Data | Where it goes |
| --- | --- |
| The task bundle your coding agent sends (its prompt, tools, examples and code references) | The server the CLI uses: your machine when self-hosted, openmerit.ai when signed in |
| Cases and answers | OpenRouter, to write cases, run candidates and judge; and your own endpoints, on the models you allow |
| The CLI's sign-in and server token | Your machine, mode 0600 |
| Usage data | OpenMerit's PostHog project: command and tool names, success, duration and versions, with a random install ID, unless you turn it off. See [Telemetry](#telemetry) |

## Limitations

- The server's local Rivet engine makes the install larger: about 300 MB on Linux and 160 MB on macOS.
- A self-hosted server is for one person; teams come later, through OIDC sign-in.
- The hosted server does not run your eval command yet: `openmerit eval-command` works on a self-hosted server only.
- pi-claude-bridge drives Claude Code through the Claude Agent SDK with your subscription. Anthropic has changed its stated billing for that use before and may again.

## Engine

`openmerit/engine` exports the search and its rules, which the OpenMerit server runs, for apps that run the same search.

- `evaluateTask`: a task's whole evaluation: the current model's repeated runs with the early stop, the samples, the search, the finalists' runs, the leader, the challengers (screened first) and the qualified Top 3, plus `nearMisses`, the models that missed the current model's score by at most one item per run. With `floor` (`EVAL_FLOOR`, 0.8, by default) it returns `below_floor` and screens nothing when the current model passes less than that share of its item runs, since the eval cannot then tell models apart; a caller whose own eval decides with its own threshold passes `floor: null`. `kinds` maps items to their kind for `baseline.byKind`, the current model's pass rate per kind, and `floorNote` words the verdict. The caller supplies `measure`, its only side effect, and `sample`, so a replay draws the same items. The server runs it.
- The task's result and its change: `taskResult` (the baseline, every candidate with why it did or did not qualify, the Top 3, the near misses and the pick, the cheapest Top 3 model that costs less per item than the current model), `eligible` (the pool rule: a priced, non-free catalogue model cheaper than the current one that supports the task's tools, images and structured output), `provisionalPick` (the cheapest pool model the catalogue rates at least as capable as the current one, named before anything is measured) and `proposeEdit` (replaces only the string literal that names the model, keeping its quotes, a `provider:` prefix and the code around it, and gives instructions for a ref with no literal, a fallback literal or a move to another endpoint). The server's result uses `proposeEdit`.
- Evidence and connections: `mergeEvidence` gathers what each connection knows about a task (graders, cases, priority and code refs), each piece naming the connection it came from, and `strongest` is the quality rule: the strongest grader (the customer's own eval, expected outputs, parity with recorded answers, confirmed labels, then a judge), real cases before written ones, and recorded spend before a request. `basedOn` writes the report's "Based on" lines, and `basedOnAll` names every grader and case source after the strongest, for a run in which all of them counted. `meetsCriteria` and `evaluateTask`'s `criteria` measure against an accepted Eval's checks (decision 7 of the plan), and `taskResult`'s `summary` words that result. A `Connector` declares the ports it fills (`list`, `evidence`, `measure`, `change`) and whether it may write; `MeasurePort` is `evaluateTask`'s `measure` and `sample`, and `ChangePort` proposes the change for a pick. `approve` records who approved a change and when; nothing is applied by it. The connections live in openmerit-core's `src/connectors/`: the eval command (the repository's own eval as the customer's grader and Measure port) and the agent bundle (`openmerit_recommend`'s bundle). They are not package exports.
- `trialOption`: the cheaper model a grading trial runs before any search, so a person grades its answers next to the current model's. It starts at the binary search's first probe, the middle of the ladder, and moves to the middle of the weaker half while the option fails nothing worth grading; an option that cannot run is skipped.
- `binarySearch`, `challengers` and `order`: the model binary search over any ladder, ordered weakest first. `order` sorts catalogue models by ECI; a vendor's named tiers can be passed in their own order. `ladder` sets apart options without an ECI, such as fine-tunes, and `challengers` measures every one of them.
- The catalogue types, `catalogueIndex` and `requestPrice`, and the Epoch ECI parsers.
- `Ledger`: reserve a model call's expected cost, then settle it with what it cost, or release it. Each call has a key, and repeating an operation on a key changes nothing. Spend is split into OpenMerit-paid and customer-paid. `MemoryLedger` implements it for tests; the server's account ledger implements it in production.
- `resolveGuardrails`: guardrails at the environment, agent and task levels. Constraints (allowed providers, models and endpoints, region, spend caps) can only be narrowed by a lower level; defaults (budget, repeats, pass rates, latency, watch, action policy, agent eval) can be replaced either way. It reports which level set each value, and rejects settings that would widen a constraint.
- `checkAgent`: the agent-eval rule. It checks a task's pick against the whole agent's eval, then the next finalists, then all passing switches together, keeping the largest savings that pass together.
- `redact`: the rules that replace key- and token-shaped text.

## Ranking

`openmerit/ranking` measures a candidate model on a task when OpenMerit, not the application, writes the cases and the grader, as the OpenMerit server does.

- `TaskBundle` describes one task: its prompt with `{{var}}` placeholders, the tools it offers with their parameter schemas and a mocked result for each, its output (text, JSON with a schema, or one of a set of labels), examples, and in `constraints.maxTurns` the most model calls one case may take (5 by default). A task that offers tools is an agent: it can take several calls. Its optional task spec says what a review of the code found: `input` (what the call receives), `steps` (what the model does, with the tools and access of each), `criteria` (what a right answer does) and `guardrails` (what the call must never do). A step can be `required` (it must happen in every case: one of its tools is called and answers) and can list in `after` the 1-based numbers of earlier steps that must happen first, only where the order matters. A `Case` is one input with its expected answer, and `toolResults` can give it its own mocked result per tool, by name. A mocked result may be a list of `{ when?, result }` entries, matched on each call's arguments: the first entry whose `when` fields all equal the call's, else the first entry without `when`; a call no entry matches is answered with an error, as a lookup that finds nothing. A case from a trace (`origin: "trace"`) holds its recorded request as OpenAI chat messages in `input.messages`, and the recorded assistant message as `expected`.
- `createClient` calls OpenRouter, any OpenAI-compatible API, and Anthropic's Messages API, through [Pi](https://pi.dev)'s model layer (`@earendil-works/pi-ai`). For a JSON task it asks for the answer in the bundle's schema, as OpenAI's `response_format` (`json_schema`), on OpenRouter and OpenAI-compatible endpoints; Anthropic's API has no such field. Each call reserves its expected cost in a `Ledger` (from `openmerit/engine`) under a key, and settles it once with the cost the endpoint reports, such as OpenRouter's, or a list-price estimate from the reported tokens. The reservation is made once Pi has built the request and before it is sent. It retries rate limits and server errors as the eval proxy does, and only the answer it keeps is charged. Each attempt waits at most 120 s for an answer (`timeoutMs` changes it), and an attempt that gets none is not retried.
- `writeCases` puts the bundle's examples first, then has a model write more cases through a completion function the caller passes in. It drops written cases that leave a placeholder empty, give an answer the output cannot have, or repeat another case. The writer sees the task spec and gives each written case a `kind`: `typical`, `edge` (about a quarter) or `guardrail` (about a quarter, when the spec has guardrails); `caseKind` returns it, or the origin for examples and traces. With `labelCheck`, it also returns a question that asks the user to confirm the written cases' answers, in the shape `openmerit_result`'s questions use.
- `runCase` runs one case in Pi's agent loop (`@earendil-works/pi-agent-core`), for single calls and agents alike: it fills the prompt, offers the tools, and answers each tool call with the case's mocked result for that tool, else the tool's own, never a real system. A single call is the same loop with no tools. Pi checks each call's arguments against the tool's schema. A model still calling tools at the task's `maxTurns` fails the case. It returns the final output, every tool call in order, the Pi transcript, which is the case's trace, and the calls it refused (`refused`: a tool the task does not offer, arguments the schema refuses, arguments no `when` matches, or no mocked result), each also a tool result in the transcript; it keeps none of them. `invalidCases` lists the cases the eval cannot run because one of the task's tools has no mocked result for them: that is the eval's defect, so they count for no model, and `createMeasure` refuses to measure them. A trace case is sent as its recorded messages, in one call.
- Graders: `exactMatch`, `labelMatch`, `jsonSchema` (the schema, and the fields the case expects), `judge` (a rubric graded by one fixed judge model, which also reads the tool calls), `parity` (for a trace case: the same tool calls, or the same answer) and `flow` (an agent's whole transcript: a call to a tool the task does not offer fails the case; a call the tool's schema or mocked result refused went back to the model as the tool's error, as a real API's would, and fails the case only if the model never calls that tool again successfully; every step check passes; and the answer passes another grader). The step checks, S1 and up by step number (`stepChecksFor`), are the spec's required steps and its `after` orders, checked on the tool calls that answered; a step that lists no tools cannot be checked and is reported, never failed. `checksBasedOn` names the C…, G… and S… checks for a report's "Based on". `graderFor` picks one from the bundle's output. Graders get the case's tool calls and Pi transcript. The judge's rubric defaults to the task itself (`rubricFor`: its description and input), and it answers one check per criterion and per guardrail (`checksFor`); any failed check fails the answer. When a judge is given, a label that matches is also judged on the spec's guardrails alone, and a JSON answer that matches its schema and the fields the case expects is also judged on the criteria and the guardrails, without a reference answer: the expected fields hold only what the input fully determines, so the criteria cover the rest. A failing grade carries a one-sentence `reason`, redacted and at most 200 characters. A judge whose provider filters the case throws `Ungradable`, and `createMeasure` reports that case with `failure: "ungradable"`; `evaluateTask` leaves a measurement's `ungradable` items out for every model, including runs measured before, and lists them in `ungradable`. The judge's calls are metered in the ledger, but not counted as the candidate's cost.
- `createMeasure` returns the measure function the search takes. It returns each case's pass or fail, with the grader's reason for a failed case, the candidate's cost and its mean latency per case, never what the model answered. `onCase` gets each case's output, tool calls, refused calls and Pi transcript as it finishes, for the caller's run artifact. A candidate the endpoint refuses on every case throws `CandidateUnavailable`, so the search skips it as untested. Once one of a candidate's calls gets no answer, its remaining cases are not sent and count as not answered, so a silent model ends its measure within one timeout. Calls are keyed by job, run, endpoint, model and case, so a workflow step that replays is not charged twice.

`node scripts/spike-ranking.ts` measures one task end to end with real calls on OpenRouter and on OpenAI. It needs `OPENROUTER_API_KEY` and `OPENAI_API_KEY`, spends at most $1, and no check runs it.

## Development

```sh
npm ci
npm run check            # strict typecheck and the CLI's tests (fakes only; no paid calls)
npm run test:server      # the server's tests, each on a local Rivet engine (about 6 minutes)
npm run build:catalogue  # maintainers: regenerate data/catalogue.json from OpenRouter and Epoch
npm run build && npm pack
```

`node scripts/smoke-packed.ts` packs and installs the package globally, then runs `server start`, a job and `openmerit mcp` against a local fake OpenRouter.
