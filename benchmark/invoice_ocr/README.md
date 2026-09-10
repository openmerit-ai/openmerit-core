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
python3 benchmark/invoice_ocr/prepare_data.py
OPENROUTER_API_KEY=... python3 benchmark/invoice_ocr/benchmark.py
```

The key is read only from the process environment. Results are written as raw
JSONL responses plus an aggregate JSON summary under `results/`.

## Fixed output schema

The response contains 10 scalar fields (supplier, customer, identifiers,
dates, currency, and totals) plus every line item with description, quantity,
unit price, and amount. The JSON Schema in
`benchmark.py` is sent to every model unchanged.

## Metrics

- **Quality:** micro-averaged, strict typed exact match over the union of JSON
  leaf paths. This penalizes missing and hallucinated line items/fields.
- **Exact document rate:** byte-independent deep JSON equality after parsing.
- **Latency:** client-observed end-to-end request time; ranking uses the median.
- **Cost:** the `usage.cost` returned by OpenRouter, summed over the 10 runs.
- **Pareto layers:** nondominated layers minimizing cost and median latency
  while maximizing exact-leaf quality.

Run `python3 benchmark/invoice_ocr/audit_results.py` after the benchmark to
produce the visibility-audited summary. The audit excludes `po_number` from
quality scoring because four selected source records contain latent PO metadata
that their images do not render; the raw, unadjusted scores remain preserved.
