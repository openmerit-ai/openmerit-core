# OpenMerit

OpenMerit finds the right model for your task from measured results on your own labelled examples, not from leaderboards alone. It runs locally against your own provider connections and your own Langfuse project. There is no OpenMerit account or login.

This package contains:

- **Scout**, a model-recommendation agent built on the [Pi coding agent](https://pi.dev). It reads your task description or codebase, finds or drafts labelled examples, and runs Scout Model Binary Search. It recommends the winner from Langfuse experiments.
- **Pi with OpenMerit's harness changes**: `openmerit` starts Pi with Scout's tools, a `/scout` command and Scout's instructions. Pi gets its own config directory, and a Claude Code subscription token works as an Anthropic credential.
- **The Langfuse connector**, with no dependencies. It works with Langfuse Cloud or self-hosted Langfuse.

Braintrust and the Tuner come later.

## Install and connect

```sh
npm install -g openmerit        # Node.js 22.19 or newer
openmerit status                # connected providers, Scout's model, Langfuse
```

**Models.** Connect either API keys or a subscription:
- **API keys:** use any key Pi supports in the environment, such as `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.
- **Subscription:** run `openmerit login`, which is Pi's `/login` for Claude, ChatGPT, Copilot and other subscriptions. You can also set `CLAUDE_CODE_OAUTH_TOKEN`.

The connected providers decide both which model Scout itself runs on and which candidates it can test.

**Langfuse.** Set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL`. A self-hosted URL works, and `LANGFUSE_HOST` is accepted as an alias. Scout records every evaluation as a Langfuse experiment and reads the finals back from Langfuse to choose the winner.

OpenMerit keeps Pi's logins and settings in `~/.openmerit/agent`. Set `OPENMERIT_HOME` or `PI_CODING_AGENT_DIR` to move them.

## Use it

```sh
# Ask Scout about a codebase. It reads the code and plans without spending until you add --execute.
openmerit scout "Which model should our enrollment agent use?" --codebase ./my-app --execute

# Describe a task and give labelled items (JSONL of {id?, input, expectedOutput}).
openmerit scout "Extract chronic conditions as ICD-10-CM categories from health declarations" \
  --dataset examples/health-declaration-codes/dataset.jsonl --providers openrouter --max-price 30 --execute

# The search alone, without the agent: deterministic, for CI and other coding agents (JSON output with --json).
openmerit run --langfuse-dataset sahra-enrollments --evaluator ./evaluator.ts --execute
openmerit run --dataset items.jsonl --system-prompt "$(cat prompt.txt)" --grader json --execute

# Interactive: Pi with Scout. Ask "which model should I use for …" or type /scout.
openmerit
```

From another coding agent (Claude Code, Codex, Amp and others), run `openmerit scout "<task>" --codebase . --json` or `openmerit run … --json`. A Pi user can also add Scout to their own Pi with `pi install npm:openmerit`.

Every run writes `.openmerit/runs/<run-id>/report.md` and `report.json` in the project directory: the recommendation, finals, every probe, Langfuse links, spend and limitations.

## How Scout decides

1. **Candidates.** Scout takes every model your connections can run that has an [Epoch Capabilities Index](https://epoch.ai/benchmarks/eci) (CC BY 4.0) and orders them by ECI, weakest first:
   - **Published:** Epoch's own score, downloaded at run time.
   - **Estimated or calibrated:** for models Epoch does not score, ScoutBM's estimate, shipped in [`data/eci-estimates.csv`](data/eci-estimates.csv) so no Cloudflare or OpenMerit service is needed. Estimated values come from the model's scores on Epoch's component benchmarks under Epoch's fitted curves. Calibrated values come from other benchmarks that track ECI closely (at least 12 anchor models, |r| ≥ 0.6). Both carry 2–4 points of error, shown as ± in `openmerit candidates`. Maintainers regenerate the file from a Scout catalogue snapshot with `node scripts/build-eci-estimates.ts <catalogue.json>`.

   Scout drops aliases, batch and free-tier variants. Each Epoch row or estimate is used once: the first connected provider, then the cheapest listing. With `--tools`, models OpenRouter lists without tool calls are dropped. Models with neither a published nor an estimated ECI are listed as unranked, never guessed.
2. **Labelled items.** Scout needs at least five. It can use a Langfuse dataset or a local JSONL, which it pushes to Langfuse with stable item IDs. If you have neither, Scout can draft items from your fixtures and tests. It marks them as drafts for you to check.
3. **Binary search.** Scout draws five items once. It probes the middle model: if that model passes all five, Scout moves to weaker models, and otherwise to stronger ones. The search pick is the weakest model that passed.
4. **Finalists.** The nearest neighbours by ECI that also pass the same five make up five finalists. Once a weaker neighbour fails, Scout tries only stronger ones.
5. **Challengers.** Up to three untested models with a higher ECI and no higher list price than the leading finalist are screened on the same five items; those that pass join the finals.
6. **Finals in Langfuse.** Each finalist runs every item three times (`--repeats`). Each probe is one Langfuse experiment on the dataset and each final run is its own experiment, since Langfuse keeps one result per item per experiment. Scout reads the finals back from Langfuse. The winner has the most passes over all runs, then the lower measured cost per item run, then the lower ECI.

**Errors are not verdicts.** Provider, auth, billing and harness errors are never counted as quality failures:
- A model the provider rejects, or one your balance can't cover, is skipped and listed as untested.
- Any other error stops the run, which keeps its completed results.

## Evaluators

- **Built-in Pi evaluator** (`--system-prompt`): one model call per item through Pi, so any connected provider can be a candidate. It has four graders:
  - `json`: every expected field must match; arrays are compared as sets.
  - `exact` and `contains`: for short answers.
  - `judge`: a rubric checked by Scout's model.
- **Your harness** (`--evaluator module.ts`): default-export an `EvaluatorPlugin` that runs one item through your real system and returns `{ pass, output, costUsd? }`. When a model cannot run, throw an error whose `name` is `"CandidateUnavailable"`; Scout then skips it as untested. Throw any other error to stop the run. [`examples/sahra-enrollment/evaluator.ts`](examples/sahra-enrollment/evaluator.ts), which you can copy into your project, drives a deployed multi-step tool-calling agent over HTTP. It reads cost and provider errors from that agent's own Langfuse traces.

## Limitations

- Binary search assumes task quality rises with ECI, so models it skips are untested.
- Screens run each sample once, so one unlucky run can screen a model out. Three runs per final item narrow chance differences but do not remove them.
- Estimated and calibrated ECIs are only as fresh as the bundled CSV and carry 2–4 points of error, more than the gap between neighbouring models.
- ECI reflects the settings Epoch evaluated, not your provider's defaults.
- The built-in Pi evaluator makes one call per item without tools. Use an evaluator module for agents.
- Langfuse ingestion is asynchronous, so reading the finals back can take a minute or two.
- Langfuse Cloud's rate limit, about 30 requests a minute, slows large runs.

## Development

```sh
npm install
npm run check      # strict typecheck plus mocked tests (no model or Langfuse calls)
OPENMERIT_LANGFUSE_LIVE=1 node --test src/connectors/langfuse/live.test.ts   # live Langfuse check (writes a scratch experiment)
npm run build && npm pack
```
