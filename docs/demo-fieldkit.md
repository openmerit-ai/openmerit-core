# Field kit · Six tasks

[Watch the six-task field-kit recording](https://openmerit.site/demo/?task=fieldkit). The captured run compares two heterogeneous model routes using real OpenRouter calls through Pi and OpenMerit. Each route uses six distinct models; five assignments change and the feasibility model is retained.

The field-kit workflow prepares an offline recording handoff from a Spanish technician brief, a synthetic equipment-label image, an HTML operating manual, and a Python capture script. Both paths already use **six different models**. The approved route pairs narrow specialists with broader coding, reasoning, and writing models:

## Workflow structure

| Task | Original mix | Approved mix | Capability being exercised |
| --- | --- | --- | --- |
| Translate brief | [Qwen3.6 Plus](https://openrouter.ai/qwen/qwen3.6-plus) | [Hy-MT2 1.8B](https://openrouter.ai/tencent/hy-mt2-1.8b) | Spanish → English translation; a compact translation specialist |
| Read label | [Qwen3.6 Flash](https://openrouter.ai/qwen/qwen3.6-flash) | [Perceptron Mk1.5](https://openrouter.ai/perceptron/perceptron-mk1.5) | Visual perception from an actual PNG input |
| Extract limits | [Gemini 3.1 Flash Lite](https://openrouter.ai/google/gemini-3.1-flash-lite) | [Schematron V2 Turbo](https://openrouter.ai/inference-net/schematron-v2-turbo) | Active-profile extraction from HTML; a 3B extraction model |
| Inspect code | [MiMo-V2.5 Pro](https://openrouter.ai/xiaomi/mimo-v2.5-pro) | [Laguna XS 2.1](https://openrouter.ai/poolside/laguna-xs-2.1) | Static Python analysis; a coding model with 33B total / 3B active parameters |
| Check feasibility | [Qwen3.7 Plus](https://openrouter.ai/qwen/qwen3.7-plus) | Qwen3.7 Plus (retained) | Reconcile the translated brief with equipment, operating limits, and code |
| Write handoff | [Gemma 4 31B](https://openrouter.ai/google/gemma-4-31b-it) | [Gemma 4 26B A4B](https://openrouter.ai/google/gemma-4-26b-a4b-it) | Copy the decision into the final schema with ordered evidence |

These are the supplied model assignments for this development workflow. Each route uses six distinct models; five assignments change and the reasoning model is retained. They describe the capabilities being exercised; the small suite does not establish broad capability rankings.

## Handoff rules

Six constraints govern the handoff: no network uploads, a compatible capture sample rate, enough battery energy, enough storage, completion by the same-day deadline, and a matching connector. Equality at a limit passes. The result must list every failing constraint in policy order, or return `ready` when none fail. No hardware is changed or dispatched, scripts are never executed, and no recording is uploaded.

The runner fixes the six-stage sequence and dispatches read-only source adapters. Translation feeds feasibility; label and manual extraction provide equipment limits; code analysis reports the final sample rate and upload flag; feasibility combines those actual outputs; writing copies that decision and its evidence. Intermediate errors are retained and scored even if a later model happens to produce a correct final answer. Raw scripts and source documents are data, not instructions to change the workflow. The vision models receive the same image pixels, without a text transcription of the label. The HTML extractor receives its extraction instructions in the JSON Schema. Translation uses plain text; code analysis requests JSON without enforced response formatting because Laguna does not support that API parameter. Other structured tasks use JSON Schema. Both routes receive the same task inputs, encodings, and output budgets: 180 tokens for each of the first four tasks, then 2,048 for the feasibility model (including a low reasoning effort) and 350 for the handoff. Optional reasoning is disabled for the other tasks where supported. No failed answer is repaired or substituted.

## Evaluation policy

Four evaluation goals cover ready and blocked kits across all six constraints. Every structured intermediate output, the final manifest, and the evidence list must match. The translation is checked through the resulting duration, deadline, and offline decision rather than a verbatim wording match. The source-adapter completion check is reported as `tool_use_performance`; it does not imply free-form tool selection by the models. Mean whole-goal latency must be ≤45 seconds and inference cost ≤$0.006. Four disjoint goals verify the approved route, including exact resource and deadline boundaries. This smaller suite keeps six-turn goals within the existing 120-request, ten-minute, and $1.25 session bounds. The evaluation records are `KIT-8101` through `KIT-8104`.

## Captured result

The supervised local run was verified on September 28, 2026.

| Path | Complete evaluation goals | Mean model cost per goal | Mean whole-goal latency |
| --- | --- | --- | --- |
| Original six-model mix | 4/4 | $0.001867339 | 29.49s |
| Approved six-model mix | 4/4 | $0.001449088 | 25.63s |

The approved route had **22% lower measured cost** and **13% lower mean latency**, with all intermediate and final checks passing. After operator approval, the application configuration changed and all 4/4 disjoint verification goals passed. The displayed sample is fieldkit-01; both paths return the same correct handoff. This demonstrates an observed efficiency improvement on the prepared suite, not an accuracy gain or a production reliability estimate.

The recording is a compressed replay of local real-provider calls, not a fresh Cloudflare run. All application models were released within March 28–September 28, 2026; dated OpenRouter sources are included in Run details and the downloaded evidence. Build: `demo-20260928-fieldkit-local-v5`. Source export SHA-256: `9f0986917f41354bb8ce80421bb9a413825fb457eb37c78af119747880a1514b`. Costs exclude Pi orchestration and infrastructure.

## What OpenMerit compares

The supplied original route and challenger are compared as complete configurations, with goals executed one at a time on both paths. OpenMerit measures them, validates the comparison, proposes an eligible improvement, and changes the application configuration after approval. It does not generate these API adapters or exhaustively search model assignments. Earlier integration comparisons were rejected after a feasibility answer exhausted its output budget and after a cheaper reasoning model misread sufficient storage. The revised challenger retains Qwen3.7 Plus for feasibility. Provider timeouts also stopped two incomplete comparisons. Those attempts are not presented as successful swaps.

See [the demo overview](demo.md) for playback controls, the shared comparison lifecycle, and how to read the measurements.
