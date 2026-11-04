# Inference Terminal

The terminal gives people and agents a local overview of an application's models, services, connections, inference activity, and linked compute. The selected repository or application path defines its scope. Coding-harness requests, tokens, and costs are outside that scope.

It reads existing evidence independently of inference. It does not call a model, change a route, run evaluations, load or unload models, or retain prompts and responses. Closing it does not stop your workloads. Collection uses local CPU, memory, and authorized runtime API capacity.

## Optional CLI product analytics

**Version 0.1.10:** Scout setup commands default analytics on without a prompt prefix, with `OPENMERIT_TELEMETRY=0` and `DO_NOT_TRACK=1` opt-outs. Terminal and evaluation commands retain the opt-in behavior below. See the [setup default contract](scout.md#scout-setup-analytics-default-version-0110).

**Coding-agent setup telemetry — npm 0.1.9:** opted-in setup adds stage/outcome/component/connection diagnostics and random setup/installation correlation, described in the [Scout lifecycle contract](scout.md#coding-agent-lifecycle-instrumentation-npm-019). Unlike the process-only terminal identity below, an opted-in setup stores its installation UUID in the existing ownership record and installed MCP headers for later calls. No paths, credentials, device names or task content are exported. The copied website prompt explicitly carries usage/unlink preferences; standalone commands still require `OPENMERIT_TELEMETRY=1`, and `DO_NOT_TRACK=1` overrides it. Plans and status checks do not create an installation identity. Older npm 0.1.8 installations need an installer rerun; hosted browser/server collection requires the matching independent Scout deployment.

Available in npm 0.1.7. CLI product analytics are off unless `OPENMERIT_TELEMETRY=1`; `DO_NOT_TRACK=1` always disables them. Terminal `discovery` configuration and `--no-discovery` are unrelated to analytics consent.

When explicitly enabled, the CLI posts `cli_command_started` and `cli_command_completed` to `https://openmerit.ai/scout/api/analytics`, with a fresh `crypto.randomUUID()` identity for that process only. No identity file, cookie, or installation ID is stored. Properties contain only a command category (`help`, `dash`, `eval_init`, `eval_doctor`, `eval_plan`, `eval_run`, `eval_watch`, `eval_report`, or `unknown`), plus completion outcome (`ok` or `error`) and integer elapsed milliseconds capped at one day. Paths, arguments, prompts, configuration, model IDs, error text, environment contents, machine names, and email are not included.

Transport is best-effort, silent, has no retries, and is bounded to about 750 ms per event. It does not change command exit status or JSON output. For a long-running `dash`, completion means startup readiness and the browser-opening attempt finished, not that the server session ended or collection succeeded. JSON and diagnostics modes complete after producing their output. Abrupt termination can lose events. See [evaluation analytics notes](agent-evaluations.md#optional-cli-product-analytics) for watch and Scout request behavior.

**Instrumentation in 0.1.7:** the opt-in schema additionally sends a sanitized package version, platform (`darwin`, `linux`, `win32`, `unknown`), supported Node major and random command ID. Errors can include at most eight allowlisted application-basename/line/column frames, never arbitrary stack text, function names, absolute paths or source context. Scout failures use fixed network/HTTP/response/timeout codes and a validated request trace when available; trace correlation is not authentication. These additions qualify the earlier minimal-property descriptions here; they do not include environment contents, change content-sharing/retention controls or enable replay.

The same opt-in enables local terminal events using that process-only UUID: `terminal_visited` (sample/live mode), `terminal_page_viewed` (fixed page category, including the connections map), `terminal_interaction` (inspect, filter, search, map expansion, mode or command action and entity kind only), `terminal_snapshot` (retained model, record, source, host, deployment and distinct observed-agent counts), and `terminal_error` (fixed collection/snapshot/render/uncaught error code and standard error class only). Counts are integers from 0 through 1,000,000,000; they describe the retained view, not complete environment totals. No entity keys, names, search values, source paths, raw source, prompts, credentials, hostname, arbitrary error messages or stacks are transmitted. No session replay or login is added.

`GET /api/info` exposes the boolean `telemetry` capability. Browser events additionally respect browser Do Not Track, Global Privacy Control and `localStorage['scout-analytics-opt-out'] === '1'`. They go only to the same-origin `POST /api/analytics` relay; the browser CSP still permits connections only to self. The loopback Host/Origin/cross-site guards apply to the relay, which projects every accepted event onto a fixed allowlist, limits JSON bodies to 2 KiB and body arrival to one second. Forwarding has no queue or retries, permits at most 60 terminal events per minute across the process and four in flight, and times out after 750 ms. Browser submission is separately capped at 60 events per minute and two in flight with a one-second timeout. Events can be dropped without affecting collection or UI requests. Collection errors follow process consent independently of browser controls. Outbound analytics carries `X-Scout-Client: cli` and `X-Scout-Analytics: on`.

## Install

Requires **Node.js 22.19 or newer** and npm. Stable `openmerit@0.1.7` includes the terminal:

```sh
npm install -g openmerit
cd /path/to/your/application
openmerit dash
```

No Git checkout, build step, Pi installation, provider API key, or separate audit command is needed. The global install does not add dependencies or configuration to your application. Run the same install command to update, or `npm uninstall -g openmerit` to remove it. `npm ls -g openmerit --depth=0` shows the installed version; `npm view openmerit dist-tags` reports published channels.

The CLI starts a server bound to `127.0.0.1` and opens the browser before initial collection finishes. Port 4310 is preferred; if occupied, the operating system chooses a free local port. The actual URL is printed. macOS, Windows, and desktop Linux use the default URL handler. SSH and headless sessions print the URL; use a private SSH port forward to view a remote instance. Browser-launch failure does not stop collection.

If npm reports `EACCES`, use a user-owned Node installation/npm prefix rather than `sudo`. If the command is not found after installation, reopen the shell and check that npm's global executable directory is on `PATH`.

The **terminal** follows the device's light/dark preference, including charts and inspectors, and update when that preference changes. There is no theme control or saved override. The npm terminal includes this appearance behavior in 0.1.7.

Keep the CLI running while using the dashboard. Files unreadable by your user are reported as unavailable. Configuration can identify services but cannot supply missing request history.

## Run from a source checkout

With dependencies installed in the OpenMerit checkout:

```sh
npm run dash -- /path/to/your/application
```

`npm run dash` bundles the interface before starting. Without a path it reads the current directory. `npm run build` includes the executable and bundled assets under `dist/terminal/`. To install that build, run `npm install -g .` from the checkout.

## CLI options

```sh
openmerit dash /path/to/your/application --port 4311 --interval 20
openmerit dash --no-open
```

| Option | Behavior |
| --- | --- |
| `[path]` | Selected application directory; defaults to the working directory |
| `--port <number>` | Require this loopback port; fail if occupied |
| `--interval <seconds>` | Collection interval from 10 to 30 seconds; defaults to 15 |
| `--no-discovery` | Disable automatic project/index/log and additional runtime discovery; explicitly configured sources remain available |
| `--no-open` | Print the URL without opening a browser |
| `--json` | Print one snapshot and exit without an HTTP server |
| `--diagnostics` | Print repository-index coverage counts, without endpoint probes, browser, or HTTP server |
| `--demo` | Use only a fictional local sample; no local collectors run |
| `--help` | Show usage |

Ctrl+C stops collection. The terminal has no persistent daemon and is independent of core evaluation pause/scheduling policy. The unreleased Pi 1.5.0 Scout adapter exposes no pause or scheduling commands.

## Repository indexing

A local background worker indexes supported application declarations without executing code or creating files in the application. It starts with collection and rechecks 60 seconds after a completed pass.

The reader supports Python, JavaScript/TypeScript (including JSX/TSX), JSON, YAML, TOML, and project-local `.env*` files. It finds literal model/endpoint fields, conservative same-file variable and object references, environment references resolved from the nearest project-local dotenv directory, selected SDK call patterns, and enclosing function names. Unknown/private HTTP(S) endpoints remain named by their sanitized address; a custom host or port never establishes a vendor, runtime, deployment, or physical machine. Public Hub/download URLs do not establish an inference service. URLs found by this index are **never probed**; existing explicitly authorized runtime discovery remains separate.

- **Services and Models:** linked application declarations appear as **Declared**, with file-and-line evidence. This does not establish reachability, availability, loaded state, usage, or cost. Model-only fields without a supported call or endpoint link remain unlinked references in Sources.
- **Sources → Code & configuration:** searchable, paginated endpoint/model/call-site references, their declaration fields, and source locations. Examples, tests, benchmarks, candidate lists, fallback values, model aliases, and unlinked references are labeled separately and excluded from the application inventory. A function or task declaration never creates a running agent, completed task, request, or environment-map path.
- **Index coverage:** unresolved expressions, conflicting dotenv declarations, parse failures, unsupported values, and read limits. Unsupported file types and policy exclusions are counted. Missing declarations do not establish that a project uses no inference.

The index does not execute or import project code, load shell files, inspect running processes, consult inherited shell variables, or fetch cloud accounts. It does not resolve cross-file imports, arbitrary expressions, template interpolation, configuration loading order, dynamic routers, YAML aliases, or multiline TOML values. Conditional values remain candidates; a fallback remains a fallback even if a runtime might choose it. Supported syntax is deliberately conservative. Models and task names are never inferred from prose, prompts, or model-name conventions.

The index skips symlinks, hidden directories, dependency/build folders, credential-named files, and request-log roots handled by the activity reader. It processes eligible files in continuing batches rather than imposing a repository-wide file, depth, byte, or declaration cap. Per-file and parser limits still apply; coverage reports excluded or unreadable material. Removing a declaration removes it after the next completed scan.

The snapshot retains selected identifiers, relative file paths, line numbers, and sanitized endpoint addresses. It discards raw source text, prompt/response fields, credentials, URL credentials, query strings, fragments, and resource paths. Known dedicated resource subdomains are redacted. Structural paths such as `/v1` or `/api/v1` may remain. Local endpoint addresses, model names, and filenames can still be sensitive; the full snapshot is intended for local viewing.

To inspect coverage counts without sharing the repository or its identifiers, run:

```sh
openmerit dash --diagnostics
```

It prints only format/read/skip/declaration/issue counts and scan limits. It does not include paths, variable names, model names, endpoint identities, file contents, or credentials, and sends nothing itself. The user chooses whether to copy the output. Issue totals include all unresolved notes; the detailed list retains at most 100 notes.

`--no-discovery` or `"discovery": false` disables the index. Request history still requires supported application logs or explicit exports. An inactive project can expose its declarations without having retained any usage history; code cannot reconstruct missing requests, tokens, latency, or spend.

### Background indexing and refresh

- **Open immediately:** the loopback server listens before initial collection. The browser shows “Opening your inference terminal” while sources load, without displaying empty metrics as measured zero. Initial collection failures are disclosed and retried on the next collection tick.
- **Discover, index, link:** a dedicated worker walks eligible directories, then prioritizes dotenv files, structured configuration, and inference-related source names. The initial index publishes usable declarations in batches. The interface shows discovered files while the total is unknown, then checked/total files. Completion means the eligible-file pass finished; exclusions and unresolved syntax still appear in coverage.
- **Keep collection independent:** saved activity and authorized runtimes continue on the existing 10–30-second interval. While indexing, the browser checks progress every second; this reads a snapshot and does not re-scan or probe endpoints. Worker progress is published at most twice per second. A pass never overlaps another pass.
- **Reuse unchanged files:** the worker checks again 60 seconds after completing a pass. It caches sanitized parser metadata and file fingerprints in memory. Unchanged source/configuration files need only filesystem checks; changed files are read again, with a content hash avoiding a reparse when only timestamps changed. Dotenv bindings are re-read and discarded each pass. Their changes re-resolve cached call sites. Deleted, newly excluded, oversized, or unreadable files lose their old declarations after the next pass. Restarting the terminal starts a fresh cache.
- **Stay useful while updating:** after the first pass, the previous index stays visible with an updating status until its replacement is complete. The local browser reuses its reference catalog when the revision is unchanged. The plain `/api/snapshot` response remains self-contained; during initial collection it has `loading: true` and no established measurements. Once ready, repository snapshots include `progress`, `revision`, and coverage counters. The optional `repositoryRevision` query omits `repository.references` only if that revision matches; callers must retain their matching catalog.

Each worker batch yields after 32 files/entries, 1 MiB of reads, or about 40 ms between files. These are scheduling budgets, **not total coverage caps**. A single file still has a 128 KiB read limit, syntax parsing retains its complexity protections, and the detailed issue list retains 100 notes. Issue totals by code now count all notes, including those beyond the detail list. The worker has a 256 MiB old-generation heap ceiling; if it fails, the terminal explicitly marks indexing interrupted, retains any available result, and retries in 60 seconds. This is not a guarantee of unlimited repository capacity: metadata and snapshots still occupy memory. Coverage distinguishes `filesIndexed` (including cache reuse) from `filesRead` and `bytesRead` on the current pass. Policy exclusions, supported syntax, and the absence of cross-file expression evaluation are unchanged.

Nothing is written into the application, and no persistent index or source-content cache is created. Endpoint identities are sanitized before entering the in-memory cache. Static URLs still never trigger network calls. `--json` and `--diagnostics` deliberately wait for a complete one-shot pass and then exit; `--no-discovery` disables this worker.

These changes apply to **repository declarations only**. The separate request-log, runtime, hardware-export, and configuration-inventory limits elsewhere in this guide still apply. They do not recover missing historical usage or make a log importer unlimited.

### Request and inventory consistency

- JSONL readers check bounded content fingerprints before resuming from a saved offset. A changed checkpoint resets the cache and imports the current file, including when it was truncated and regrew between polls. Each cached file adds at most 8 KiB of verification reads per poll; only hashes are retained. These checks cover the initial consumed bytes and the latest read boundary, not every byte of a large historical file. Rewrites that preserve both sampled regions cannot be distinguished from appends; append-only logs or rotation to a new file remain the reliable format.
- Copies of one request that disagree on `completed` versus `failed` expose a `status` conflict in request details and the dashboard warning. Source precedence still determines the displayed outcome; a normal `running` to terminal update is not a conflict.
- For matching models in the hardware export, a fresh resident report takes precedence over a stale report from another host, regardless of host order. Once all such reports are stale, residency is unknown.
- Model details show unavailable request and cost coverage when no request source is connected, consistent with the overview and model table. A readable empty request source still establishes a recorded count of zero.

## Automatic application discovery

Project declarations establish service and endpoint inventory; explicit host links establish physical placement. Task summaries remain separate from request measurements. Missing status, currency, and cost basis stay unknown, and inventory/read limits appear in source coverage.

Discovery runs as part of `openmerit dash`; no separate audit command or exporter is needed for supported sources. The first snapshot checks the selected project and its declared loopback runtime endpoints. Project declarations and previously unresponsive addresses are checked again every 60 seconds. Responding runtimes, OS readings, project request logs, and existing exports refresh at the normal 10–30-second collection interval.

Alongside the repository index, the bounded provider/runtime discovery reader checks four root files: `.env`, `.env.local`, `package.json`, and `requirements.txt`, each limited to 128 KiB and required to resolve to a regular file inside the project. This reader does not execute project code, source shell files, or expand environment expressions. Recursive source/configuration references are handled by the separate syntax index described above. Supported SDK declarations are shown as **Detected** source hints; an installed SDK is not proof of a service connection or request. Supported literal `.env` declarations establish project configuration evidence. Inherited shell credentials and endpoint variables are not added to project services; the terminal cannot establish which project owns them. For applications configured only through their launch environment, declare the services explicitly in `.openmerit/terminal.json` or supply recorded request metadata. Each file is independent evidence; discovery does not pretend to know an application's loading order. Credential contents and unrelated settings are discarded before metadata is retained or returned.

Local runtime probes require an endpoint in the selected project’s `.env` or `.env.local`, or an explicit runtime in `.openmerit/terminal.json`. No standard ports are probed automatically. SDK dependencies, runtime names in historical records, and inherited shell endpoint settings alone do not authorize a probe. A recorded request remains visible without discovering any additional runtime models. Supported API endpoint variables are listed below; `OLLAMA_HOST` and `OLLAMA_BASE_URL` identify native Ollama endpoints. `OLLAMA_HOST` may use `127.0.0.1:11434` without the HTTP scheme. Endpoint paths must be empty or `/v1`; credentials, queries, fragments, and non-loopback hosts are rejected. At most eight discovered origins are checked without authentication or redirects. Compatible endpoints use read-only `GET /v1/models` and `GET /metrics`; native Ollama declarations use `GET /api/tags` and `GET /api/ps`. Unknown or nonresponding candidates do not become service rows. Configured origins are not probed twice. A compatible catalog supplies model availability; recognized vLLM counters can also identify vLLM. A port number alone never establishes LM Studio or vLLM identity, so an otherwise unidentified compatible runtime is named by its loopback origin. Bounded inventory from a project endpoint can be shown, including available models that have no recorded project usage. Catalogs are limited to 100 entries per response; exceeded limits mark the source Partial, include omitted counts, and display an inventory-coverage notice. API compatibility and a loopback address do not establish a runtime role, physical host, or self-hosted serving mode. Inventory and shared runtime counters do not establish that the selected application used every model. Removing an endpoint declaration removes its discovered inventory on the next 60-second discovery pass. This is bounded project-linked discovery, not network or remote-host scanning.

**Sources** shows automatic discovery status and per-source coverage. Configuration, responding inventory APIs, and recorded activity remain distinct. Missing usage, identities, paths, and measurements stay unknown. Overview request totals and path counts include supported application request logs even when no activity export exists; retained requests still count when source coverage is partial.

Set `"discovery": false` in `.openmerit/terminal.json`, or pass `--no-discovery`, to skip these additional scans. Explicit exports and explicitly declared runtimes remain available. Machine readings appear in Local compute only when a runtime or deployment explicitly declares `hostId: "this-machine"`. An endpoint alone does not establish physical placement. Set `"ollama": false` to suppress native Ollama declaration discovery as well. Restart after changing `terminal.json`; supported declaration files are reread automatically.

### Existing project request logs

Preview behavior: `openmerit dash /path/to/project` also discovers existing `.jsonl` logs (including numeric rotations such as `.jsonl.1`) under `logs/`, `runs/`, and `results/`, descending at most two subdirectories beneath each root. No exporter, project configuration, credential, or inference call is required when the application already writes a supported format. Selecting the project authorizes these bounded project-local reads. Log files may contain conversation text; the parser retains only allowlisted request metadata, discarding prompts, outputs, headers, and credentials. Symbolic-link files and directories are skipped. Discovery does not execute source code, read arbitrary databases, or scan dependency directories.

Supported records are:

- Structured request results with stable `id`, ISO `occurredAt`, `model`, explicit `status` (`running`, `completed`, or `failed`), and a `usage` object containing numeric `input_tokens`/`output_tokens` or `prompt_tokens`/`completion_tokens`. Explicit agent, task, connection, timing, and cost fields use the same names as the activity export. Failure/running records without usage need a numeric `httpStatus` or `event: "inference.request"`.
- Saved response objects with `object: "response"`, stable `id`, `model`, `created_at`, recognized status, and numeric usage, either directly in each line or under `response` in a metadata envelope.
- Saved chat completion objects with `object: "chat.completion"`, stable `id`, `model`, `created`, completed choices, and numeric usage, directly or under `response`.

These are format adapters, not automatic OpenAI/OpenRouter account ingestion. An API-compatible object does not establish its serving company or connection. A structured result must explicitly supply those identities; otherwise they stay unknown. Without an application/workload label, the relative log filename is shown. Agent/task names are never inferred from prompts or source code. Costs are copied when supplied; no missing price is synthesized. A recorded running event establishes running status only until a later event updates it; the reader cannot determine whether an abandoned request is still executing.

The reader checks at most 2,048 directory entries and the newest 128 candidate files each poll. It reads up to 512 KiB per file and 4 MiB overall, caches up to 1,000 records per file and 10,000 retained records overall. Initial oversized files import a bounded tail. Appends, split UTF-8 lines, same-file updates, truncation, and rotation are handled; deleted/unreadable sources lose their cached records. Malformed or unsupported lines and scan limits appear as partial coverage in **Sources**. Ordinary unstructured text logs and standalone `.json` response files are not supported.

### Application scope

The terminal does not discover or read Pi, Codex, Claude Code, OpenCode, or other coding-harness histories. Application scope does not include coding-assistant sessions or credentials.

Application agents, background jobs, and evaluations remain in scope when they produce supported request evidence. The `agent` scope means an agent in the application, not the coding assistant developing it. Explicit exports and discovered request logs must belong to the application; records explicitly marked `scope: "development"` are rejected. An unlabeled API response cannot establish whether it came from an application or a coding tool, so the terminal does not guess its purpose from a model or agent name. Keep development logs separate from application request sources.

Configuration identifies declared services; it cannot establish past executions or costs. Local runtime inventory and whole-machine counters can describe shared infrastructure and are not attributed exclusively to the selected application. The collector does not retrieve cloud account usage, inspect arbitrary processes, or connect to a remote deployment from its source code alone. Applications without a supported request source can use the optional activity export below.

## Historical activity

Choose **1h**, **6h**, **24h**, **7d**, **30d**, or **All time**. **All time** is the default. It shows all retained, supported request evidence without an age cutoff, including logs from an application that is no longer running. The collector and project-log readers retain supported older records within their read/cache limits.

The date range below the page heading shows the earliest and latest retained request, not the project creation date. All time charts span those recorded dates; an inactive project's last request stays dated in the past. Longer ranges use calendar labels and interval units appropriate to their span. Overview totals, models, services, maps, agent/task details, and activity use the same selected range. Hardware and capacity continue to show their latest samples independently of the activity range.

**All time does not promise complete lifetime history.** It can reach the beginning only when the application recorded that history in supported sources that remain readable within the existing limits. The terminal does not reconstruct missing logs from code or Git history, query cloud account history, or keep a separate persistent archive. Initial tail reads, file/count limits, malformed or unsupported records, unreadable sources, and unresolved source overlap can leave gaps. **Partial history · review sources** exposes known gaps next to the available dates. Even without a known gap, the range covers recorded sources only.

The same per-file and total read/cache bounds still apply. Deleted sources are removed from the next snapshot; restarting rereads available files. The JSON snapshot adds `history.first`, `history.last`, `history.retained`, `history.coverage` (`available` or `partial`), and `history.sourceIds`. `available` never asserts complete project history. First/last dates are null when there are no retained requests.

## Explore the environment

Pages, detail panels, and inventory cards lead directly with their title. Supporting context appears below the title; there are no small uppercase labels above headings.

- **Overview:** inventory counts, observed usage, a map of recorded workload-to-deployment connections, shared capacity, and recent activity.
- **Models:** filter by self-hosted (local or private) or cloud location, search models, and inspect their available measurements. Rows lead with the model name, followed by the serving service, location, and observed request paths. Select the name to open its details.
- **Services:** a searchable inventory of model APIs, inference clouds, routers, gateways, and runtimes identified in the environment. Each service opens its models, deployments, recorded paths, explicitly linked capacity pools, and identity evidence. The secondary **Environment map** view contains the deployment map, agent focus selector, deployment list, and shared pools. Selecting an agent opens Deployments, Paths, and Capacity views. Selecting an entry connection reveals its reported hop sequence; deployment and capacity nodes open their evidence and shared dependencies. A path is a source-reported connection, not a network inspection or an enforced routing policy.
- **Activity:** a request-volume chart stacked in the five request-path colors, with selectable path totals and the most recent 100 request summaries in the selected activity window. Aggregate totals include all retained request records in that window. Without readable request evidence, Activity shows **Request count unavailable** and **Failures unknown** instead of zero. A connected, empty request feed can establish zero recorded requests; missing request statuses leave failure coverage incomplete. Selecting a path isolates its chart series while the activity table keeps the full window. Chart bins support pointer inspection and Left/Right or Home/End keyboard navigation; map nodes also support keyboard inspection.
- **Local compute:** this machine and exported self-hosted servers, grouped by supplied site and rack labels, a reported-site filter when site labels exist, and per-host CPU, system RAM, accelerator readings, loaded models, and optional vLLM counters. Select a host to inspect its resources. Missing measurements and stale readings remain explicit. This does not attribute machine usage to an individual request.
- **Sources:** successful connections, unavailable sources, collection gaps, and setup instructions.

Use Command+K or Control+K to find a view, model, source, or reported agent/task. Escape closes details. Keyboard actions remain immediate, and reduced-motion preferences disable movement transitions.

Dropdowns follow the interface's color scheme and share an inset chevron with neutral focus and selection states. For the agent and host-location selectors, use Enter, Space, or an arrow key to open; arrows, Home/End, or typing a name prefix move through options. Enter or Space confirms, Escape cancels, and Tab confirms and continues through the page. Clicking outside dismisses the menu. An open menu preserves its options and position during passive polling; underlying collection continues.

When request metadata includes stable agent or task IDs, the overview leads directly with their counts for the selected window, without an “Observed” prefix. Select a count to browse those agents or tasks and inspect their request totals, models, connections, and available measurements. Records without these IDs do not contribute to those counts. These are activity summaries, not an agent registry or a task lifecycle tracker; a completed inference request does not establish that its task is complete. The overview previews up to twelve models and ten recent requests. The Models view contains the full retained model inventory; Activity lists the latest 100 requests.

### Where names come from

The terminal does not infer agent roles, task descriptions, service identities, or physical locations from arbitrary source code, prompts, or model output. Being present in a repository does not establish that an agent ran. The terminal reads supported metadata exports, explicit configuration, runtime inventory, and the operating system. The syntax index records supported code/configuration declarations as references; those references do not create running agents or request history. Application logs or exports must supply their existing request identities; the terminal does not generate nicer descriptions to fill gaps.

| Identity | Source and fallback |
| --- | --- |
| Project | The selected directory’s basename |
| Agent / task | `agent` / `task` from activity metadata; otherwise the corresponding `agentId` / `taskId`. Without an ID, the record does not establish a counted agent or task. |
| Workload | The exported `workload` or the target ID in an OpenMerit application audit summary. Missing values display “Unattributed workload.” |
| Connection | The exported `route` or first reported path hop; inventory names are explicitly declared in `.openmerit/terminal.json`. No name means an unattributed route. |
| Runtime | Its configured name; an unnamed compatible runtime displays its validated loopback address. The built-in Ollama collector names the protocol it queries. |
| This machine | The full hostname reported by the operating system, without stripping its domain suffix |
| Exported host | Explicit `name`, then `hostname`, then `id` from the hardware export |
| Site / rack | Only the export’s `site` / `rack` fields. Missing placement stays unspecified; neither hostname nor IP address establishes a physical location. |

Agent and task inspectors include “Where this name comes from,” with the ID, supplied display name or fallback, metadata field, and source. Activity details keep IDs and display names separate. Local compute shows each host’s name source. “Agents recorded on this deployment” is based on agent IDs joined to matching deployment metadata in the selected window; it is not an assertion about currently running processes.

A sticky top header contains the environment selector, search, and six text tabs: Overview, Models, Services, Activity, Local compute, and Sources. A thin underline marks the selected view. Source coverage is a compact link at the right on desktop. There is no sidebar or collapse setting. On narrow screens, tabs scroll horizontally and the selected tab is brought into view when navigating. The environment selector and search remain available.

The tab row is one keyboard stop. Left/Right arrows move focus between tabs, Home/End reach the first/last tab, and Enter/Space selects a view. Keyboard selection is immediate. Focus and horizontal tab position survive passive refreshes. Direct hash URLs still open the corresponding view; Command+K or Control+K continues to open search.

Request paths use the same colors, custom icons, and text labels across the overview counts, map nodes and legend, model badges, connection cards, and activity chart legend. Map threads retain the matching path color. Icons accompany labels rather than replacing them:

| Path | Color | Icon | Meaning |
| --- | --- | --- | --- |
| Direct API | Royal blue | Two endpoints joined by a straight line | A reported direct connection to a provider's API |
| Local runtime | Amber | Processor chip | A reported connection to a local or private inference runtime |
| Router | Violet | One path branching into two | A reported routing service |
| Gateway | Cyan | An arrow passing through a frame | A reported gateway connection |
| Unclassified | Gray | Broken ring | The metadata does not establish the path type |

Path counts use the selected activity window, counting each retained request once. The short bars show each category's share of those requests. Models reached through multiple kinds of connection display each observed type. A loaded or configured model without recorded activity says “No path observed.” Model location remains a separate field: a local model can be reached through a gateway, and a cloud provider does not by itself establish a direct path. With **All agents & workloads** selected, every retained request, workload, entry connection, and model/service pair in the selected time window is represented. There are no top-N workload or model limits. Workloads and models with identical sets of recorded entry connections form compact card stacks with complete counts. Each stack shows an actual member name, a `+N` count for the other members, and totals for the whole stack. Select a group to reveal every member, or use **Expand all** and **Collapse all**. Expanded maps scroll at the same card and text scale, and keyboard users can expand groups with Enter or Space. Group expansion survives passive refreshes; newly observed members join their matching group.

The three columns show workloads, entry connections, and models. Each thread aggregates only actual recorded relationships. The footer reports all represented requests in the selected scope; expanding or collapsing never changes that total. Focusing an agent applies the same complete representation to that agent’s activity. Model identity includes its serving service, so the same model served by different services stays distinct. Model captions show the reported service and, when available, explicitly matched deployment information. Missing deployment identities are explained in the inspector rather than repeated on map nodes. The map does not infer a physical instance from a model name. Select a connection to inspect its reported hop sequences; the Deployments control opens declared and runtime-discovered inventory, which can include instances without attributable request activity.

An explicit `routeKind` determines the category. Otherwise, the terminal matches the route name against declared inventory or local runtime source names, ignoring case and surrounding whitespace. A matching provider is direct; a matching router or gateway retains that type; a runtime must be declared local or private. The “Local runtime” path category includes self-hosted private runtimes; the model location and host placement distinguish them from this machine. Conflicting inventory types remain unclassified. The literal route names `Direct` and `Direct API` are also treated as direct connections. It does not promote a generic activity record’s serving `provider` into a route or guess from model location or arbitrary substrings. The category describes the entry connection once per request. An optional ordered `path` supplies additional reported hops; the terminal never infers hidden intermediaries. When `route` or `routeKind` is omitted, a valid path supplies its first-hop value. A path contradicting an explicit entry name or type is discarded, preserving that explicit entry metadata.

Local compute uses Liveline for CPU and memory history. These are passive readings on the configured collection interval, not a live inference stream. The curve interpolates between recorded points and holds the latest value between polls. Hovering provides chart inspection; the readout below it identifies the nearest **actual sample**, with its timestamp. Focus that readout and use Left/Right, Home, or End to inspect recorded samples with the keyboard. Missing readings or missed collection windows break the history; the chart resumes from the latest uninterrupted run. Reduced motion uses a static chart. Whole-machine usage is not attributed to individual inference requests.

Torph animates changed totals, table measurements, status labels, and source counts while preserving the surrounding interface between polls. Neither animation library changes the collection interval or makes inference calls.

The environment selector opens `inference-sample`, a fictional enterprise workspace with 40 agents, 140 tasks, 21 models, and 9,600 requests over 24 hours. It includes all five path classifications, traffic bursts, running and failed requests, missing measurements, partial and unavailable sources, three self-hosted runtimes, 27 distinct deployments, 14 shared capacity pools, and an hour of host history. Its six hosts include a workstation and five rack servers across two racks, with eleven accelerators listed. Four hosts have recent readings, one is stale, and one has no measurement. Seven loaded models are placed explicitly across three hosts. Six cloud models have separate `us-1` and `eu-1` example deployments. The capacity sample includes twelve recent readings, one stale reading, and one missing reading. Shared gateway pools connect consumers across reported agent IDs. Names resemble exported configuration keys (for example, `support.review` and `llm-gateway`); some agent/task display names are absent and the UI uses their IDs. These identifiers are fictional, not discovered in the current repository. The sample workstation has no site label; server sites and racks are fictional exporter fields. Baseten, Groq, and Cerebras illustrate serving services distinct from model creators; their sample configuration evidence, deployment modes, and quotas are fictional. Model rates, latency, allocation, and utilization values are illustrative; the sample is for inspecting the interface at scale, not a performance benchmark. Sample data never enters the real snapshot or project files. A command started with `--demo` only exposes a sample workspace; restart without that flag to collect real data.

## Collection sources

### OpenMerit evidence

The terminal reads `.openmerit/events.jsonl` for recorded `product_task_completed` automation signals. It retains model and target identifiers and available cost, token, and duration measurements in a separate `taskSummaries` array. These task-level summaries never enter request counts, activity charts, request token/spend totals, model-use inventory, or request history. **Sources → OpenMerit** shows their retained count and expandable summary details. They remain available when request logs also exist. It does not treat generic Pi activity as application evidence.

The existing audit redactor may have replaced token-shaped fields with `[REDACTED]`. These remain unknown in the terminal. The terminal does not reconstruct missing counts from cost or other fields.

### Existing activity exports

Export request metadata from an application, agent, router, gateway, or existing evidence system to `.openmerit/inference.jsonl`. Each record must occupy one newline-terminated JSON line. The file is an optional import contract, not an instrumentation SDK or an inline proxy.

```json
{"id":"request-123","occurredAt":"2026-10-07T08:00:00Z","workload":"your-service-id","scope":"application","model":"your-model","provider":"your-provider","route":"your-gateway","routeKind":"gateway","location":"cloud","status":"completed","inputTokens":120,"outputTokens":40,"cacheReadTokens":0,"durationMs":850,"cost":0.002,"costKind":"reported","currency":"USD"}
```

Required fields are `id`, `occurredAt` (a valid timestamp), and `model`. Optional fields have the following meanings:

| Field | Meaning |
| --- | --- |
| `workload` | Application, agent, or evaluation name |
| `agentId`, `agent` | Optional stable agent ID and display name; the ID enables grouping and observed-agent counts. Without a name, the ID is displayed. |
| `taskId`, `task` | Optional stable task ID and display name; the ID enables grouping and observed-task counts. These fields carry no task lifecycle or execution trace. |
| `scope` | `application`, `agent`, or `evaluation`; defaults to `application` |
| `provider` | Serving service or runtime name, shown as “Served by”; otherwise unattributed. This field does not establish who created the model. |
| `modelCreator` | Optional source-reported creator name, capped at 160 characters. Missing values stay unknown; the terminal does not derive this field from the serving company, SDK, model name, or API catalog ownership. |
| `route` | Reported gateway, router, or direct connection name; otherwise unattributed |
| `routeKind` | Optional `direct`, `local`, `router`, `gateway`, or `unknown`; explicit values take precedence over name matching. Omitted/invalid values become `null` in the snapshot and permit the fallback classification above. |
| `deploymentId` | Optional stable deployment identity. Joins only when the declared/discovered deployment ID, model, and provider all match. No join is inferred from a model name alone. |
| `path` | Optional ordered array of 1–8 `{ "name": "connection", "kind": "gateway" }` hops. Kinds use the same values as `routeKind`. Invalid/oversized paths are discarded as a whole; unsupported kinds become `unknown`. The first hop must agree with explicit entry metadata. |
| `location` | `local`, `private`, `cloud`, or `unknown`; defaults to `unknown` |
| `status` | `running`, `completed`, or `failed`; missing/invalid values become `unknown` |
| `inputTokens`, `outputTokens`, `cacheReadTokens` | Nonnegative measured counts, when available |
| `durationMs` | Nonnegative measured duration in milliseconds |
| `cost` | Nonnegative source-supplied cost |
| `costKind` | `reported` or `estimated`; missing/invalid values become `unknown` |
| `currency` | Only explicit `USD` values enter dollar totals. Missing/unsupported currency becomes `unknown`; its numeric amount is preserved without a dollar claim |
| `requestId` | Optional correlation metadata; not used for automatic cross-source joining |

Use a stable `id` to append updates to an ongoing request. A later complete record with that ID replaces the prior record, so updates must include all fields you want retained. Use different IDs for separately charged attempts or retries. IDs must be unique within the activity feed. Correlate and deduplicate upstream when exporting overlapping systems.

Missing, invalid, negative, or redacted measurements remain unknown. Numeric zero is preserved. Only allowlisted metadata fields are projected into the terminal; prompts, completions, headers, and other arbitrary payload fields are omitted. Do not put secrets in metadata names or identifiers.

Explicit application activity and supported project request logs are reconciled together. A record merges with a copy only through either (a) the same recorded ID, timestamp, model, provider, and connection or (b) the same API request ID, model, and recorded connection (provider if no connection is supplied). Equal timestamps or token counts alone never establish identity. Distinct attempts must have distinct IDs. A terminal (`completed` or `failed`) record replaces a running copy; an unknown status never finalizes a running request. An explicitly reported status can replace an unknown one; otherwise explicit activity takes precedence, then project logs in scan order. All contributing source IDs are retained. Conflicting measurements are disclosed rather than added together.

When sources cover the same connection/model and unmatched records lack a comparable API request ID, lower-priority unmatched records are excluded from combined totals; **Sources** retains each source's separate count and explains the unresolved overlap. This conservative rule can omit genuinely distinct activity rather than claim an unverified sum. Sources using different aliases for the same connection cannot always be correlated; this is not universal cross-system matching. OpenMerit task summaries are always retained separately and never establish request coverage. The snapshot reports `discovery.requestSource` (`combined` for multiple contributing sources), `requestSources`, and reconciliation counts for included, matching, excluded, and conflicting records.

### Local model runtimes

Ollama is read only at a project-declared endpoint, using `GET /api/tags` and `GET /api/ps`. For example, declare `OLLAMA_BASE_URL=http://127.0.0.1:11434` in the application’s `.env`, or use the explicit `ollama` field below. Merely having Ollama running does not add it to this project’s terminal. This provides installed models, loaded models, and available model-allocation metadata. It does not supply request history. Loaded means resident in memory, not necessarily generating.

Other local servers can be declared in `.openmerit/terminal.json`:

```json
{
  "activityFile": ".openmerit/inference.jsonl",
  "ollama": "http://127.0.0.1:11434",
  "runtimes": [
    { "name": "LM Studio", "type": "openai-compatible", "url": "http://127.0.0.1:1234" },
    { "name": "vLLM", "type": "vllm", "url": "http://127.0.0.1:8000" }
  ],
  "inventory": [
    { "name": "Your gateway", "kind": "gateway", "location": "cloud" },
    { "name": "Your model", "kind": "model", "provider": "Your provider", "location": "cloud" }
  ]
}
```

Restart the terminal after configuration changes. Set `ollama` to `false` to disable its discovery. Runtime URLs must be HTTP loopback origins with no credentials, path, query, or fragment. Remote and authenticated runtime endpoints are not supported in this initial version. The runtime list is limited to eight entries; omitted entries are disclosed on the configuration source. `runtimes[].type` also accepts `ollama` for native inventory/residency reads. Optional `hostId`, `location`, and `servingMode` fields supply explicit placement. `hostId: "this-machine"` links this operating-system host and local location; another ID links an exported host. Without those fields, host and serving mode remain unknown even for a loopback URL. The legacy `ollama` URL field identifies an endpoint only and makes no host assignment.

`openai-compatible` reads `GET /v1/models`. Models are labeled available; the list does not prove they are loaded. `vllm` also reads `GET /metrics` for running/waiting requests, inference cache usage, and cumulative input-token, output-token, and finished-request counters. Cache usage is the highest valid `vllm:kv_cache_usage_perc` series, expressed as a percentage; percentages are not summed across workers. These runtime aggregates are displayed separately from imported request totals and are not attributed to projects. Counters can reset when a runtime restarts.

To associate a runtime with this machine, declare that relationship only when it is known:

```json
{
  "runtimes": [
    {
      "name": "Ollama",
      "type": "ollama",
      "url": "http://127.0.0.1:11434",
      "hostId": "this-machine",
      "servingMode": "self-hosted"
    }
  ]
}
```

An SSH tunnel or proxy can use the same loopback URL while its model host is elsewhere. Omit `hostId` unless supplied by configuration or an exporter. Native Ollama residency remains available at the endpoint without attaching it to the laptop. Generic API-compatible sources are **Model endpoints** until a runtime protocol or explicit role establishes more; their service type remains unclassified when unknown.

The optional `inventory` accepts `model`, `provider`, `gateway`, `router`, and `runtime` entries. Entries are declared configuration until supported by observations. Supported project-file declarations can also identify configured services, as described below. Inherited process-environment variables are ignored for project inventory. Their credential values are not returned or used to call those services. Automatic discovery additionally reads the supported project declarations and request logs described above. Credential stores and arbitrary processes are not scanned.

### Service inventory

The **Services** tab replaces Connections. It opens on a compact inventory with type filters and service/model search; the **Environment map** switch preserves the topology view. Existing `#connections` links open that map, while `#services` opens Services. The overview keeps its compact map.

Service rows come from declared non-model inventory, configured runtime sources, serving-provider metadata, deployments, and recorded path names. A model's `modelCreator` does not create a service row or establish an API connection to that lab. Names remain as reported. Exact curated aliases can share a row only when there is one unambiguous existing service and the alias is not separately declared. Explicitly declared service names remain separate.

Types are **Model API**, **Inference cloud**, **Router**, **Gateway**, **Runtime**, or **Unclassified**. Explicit declared/reported router, gateway, and runtime roles take precedence over the known-service registry. A `provider` inventory entry can set `serviceType` to `model-api` or `inference-cloud`; this also takes precedence over the registry. Multiple explicit roles remain visible. Known API services use Model API; Baseten, Groq, and Cerebras use Inference cloud. Custom providers without a supplied subtype remain unclassified. These roles describe services; the existing five request-path categories are unchanged. No new type implies discovered hardware or a verified network path.

Requests, paths, median latency, and supplied USD spend cover the selected window. A request counts once per service, even if a hop repeats, but can touch several services: row totals are not additive. Latency and spend describe the whole recorded request, not service-added latency or the service's bill. Last activity comes from all retained records; a service can therefore show activity outside the selected window. Models/deployments include inventory plus relationships reported in that window. Shared pools are linked only through explicit service or serving-deployment associations, not assigned to every intermediary in a path. A displayed capacity reading is one reported pool measurement, with its description directly beneath the value on the same right edge; full pool details remain in the inspector.

Configuration, inventory, and activity evidence are distinct. A configured service with no requests says **Configured only**; inventory does not imply connectivity, current health, available capacity, or usage. Every inspector includes the fields and sources behind the identity. Filtering and inspecting services remain passive and make no external requests.

### Inference services and model creators

The terminal recognizes configuration evidence for Baseten, Groq, and Cerebras alongside the existing services below. The full set is documented under **Additional inference endpoints**. The configuration reader described here uses supported literal declarations in the selected project’s `.env` and `.env.local` files. The repository index additionally reads supported code and nested configuration as described under Repository indexing. Global shell variables do not establish project ownership. Shell histories and credential stores are not scanned; source indexing follows the bounded syntax rules above. A configured service does not establish an active connection, model inventory, usage, available capacity, or a hardware allocation.

| Service | Credential-variable names | Optional endpoint-variable names |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_BASE_URL`, `OPENAI_API_BASE` |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` |
| OpenRouter | `OPENROUTER_API_KEY` | — |
| Google | `GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_API_KEY` | — |
| Groq | `GROQ_API_KEY` | `GROQ_BASE_URL` |
| Cerebras | `CEREBRAS_API_KEY` | `CEREBRAS_BASE_URL` |
| Baseten | `BASETEN_API_KEY` | `BASETEN_BASE_URL` |

Nonempty credential variables identify a configured service by variable name. Endpoint overrides take precedence for that SDK's group: for example, `OPENAI_BASE_URL=https://api.groq.com/openai/v1` identifies Groq rather than OpenAI. Recognized HTTPS hosts are `api.openai.com`, `api.anthropic.com`, `openrouter.ai`, `api.groq.com`, `api.cerebras.ai`, `inference.baseten.co`, and Baseten's `model-<id>.api.baseten.co` hosts. User information and nonstandard ports are rejected. Unknown, local, or malformed overrides suppress that group's credential-name fallback; the source reports only the unrecognized variable name. Multiple configured endpoints do not establish which one an application uses.

Service details show the identifying variable and whether the evidence was a credential name or a recognized endpoint. Project-file sources identify declarations from each file and any unknown endpoints. Credential values and raw endpoint URLs, including their paths and queries, never enter the snapshot. Recognized endpoint hostnames may appear in service evidence; Baseten deployment identifiers are redacted as `model-….api.baseten.co`. Configured local runtimes can display their validated loopback host and port. No arbitrary endpoint URL becomes a link. Detection makes no cloud requests and does not assign a request path or rewrite recorded providers from ambient environment configuration.

Supply `modelCreator` in activity metadata, model inventory, deployments, or exported loaded-model entries when that identity is available. The model inspector shows the reported creator separately from **Served by**, including its source. Conflicting creator reports for the same model/service leave the inventory creator unresolved. Existing family icons are visual recognition only; they do not populate creator metadata. An explicit creator takes precedence over family icon matching. Baseten, Groq, and Cerebras service icons are bundled locally.

For example, an export may report `model: "gpt-oss-120b"`, `modelCreator: "OpenAI"`, and `provider: "Groq"`. An application using a gateway still reports its gateway path; the serving company does not change that category. No account API, inference call, remote hardware discovery, or model availability check is performed by this detection.

### Additional inference endpoints

The provider/runtime discovery reader recognizes 39 cloud/API/router/gateway service identities, including the two Hugging Face products described below. It reads supported literal declarations in the selected project's `.env` and `.env.local`; the file's presence does not prove the application loaded it. The separate repository index can identify additional nested declarations and conservative source references without probing their URLs. No installation, API request, account access, or additional permission is needed to recognize these declarations.

Any recognized endpoint can be supplied through `OPENAI_BASE_URL` or `OPENAI_API_BASE`, even when the application uses an OpenAI-compatible SDK for another service. The following additional variable names are accepted. Endpoint aliases are supported application conventions, not a claim that every vendor SDK reads them automatically. A nonempty credential declaration is recorded only as **Configured**; its value is discarded. An endpoint override suppresses that group's credential-based vendor fallback, including when the URL is unknown or malformed.

| Service | Credential declarations | Endpoint declarations |
| --- | --- | --- |
| [Mistral](https://docs.mistral.ai/getting-started/quickstarts/developer/first-api-request) | `MISTRAL_API_KEY` | `MISTRAL_BASE_URL`, `MISTRAL_SERVER_URL` |
| [DeepSeek](https://api-docs.deepseek.com/) | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` |
| [Cohere](https://docs.cohere.com/docs/compatibility-api) | `COHERE_API_KEY`, `CO_API_KEY` | `COHERE_BASE_URL` |
| [xAI](https://docs.x.ai/developers/rest-api-reference/inference) | `XAI_API_KEY` | `XAI_BASE_URL` |
| [Voyage AI](https://docs.voyageai.com/docs/embeddings) | `VOYAGE_API_KEY` | `VOYAGE_BASE_URL` |
| [Jina AI](https://jina.ai/embeddings/) | Endpoint required | `JINA_BASE_URL` |
| [Together AI](https://docs.together.ai/docs/inference/openai-compatibility) | `TOGETHER_API_KEY` | `TOGETHER_BASE_URL` |
| [Fireworks AI](https://docs.fireworks.ai/tools-sdks/openai-compatibility) | `FIREWORKS_API_KEY` | `FIREWORKS_BASE_URL` |
| [DeepInfra](https://docs.deepinfra.com/chat/overview) | `DEEPINFRA_API_KEY`, `DEEPINFRA_API_TOKEN` | `DEEPINFRA_BASE_URL` |
| [Replicate](https://replicate.com/docs/reference/how-does-replicate-work/) | `REPLICATE_API_TOKEN` | `REPLICATE_BASE_URL` |
| [NVIDIA API Catalog](https://docs.api.nvidia.com/nim/reference/llm-apis) | Endpoint required | `NVIDIA_BASE_URL`, `NVIDIA_NIM_BASE_URL` |
| [SambaNova](https://docs.sambanova.ai/docs/en/integrations/vscode) | `SAMBANOVA_API_KEY` | `SAMBANOVA_BASE_URL` |
| [Novita AI](https://docs.novita.ai/api-reference/model-apis-llm-create-chat-completion) | `NOVITA_API_KEY` | `NOVITA_BASE_URL` |
| [Nebius Token Factory](https://nebius.com/blog/posts/launch-production-agents-at-scale) | Endpoint required | `NEBIUS_BASE_URL` |
| [SiliconFlow](https://docs.siliconflow.com/en/userguide/quickstart) | `SILICONFLOW_API_KEY` | `SILICONFLOW_BASE_URL` |
| [Azure OpenAI](https://learn.microsoft.com/en-us/azure/ai-studio/ai-services/concepts/endpoints) | Endpoint required | `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_API_BASE` |
| [Azure AI Foundry](https://learn.microsoft.com/en-us/azure/ai-studio/ai-services/concepts/endpoints) | Endpoint required | `AZURE_AI_ENDPOINT`, `AZURE_AI_INFERENCE_ENDPOINT`, `AZURE_INFERENCE_ENDPOINT` |
| [Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html) | `AWS_BEARER_TOKEN_BEDROCK` | `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`, `BEDROCK_ENDPOINT_URL`, `BEDROCK_BASE_URL` |
| [Amazon SageMaker](https://docs.aws.amazon.com/sagemaker/latest/dg/realtime-endpoints-openai-compatible.html) | Endpoint required | `AWS_ENDPOINT_URL_SAGEMAKER_RUNTIME`, `SAGEMAKER_ENDPOINT_URL`, `SAGEMAKER_BASE_URL` |
| [Google Vertex AI](https://docs.cloud.google.com/api-gateway/docs/model-routing-configure) | Endpoint required | `VERTEX_AI_ENDPOINT`, `VERTEX_AI_BASE_URL` |
| [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/) | Endpoint required | `CLOUDFLARE_WORKERS_AI_BASE_URL` |
| [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/usage/universal/) | Endpoint required | `CLOUDFLARE_AI_GATEWAY_URL` |
| [Portkey](https://portkey.ai/blog/using-openai-agentkit-with-anthropic-gemini-and-other-providers/) | `PORTKEY_API_KEY` | `PORTKEY_BASE_URL`, `PORTKEY_GATEWAY_URL` |
| [Vercel AI Gateway](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions) | Endpoint required | `AI_GATEWAY_BASE_URL`, `VERCEL_AI_GATEWAY_BASE_URL` |
| [Alibaba Cloud Model Studio](https://help.aliyun.com/en/model-studio/base-url) | `DASHSCOPE_API_KEY` | `DASHSCOPE_BASE_URL`, `DASHSCOPE_API_BASE` |
| [MiniMax](https://platform.minimax.io/docs/api-reference/text-openai-api) | `MINIMAX_API_KEY` | `MINIMAX_BASE_URL` |
| [Moonshot AI](https://platform.kimi.ai/docs/overview) | `MOONSHOT_API_KEY` | `MOONSHOT_BASE_URL` |
| [Z.AI](https://docs.z.ai/guides/overview/quick-start) | `ZAI_API_KEY` | `ZAI_BASE_URL` |
| [Perplexity Sonar and Router](https://docs.perplexity.ai/docs/getting-started/quickstart) | Endpoint required | `PERPLEXITY_BASE_URL` |

Existing services also gain `OPENROUTER_BASE_URL`, `GEMINI_BASE_URL`, and `GOOGLE_GEMINI_BASE_URL`. Gemini's `generativelanguage.googleapis.com` endpoint identifies **Google**, separate from **Google Vertex AI**.

#### Supported endpoint boundaries

The registry uses exact HTTPS API hostnames or anchored service-specific formats. It does not match a company name anywhere in a URL. URL user information, nonstandard ports, control characters, and lookalike domains are rejected. Unknown declarations retain only their variable name in source coverage. No remote DNS lookup or HTTP request is made.

- **Model APIs:** `api.mistral.ai`, `api.deepseek.com`, `api.cohere.ai` / `api.cohere.com`, `api.x.ai`, `api.voyageai.com`, `api.jina.ai`, `api.minimax.io`, `api.moonshot.ai`, and `api.z.ai`.
- **Inference clouds:** `api.together.ai` / `api.together.xyz`, `api.fireworks.ai`, `api.deepinfra.com`, `api.replicate.com`, `integrate.api.nvidia.com`, `api.sambanova.ai`, `api.novita.ai`, `api.studio.nebius.com` / `api.studio.nebius.ai`, and `api.siliconflow.com` / `api.siliconflow.cn`. NVIDIA's hosted API does not imply local NIM or NVIDIA hardware.
- **Azure:** single-resource `*.openai.azure.com` endpoints identify Azure OpenAI. `*.services.ai.azure.com` with a root, `/models`, or `/openai` path identifies Azure AI Foundry. Foundry project-management URLs are not accepted. Resource labels are redacted to `…`.
- **AWS:** regional `bedrock-runtime[‐fips].<region>.amazonaws.com` and `runtime[‐fips].sagemaker.<region>.amazonaws.com` hosts, including the `.com.cn` suffix, identify their respective services. Control-plane and unrelated AWS hosts do not match. These are structural service identities, not a claim that every region exposes every API.
- **Vertex:** `aiplatform.googleapis.com` and regional `<region>-aiplatform.googleapis.com` identify Google Vertex AI. Project IDs and endpoint IDs in paths are discarded. A generic Google API key or service-account file does not establish Vertex usage.
- **Cloudflare:** Workers AI requires `api.cloudflare.com/client/v4/accounts/<account>/ai...`; other Cloudflare API paths do not match. `gateway.ai.cloudflare.com` identifies Cloudflare AI Gateway separately. Account, gateway, and model path segments are never retained.
- **Gateways:** `api.portkey.ai` and `ai-gateway.vercel.sh` identify Portkey and Vercel AI Gateway. These do not establish which downstream providers or models were used.
- **Alibaba:** the documented `dashscope`, `dashscope-intl`, `dashscope-us`, and `cn-hongkong.dashscope` hosts under `aliyuncs.com`, plus workspace hosts in the Beijing, Hong Kong, Singapore, and Tokyo `maas.aliyuncs.com` regions. Workspace labels are redacted to `….maas.aliyuncs.com`. This is a serving platform; it does not imply Qwen as the model creator.
- **Perplexity:** the legacy API base/root, `/v1`, and `/chat/completions` identify Sonar; `/router...` identifies Perplexity Router. Search and agent-product paths do not imply either service. A generic Perplexity key alone does not identify the product.

Generic AWS credentials, `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, Azure keys without an endpoint, `CLOUDFLARE_API_TOKEN`, `NVIDIA_API_KEY`, `NGC_API_KEY`, `NEBIUS_API_KEY`, `JINA_API_KEY`, `AI_GATEWAY_API_KEY`, and `VERCEL_OIDC_TOKEN` are not used as standalone discovery evidence. Provider SDK dependencies only produce an SDK hint. Services with no bundled logo use their name; a model never inherits its serving platform's brand.

**Coverage is still bounded.** Custom domains, private/LAN endpoints, unlisted regional or sovereign-cloud variants, serverless application URLs (for example, custom Modal or RunPod deployments), and URLs assembled only in application code are not automatically identified by this registry. Self-hosted LiteLLM, vLLM, SGLang, NIM, or other compatible servers cannot be distinguished merely from an arbitrary URL or port. A declared safe loopback endpoint can still expose a supported catalog through the existing runtime discovery path, without inventing its runtime identity or physical host. Explicit terminal inventory can name other services and their roles.

Configured services add no historical requests, model catalog, agent names, tokens, cost, deployments, or hardware. Supported saved request logs and explicit inventory remain the source for those fields. A previously active project whose logs were never saved cannot reconstruct past calls from a URL or API key. Known service names in recorded metadata can be classified, but the registry does not insert unreported request-path hops or rewrite provider names.

### Hugging Face endpoints

The provider/runtime reader recognizes literal endpoint declarations in the selected project's `.env` and `.env.local`.

| Endpoint host | Service in the terminal | Type |
| --- | --- | --- |
| Subdomains of `endpoints.huggingface.cloud` | Hugging Face Endpoints | Inference cloud |
| `router.huggingface.co` | Hugging Face Router | Router |

The reader accepts the documented `HF_INFERENCE_ENDPOINT` variable, application aliases `HF_ENDPOINT_URL` and `HUGGINGFACE_ENDPOINT_URL`, and existing supported SDK base-URL overrides such as `OPENAI_BASE_URL`. For example:

```dotenv
HF_INFERENCE_ENDPOINT=https://your-endpoint.us-east-1.aws.endpoints.huggingface.cloud
OPENAI_BASE_URL=https://router.huggingface.co/v1
```

These declarations identify two configured services; they do not establish that either endpoint is reachable or has served requests. Endpoint subdomains are redacted to `….endpoints.huggingface.cloud`; paths, query strings, fragments, and tokens are not exposed. HTTPS is required, user information and nonstandard ports are rejected, and lookalike domains do not match. An unknown base URL never falls back to the SDK vendor. Generic Hub URLs and custom domains remain unidentified unless explicitly declared in the terminal inventory.

`HF_TOKEN`, `HUGGING_FACE_HUB_TOKEN`, `HUGGINGFACEHUB_API_TOKEN`, and the Hub's `HF_ENDPOINT` do not establish an inference service and are not used for discovery. Declaring `@huggingface/inference`, `huggingface_hub`, or `huggingface-hub` produces only an SDK hint. A model downloaded from the Hub does not establish Hugging Face as its serving provider.

The terminal makes no remote calls, reads no Hugging Face token cache, and fetches no account history or model catalog. Models, requests, tokens, costs, agents, and deployment links still require recorded metadata or explicit inventory. Supported request logs can use `provider: "Hugging Face Endpoints"` or `route: "Hugging Face Router"` to identify the corresponding service. A generic `Hugging Face` name remains unclassified; the terminal does not choose a product or serving provider for it. The two products share a locally bundled official logo but remain separate service identities.

The recognized formats follow Hugging Face's [environment-variable documentation](https://huggingface.co/docs/huggingface_hub/en/package_reference/environment_variables), [dedicated endpoint guide](https://huggingface.co/docs/huggingface_hub/guides/inference_endpoints), and [inference router documentation](https://huggingface.co/docs/inference-providers/index). The repository index also reads supported literal source declarations and custom dotenv names referenced by supported inference fields; dynamic expressions and cross-file imports remain unresolved.

### Deployments and shared capacity

A model identity is separate from a deployment of that model. Declare deployment identities and shared resource pools in `.openmerit/terminal.json`. These are metadata declarations, not credentials or endpoints to call:

```json
{
  "deployments": [
    {
      "id": "assistant-primary",
      "name": "US East / primary",
      "model": "your-model",
      "provider": "your-serving-service",
      "modelCreator": "your-model-creator",
      "servingMode": "dedicated",
      "location": "cloud",
      "poolIds": ["provider-account"]
    }
  ],
  "capacityPools": [
    { "id": "provider-account", "name": "Provider / shared account", "kind": "quota", "windowSeconds": 60 },
    { "id": "llm-gateway-pool", "name": "llm-gateway", "kind": "gateway" }
  ],
  "inventory": [
    { "name": "llm-gateway", "kind": "gateway", "location": "cloud", "poolIds": ["llm-gateway-pool"] }
  ],
  "capacityFile": ".openmerit/capacity.json"
}
```

Deployments may supply `modelCreator` and `servingMode` (`shared`, `dedicated`, `self-hosted`, or `unknown`). These are declarations; no mode is inferred from a company name or credential. Declared deployments also contribute configured models to the inventory when no runtime or activity source has listed them. Hardware stays “Not reported” until a matching host export supplies it.

Deployment locations accept `local`, `private`, `cloud`, or `unknown`. Pool kinds accept `quota`, `runtime`, `gateway`, or `unknown`. Limits are 200 deployments, 100 pools, and 16 pool references per entry; labels and IDs are capped at 160 characters. Duplicate IDs are excluded rather than resolved arbitrarily. IDs beginning with `runtime:` are reserved for discovery. An optional deployment `hostId` links to the exact host ID in Local compute; an absent or unmatched ID stays unplaced. Configuration changes require restarting the terminal.

Activity exports can add `"deploymentId":"assistant-primary"` to a record with the same model and provider. An optional `path` can report ordered router/gateway/runtime connections. Connection-to-pool links use exact, unambiguous name and kind matches in inventory; deployment-to-pool links use explicit IDs. These dependencies are declarations, not independently verified network paths. One request may touch several pools; repeated links to the same pool count it only once. Pool request counts must not be summed as a total of unique requests.

Local runtime inventories also create deployment identities and a shared runtime pool. Catalog entries identify models at an endpoint, not verified physical instances. They retain unknown placement and serving mode unless the runtime configuration supplies them; a loopback address can be a proxy or tunnel. Discovered IDs are `runtime:<model inventory id>` for deployments and `runtime:<source id>` for pools; inspect the snapshot to obtain them. Existing activity must explicitly reference those IDs to join to discovered deployments. No association is guessed from an equal model name. A loaded model means resident memory, not available concurrency. Declared and discovered instances are not automatically merged.

Export existing capacity measurements to the project-local JSON file (defaults to `.openmerit/capacity.json`):

```json
{
  "pools": [
    {
      "id": "provider-account",
      "observedAt": "2026-10-07T08:00:00Z",
      "resetAt": "2026-10-07T08:01:00Z",
      "metrics": { "requestsUsed": 842, "requestsLimit": 1000, "tokensUsed": 630000, "tokensLimit": 1000000 }
    },
    {
      "id": "llm-gateway-pool",
      "observedAt": "2026-10-07T08:00:00Z",
      "metrics": { "running": 46, "concurrencyLimit": 50, "waiting": 4 }
    }
  ]
}
```

The file is read on the normal passive interval. Write a complete JSON object, preferably by atomic replacement. It is limited to 128 KiB and must resolve to a regular file within the project. Only declared pool IDs and allowlisted fields are used. Invalid or unavailable files clear exported readings; no old measurement is silently marked current. Only the first 100 entries are considered. Duplicate IDs and invalid/future timestamps are excluded. The terminal does not call cloud account APIs to populate these measurements.

Supported nonnegative numeric metrics are `running`, `waiting`, `concurrencyLimit`, `requestsUsed`, `requestsLimit`, `tokensUsed`, `tokensLimit`, `cachePercent` (0–100), `memoryUsedBytes`, and `memoryTotalBytes`. Missing or invalid values stay unknown; zero stays zero. Limit bars require both a usage value and a positive limit. Counts may exceed a limit; text retains the measurement while bar width caps at 100%. A pool's declared `windowSeconds` describes the exported quota window; it is independent of the selected activity window. `resetAt` is source-reported metadata and does not trigger a reset or action.

The inspector shows the source timestamp and marks readings older than three collection intervals stale. Checking a file does not refresh the measurement's age. vLLM running/waiting and cache readings populate its discovered runtime pool; Ollama and compatible inventory alone provide no capacity measurement. Pool totals cover all consumers of that resource, including other projects. Shared agents are identified from retained activity in the selected window, not from pool counters. These readings do not establish agent-level resource attribution, bottleneck causality, remaining headroom, or guaranteed readiness.

The overview previews three pools, prioritizing recent measured utilization fractions. The full list includes stale and missing readings. Agent inspectors offer separate Deployments, Paths, and Capacity views. Capacity inspectors show shared agents, and selecting one returns to that agent's environment. Inspector contents refresh on the normal poll without resetting scroll or keyboard focus. Unknown deployment identities, missing pool links, and unavailable readings remain visible gaps.

### This machine

CPU utilization is sampled from operating-system CPU time deltas and is unknown until two samples exist. Memory is total physical memory minus reported free memory. These measurements describe the whole machine. macOS cache and reclaimable-memory behavior can differ from Activity Monitor's presentation.

The terminal retains up to 240 samples per host in memory. The operating-system collector does not collect GPU utilization; additional accelerator readings can come from the hardware export below. Energy and hardware costs are not inferred. Ollama's reported VRAM allocation can overlap system memory on unified-memory machines; these values must not be added together.

### Additional hosts and racks

The **Local compute** inventory includes this machine only when a runtime or deployment explicitly declares `hostId: "this-machine"`. A cloud-only project has no automatically added host. The snapshot’s legacy `machine` object remains available as whole-machine context with `scope: "whole-machine"` and `projectLinked`; consumers should use `hosts` for the scoped compute inventory. The local host uses the reserved ID `this-machine`. Its display name is the full operating-system hostname. Additional hosts are supplied by an existing exporter through `.openmerit/hosts.json`. An optional `hardwareFile` in `.openmerit/terminal.json` changes that project-local path. The terminal reads this file on its normal 10–30-second polling interval; it does not connect to remote hosts, scan networks, or install collectors. Each host may supply `name` and/or `hostname`; display precedence is `name`, `hostname`, then `id`. Snapshots expose the selected field as `nameField`. Site and rack are optional export labels, not discovered locations. The site filter is hidden when no host reports a site.

For example, an exporter can atomically replace this JSON file with its latest measurements:

```json
{
  "hosts": [{
    "id": "gpu-01",
    "name": "Inference 01",
    "site": "Primary",
    "rack": "Rack A",
    "observedAt": "2026-10-07T12:00:00Z",
    "chip": "AMD EPYC",
    "cores": 64,
    "platform": "linux",
    "arch": "x64",
    "cpuPercent": 32.4,
    "memoryTotal": 274877906944,
    "memoryUsed": 137438953472,
    "accelerators": [{
      "id": "gpu-0",
      "name": "NVIDIA H100",
      "vendor": "NVIDIA",
      "kind": "gpu",
      "utilization": 72,
      "memoryTotal": 85899345920,
      "memoryUsed": 42949672960
    }],
    "loadedModels": [{
      "id": "model-instance-1",
      "name": "example-model",
      "provider": "Private runtime",
      "runtime": "vLLM",
      "deploymentId": "private-model-primary",
      "memoryBytes": 38654705664,
      "memoryKind": "accelerator"
    }]
  }]
}
```

Replace the example timestamp with the actual measurement time. Each host retains its own timestamp; reading the file again does not refresh it or create a new history sample. A reading older than three collection intervals is marked stale. Future or absent timestamps cannot establish utilization or model residency. Static inventory such as processor name and memory capacity can still be listed. A removed host, invalid file, oversized file, or failed read clears imported hosts and their histories; this machine remains available.

The export is bounded to 256 KiB, 64 hosts, 16 accelerators per host, and 100 loaded-model entries per host. Labels and IDs are capped at 160 characters. Duplicate IDs within each list are excluded, and exported `this-machine` entries are rejected. Files must be regular files inside the project after symlink resolution. Unsupported fields are discarded. Only supplied metadata is retained; endpoints, credentials, prompts, and responses are not imported.

CPU and accelerator utilization are percentages from 0 to 100; memory fields are nonnegative bytes, displayed as GiB. Used memory exceeding a supplied total is discarded. Missing metrics remain unknown, and zero remains zero. System RAM, accelerator memory, and model allocations are displayed separately and are never added into a misleading fleet total. Hosts can contain mixed accelerator types. Optional accelerator `vendor` and `kind` fields identify reported hardware; supported kinds are `gpu`, `lpu`, `wse`, `npu`, `tpu`, `other`, and `unknown`. They are never inferred from an inference service, and do not supply missing utilization or memory readings. Fleet counts describe listed inventory, not usable capacity.

**Loaded models** means source-reported residency, not an active request or guaranteed readiness. `memoryKind` accepts `accelerator`, `system`, `unified`, or `unknown`; it identifies the allocation being reported. An omitted `loadedModels` field means residency is unknown; an empty array means the source explicitly reported no loaded models. Stale hosts show their last reported models. Exported model names also enter the model inventory as private models, with unknown current state when their host reading is stale. Replicas are kept separate in each host's residency list. Model identity matches do not establish deployment placement: declare the matching `hostId` on a deployment to make that link.

The operating-system view currently receives loaded-model evidence from Ollama's `/api/ps`. A compatible `/v1/models` catalog establishes availability, not residency. Runtime counters remain associated with their host and retain their separate lifetime scope.

### Model and service identities

Small, locally bundled official marks identify recognized services and model families throughout the terminal: the overview and Models table, environment-map nodes, deployment lists, activity rows, loaded models, runtime counters, source rows, shared-capacity panels, search results, and detail inspectors. Marks are unframed and scaled to the surrounding text. The custom colored path-type icons remain separate: a service's identity and its routing role convey different information.

Service names use an exact curated registry, including supported “API” aliases. It covers OpenAI, Anthropic, Google AI, DeepSeek, Mistral, Cohere, Qwen, Meta, Nomic, BAAI, Ollama, vLLM, LM Studio, OpenRouter, and OpenMerit's own mark. Custom services remain text-only beside their path-type icons. An OpenAI-compatible endpoint does not inherit OpenAI branding merely because it supports that protocol.

Model marks identify the recognized family independently of where the model runs. For example, Qwen models carry Qwen's mark while their Ollama runtime carries Ollama's; Llama carries Meta's while vLLM retains its own identity. The registry recognizes GPT and selected OpenAI reasoning/embedding families, Claude, Gemini/Gemma, DeepSeek, Mistral families, Cohere Command/Embed, Qwen, Llama, Nomic Embed, and BGE. Family matching is anchored at the start of a model name. Namespaced IDs must use a recognized official namespace for that family; arbitrary namespaces and unfamiliar names receive no model mark or placeholder. Display names and the reported provider/runtime remain unchanged. A family mark is a visual aid, not verification of model weights or provenance.

All 21 models in the enterprise sample have a consistent identity across inventory, requests, deployments, and host residency. Shared pools receive a service mark only when their declared links resolve unambiguously to one recognized service, or their own exact name is recognized. Decorative images are hidden from assistive technology so a model or service name is announced once; text labels and keyboard behavior remain available.

There are no favicon lookups, third-party image services, or remote asset requests while using the terminal. Asset origins and hashes are recorded in `packages/terminal/brand-assets.json` in the source checkout. The additional model-family references are the publishers' model cards for [Qwen3](https://huggingface.co/Qwen/Qwen3-8B), [Llama 3.3](https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct), [Nomic Embed](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5), and [BGE](https://huggingface.co/BAAI/bge-reranker-v2-m3). Marks identify their respective makers or services and do not imply affiliation.


## Freshness, retention, and limits

Collectors run once per interval with no overlapping collection cycles. Each runtime request has a timeout and a response-size bound. Browser refreshes read the cached snapshot, so additional tabs do not multiply runtime polling. The interface shows a delayed-collection notice when its snapshot is older than three intervals. A successful source check does not mean that source has recent inference activity.

File readers handle partial lines, split UTF-8 writes, and ordinary file rotation. Activity and audit file reads are bounded to 4 MiB, and each reader retains up to 10,000 unique records. Discovered project logs have the stricter per-file and aggregate limits described above. A large initial file imports its tail. Truncation and malformed records are disclosed in source details. Valid retained records have no age cutoff; future timestamps remain excluded. An unavailable or removed file is not kept looking connected.

Inventory bounds remain in place: eight explicit runtimes, eight discovered endpoint candidates after deduplication, 100 declared inventory entries, 200 deployments, 100 declared/exported pools, 16 pool references per inventory/deployment entry, 100 models per endpoint catalog or native Ollama list, 64 exported hosts, 16 accelerators and 100 loaded-model entries per host. Reaching a count bound with additional entries sets **Partial** coverage and reports omitted counts in Sources; the dashboard displays **Inventory is incomplete**. Retained counts mean entries in view, not complete environment totals. Oversized files or responses remain unavailable rather than being silently accepted.

Missing cost provenance stays unknown even when an explicit USD amount is available. Activity marks estimates with `*` and unknown cost basis with `?`; unknown currency amounts are available in record details but excluded from dollar aggregates.

Collected usage is not persisted to a new database. Machine history and imported-record caches are process-local and disappear when the terminal closes. Existing source files remain under their owner's retention policy.

The map represents every retained request, workload, entry connection, and model/service pair in its selected scope. Collapsible groups reduce visual density without removing records. Its footer states the complete represented request count, while deployment evidence and gaps remain available in inspectors. Full retained request metadata is available through the JSON API. There is no inferred quality score, provider billing verification, automatic cloud account connection, or universal inference discovery.

## Agent access

```sh
openmerit dash --json
```

From the checkout:

```sh
node packages/terminal/src/cli.mjs dash /path/to/project --json
```

While the server is running, `GET /api/snapshot` returns the cached JSON object. Schema version 1 contains `mode`, `observedAt`, `interval`, `project`, `models`, `inventory`, `records`, `taskSummaries`, `sources`, `runtimeStats`, `deployments`, `capacityPools`, `hosts`, `machine`, and `discovery`. The optional `discovery` object reports whether discovery is enabled, its last check time, the 60-second configuration discovery interval, candidate count, contributing request sources, and reconciliation coverage. Request records can include `sourceIds`, a supported log `evidenceFormat`, and `conflictingFields`. Colliding local IDs from demonstrably distinct records receive a stable namespaced ID while retaining `originalId`. The host, deployment, and pool fields are optional version-1 snapshot fields; snapshots without them show unknown coverage. `machine` remains the current host for compatibility; `hosts` is the retained project-linked hardware inventory. Sources affected by inventory limits expose `truncated: true` and a `limits` array of `{ collection, limit, omitted }`; their state is `partial`. The UI shows an inventory-coverage notice and per-source omitted counts. Task summaries never establish request coverage. Unknown status, cost basis, and currency are represented by `"unknown"`. Fields containing unsupported measurements use `null` or are absent. `GET /api/sample` returns only fictional data. `GET /api/info` describes the process's mode and interval.

The server binds to `127.0.0.1`, accepts read-only GET requests plus the optional analytics-only POST relay described above, checks Host and Origin, rejects cross-site browser requests, and serves only its bundled assets and explicit API routes. The relay does not change project files or inference state. It provides no general file-serving endpoint. Local processes and other users with access to this machine may still reach the loopback service; this is not a multi-user authentication boundary.

See [security and data](security.md) for the separate OpenMerit orchestration and harness data boundaries.
