# openmerit

OpenMerit is the open, vendor-neutral decision layer for choosing the best
available model route for a task at a given moment.

It works with agent harnesses, model providers, and observability systems. It
does not replace any of them. A harness supplies a completed task and the model
routes it can execute; OpenMerit measures alternatives, preserves the evidence,
applies the user's policy, and returns a better primary route with a vetted
fallback.

> No model keeps its place by configuration. It earns traffic through current,
> measured merit.

The first integration is [pi](https://pi.dev). The domain records and decision
engine preserve exact provider routes so the same logical model can be compared
through native, routed, custom, or local providers.

```text
completed harness task + eligible routes
                    │
                    ▼
       controlled route comparison
                    │
                    ▼
 quality + cost + latency evidence
                    │
                    ▼
      pareto frontier + policy gate
                    │
                    ▼
 recommendation / primary route + fallback
```

## What 0.1.5 does

- Uses the active harness response as the measured baseline.
- Selects a small, deterministic price-spread slate from routes already
  configured and eligible in the harness.
- Executes alternatives sequentially through their exact routes.
- Scores every answer with a configured evaluator route using the harness's
  credential store.
- Records quality, price, latency, cost, errors, and tool activity.
- Builds a per-task Pareto frontier and chooses a primary and fallback.
- Recommends changes by default; automatic application is an explicit opt-in.
- Rechecks the current policy, task, session, and baseline route immediately
  before an automatic switch.
- Offers or automatically engages the task's fallback after a final model
  error, after rechecking its exact route against current policy.

Normal application traffic still flows directly between the harness and its
providers. OpenMerit runs only its explicit comparison and evaluation calls.

## What OpenMerit is not

- It is not an agent harness.
- It is not a model provider, reseller, proxy, or API gateway.
- It is not a general observability product.
- It is not a universal leaderboard.
- It does not inject unconfigured models or own provider credentials.

Harness authors can integrate through the stable npm exports (`openmerit` and
`openmerit/harness`). See [`docs/harness-integration.md`](docs/harness-integration.md)
for the adapter contract and ownership boundaries.

Local JSONL files are an auditable default evidence store, not a requirement
that future integrations use local storage.

## Install with pi

Requirements:

- Node 22.18 or newer
- pi 0.85.1 or newer
- At least two authenticated, policy-eligible routes in pi

```bash
pi install npm:openmerit
npx --yes openmerit init
npx --yes openmerit verify
pi list
```

For development from a checkout:

```bash
npm ci
npm run check
pi install "$PWD"
```

Install OpenMerit from only one source so pi does not load the extension twice.

## Use it

Start pi with any configured model and complete a task. Once the response
settles, the extension queues one session-bound comparison. The shipped policy
never changes the active model without approval.

Inside pi:

- `/openmerit` — current route, fallback, comparison status, budget, and evidence
- `/openmerit apply` — apply the latest recommendation for the active task
- `/openmerit dismiss` — dismiss pending recommendations for the active task
- `/openmerit compare` — compare the latest completed task explicitly
- `/openmerit pause` — stop automatic comparisons and cancel the active one
- `/openmerit resume` — enable comparisons for future completed tasks
- `/openmerit fallback` — switch to the current vetted fallback
- `/openmerit doctor` — sanitized installation and route diagnostics

Shell commands:

```bash
npx openmerit status
npx openmerit frontier
npx openmerit doctor
npx openmerit verify
```

## Policy

`openmerit init` creates `~/.openmerit/policy.json` without replacing an
existing file. The 0.1.5 policy schema is:

```json
{
  "version": 3,
  "mode": "recommend",
  "auto_apply": {
    "enabled": false,
    "min_score_gain": 0.1,
    "max_price_ratio": 1.5,
    "require_frontier": true
  },
  "budgets": {
    "max_usd_per_trial": 0.25,
    "max_trials_per_day": 20,
    "max_usd_per_day": 5
  },
  "providers": {
    "allow": ["*"],
    "deny": []
  },
  "comparison": {
    "max_routes": 3
  },
  "benchmark_refresh_minutes": 0,
  "fallback": {
    "auto_update": true,
    "min_score": 0.6,
    "apply_on_error": true
  },
  "evaluator_model": null,
  "max_usd_per_m": 20,
  "route_overrides": {},
  "pi": {
    "provider_extensions": []
  }
}
```

Set `benchmark_refresh_minutes` to a positive interval to register eligible Pi
tasks as durable benchmark refresh jobs. The Pi extension runs due refreshes in
the active session and surfaces the resulting recommendation for the harness
to apply according to policy. `0` disables recurring refreshes.

For refreshes when Pi is not open, invoke `openmerit refresh` from a user-owned
cron, launchd, or CI schedule. Use `openmerit refresh <job-id>` to run one
specific job. OpenMerit performs the comparison through Pi's configured routes;
the scheduler only decides when to invoke it.

OpenRouter public benchmark snapshots can be imported with:

```bash
OPENROUTER_API_KEY=... openmerit benchmarks sync intelligence
```

Snapshots are stored separately from task trials and are priors for model
discovery; they do not replace a task-local evaluation.

Leveled runtime logs are stored in `~/.openmerit/openmerit.log.jsonl`. Set
`OPENMERIT_LOG_LEVEL=debug` for additional diagnostics and inspect them with
`openmerit logs`, or filter severe entries with `openmerit logs error`.

`mode: "auto"` and `auto_apply.enabled: true` are both required for automatic
primary-route changes. The extension reevaluates the saved evidence against the
current policy before switching, so changing the policy to supervised mode also
stops a previously generated automatic recommendation.

`evaluator_model` may be an exact `provider:modelId` route or a stable logical
model ID. When it is null, OpenMerit uses the active route when capable. For
high-stakes deployments, configure an evaluator route deliberately.

Policies written for 0.1.x remain readable: `watch.models_per_task` normalizes
to `comparison.max_routes`, and `judge_model` normalizes to
`evaluator_model`. Removed watcher fields are ignored.

### Custom and local routes

OpenMerit never guesses that a local route is free. If pi omits metadata, add an
override for the exact route:

```json
{
  "route_overrides": {
    "ollama:qwen3:8b": {
      "cost": { "input": 0, "output": 0 },
      "context_window": 32768,
      "max_tokens": 4096,
      "input": ["text"]
    }
  }
}
```

Provider lifecycle metadata can also be supplied for a route. Routes marked
`preview`, `deprecated`, or `retired` are excluded from candidate comparisons;
use `availability: "active"` only when the provider has omitted that signal:

```json
{
  "route_overrides": {
    "openrouter:openai/gpt-4-turbo-preview": {
      "availability": "deprecated"
    }
  }
}
```

If a custom provider is registered by a pi extension, allowlist that exact
absolute file under `pi.provider_extensions`. Isolated subprocesses disable
ordinary extension discovery and refuse to load OpenMerit recursively.

## Safety boundaries

- Candidate tools are disabled by default. Set `OPENMERIT_PI_TRIAL_TOOLS` to an
  explicit comma-separated allowlist such as `read,grep,find,ls` only when the
  comparison genuinely requires tools.
- Candidate runs use temporary copies of the working directory. This protects
  ordinary relative project writes, but it is not an OS sandbox. Tool-enabled
  shell commands can access absolute paths or the network.
- Task text, attached files or images, candidate answers, rubric requests, and
  evaluation requests are sent through the selected configured routes. Use
  non-sensitive tasks while evaluating this alpha.
- Unknown-price routes are not admitted as candidates and cannot auto-apply.
- The per-trial budget is an admission estimate using route metadata, input
  bytes, and up to 4K output tokens. It is not a provider-side hard cap.
- Ledger updates are process-locked so simultaneous pi sessions cannot silently
  overwrite one another's recorded spend.
- One evaluator score is evidence, not truth. 0.1.5 remains an alpha; repeated
  evaluation, outcome-based scoring, and richer reliability evidence are future
  decision inputs.

## State (`~/.openmerit/`)

| Path | Purpose |
|---|---|
| `policy.json` | user-owned decision, budget, provider, and fallback policy |
| `harness-state.json` | active Pi route, eligible routes, session, fallback, and pause state |
| `trials.jsonl` | append-only route measurements with task and session identity |
| `recommendations.jsonl` | append-only decisions and status changes; latest ID wins |
| `events.jsonl` | versioned audit events for trials and recommendations |
| `ledger.json` | UTC daily comparison and evaluation spend |
| `jobs/*.json` | session-bound comparison ownership and completion markers |
| `benchmarks.jsonl` | versioned per-task benchmark definitions |
| `benchmark-jobs.jsonl` | durable refresh requests consumed by the harness extension |
| `public-benchmarks.jsonl` | imported public benchmark snapshots and provenance |
| `traces/trials/*.jsonl` | raw Pi event streams for candidate executions |

Atomic snapshots are replaced by rename. JSONL readers retain valid later
records after an interrupted line, and automatic application fails closed when
recommendation history is malformed. Files left by pre-0.1.5 watcher features
are not deleted; 0.1.5 simply stops reading or writing them.

## Architecture

- `src/comparison.ts` — session-bound orchestration and candidate selection
- `src/policy.ts` — the only automatic-application authority
- `src/frontier.ts` — quality/price/latency Pareto evidence
- `src/recommend.ts` — primary and fallback recommendation construction
- `src/harness.ts` — provider-neutral candidate execution contract
- `src/providers.ts` — inference contract used by evaluators
- `src/pi-trials.ts` and `src/llm.ts` — first-party Pi integration
- `extension/openmerit.ts` — thin in-session lifecycle and route-application adapter
- `src/store.ts` and `src/integrations.ts` — local audit persistence

The reasoning behind the 0.1.5 boundary is recorded in
[`docs/0.1.5-architecture-decisions.md`](docs/0.1.5-architecture-decisions.md).

## Development and benchmarks

```bash
npm run typecheck
npm run typecheck:extension
npm test
npm run build
npm run benchmark:verify-recorded
npm run check
```

`benchmark/` remains in the repository to verify evaluation artifacts and
scoring semantics. It is not shipped as runtime product behavior or bundled in
the npm package.

## License

MIT
