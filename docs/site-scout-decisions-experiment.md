# Scout Decisions experiment — 14 October 2026

Historical experiment record. The comparison against the keyword interpreter and its runner were retired during the 16 October single-runtime consolidation. Use `scout/experiments/audit.mjs` for the current semantic acceptance suite. Commands below describe the historical experiment only.

Historical status: this initial experiment was local only and did not change production. The subsequent integration below supersedes its implementation status; see the Scout launch record for verified publication.

## Question and method

Does interpreting the user's task with OpenAI Decisions improve capability selection before Scout's existing evidence-based ranking?

The experiment uses `gpt-6-luna` through `POST /v1/decisions`, one call containing 14 independent choice questions per prompt. It sends only the synthetic prompts in `scout/experiments/decisions-cases.mjs`, not candidate model names, rankings, credentials, or production traffic. This is an opt-in developer command, not part of normal verification:

```sh
node scout/experiments/run-decisions.mjs /absolute/path/results.json
```

`OPENAI_API_KEY` must be available in the environment. Running this command incurs API usage and saves prompts, responses, usage and derived rankings to the specified local file. It does not save the key. The Worker does not import these experimental modules.

Twenty prompts and 65 selected boolean expectations were written before the calls. Four additional requests repeat the invoice wording pair, giving 24 requests total. The cases target known weaknesses and are not a representative or independently labeled evaluation set. Expectations check selected dimensions, not every possible classifier output. Memory and tool-interface judgments are assessed separately because the baseline does not expose these fields.

Both interpreters use the identical bundled snapshot from `2026-10-14T15:33:40.447Z`: 211 models and 137 benchmark series. Prices, evidence, filtering, and the 80% quality / 13% price / 7% throughput formula are held fixed. Decisions changes capability selection and weights: absent/uncertain = 0, useful = 1, required = 3, with Scout's existing document multiplier of two. This experiment does not yet interpret price/speed preferences or enforce new tool, context-length or memory constraints.

## Observations

| Measurement | Keywords | Decisions |
| --- | --- | --- |
| Specified capability checks passed | 49/65 | 65/65 |
| Cases passing every specified check | 9/20 | 20/20 |
| Invoice rankings across six requests / two wording variants | 2 distinct rankings | 1 ranking |
| Explicit memory-scope judgments | Not represented | 20/20 matched expectations |
| Tool-interface judgments | Not represented | 20/20 matched expectations |

The perfect result applies only to the selected checks. Manual review found additional incorrect outputs below; it is not a claim of perfect classification accuracy. Sixteen of twenty top-five lists changed. A different list does not establish a better list without testing the candidate models on actual work.

The original invoice paragraph and its `tool` → `application` variant both produced documents = 6, structured = 3, vision = 3, with no agent requirement. All six requests returned:

1. GPT-5 Mini
2. Gemini 2.5 Pro
3. Gemini 3 Flash Preview
4. GPT-4.1 Mini
5. GPT-5

The original keyword result had Gemini 3 Flash Preview second, Gemini 2.5 Pro third, GPT-5 fourth and GPT-4.1 fifth. The semantic result agrees with the keyword result after removing the incidental word `tool`.

Decisions also detected implicit external actions, respected explicit exclusions of browsing/tools, separated fictional agents from software agents, distinguished session memory from persistent memory, and avoided treating a 200-word “long email” as long-context work on the specified checks.

### Latency and usage

Measured from the local machine, including network and response parsing, sequential requests with no application cache or retries:

| API-call measurement | Result |
| --- | --- |
| Requests | 24 successful, 0 failed |
| Minimum | 228 ms |
| Median | 447 ms |
| Sample p95 (nearest rank) | 1,301 ms |
| Maximum | 1,721 ms |
| Input tokens | 66,804 |
| Estimated API cost | $0.0066804 |

Cost uses the [published Decisions input rate](https://developers.openai.com/api/docs/guides/decisions#pricing-and-availability) of $0.10 per million tokens, excluding account-specific premiums. This is an estimate, not a billing invoice. These timings are the extra interpretation call, not deployed Scout end-to-end latency. The first request was the slowest; the measurements do not establish the cause. Twenty-four observations are insufficient to establish production tail latency.

## Failures found outside the initial assertions

Manual review of the complete responses found false positives that the prewritten partial assertions did not cover:

- The fictional-agent story incorrectly received a strict JSON requirement: `yes` probability 0.52, confidence 0.04. It also received structured-output weight 3 despite only 0.42 probability for `required`.
- The supplied-product comparison incorrectly received a strict JSON requirement: `yes` probability 0.58, confidence 0.16.
- The codebase review received structured-output weight 3 without an extraction/schema requirement.
- The two persistent-memory paraphrases received different general capability weights and different rankings. The memory classification itself was consistent, but ranking stability is not solved generally.

An offline sensitivity check requiring at least 0.80 summed probability for positive capability weights removed several questionable tags but reduced the original checks from 65/65 to 57/65. A blanket confidence cutoff is therefore not a validated fix. It was not added to the interpreter. Confidence must be calibrated per decision, and hard exclusion rules need particular care.

## Evidence limitations and next decision

The initial frozen index had zero dedicated memory benchmark series. The Berkeley Function Calling Leaderboard series has zero model matches; agent evidence includes τ benchmarks. Recognizing a memory need does not establish which model handles it best. Memory depends on the model and memory setup, and should remain explicitly unverified until comparable evidence is ingested.

No candidate model processed an invoice, performed tool calls or used a memory store during this experiment. There is no measured downstream task-success improvement. No latency or price preferences were newly inferred or optimized.

The result supports continuing with a decision interpreter, but not deploying this raw prototype as a fully validated ranking improvement. Before production: add comprehensive negative assertions, calibrate hard filters on a separate labeled set, handle uncertain answers explicitly, enforce required API features, add comparable memory/tool evidence, and measure latency from the deployed service. Keep the public data-handling guide accurate when prompts begin reaching an inference provider.


## Integration follow-up — 14 October 2026

The production interpreter retains fourteen typed questions. A shorter six-question rewrite lost valid requirements in diagnostic cases and was rejected. Targeted normalization now grounds JSON/schema filtering in prompt wording, removes incidental agent tags when external action is excluded, and separates persistent memory from session state. It preserves consequential uncertainty without hiding valid low-confidence requirements behind a blanket probability cutoff.

Thirty real Decisions calls, including ten additional negation/format/tool/memory cases, passed all 83 selected boolean checks. Median API time was 447 ms, sample p95 897 ms, and maximum 1,064 ms; total input usage was 83,009 tokens. This remains a small, development-informed diagnostic set, not a held-out accuracy benchmark. Captured results are retained outside the repository in the task artifact directory.

The index now includes BFCL v4 native function-calling results and three separate external-memory backends, with strict support/evidence filters. On the captured snapshot, the two memory paraphrases return the same five model IDs despite slightly different generic capability weights. The rank formula remains 80/13/7. API/MCP share one interpreter and never accept client-supplied classifications. No vector database or generative reranker was added.
