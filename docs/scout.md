# Scout by OpenMerit

Describe what you need a model to do. Scout returns up to five available models using relevant public benchmark results, task-shaped reference cost, and completion time. The `/scout/` page, JSON API, and MCP tool all use the same index and ranking.

Scout is a separate beta product. It does not change the OpenMerit npm package, Pi coordinator, or Inference Terminal. Recommendations are evidence-based candidates for your own evaluation, not a guarantee of task accuracy or an independently validated state-of-the-art ranking.

## Use Scout

Open [Scout](https://openmerit.ai/scout/), type a task, and select **Find models**. For example: “I want to upload an invoice and get the invoice number, date, vendor, subtotal, tax, and total as JSON.” The examples submit real requests to the same API as your own input.

The comparison table keeps recommendations in Scout rank order. When a matching measured task profile is available, it shows calibration accuracy, mean reported cost per 1,000 similar tasks, and median full request time. Otherwise it shows relative benchmark quality and reference cost/time estimates. The caption identifies the evidence, sample size or workload assumptions. Neither mode executes your prompt. Select **Evidence** for a model to inspect its ID, separate input/output prices, benchmark scores, evaluation configurations, and source links. On narrow screens, scroll the table horizontally; the model column stays visible. Provider marks appear beside provider names, without icon tiles. They are bundled and served from the same origin; missing marks leave the provider name visible. No third-party favicon service is contacted. The page follows the device’s light or dark appearance with the Inference Terminal’s compact typography and neutral surfaces. **Copy JSON** copies the complete recommendation response. **API & MCP**, **Capabilities**, and **Sources** expand below the index status.

The capability index lists each area with its benchmark-series and model counts. After a search, task matches appear first with a check mark. Counts describe index coverage, not the number of models eligible for your task. The source panel distinguishes the last successful collection time from the age of published measurements.

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

- `recommendations`: up to five distinct model IDs with rank, provider, reason, quality signal, evidence coverage, input/output pricing, reference timing when available, supported inputs, and source-linked evidence. `reference` gives cost in USD and completion seconds (`null` when unavailable). Benchmark mode includes assumed input/output tokens; measured mode sets those token counts to `null` and supplies `measured` with observed field accuracy, the reliability-capped `effectiveQuality`, cross-task `availability`, valid outputs, sample size, charge coverage, provider routes and evidence provenance. `comparison` gives the number of comparable candidates and average shared-capability coverage. The compatibility `pricing.blendedPerMillion` field retains its old 3:1 calculation but is no longer scored.
- `task`: interpreted capabilities and weights; image-input, structured-output, tool-calling and persistent-memory requirements; `requirements.tools` (`yes`, `no`, `unspecified`); `requirements.memory` (`none`, `session`, `persistent`, `unspecified`); consequential `uncertainty`; `workload.input` and `workload.output` (`short`, `medium`, `long`), `workload.priority` (`balanced`, `quality`, `cost`, `latency`), `kind` (`extract`, `classify`, `dispatch`, `sql`, `calculate`, `retrieve`, `other`), and `interpreter: "openai-decisions"`. `keywords` is retained as an empty compatibility field. A general-purpose fallback means no specific capability was identified, not that the classifier was unavailable.
- `checkedAt`, `stale`, `degraded`, `sources`: index and source health. Each source has its own last successful check. A failed source is marked degraded; any source unchecked for more than two hours makes the index stale.
- `benchmarks`, `benchmarksWithResults`, `models`, `availableModels`, `eligibleModels`: indexed series, series with matched results, evidence-backed models, catalogue models, and eligible candidates for this task.
- `wordCloud`: capability vocabulary with benchmark and model coverage counts.
- `ranking`: algorithm version, `mode` (`measured` or `benchmarks`), workload and tradeoff weights. A measured `profile` gives the task type, sample size, eligible tested pool, protocol hash, collection and expiry times, and public evidence URL. `benchmarkEligibleModels` reports the separate public-benchmark pool. Rank is the final order; the aggregate `score` is a supporting signal and can be non-monotonic because stronger direct comparisons take precedence.
- `warnings`, `methodology`, `interpretationMs`, `elapsedMs`: limitations, ranking method, Decisions request time, and measured server ranking time when the runtime provides a sufficiently precise clock (`null` otherwise). Cloudflare freezes its clock during synchronous work, so the hosted page reports measured HTTP round-trip time instead of claiming zero-millisecond computation.

`GET /scout/api/status` returns index coverage, source timestamps, freshness, and scheduler state without submitting a prompt. API responses are `no-store`. Errors return JSON with `error`: 400 for invalid input, 413 for an oversized request, 415 for a non-JSON body, 405 for an unsupported method, 404 for an unknown endpoint, 429 when shared admission limits are reached, and 503 if interpretation is unavailable. A failed, malformed, refused, or timed-out Decisions response never silently falls back to keyword ranking. MCP reports these failures as tool errors.

Scout recommends models; it does not process an uploaded invoice, execute a task, install a model, or select a provider account.

## Real sources and their limits

The hourly updater fetches six public feeds and prepares the index before requests arrive. Queries make one Decisions call for intent classification; they do not browse benchmark sites or ask a model to invent rankings.

| Feed | Used for |
| --- | --- |
| [Epoch AI](https://epoch.ai/benchmarks) | Benchmark definitions, published results, source links, and evaluation configurations. |
| [Artificial Analysis](https://artificialanalysis.ai/leaderboards/models) | Benchmark results, measured first-answer delay and reference generation speed. Archived evaluations remain labelled when their models are still available. |
| [OmniDocBench](https://github.com/opendatalab/OmniDocBench#end-to-end-evaluation) | Document parsing scores from the explicitly labelled `v1.6_full` leaderboard, including newer document models than the OpenVLM snapshot. |
| [OpenCompass / VLMEvalKit](https://huggingface.co/spaces/opencompass/open_vlm_leaderboard) | Visual understanding and OCR benchmark results. Its feed currently identifies itself as 17 September 2025. |
| [Berkeley Function Calling Leaderboard (BFCL v4)](https://gorilla.cs.berkeley.edu/leaderboard) | Native function-calling single-turn, live, and multi-turn scores; separate memory scores for key-value, vector, and recursive-summarization stores. |
| [OpenRouter](https://openrouter.ai/api/v1/models) | Available model IDs, input modalities, declared tools and structured-output support, context limits, and advertised token prices. |

Over 100 benchmark **series** are indexed, including source-specific implementations and versions. This is not 100 independent publishers, and coverage is not uniformly current. Some definitions have no results matched to an available model. Both counts are exposed. Missing metrics and ambiguous or unmatched model versions are omitted. Availability is limited to OpenRouter's text-output catalogue, excluding batch/free variants and known routers.

Collection time is not measurement time. A successful hourly check does not make an old result new. Some feeds omit measurement dates; those remain unknown. Model release dates are never substituted. OmniDocBench's repository version and leaderboard version differ; Scout uses the version actually printed on the score table. Document parsing is a proxy for invoice extraction, not an evaluation of your exact six fields. New models without comparable evidence may be absent from a task's shortlist.

Epoch AI attribution: “Capabilities & benchmarking,” published at epoch.ai, normalized and matched by Scout under the source's [CC BY 4.0 terms](https://creativecommons.org/licenses/by/4.0/). Other sources are attributed in the source panel and individual evidence links. These are data-source attributions, not a statement about OpenMerit's licensing.

## Ranking

One server-side call to [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions), using `gpt-6-luna`, interprets the work the selected model must perform. It distinguishes executing tools from writing code about them, incidental words such as “tool” or “agent,” supplied plain text versus visual inputs, and session state versus persistent memory. Eighteen typed choices become capability weights, requirements, reference input/output sizes, a tradeoff priority, and a narrow task operation. One function dispatch is distinct from an autonomous action loop. SQL generation counts as coding. Required extraction is not downweighted merely because reasoning is marked useful. Long-context requirements imply a long reference input. Visual input uses at least the medium category, even when the task description is short. Decisions sees the task, not candidate names or rankings; the shortlist still comes from collected scores.

Strong JSON/schema filtering also needs explicit format wording in the prompt. An uncertain format answer cannot turn an ordinary story or comparison into a JSON task. Low-confidence consequential classifications and unspecified retention/tool interfaces are exposed as uncertainty. This is still a probabilistic classifier: paraphrases can differ, ambiguous requests can be misread, and English format-grounding rules limit multilingual handling. Scout has no clarification dialogue or user-defined constraints yet.

Image tasks require an image-capable model. JSON/schema tasks require declared `response_format` or `structured_outputs` support. Visual document tasks require document-specific evidence. Required tool use needs declared `tools` support and relevant tool-calling evidence. A matching measured task profile can supply this evidence; the benchmark fallback requires published results for the capability. Persistent memory needs declared tools support and dedicated memory evidence; generic reasoning or a large context window cannot substitute. Session-only state does not trigger this filter. Recognized image/video/audio generation and transcription tasks return no recommendations because those outputs are outside the current index.

BFCL contributes only native function-calling (`FC`) configurations, preserving their published labels. Its six correlated series count as one benchmark family, not six independent sources. Missing scores stay unknown and zero remains a score. Model versions are matched conservatively; ambiguous versions are omitted. BFCL does not supply per-model measurement dates, so these remain unknown.

The [BFCL memory evaluations](https://gorilla.cs.berkeley.edu/blogs/16_bfcl_v4_memory.html) test using external memory stores across sessions. They do **not** establish built-in model memory, automatic retention in your app, or performance on your storage system. The application still implements storage and tool execution. Models without matched memory results are excluded when persistent memory is required, including newer models with other strong scores.

Ranking version 3 first checks for a matching, recent **measured task profile**. The static evidence file contains only calibration aggregates: mean per-case field accuracy, mean reported charge, median full request time, valid-output counts, provider routes, and provenance. Malformed schemas and request failures receive zero accuracy; failure time remains in the latency median. Unknown charges are excluded from the cost mean and the known-charge count is disclosed. A model with no known charges earns no cost advantage. Request reliability is shared across calibration tasks: after two or more failed requests, the observed HTTP success rate caps the model’s task-quality signal. A clean task slice cannot erase repeated route failures elsewhere. One isolated failure remains in its own task score rather than penalizing every other task. This is route evidence from the evaluation period, not a promise about current provider availability.

Profiles cover small text-field extraction, rule-based classification, single-function dispatch, read-only SQL, short numerical problems, long-text record retrieval, and visual-field extraction. Matching requires the same typed operation, image/tool/schema requirements, and input/output size category. A new required capability outside the profile, an autonomous loop, or session/persistent memory prevents a match. At least five currently eligible tested models and six calibration cases per model are required. Availability and declared capabilities still come from the refreshed catalogue. Evidence expires after seven days; expired, undersampled and unmatched profiles fall back to public benchmarks.

Measured mode ranks **within its disclosed tested pool**, not every catalogue model. It applies the same pairwise policy to actual observed accuracy, charges and time. A ten-percentage-point accuracy gap gives full pairwise quality preference. These are small development samples, not confidence intervals or proof of accuracy on an arbitrary prompt. Text cases are authored; the visual calibration set contains eight public Portuguese invoices. Classification, arithmetic and simple dispatch can saturate at perfect accuracy, leaving cost and variable latency to determine close positions. Public calibration aggregates and their protocol hash are available through each model’s **Measured task evidence** link. Raw answer keys and held-out test outcomes are not runtime inputs. The source images are attributed to [Cruz and Castelli's invoice dataset](https://zenodo.org/records/6371710), under that dataset's CC BY 4.0 terms.

The **benchmark fallback** compares each pair only on benchmarks both have run. It does not compare percentiles from different cohorts. Differences are averaged within correlated families, then across shared task capabilities. The first two percentage points are treated as an indifference band; a further twenty-point gap gives full quality preference. This deliberately conservative proxy policy prevents a small benchmark lead from outweighing a large cost/time premium. It is not a statistical significance test. Format-following evidence has one-quarter weight only when another substantive capability is **required**, rather than merely useful.
Each comparison also considers relative cost and completion time. The default balanced priority uses **60% quality, 20% cost, 20% latency**. An explicit quality priority uses 90/5/5; cost uses 60/35/5; latency uses 60/5/35. These are transparent defaults, not learned optimal weights. Decisions can infer a priority from the prompt; there are no new controls or extra interpretation calls. Broad or ambiguous preferences can still be misclassified.

The strongest supported pairwise preferences are applied first, skipping any that would create a cycle, to order the whole candidate pool before taking five. This prevents a model's easy wins over weak candidates from automatically overriding its direct comparison with another finalist. Strength is reduced when fewer task capabilities have shared evidence. Unsupported comparisons add no pairwise preference. A conservative aggregate signal breaks otherwise unresolved orderings; stable IDs break exact ties. Missing measurements are never treated as zero cost or instant completion. Warnings expose limited comparison coverage.

Reference input sizes are **1,024 / 4,096 / 32,768 tokens**, and visible output sizes are **128 / 512 / 2,048 tokens**, for short / medium / long. Cost is input tokens × advertised input rate + output tokens × advertised output rate. This excludes hidden reasoning, cache effects, image-specific tokenization and other modality charges. An image task's input size is an illustrative token workload, not a prediction of that image's bill. Separate rates and the assumptions are returned so clients can substitute their own measured usage.

Reference completion time is **time to the first answer token + visible output tokens / throughput**. When the source publishes multiple configurations, Scout calculates completion time for each paired measurement and takes the median. It does not mix one configuration's delay with another's throughput, or confuse early streamed reasoning with the first answer. Missing first-answer timing for a reasoning configuration stays unknown. A legacy snapshot with only first-token timing supplies no completion estimate; deployment replaces an older data format with the bundled compatible snapshot even if the legacy refresh timestamp is newer. These measurements are from Artificial Analysis, not the caller's OpenRouter route; provider and reasoning settings may differ. They are not guaranteed task latency.

The goal is an ordered five-model shortlist, not just a first-place pick. Regression checks cover all five positions, all ten within-five pairs, cutoff membership, provider-name invariance, unknown cost/time, capability and modality boundaries, expiry, and rejection of held-out observations during evidence building. Paid evaluation uses separate calibration and held-out cases across seven task types. Held-out measurements compare both membership and ordering within the tested candidate pool; they do not establish a global optimum or a perfect ordering for every prompt. Test the five candidates on your own examples before choosing a production model.
If fewer than five eligible models have evidence, Scout returns fewer and explains why. There are no accounts, saved prompt history, vector database, user selection controls, or language-model reranker.

## Current validation limits

The 14 October development audit used 438 calibration observations, an initial 358-call test, then 159 fresh validation calls after a general reliability correction. The unchanged visual shortlist retained its original 40-call test; it was not rerun. The final validation has three fresh cases per text task and five document photos. The candidate pools were selected before testing and do not cover the whole catalogue.

| Task | Top-five membership, before → after | Ordered pairs, before → after | Field accuracy, before → after |
| --- | --- | --- | --- |
| Text extraction | 5/5 → 4/5 | 6/10 → 6/10 | 43/45 → 42/45 |
| Classification | 4/5 → 4/5 | 4/10 → 9/10 | 30/30 → 30/30 |
| Single-tool dispatch | 1/5 → 5/5 | 6/10 → 8/10 | 15/15 → 15/15 |
| SQL generation | 4/5 → 4/5 | 3/10 → 9/10 | 15/15 → 15/15 |
| Numerical reasoning | 3/5 → 3/5 | 3/10 → 10/10 | 15/15 → 15/15 |
| Long-text retrieval | 3/5 → 4/5 | 8/10 → 6/10 | 45/45 → 43/45 |
| Document photos | 4/5 → 4/5 | 8/10 → 7/10 | 135/150 → 134/150 |

Membership compares against the measured-policy top five within each tested pool. Ordered pairs compare all ten pairs within each shortlist, using the same 60/20/20 policy on actual test accuracy, charges and request time. Overall membership improved from 24/35 to 28/35 and pair agreement from 38/70 to 55/70, but none of the seven final lists matched the entire measured order. Text extraction, long-text retrieval and visual extraction still showed small accuracy regressions. These results do **not** establish that the text-extraction regression is fully resolved or that all five recommendations are optimal.

The first test exposed cross-task request failures; those test outcomes were not ingested as calibration. The reliability correction uses calibration observations only. Provider rate limits and timeouts count as failures, and latency can change between runs. The final sample is small and the visual test contains four payment slips and one invoice, including missing identifiers and tax fields. Reported improvements are development evidence, not a SOTA claim.

## Refresh and data handling

The task description is sent to Scout and then to OpenAI Decisions for interpretation. Scout's application code processes it in memory without saving or logging it. Only the public index and published calibration aggregates are persisted; prompts are not sent to benchmark sites or recommended-model providers. [OpenAI's API data controls and retention policies](https://developers.openai.com/api/docs/guides/your-data) apply to that provider call. Scout does not claim zero retention by OpenAI. Hosting infrastructure can have separate request-metadata policies. Clipboard actions occur only when selected. Describe the task rather than pasting actual invoices, credentials or private customer records.

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

`npm run scout:refresh` fetches the six public feeds and atomically updates `scout/snapshot.json` after validation. Successful sources replace their previous data; failed sources retain labelled prior data when available. Refreshing public sources requires no provider key or inference budget. It does not run model evaluations or update the separate calibration file. Calibration refreshes are an explicit offline evaluation and deployment; no paid hourly evaluation job is installed. Recommendation queries require the server key and incur Decisions API usage.

## Hosting and verification

`wrangler.scout.jsonc` defines a separate Scout Worker, one SQLite Durable Object holding the index, and an hourly cron at minute 7 UTC. Configure `OPENAI_API_KEY` as a secret on this Scout Worker before deployment. Searches interpret the task once and use the prepared in-memory index. The bundled snapshot allows immediate startup; subsequent successful updates persist across restarts. Refreshes are serialized.

`demo/domain-router.mjs` routes Scout paths to this service while retaining the existing website, protected memo, authentication, and dashboard services. The public guide is generated and published with the main documentation. Do not deploy the older root `wrangler.jsonc` to publish Scout. `npm run build:scout` packages only Scout, public documentation, and its shared assets; private memo and demo applications are excluded.

```sh
npm run check:scout
npm run verify
npx wrangler@4.136.3 dev --config wrangler.scout.jsonc
```

Tests cover measured-profile matching, held-out data isolation, ordered top-five behavior, false-positive regressions, response validation, memory/tool eligibility, provenance, missing metrics, source outage recovery, catalogue removals, provider failure/timeout, admission limits, shared API/MCP interpretation, compact evidence and routing isolation. Real API diagnostic cases are separate opt-in checks that incur provider usage. These establish implementation behavior, not task-level model accuracy. Local checks and CI do not publish a deployment. Physical mobile hardware requires separate verification.
