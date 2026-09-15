# Invoice OCR/Vision Model Benchmark

This benchmark runs the same fixed-schema extraction prompt over 10 synthetic
invoice images with exact source-of-truth JSON. It compares five
vision-capable OpenRouter models across quality, cost, and latency.

The sample is pinned to revision
`44ddfd3c0c373b69f377910f83c4164a1e52d52c` of
[`alamgirqazi/invoice-ocr-synthetic`](https://huggingface.co/datasets/alamgirqazi/invoice-ocr-synthetic)
(CC BY 4.0). It contains four clean, three faded, and three bad-scan images,
with no repeated base invoice.

## Run

```bash
npm run benchmark:invoice:prepare
OPENROUTER_API_KEY=... npm run benchmark:invoice
```

The key is read only from the process environment. Results are written as raw
JSONL responses plus an aggregate JSON summary under `results/`.

## Fixed output schema

The response contains 10 scalar fields (supplier, customer, identifiers,
dates, currency, and totals) plus every line item with description, quantity,
unit price, and amount. The JSON Schema in
`benchmark.ts` is sent to every model unchanged.

## Metrics

- **Quality:** micro-averaged, strict typed exact match over the union of JSON
  leaf paths. This penalizes missing and hallucinated line items/fields.
- **Exact document rate:** byte-independent deep JSON equality after parsing.
- **Latency:** client-observed time for the successful request attempt; ranking
  uses the median. If a request succeeds after a retry, prior attempt and
  backoff time are not included.
- **Cost:** the `usage.cost` returned by OpenRouter, summed over the 10 runs.
- **Pareto layers:** nondominated layers minimizing cost and median latency
  while maximizing exact-leaf quality.

Run `npm run benchmark:invoice:audit -- <runs.jsonl>` after the benchmark to
produce the visibility-audited summary. The audit excludes `po_number` from
quality scoring because four selected source records contain latent PO metadata
that their images do not render; the raw, unadjusted scores remain preserved.

## Round two

The second benchmark reuses the exact dataset, prompt, JSON Schema, request
settings, scoring functions, and PO-visibility projection. It tests five model
IDs that do not overlap with round one:

- `google/gemma-4-26b-a4b-it` - very cheap open model
- `qwen/qwen3-vl-235b-a22b-instruct` - document/OCR-oriented model
- `xiaomi/mimo-v2.5` - strong general VLM
- `x-ai/grok-4.6` - strong general VLM
- `openai/gpt-6-astra` - frontier model

Before paid calls, the runner queries OpenRouter's public model catalog and
endpoint APIs. It requires image input plus at least one live endpoint that
advertises both `response_format` and `structured_outputs`, and records the
complete availability/pricing snapshot beside the run.

```bash
npm run benchmark:invoice:round2 -- --verify-only
OPENROUTER_API_KEY=... npm run benchmark:invoice:round2
npm run benchmark:invoice:round2:audit -- \
  benchmark/invoice_ocr/results/runs_round2_<timestamp>.jsonl
```

Round-two files use `*_round2_<timestamp>` names, so neither the first run nor
later second-round runs are overwritten. The audited summary adds strict local
schema validation and clean/faded/bad-scan quality slices without changing the
quality score itself. `valid_output_rate` means a parseable JSON object;
`schema_valid_rate` means the parsed object also conforms to the complete fixed
schema; `failure_rate` includes requests that completed without usable message
content.
