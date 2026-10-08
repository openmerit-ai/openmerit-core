# Inference Terminal

The Inference Terminal is an unreleased addition in the source checkout. It gives people and agents a local overview of models, providers, connections, inference activity, and compute. Published `openmerit@0.1.5` does not include this command.

The terminal reads existing metadata independently of inference. It does not call a model, change a route, run evaluations, load or unload models, or store prompts and responses. Closing it does not stop your workloads. Collection consumes a small amount of local CPU, memory, and runtime API capacity; it is not zero-overhead monitoring.

## Share the sample

The [hosted sample preview](https://dash.openmerit.site/) lets you explore the fictional enterprise environment in a browser without installing the terminal. It includes 40 agents, 140 tasks, and 21 models, with the same tabs and inspectors as the local interface. All identities, requests, costs, and hardware readings are illustrative. Shared links use the title **Inference Terminal by OpenMerit** and a dedicated preview image.

The preview is accessible to anyone with the link and asks search engines not to index it. It does not connect to your machine, accept project uploads, make inference calls, or expose the local snapshot API. Its read-only `/api/sample` endpoint returns fictional data. Real environment collection still runs locally through the source-build commands below; sharing this preview does not publish the npm command.

## Start the terminal

From the source checkout, with dependencies installed:

```sh
npm run dash
npm run dash -- /path/to/your/project
```

Open the printed local URL, normally `http://127.0.0.1:4310`. The page uses dark mode only, with neutral graphite surfaces and silver accents. The browser is not opened automatically. Node.js 22.19 or newer is required.

The built package provides the following shell command when installed from this source build:

```sh
openmerit dash
openmerit dash /path/to/your/project --port 4311 --interval 20
```

`npm run dash` bundles the browser interface before starting the server. `npm run build` includes the executable and the local web assets under `dist/terminal/`. Torph and Liveline are bundled locally, with no browser requests to package CDNs. To install that build for shell use, run `npm install -g .` from the checkout. This is a local source installation, not an npm release.

| Option | Behavior |
| --- | --- |
| `[path]` | Project directory; defaults to the current working directory |
| `--port <number>` | Loopback port; defaults to 4310 |
| `--interval <seconds>` | Collection interval from 10 to 30 seconds; defaults to 15 |
| `--no-discovery` | Skip project-file discovery, additional runtime discovery, and optional Pi history for this run; existing OS, Ollama, declared sources, and process-environment metadata remain available |
| `--access` | Review Pi history access for this project in an interactive terminal, then exit; works while another terminal process is running |
| `--revoke-access` | Revoke Pi history access for this project and exit; running collectors apply it on the next poll |
| `--json` | Print one snapshot and exit without starting an HTTP server |
| `--demo` | Use an explicitly fictional environment; no local collectors run |
| `--help` | Show usage |

Use Ctrl+C to close the terminal. There is no persistent daemon or background scheduler. Collection runs only while the command is running. The terminal is separate from Pi's `/openmerit pause` and other orchestration commands.

## Automatic discovery and access

Discovery runs as part of `openmerit dash`; no separate audit command or exporter is needed for supported sources. The first snapshot checks the selected project and known loopback runtime addresses. Project declarations and previously unresponsive addresses are checked again every 60 seconds. Responding runtimes, OS readings, supported usage history, and existing exports refresh at the normal 10–30-second collection interval.

The project scan reads only four fixed files: `.env`, `.env.local`, `package.json`, and `requirements.txt`, each limited to 128 KiB and required to resolve to a regular file inside the project. It does not recursively index source code, execute project code, source shell files, or expand environment expressions. Supported SDK declarations are shown as **Detected** source hints; an installed SDK is not proof of a service connection or request. Supported literal `.env` declarations provide the same service identity evidence as inherited environment variables. Each file is independent evidence; discovery does not pretend to know an application's loading order. Credential contents and unrelated settings are discarded before metadata is retained or returned.

Alongside Ollama's existing default address, discovery checks `http://127.0.0.1:1234` and `http://127.0.0.1:8000`, plus safe HTTP loopback origins in the supported endpoint variables listed below. Endpoint paths must be empty or `/v1`; credentials, queries, fragments, and non-loopback hosts are rejected. At most eight additional origins are checked with read-only `GET /v1/models` and `GET /metrics`, without authentication or redirects. Unknown or nonresponding candidates do not become service rows. Configured origins are not probed twice. A compatible catalog supplies model availability; recognized vLLM counters can also identify vLLM. A port number alone never establishes LM Studio or vLLM identity, so an otherwise unidentified compatible runtime is named by its loopback origin. This is bounded discovery on this machine, not network or remote-host scanning.

**Sources** shows automatic discovery status, per-source coverage, and any access required. Configuration, responding inventory APIs, and recorded activity remain distinct. Missing usage, identities, paths, and measurements stay unknown. Overview request totals and path counts include approved native history even when no activity export exists; retained requests still count when source coverage is partial.

Set `"discovery": false` in `.openmerit/terminal.json`, or pass `--no-discovery`, to skip these additional scans and the optional history reader. Existing explicit exports, declared runtimes, inherited service configuration, machine readings, and Ollama's existing collector remain available. Set `"ollama": false` separately to disable that collector. Restart after changing `terminal.json`; supported declaration files are reread automatically.

### Optional Pi usage history

When the project's standard Pi history directory exists, interactive startup offers a single access choice. The server starts first, so other sources are already available. Until approval, the terminal checks only whether that exact directory exists; it does not enumerate or read session files. Noninteractive runs, including `--json`, never prompt or grant access implicitly. They use an existing grant or report **Needs access**.

Pi sessions can contain conversation text. Approval permits the reader to parse those files, but only assistant usage metadata is retained in memory and exposed: model, reported provider, request timestamp, terminal status, tokens, and estimated USD cost. Prompts, completions, tool results, and arbitrary message fields are discarded. No source file is modified. This adapter supports Pi session format version 3, verified against Pi 0.87. It reads the current project's directory under `~/.pi/agent/sessions`, respecting an inherited `PI_CODING_AGENT_DIR`. Custom per-session directories and other tools' private history formats are not supported.

The reader verifies each session header's canonical project path. It counts terminal assistant entries, including tool-use completions and failed/aborted entries with usage; pending entries are excluded. Stable session/entry IDs replace duplicates. Input tokens include recorded input, cache reads, and cache writes only when all three values are present. Pi's SDK cost is marked **estimated**, not a verified provider bill. Workload is identified as **Pi**, the source application. The recorded Pi provider ID is also retained as the connection name: this identifies the provider connection selected by Pi, not a guessed serving company. The existing inventory/runtime matcher supplies a category only when that name matches unambiguous evidence. A custom name stays visible even if its type is unknown. Session IDs do not become invented agent/task identities; duration, deployment, hidden hops, model creator, and per-request hardware are not inferred. Current Pi credential or model configuration files are not read to reconstruct historical endpoints.

Choices are stored outside the repository in `~/.openmerit/terminal-access.json`, keyed to the canonical project and history-directory paths. The file is created with owner-only permissions where supported. Repository configuration cannot grant access; selecting a different canonical history directory requires a new choice. Review or revoke from the project directory:

```sh
openmerit dash --access
openmerit dash --revoke-access
```

`--access` requires an interactive terminal and exits after the choice; it does not bind another server port. Revocation is checked on every collection and clears cached Pi metadata. The browser has no permission-granting API. The operating system may still deny access; this choice cannot override OS permissions. Access storage must remain outside the selected project.

Pi reads are bounded to 512 directory entries, the newest 32 recently modified regular session files, 512 KiB of new session data per file, and 4 MiB of session data per poll, plus an at-most-8-KiB header check for each newly opened or replaced file. Each file retains at most 312 usage records; results cover at most the last 24 hours. Unsupported, unreadable, malformed, and truncated histories are disclosed as partial coverage. Symbolic-link session files are skipped. Source files retain their owner's original retention policy.

This first discovery layer does not read Codex or Claude Code histories, retrieve cloud account usage, inspect arbitrary processes, or invent missing application metadata. Supported local runtime inventory does not expose historical requests by itself. Applications without a supported history source can still use the optional activity export below.

## Explore the environment

Pages, detail panels, and inventory cards lead directly with their title. Supporting context appears below the title; there are no small uppercase labels above headings.

- **Overview:** inventory counts, observed usage, a map of recorded workload-to-deployment connections, shared capacity, and recent activity.
- **Models:** filter by self-hosted (local or private) or cloud location, search models, and inspect their available measurements. Rows lead with the model name, followed by the serving service, location, and observed request paths. Select the name to open its details.
- **Services:** a searchable inventory of model APIs, inference clouds, routers, gateways, and runtimes identified in the environment. Each service opens its models, deployments, recorded paths, explicitly linked capacity pools, and identity evidence. The secondary **Environment map** view contains the deployment map, agent focus selector, deployment list, and shared pools. Selecting an agent opens Deployments, Paths, and Capacity views. Selecting an entry connection reveals its reported hop sequence; deployment and capacity nodes open their evidence and shared dependencies. A path is a source-reported connection, not a network inspection or an enforced routing policy.
- **Activity:** a request-volume chart stacked in the five request-path colors, with selectable path totals and the most recent 100 request summaries in the selected 1-, 6-, or 24-hour window. Aggregate totals include all retained records in that window. Selecting a path isolates its chart series while the activity table keeps the full window. Chart bins support pointer inspection and Left/Right or Home/End keyboard navigation; map nodes also support keyboard inspection.
- **Local compute:** this machine and exported self-hosted servers, grouped by supplied site and rack labels, a reported-site filter when site labels exist, and per-host CPU, system RAM, accelerator readings, loaded models, and optional vLLM counters. Select a host to inspect its resources. Missing measurements and stale readings remain explicit. This does not attribute machine usage to an individual request.
- **Sources:** successful connections, unavailable sources, collection gaps, and setup instructions.

Use Command+K or Control+K to find a view, model, source, or reported agent/task. Escape closes details. Keyboard actions remain immediate, and reduced-motion preferences disable movement transitions.

Dropdowns share a dark menu, inset chevron, and neutral focus and selection states. For the agent and host-location selectors, use Enter, Space, or an arrow key to open; arrows, Home/End, or typing a name prefix move through options. Enter or Space confirms, Escape cancels, and Tab confirms and continues through the page. Clicking outside dismisses the menu. An open menu preserves its options and position during passive polling; underlying collection continues.

When request metadata includes stable agent or task IDs, the overview leads directly with their counts for the selected window, without an “Observed” prefix. Select a count to browse those agents or tasks and inspect their request totals, models, connections, and available measurements. Records without these IDs do not contribute to those counts. These are activity summaries, not an agent registry or a task lifecycle tracker; a completed inference request does not establish that its task is complete. The overview previews up to twelve models and ten recent requests. The Models view contains the full retained model inventory; Activity lists the latest 100 requests.

### Where names come from

The terminal does not infer agent roles, task descriptions, service identities, or physical locations from arbitrary source code, prompts, or model output. Being present in a repository does not establish that an agent ran. This build reads supported metadata exports, explicit configuration, runtime inventory, and the operating system. A codebase integration must export its existing identifiers; it should not generate nicer descriptions to fill gaps.

| Identity | Source and fallback |
| --- | --- |
| Project | The selected directory’s basename |
| Agent / task | `agent` / `task` from activity metadata; otherwise the corresponding `agentId` / `taskId`. Without an ID, the record does not establish a counted agent or task. |
| Workload | The exported `workload`, the target ID in an OpenMerit audit summary, or `Pi` for the Pi history adapter. Missing values display “Unattributed workload.” |
| Connection | The exported `route`, first reported path hop, or recorded Pi provider connection ID; inventory names are explicitly declared in `.openmerit/terminal.json`. No name means an unattributed route. |
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

Path counts use the selected activity window, counting each retained request once. The short bars show each category's share of those requests. Models reached through multiple kinds of connection display each observed type. A loaded or configured model without recorded activity says “No path observed.” Model location remains a separate field: a local model can be reached through a gateway, and a cloud provider does not by itself establish a direct path. With **All agents & workloads** selected, the map represents every recorded entry connection in the selected time window. It first reserves a workload for each connection, then fills toward four workloads by recorded volume. It selects model/deployment identities that keep every displayed connection and workload linked by actual records, then fills toward six identities (eight when focusing an agent). These are layout targets, not caps: the map grows and scrolls when coverage needs more nodes. Focusing an agent applies the same connection coverage within that agent’s recorded activity. The header and footer disclose workload, request, and deployment-identity coverage; workloads and models remain representative selections. The middle column shows each entry connection once, with a hop count or the number of distinct reported sequences. Select it to inspect those sequences and their recorded hops. An unidentified deployment remains an explicit gap. Full workload and model lists remain available through their inspectors.

An explicit `routeKind` determines the category. Otherwise, the terminal matches the route name against declared inventory or local runtime source names, ignoring case and surrounding whitespace. A matching provider is direct; a matching router or gateway retains that type; a runtime must be declared local or private. The “Local runtime” path category includes self-hosted private runtimes; the model location and host placement distinguish them from this machine. Conflicting inventory types remain unclassified. The literal route names `Direct` and `Direct API` are also treated as direct connections. It does not promote a generic activity record’s serving `provider` into a route or guess from model location or arbitrary substrings. The Pi adapter is source-specific: Pi’s provider field records its selected connection, so that ID supplies the connection name before classification. The category describes the entry connection once per request. An optional ordered `path` supplies additional reported hops; the terminal never infers hidden intermediaries. When `route` or `routeKind` is omitted, a valid path supplies its first-hop value. A path contradicting an explicit entry name or type is discarded, preserving that explicit entry metadata.

Local compute uses Liveline for CPU and memory history. These are passive readings on the configured collection interval, not a live inference stream. The curve interpolates between recorded points and holds the latest value between polls. Hovering provides chart inspection; the readout below it identifies the nearest **actual sample**, with its timestamp. Focus that readout and use Left/Right, Home, or End to inspect recorded samples with the keyboard. Missing readings or missed collection windows break the history; the chart resumes from the latest uninterrupted run. Reduced motion uses a static chart. Whole-machine usage is not attributed to individual inference requests.

Torph animates changed totals, table measurements, status labels, and source counts while preserving the surrounding interface between polls. Neither animation library changes the collection interval or makes inference calls.

The environment selector opens `inference-sample`, a fictional enterprise workspace with 40 agents, 140 tasks, 21 models, and 9,600 requests over 24 hours. It includes all five path classifications, traffic bursts, running and failed requests, missing measurements, partial and unavailable sources, three self-hosted runtimes, 27 distinct deployments, 14 shared capacity pools, and an hour of host history. Its six hosts include a workstation and five rack servers across two racks, with eleven accelerators listed. Four hosts have recent readings, one is stale, and one has no measurement. Seven loaded models are placed explicitly across three hosts. Six cloud models have separate `us-1` and `eu-1` example deployments. The capacity sample includes twelve recent readings, one stale reading, and one missing reading. Shared gateway pools connect consumers across reported agent IDs. Names resemble exported configuration keys (for example, `support.review` and `llm-gateway`); some agent/task display names are absent and the UI uses their IDs. These identifiers are fictional, not discovered in the current repository. The sample workstation has no site label; server sites and racks are fictional exporter fields. Baseten, Groq, and Cerebras illustrate serving services distinct from model creators; their sample configuration evidence, deployment modes, and quotas are fictional. Model rates, latency, allocation, and utilization values are illustrative; the sample is for inspecting the interface at scale, not a performance benchmark. Sample data never enters the real snapshot or project files. A command started with `--demo` only exposes a sample workspace; restart without that flag to collect real data.

## Collection sources

### OpenMerit evidence

The terminal reads `.openmerit/events.jsonl` for recorded `product_task_completed` automation signals. It imports the model and target identifiers and available cost, token, and duration measurements. It does not treat generic Pi activity as application evidence.

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
| `status` | `running`, `completed`, or `failed`; defaults to `completed` |
| `inputTokens`, `outputTokens`, `cacheReadTokens` | Nonnegative measured counts, when available |
| `durationMs` | Nonnegative measured duration in milliseconds |
| `cost` | Nonnegative source-supplied cost |
| `costKind` | `reported` or `estimated`; defaults to `reported` |
| `currency` | `USD` is supported; other currencies are excluded from dollar totals |
| `requestId` | Optional correlation metadata; not used for automatic cross-source joining |

Use a stable `id` to append updates to an ongoing request. A later complete record with that ID replaces the prior record, so updates must include all fields you want retained. Use different IDs for separately charged attempts or retries. IDs must be unique within the activity feed. Correlate and deduplicate upstream when exporting overlapping systems.

Missing, invalid, negative, or redacted measurements remain unknown. Numeric zero is preserved. Only allowlisted metadata fields are projected into the terminal; prompts, completions, headers, and other arbitrary payload fields are omitted. Do not put secrets in metadata names or identifiers.

When the explicit activity file contains valid records, it is the sole source for request totals. OpenMerit audit summaries are not added to that file's totals, avoiding overlap. This is source precedence, not automatic cross-system request matching. Without valid explicit records, approved Pi usage history takes precedence, then OpenMerit audit summaries. Sources are never summed together. The snapshot identifies the selected request source in `discovery.requestSource`; this precedence can intentionally leave unrelated activity from lower-priority sources out of totals.

### Local model runtimes

Ollama is read at `http://127.0.0.1:11434` using `GET /api/tags` and `GET /api/ps`. This provides installed models, loaded models, and available model-allocation metadata. It does not supply request history. Loaded means resident in memory, not necessarily generating.

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

Restart the terminal after configuration changes. Set `ollama` to `false` to disable its discovery. Runtime URLs must be HTTP loopback origins with no credentials, path, query, or fragment. Remote and authenticated runtime endpoints are not supported in this initial version. The runtime list is limited to eight entries.

`openai-compatible` reads `GET /v1/models`. Models are labeled available; the list does not prove they are loaded. `vllm` also reads `GET /metrics` for running/waiting requests, inference cache usage, and cumulative input-token, output-token, and finished-request counters. Cache usage is the highest valid `vllm:kv_cache_usage_perc` series, expressed as a percentage; percentages are not summed across workers. These runtime aggregates are displayed separately from imported request totals and are not attributed to projects. Counters can reset when a runtime restarts.

The optional `inventory` accepts `model`, `provider`, `gateway`, `router`, and `runtime` entries. Entries are declared configuration until supported by observations. Known process-environment variables can also identify configured services, as described below. Their credential values are not returned or used to call those services. Automatic discovery additionally reads the supported project declarations and optional, approved Pi history described above. Credential stores and arbitrary processes are not scanned.

### Service inventory

The **Services** tab replaces Connections. It opens on a compact inventory with type filters and service/model search; the **Environment map** switch preserves the topology view. Existing `#connections` links open that map, while `#services` opens Services. The overview keeps its compact map.

Service rows come from declared non-model inventory, configured runtime sources, serving-provider metadata, deployments, and recorded path names. A model's `modelCreator` does not create a service row or establish an API connection to that lab. Names remain as reported. Exact curated aliases can share a row only when there is one unambiguous existing service and the alias is not separately declared. Explicitly declared service names remain separate.

Types are **Model API**, **Inference cloud**, **Router**, **Gateway**, **Runtime**, or **Unclassified**. Explicit declared/reported router, gateway, and runtime roles take precedence over the known-service registry. A `provider` inventory entry can set `serviceType` to `model-api` or `inference-cloud`; this also takes precedence over the registry. Multiple explicit roles remain visible. Known API services use Model API; Baseten, Groq, and Cerebras use Inference cloud. Custom providers without a supplied subtype remain unclassified. These roles describe services; the existing five request-path categories are unchanged. No new type implies discovered hardware or a verified network path.

Requests, paths, median latency, and supplied USD spend cover the selected window. A request counts once per service, even if a hop repeats, but can touch several services: row totals are not additive. Latency and spend describe the whole recorded request, not service-added latency or the service's bill. Last activity comes from all retained records; a service can therefore show activity outside the selected window. Models/deployments include inventory plus relationships reported in that window. Shared pools are linked only through explicit service or serving-deployment associations, not assigned to every intermediary in a path. A displayed capacity reading is one reported pool measurement, with its description directly beneath the value on the same right edge; full pool details remain in the inspector.

Configuration, inventory, and activity evidence are distinct. A configured service with no requests says **Configured only**; inventory does not imply connectivity, current health, available capacity, or usage. Every inspector includes the fields and sources behind the identity. Filtering and inspecting services remain passive and make no external requests.

### Inference services and model creators

The terminal recognizes configuration evidence for Baseten, Groq, and Cerebras alongside the existing services. Inherited variables and supported literal declarations in the selected project’s `.env` and `.env.local` files provide evidence. Shell histories, arbitrary source files, and credential stores are not scanned. A configured service does not establish an active connection, model inventory, usage, available capacity, or a hardware allocation.

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

Service details show the identifying variable and whether the evidence was a credential name or a recognized endpoint. **Sources → Service configuration** explains inherited variables; project-file sources identify declarations from each file and any unknown endpoints. Credential values and raw endpoint URLs, including their paths and queries, never enter the snapshot. Recognized endpoint hostnames may appear in service evidence; Baseten deployment identifiers are redacted as `model-….api.baseten.co`. Configured local runtimes can display their validated loopback host and port. No arbitrary endpoint URL becomes a link. Detection makes no cloud requests and does not assign a request path or rewrite recorded providers from ambient environment configuration.

Supply `modelCreator` in activity metadata, model inventory, deployments, or exported loaded-model entries when that identity is available. The model inspector shows the reported creator separately from **Served by**, including its source. Conflicting creator reports for the same model/service leave the inventory creator unresolved. Existing family icons are visual recognition only; they do not populate creator metadata. An explicit creator takes precedence over family icon matching. Baseten, Groq, and Cerebras service icons are bundled locally.

For example, an export may report `model: "gpt-oss-120b"`, `modelCreator: "OpenAI"`, and `provider: "Groq"`. An application using a gateway still reports its gateway path; the serving company does not change that category. No account API, inference call, remote hardware discovery, or model availability check is performed by this detection.

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

Local runtime inventories also create deployment identities and a shared runtime pool. Discovered deployments use `hostId: "this-machine"`. Discovered IDs are `runtime:<model inventory id>` for deployments and `runtime:<source id>` for pools; inspect the snapshot to obtain them. Existing activity must explicitly reference those IDs to join to discovered deployments. No association is guessed from an equal model name. A loaded model means resident memory, not available concurrency. Declared and discovered instances are not automatically merged.

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

The **Local compute** inventory includes this machine automatically, with the reserved ID `this-machine`. Its display name is the full operating-system hostname. Additional hosts are supplied by an existing exporter through `.openmerit/hosts.json`. An optional `hardwareFile` in `.openmerit/terminal.json` changes that project-local path. The terminal reads this file on its normal 10–30-second polling interval; it does not connect to remote hosts, scan networks, or install collectors. Each host may supply `name` and/or `hostname`; display precedence is `name`, `hostname`, then `id`. Snapshots expose the selected field as `nameField`. Site and rack are optional export labels, not discovered locations. The site filter is hidden when no host reports a site.

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

File readers handle partial lines, split UTF-8 writes, and ordinary file rotation. Activity and audit file reads are bounded to 4 MiB, and each reader retains up to 10,000 unique records. Pi history has the stricter per-file and aggregate limits described above. A large initial file imports its tail. Truncation and malformed records are disclosed in source details. Results are limited to the most recent 24 hours and exclude future timestamps. An unavailable or removed file is not kept looking connected.

Collected usage is not persisted to a new database. Optional access choices are stored separately in the user-level permissions file. Machine history and imported-record caches are process-local and disappear when the terminal closes. Existing source files remain under their owner's retention policy.

The map represents all recorded entry connections in its selected scope, with representative workloads and model/deployment identities; its footer discloses represented requests and deployment-identity coverage. Full retained request metadata is available through the JSON API. There is no inferred quality score, provider billing verification, automatic cloud account connection, or universal inference discovery.

## Agent access

```sh
openmerit dash --json
```

From the checkout:

```sh
node packages/terminal/src/cli.mjs dash /path/to/project --json
```

While the server is running, `GET /api/snapshot` returns the cached JSON object. Schema version 1 contains `mode`, `observedAt`, `interval`, `project`, `models`, `inventory`, `records`, `sources`, `runtimeStats`, `deployments`, `capacityPools`, `hosts`, `machine`, and `discovery`. The optional `discovery` object reports whether discovery is enabled, its last check time, the 60-second discovery interval, candidate count, and selected request source. The host, deployment, and pool fields extend the unreleased version-1 snapshot; older snapshots without them show unknown coverage. `machine` remains the current host for compatibility; `hosts` is the full hardware inventory. Fields containing unsupported measurements use `null` or are absent. `GET /api/sample` returns only fictional data. `GET /api/info` describes the process's mode and interval.

The server binds to `127.0.0.1`, accepts read-only GET requests, checks Host and Origin, rejects cross-site browser requests, and serves only its bundled assets and explicit API routes. It provides no general file-serving endpoint. Local processes and other users with access to this machine may still reach the loopback service; this is not a multi-user authentication boundary.

See [security and data](security.md) for the separate OpenMerit orchestration and harness data boundaries.
