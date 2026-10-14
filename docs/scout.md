# Scout by OpenMerit

Describe what you need a model to do. Scout returns up to five available models using relevant public benchmark results, token prices, and reference speed. The `/scout/` page, JSON API, and MCP tool all use the same index and ranking.

Scout is a separate beta product. It does not change the OpenMerit npm package, Pi coordinator, or Inference Terminal. Recommendations are evidence-based candidates for your own evaluation, not a guarantee of task accuracy or an independently validated state-of-the-art ranking.

## Use Scout

Open [Scout](https://openmerit.ai/scout/), type a task, and select **Find models**. For example: “I want to upload an invoice and get the invoice number, date, vendor, subtotal, tax, and total as JSON.” The examples submit real requests to the same API as your own input.

The comparison table keeps recommendations in Scout rank order, with aligned quality, cost, and reference-speed columns. Select **Evidence** for a model to inspect its ID, separate input/output prices, benchmark scores, evaluation configurations, and source links. On narrow screens, scroll the table horizontally; the model column stays visible. Provider favicons are bundled with Scout and served from the same origin. Unknown providers or unavailable images use a text initial; no third-party favicon service is contacted.

The capability index shows which areas have benchmark coverage. Matching capabilities are highlighted after a search. The source panel distinguishes the last successful collection time from the age of published measurements.

## Connect a coding agent

Add this remote **Streamable HTTP MCP** endpoint to an agent that supports it:

```text
https://openmerit.ai/scout/mcp
```

Scout exposes one read-only tool, `scout_models`, with one argument:

```json
{"prompt":"Upload an invoice and extract six fields as JSON"}
```

No API key is required from the caller. Scout sends the task description to OpenAI Decisions to interpret requirements, then ranks its collected evidence. It does not execute the recommended models. The MCP endpoint supports protocol versions `2025-03-26`, `2025-06-18`, and `2025-11-25`, including initialization, tool discovery, and tool calls. It uses JSON responses without sessions or a long-lived SSE stream. Browser requests must have the same origin; ordinary agent clients omit the Origin header. An unsupported protocol version is rejected. Agent configuration is client-specific; connecting an endpoint does not automatically make an agent use it.

Tell the agent: “Before choosing an inference model for this feature, call Scout with the task description. Compare the five candidates, read their evidence and warnings, and evaluate the shortlist on our own examples.”

The MCP response includes up to four relevant evidence entries per model and the total evidence count. Evidence satisfying required memory, tool-calling, and visual-document capabilities is shown first. The JSON API exposes the complete evidence list.

## JSON API

```sh
curl https://openmerit.ai/scout/api/recommend \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Upload an invoice and extract six fields as JSON"}'
```

`POST /scout/api/recommend` accepts exactly one property, `prompt`: a non-empty string of at most 4,000 characters. The JSON body is limited to 18,000 bytes. Unknown properties are rejected.

The response contains:

- `recommendations`: up to five distinct model IDs with rank, provider, reason, quality signal, evidence coverage, input/output pricing, reference speed when available, supported inputs, and source-linked evidence.
- `task`: interpreted capabilities and weights; image-input, structured-output, tool-calling and persistent-memory requirements; `requirements.tools` (`yes`, `no`, `unspecified`); `requirements.memory` (`none`, `session`, `persistent`, `unspecified`); consequential `uncertainty`; and `interpreter: "openai-decisions"`. `keywords` is retained as an empty compatibility field. A general-purpose fallback means no specific capability was identified, not that the classifier was unavailable.
- `checkedAt`, `stale`, `degraded`, `sources`: index and source health. Each source has its own last successful check. A failed source is marked degraded; any source unchecked for more than two hours makes the index stale.
- `benchmarks`, `benchmarksWithResults`, `models`, `availableModels`, `eligibleModels`: indexed series, series with matched results, evidence-backed models, catalogue models, and eligible candidates for this task.
- `wordCloud`: capability vocabulary with benchmark and model coverage counts.
- `warnings`, `methodology`, `interpretationMs`, `elapsedMs`: limitations, ranking method, Decisions request time, and measured server ranking time when the runtime provides a sufficiently precise clock (`null` otherwise). Cloudflare freezes its clock during synchronous work, so the hosted page reports measured HTTP round-trip time instead of claiming zero-millisecond computation.

`GET /scout/api/status` returns index coverage, source timestamps, freshness, and scheduler state without submitting a prompt. API responses are `no-store`. Errors return JSON with `error`: 400 for invalid input, 413 for an oversized request, 415 for a non-JSON body, 405 for an unsupported method, 404 for an unknown endpoint, 429 when shared admission limits are reached, and 503 if interpretation is unavailable. A failed, malformed, refused, or timed-out Decisions response never silently falls back to keyword ranking. MCP reports these failures as tool errors.

Scout recommends models; it does not process an uploaded invoice, execute a task, install a model, or select a provider account.

## Real sources and their limits

The hourly updater fetches six public feeds and prepares the index before requests arrive. Queries make one Decisions call for intent classification; they do not browse benchmark sites or ask a model to invent rankings.

| Feed | Used for |
| --- | --- |
| [Epoch AI](https://epoch.ai/benchmarks) | Benchmark definitions, published results, source links, and evaluation configurations. |
| [Artificial Analysis](https://artificialanalysis.ai/leaderboards/models) | Benchmark results and measured reference generation speed. Archived evaluations remain labelled when their models are still available. |
| [OmniDocBench](https://github.com/opendatalab/OmniDocBench#end-to-end-evaluation) | Document parsing scores from the explicitly labelled `v1.6_full` leaderboard, including newer document models than the OpenVLM snapshot. |
| [OpenCompass / VLMEvalKit](https://huggingface.co/spaces/opencompass/open_vlm_leaderboard) | Visual understanding and OCR benchmark results. Its feed currently identifies itself as 17 September 2025. |
| [Berkeley Function Calling Leaderboard (BFCL v4)](https://gorilla.cs.berkeley.edu/leaderboard) | Native function-calling single-turn, live, and multi-turn scores; separate memory scores for key-value, vector, and recursive-summarization stores. |
| [OpenRouter](https://openrouter.ai/api/v1/models) | Available model IDs, input modalities, declared tools and structured-output support, context limits, and advertised token prices. |

Over 100 benchmark **series** are indexed, including source-specific implementations and versions. This is not 100 independent publishers, and coverage is not uniformly current. Some definitions have no results matched to an available model. Both counts are exposed. Missing metrics and ambiguous or unmatched model versions are omitted. Availability is limited to OpenRouter's text-output catalogue, excluding batch/free variants and known routers.

Collection time is not measurement time. A successful hourly check does not make an old result new. Some feeds omit measurement dates; those remain unknown. Model release dates are never substituted. OmniDocBench's repository version and leaderboard version differ; Scout uses the version actually printed on the score table. Document parsing is a proxy for invoice extraction, not an evaluation of your exact six fields. New models without comparable evidence may be absent from a task's shortlist.

Epoch AI attribution: “Capabilities & benchmarking,” published at epoch.ai, normalized and matched by Scout under the source's [CC BY 4.0 terms](https://creativecommons.org/licenses/by/4.0/). Other sources are attributed in the source panel and individual evidence links. These are data-source attributions, not a statement about OpenMerit's licensing.

## Ranking

One server-side call to [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions), using `gpt-6-luna`, interprets the work the selected model must perform. It distinguishes executing tools from writing code about them, incidental words such as “tool” or “agent,” supplied plain text versus visual inputs, and session state versus persistent memory. Fourteen typed choices become capability weights and requirements. Decisions sees the task, not candidate names or rankings; the shortlist still comes from collected scores.

Strong JSON/schema filtering also needs explicit format wording in the prompt. An uncertain format answer cannot turn an ordinary story or comparison into a JSON task. Low-confidence consequential classifications and unspecified retention/tool interfaces are exposed as uncertainty. This is still a probabilistic classifier: paraphrases can differ, ambiguous requests can be misread, and English format-grounding rules limit multilingual handling. Scout has no clarification dialogue or user-defined constraints yet.

Image tasks require an image-capable model. JSON/schema tasks require declared `response_format` or `structured_outputs` support. Visual document tasks require document-specific evidence. Required tool use needs declared `tools` support and published tool-calling evidence. Persistent memory needs declared tools support and dedicated memory evidence; generic reasoning or a large context window cannot substitute. Session-only state does not trigger this filter. Recognized image/video/audio generation and transcription tasks return no recommendations because those outputs are outside the current index.

BFCL contributes only native function-calling (`FC`) configurations, preserving their published labels. Its six correlated series count as one benchmark family, not six independent sources. Missing scores stay unknown and zero remains a score. Model versions are matched conservatively; ambiguous versions are omitted. BFCL does not supply per-model measurement dates, so these remain unknown.

The [BFCL memory evaluations](https://gorilla.cs.berkeley.edu/blogs/16_bfcl_v4_memory.html) test using external memory stores across sessions. They do **not** establish built-in model memory, automatic retention in your app, or performance on your storage system. The application still implements storage and tool execution. Models without matched memory results are excluded when persistent memory is required, including newer models with other strong scores.

Scores become within-benchmark mid-rank percentiles. Small comparison cohorts are shrunk toward neutral. Multiple configurations use their median; their names and source links are retained. Correlated versions of common benchmark families are grouped before averaging. Sparse evidence is shrunk toward neutral, and missing capability evidence is penalized. This prevents one isolated high score from carrying the same confidence as broad evidence.

The final fixed weighting is **80% task quality signal, 13% token price, 7% reference throughput**. Quality is a ranking signal, not predicted accuracy. Evaluation harnesses, reasoning budgets, benchmark overlap, and selection bias limit comparisons. No empirical claim is made that these defaults predict task outcomes better than other recommendation methods.

Price uses a **3:1 input/output token mix**, in USD per million total tokens, solely for comparison. Separate input and output prices are returned. This is not a per-invoice estimate; it excludes caching, reasoning-token usage, modality-specific charges, and provider-specific differences. Speed is an Artificial Analysis reference measurement, not guaranteed latency on the OpenRouter route. Archived speed measurements are labelled. Missing speed stays unknown and contributes no bonus; time to first token is reported where available but not scored.

If fewer than five eligible models have evidence, Scout returns fewer and explains why. There are no accounts, saved prompt history, selection controls, vector database, or language-model reranker. Cost and speed preferences in prose do not yet change the fixed 80/13/7 blend.

## Refresh and data handling

The task description is sent to Scout and then to OpenAI Decisions for interpretation. Scout's application code processes it in memory without saving or logging it. Only the public index is persisted; prompts are not sent to benchmark sites or recommended-model providers. [OpenAI's API data controls and retention policies](https://developers.openai.com/api/docs/guides/your-data) apply to that provider call. Scout does not claim zero retention by OpenAI. Hosting infrastructure can have separate request-metadata policies. Clipboard actions occur only when selected. Describe the task rather than pasting actual invoices, credentials or private customer records.

Each query has one Decisions request with a four-second timeout and no automatic retry. Shared in-memory admission limits allow at most eight active requests and 120 starts per minute for the Scout service. Excess requests fail promptly instead of queuing. These counters reset with the process and are not an account-level billing cap. Provider-side limits can also make interpretation unavailable. The API key is held server-side; callers never receive it.

Sources refresh independently. A failed download, changed parser format, or unexpected loss of coverage preserves that source's previous evidence and timestamp while healthy sources and prices continue updating. Fresh catalogue removals still remove unavailable models. A complete outage preserves the previous index. Failure and stale status are exposed in both interfaces.

Source content is parsed as data, never executed. Downloads, decompression, and request bodies are size-bounded; source downloads time out. Links are restricted to HTTP(S). The publisher's OpenVLM data URL uses HTTP and lacks transport authentication; the remaining feeds use HTTPS. Scout does not independently authenticate benchmark submissions.

## Run locally

Requires Node.js 22.19 or newer. Make `OPENAI_API_KEY` available in the server environment before starting; never put it in browser code. It must have access to the Decisions API:

```sh
npm ci
npm run scout
```

Open `http://127.0.0.1:45833/scout/`. Local API and MCP endpoints use that same origin. `SCOUT_PORT` changes the port. The server immediately uses the newer of its bundled index and `.openmerit/scout/snapshot.json` cache, refreshes when older than an hour, and continues hourly while running. Stopping the process stops its local schedule.

`npm run scout:refresh` fetches the six public feeds and atomically updates `scout/snapshot.json` after validation. Successful sources replace their previous data; failed sources retain labelled prior data when available. Refreshing public sources requires no provider key or inference budget. Recommendation queries require the server key and incur Decisions API usage.

## Hosting and verification

`wrangler.scout.jsonc` defines a separate Scout Worker, one SQLite Durable Object holding the index, and an hourly cron at minute 7 UTC. Configure `OPENAI_API_KEY` as a secret on this Scout Worker before deployment. Searches interpret the task once and use the prepared in-memory index. The bundled snapshot allows immediate startup; subsequent successful updates persist across restarts. Refreshes are serialized.

`demo/domain-router.mjs` routes Scout paths to this service while retaining the existing website, protected memo, authentication, and dashboard services. The public guide is generated and published with the main documentation. Do not deploy the older root `wrangler.jsonc` to publish Scout. `npm run build:scout` packages only Scout, public documentation, and its shared assets; private memo and demo applications are excluded.

```sh
npm run check:scout
npm run verify
npx wrangler@4.136.3 dev --config wrangler.scout.jsonc
```

Tests cover false-positive regressions, response validation, memory/tool eligibility, provenance, missing metrics, source outage recovery, catalogue removals, provider failure/timeout, admission limits, shared API/MCP interpretation, compact evidence and routing isolation. Real API diagnostic cases are separate opt-in checks that incur provider usage. These establish implementation behavior, not task-level model accuracy. Local checks and CI do not publish a deployment. Physical mobile hardware requires separate verification.
