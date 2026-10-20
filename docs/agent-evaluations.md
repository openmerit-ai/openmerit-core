# Evaluate CLI changes across coding agents

**npm preview `0.1.7-preview.3`.** Install from the `preview` tag; stable `openmerit@0.1.6` does not include these commands. This evaluates the coding agent with your CLI and documentation. The [Pi workflow](getting-started.md) still evaluates application inference; the [Inference Terminal](inference-terminal.md) remains read-only. Scout's hosted API and MCP service deploy independently; npm installation does not start or bundle the hourly research service.

Compared with `0.1.7-preview.1`, this version adds [corrected cost accounting and blocked-execution handling](#accounting-and-blocked-executions), plus [budget selection after model scope](#budget-selection). It does not claim reconciled provider billing or a guaranteed exact model order.

One local runner supports Claude Code, Codex and OpenCode. Scout supplies candidates; local task checks measure each model/agent/CLI combination. Installing npm alone does not install or authenticate agents, modify project instructions, or start paid evaluations.

## Set up

Install the preview and initialize it inside the project you want to evaluate:

```sh
npm install -g openmerit@preview
openmerit eval init
openmerit eval doctor
```

Init creates `.openmerit/eval.json`, a tiny extraction fixture, a tool and a standalone grader. It appends marked instructions to `AGENTS.md` and `CLAUDE.md`, preserving existing contents. Codex/OpenCode can read `AGENTS.md`; Claude Code reads `CLAUDE.md`. The instructions ask the agent to configure representative tasks, choose scope, obtain the user's budget, and rerun after CLI changes. These are instructions the host must follow, not guaranteed hooks. There are no install-time hooks or background services. A second init refuses to overwrite the suite.

Replace the starter before drawing product conclusions. Have your agent author representative fixtures and graders with you, and reserve fresh cases for final validation.

## Choose scope and connections

```sh
openmerit eval plan
```

The first interactive plan asks: **existing project connections or all models Scout indexes?** It then asks for a **$10, custom or no-fixed-cap budget**. Both choices are saved. Noninteractive agents must ask the user and pass `--scope existing` or `--scope all` together with `--budget <USD|unlimited>` on first setup; missing input never chooses scope or spending automatically.

Add explicit routes to `connections` in the config, for example:

```json
{
  "id": "claude-project",
  "agent": "claude",
  "scoutId": "anthropic/claude-haiku-4.5",
  "model": "claude-haiku-4-5-20251001",
  "env": ["ANTHROPIC_API_KEY"]
}
```

`scoutId` is Scout's catalogue ID. `model` is the native identifier your authenticated agent accepts. `command` optionally selects another executable path. `env` lists environment variable **names**, never values. Only basic OS variables and explicitly listed names pass to child agents. Saved authentication remains available through the normal home directory. No dotenv files are loaded automatically. Configure endpoint details through the native agent or named environment variables.

An SDK dependency or key-variable name does not prove access. The agent should inspect the project's intended connections and declare the models they can serve. This preview does not automatically enumerate endpoint catalogues. Multiple connections can test one Scout model through different agents/routes. Prefer pinned model versions; aliases can change.

Existing scope sends IDs and requires Scout to acknowledge filtering **before ranking five**. Fewer than five eligible models remain fewer. All scope searches the index, but missing authenticated routes block execution until configured and replanned. Inaccessible candidates are not silently replaced. Unranked Hugging Face specialists are not executed automatically.

Scout receives only each task's `description`, plus IDs for existing scope. Scout sends descriptions to OpenAI Decisions. Fixtures, execution prompts, endpoint URLs and credentials stay out of this request. The shortlist, warnings and ranking context are frozen locally. Scout scores are screening evidence, not measured success with your harness.

## Tasks and variants

Each task needs `id`, `description` (for Scout, at most 4,000 characters), `prompt` (for execution), `fixture` (a project-relative directory) and `grader` (a standalone Node `.mjs` file).

Each variant needs `id`, `files` and `instructions`. The starter compares `bare` against `cli`. Bare omits your CLI/docs; native agent tools remain available. Across agents you are comparing different harnesses, with different permission systems. A no-native-tools experiment needs a separately controlled configuration.

Selected files, including uncommitted changes, are snapshotted before execution. Variant paths must not overwrite fixture inputs and retain their project-relative locations; fixture contents go at the workspace root. Include self-contained CLI artifacts and lean docs explicitly. Dependencies are not installed automatically; tools must be bundled or have their runtime requirements already available. Symlinks, parent-directory paths, `.env*`, `.git`, `.openmerit` and `node_modules` are rejected. Each selected snapshot is limited to 25 MB. Do not select credentials stored under other filenames.

The grader reads `{ "workspace": "/temporary/path", "output": "final response" }` from stdin and prints exactly `{ "quality": 0.0 }`, with a finite score from 0 to 1. It can check generated files using executable assertions. Keep it self-contained: imports beside it are not copied automatically. Graders are copied outside agent workspaces; never also include them or answer keys in fixtures/variant files. Test graders against correct and incorrect answers. A broken grader stops the experiment with unknown quality. Ordinary agent failures/timeouts count as quality zero; recognized budget, environment and connection blocks instead stop with unknown quality. See [failure classification](#accounting-and-blocked-executions).

## Run after changes

The starter's `budget.maxUsd` is zero. After the user's scope and budget choices, for example:

```sh
openmerit eval plan --scope existing --budget 10
openmerit eval run
# Edit your CLI or its documentation.
openmerit eval run
```

For repeated local development:

```sh
openmerit eval watch
```

Watch runs initially, then after selected source/docs/fixture/grader/config bytes change and remain stable for two polls. Result writes do not trigger it. Runs never overlap; edits during execution become the next revision. Ctrl+C stops the watcher and active child process. No OS schedule or daemon is installed. `OPENMERIT_EVAL=1` tells cooperating agent instructions not to recurse into another evaluation.

Every attempt uses a new workspace and agent session. Each task runs balanced rounds across all selected connections and variants; order rotates and reverses. The default is 3–10 repetitions. After three, rounds continue while any group's quality range exceeds 5 percentage points, an attempt failed, or cost, input-token or latency variation has a coefficient of variation above 0.25. Ten is the maximum. Missing metrics cannot establish stability. Set `repeats.min` equal to `repeats.max` for fixed repetitions, useful for holdouts. This heuristic is not a significance test, and repetition is not task diversity.

The frozen plan survives CLI changes. Changes to descriptions, scope or connections require replanning. Previous-revision comparisons require matching prompts, fixtures, graders, routes, repeat settings, selected candidates, variant IDs, timeouts, agent versions, runner versions, invocation settings and reported model identities. CLI/docs bytes and variant instructions are the interventions. Keep external services and native agent settings stable too; they are not hermetically captured.

## Metrics

```sh
openmerit eval report
openmerit eval report --json
```

Reports show quality mean/range, failures, mean input/output tokens, mean reported dollars and median full-process seconds per task/connection/variant. They retain Scout ranks but do not force a weighted winner. Lower cost with lower quality is a tradeoff. Matching complete revisions show deltas; partial/invalid experiments do not.

Claude provides aggregate and per-model usage and cost estimates, reconciled without counting the same usage twice. Codex JSON events provide tokens but not billed dollars, so cost stays unknown. OpenCode per-step usage/cost is summed across the episode, including tools; missing or zero step pricing leaves full cost unknown and preserves partial estimates. Input totals include separately reported cache reads/writes; cached tokens are retained separately without counting them twice. OpenCode output totals include separately reported reasoning tokens. Agent accounting and subscriptions differ. Reported costs are not reconciled provider bills; zero pricing is treated as unknown. Catalogue prices never replace unknown measured costs.

Preflight requires supported noninteractive JSON interfaces: Claude print JSON, Codex `exec --json --ephemeral --sandbox workspace-write`, and OpenCode `run --format json --auto`. OpenCode's auto option approves tool requests that are not explicitly denied, avoiding an interactive approval stall. Claude uses an explicit local tool allowlist without inherited MCP configuration; Codex and OpenCode retain native global settings. Recognized permission failures stop as connection problems, not model-quality evidence. OpenMerit does not add a sandbox around Claude/OpenCode. The old 2025 Codex CLI is unsupported. Native references: [Claude Code](https://code.claude.com/docs/en/headless), [Codex](https://developers.openai.com/codex/noninteractive), [OpenCode](https://opencode.ai/docs/cli/).

## Budget and data

`budget.maxUsd` applies cumulatively across runs and restarts. Before each attempt the runner persists a reservation. It retains the greater of that reservation and the available full or partial cost estimate; estimates never release reserved allowance. Partial events never count as a complete bill. Insufficient remaining allowance stops a partial run. Raising maxUsd extends the allowance, not resets it. Do not delete unknown spend from the ledger. This is admission control, not a billing cutoff: one attempt may exceed its reservation. Finite budgets also use Claude's native maximum-budget flag. Use provider-side limits for hard monetary caps. Each attempt also has a timeout and 4 MB process-output limit. See [budget selection](#budget-selection) for the three choices and automatic reservations.

`.openmerit/eval/` holds `plan.json`, `budget.json`, `latest.json`, `runs/*.json` and `lock/pid`. Init ignores it in Git. Reports contain identities, metrics, hashes and status, not full transcripts or final outputs. Temporary files are removed afterward. Native agents/providers may retain their own data; Claude/Codex receive ephemeral flags, while OpenCode uses native storage. `.openmerit/eval.json` can be versioned without credentials.

Fresh workspaces are not security sandboxes. Trusted agents and graders execute with native permissions and user-level resources. Hard kills may leave temporary directories. After a crash, inspect the lock's PID and remove it only if that process is gone. This preview does not change Pi approvals, swap production models or upload results into Scout rankings.


## VM acceptance limits

The published `0.1.7-preview.1` package was tested on an Ubuntu ARM64 VM with Node 22.23.1 on 15 October 2026. Claude Code 2.1.300 and OpenCode 1.19.0 executed a small CSV CLI task before and after a parser change. A separate OpenCode watcher completed three attempts per revision and emitted comparison deltas. Codex 0.162.1 passed interface preflight but could not execute filesystem tools because that VM denied the required Linux user namespaces. CLI flag checks do not establish that the native sandbox works on a host.

In that earlier `0.1.7-preview.1` test, a native budget stop could appear as a generic agent failure, and a successful final response explaining a host permission problem could receive zero from the task grader. These did not establish poor model quality; the corrections below address recognized native failures. The combined VM run also stopped before its final repetition because conservative reservations and agent cost estimates exhausted its local allowance; partial reports correctly omitted automatic comparison. Agent-reported cost differed substantially from OpenRouter account usage. This was one integration fixture, not validation of general task quality, exact model order, or billing accuracy.

## Accounting and blocked executions

Since `0.1.7-preview.2`, recognized budget, sandbox, permission, authentication and model-access blocks are separate from task failures. A blocked attempt has `quality: null`, stops the run and cannot produce a revision comparison. Reports distinguish scored attempts, blocked attempts and task-check failures. Ordinary wrong outputs still receive their grader score; ordinary agent failures and configured timeouts still count as failures. Cancellation, a missing executable and output-limit interruption are unscored. Error classification uses native failure fields and failed-tool diagnostics, not arbitrary task text or model commentary. Unrecognized host failures can still require manual review.

On Linux, Codex preflight also runs a local sandbox probe before any model request or budget reservation. It uses the configured executable and the workspace-write policy; it does not weaken sandbox permissions. A failed probe produces `environment_blocked` with no task score. Doctor performs this same probe. Other operating systems still have interface checks only.

Claude's per-model totals recover usage omitted from aggregate budget-stop responses, without adding the same aggregate and model counters twice. Costs carry `costBasis` and remain native estimates. Zero or missing pricing is unknown; incomplete OpenCode step pricing stays partial. Partial costs survive into the row, summary and ledger, including failed attempts. No provider bill is reconstructed from these estimates, and no account-wide spend delta is assigned to individual attempts.

Budget admission now retains the greater of each reservation and its available full or partial estimate, including old ledger entries. Estimates never release a reservation. This may exhaust an existing allowance earlier; increasing it requires an explicit budget decision. The displayed reserved allowance is not billed spend, and a provider-side limit is still needed for a hard cap. Report version 2 prevents comparisons with the earlier accounting rules. There is no new provider integration, proxy, background service or model-specific rule.

## Budget selection

After choosing existing connections or all indexed models, the first interactive `eval plan` asks:

1. **$10** — a cumulative evaluation allowance for this project.
2. **Custom amount** — asks how much in USD.
3. **No fixed cap** — run the configured suite without a monetary admission limit.

Nothing is preselected. Blank, invalid or cancelled input cannot enable spending. Init still starts at zero. Newly generated project instructions tell coding agents to ask the same follow-up and pass the answer explicitly, for example:

```sh
openmerit eval plan --scope existing --budget 10
# Alternatives after the user's choice:
openmerit eval plan --budget 25.50
openmerit eval plan --budget unlimited
```

`--budget` belongs to `plan`, accepts positive USD amounts with at most two decimal places or the exact word `unlimited`, and never starts evaluation by itself. Noninteractive planning requires explicit flags when scope or budget has not been chosen. Existing positive budgets are reused. The choices are saved even if Scout subsequently fails, so a retry does not ask again. Init does not rewrite instructions in already-initialized projects; an agent in such a project can use these flags directly.

The allowance is cumulative across runs, watched edits, restarts and replanning. Changing from $10 to $20 raises the total allowance to $20; it does not add $20 or erase earlier reservations. Changing to or from no fixed cap also preserves the ledger. A normal `eval plan` reuses the saved choice. To change it, pass a new `--budget` value; setting `budget.maxUsd` back to zero in the config disables paid execution and prompts again on the next interactive plan.

Reservations are internal. New suites and budget choices use `reservationUsd: "auto"`: the smaller of $0.25 and the total allowance divided across the minimum planned attempts (tasks × selected connections × variants × minimum repetitions). No fixed cap uses $0.25 for ledger bookkeeping. This is a conservative starting allowance, not a prediction of an attempt's price or a guarantee the suite will finish. Higher reported charges still consume more allowance. Existing explicitly configured numeric reservations remain supported. Finite budgets retain Claude's native per-attempt budget flag; as before, an attempt can exceed its reservation, and provider limits are needed for a hard billing cap.

No fixed cap is stored explicitly as `budget.maxUsd: "unlimited"`; missing, null or invalid values never mean unlimited. It also removes Claude's per-attempt dollar limit, while keeping the same task count, 3–10 repetition bounds, timeouts and native permissions. Provider/account limits still apply. Usage and cost estimates remain recorded. `eval watch` can incur further charges after each selected change until stopped; Ctrl+C stops it and the active attempt. No background service or automatic production model change is added.
