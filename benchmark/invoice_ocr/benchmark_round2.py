#!/usr/bin/env python3
"""Run the second OpenRouter invoice benchmark without touching round-one results."""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import math
import os
import urllib.parse
import urllib.request

from benchmark import (
    DATA_DIR,
    MODELS as ROUND1_MODELS,
    OUTPUT_SCHEMA,
    PROMPT,
    RESULTS_DIR,
    content_from_response,
    invoke,
    make_request,
    pareto_layers,
    parse_json,
    score,
    summarize,
    utc_now,
)


OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"

MODEL_SPECS = [
    {
        "model": "google/gemma-4-26b-a4b-it",
        "role": "very cheap open model",
        "selection_reason": (
            "Open-weight, small active parameter count, image input, and native "
            "structured-output support at very low catalog pricing."
        ),
    },
    {
        "model": "qwen/qwen3-vl-235b-a22b-instruct",
        "role": "document/OCR-oriented model",
        "selection_reason": (
            "Open-weight VLM explicitly positioned for document parsing, charts, "
            "tables, and other text-rich visual inputs."
        ),
    },
    {
        "model": "xiaomi/mimo-v2.5",
        "role": "strong general VLM",
        "selection_reason": (
            "Modern native omnimodal model with low pricing and structured-output "
            "support, adding a distinct provider and architecture."
        ),
    },
    {
        "model": "x-ai/grok-4.6",
        "role": "strong general VLM",
        "selection_reason": (
            "High-end general multimodal model with native structured outputs and "
            "a provider family not represented in round one."
        ),
    },
    {
        "model": "openai/gpt-6-astra",
        "role": "frontier model",
        "selection_reason": (
            "Current OpenAI flagship with image input and native structured outputs, "
            "included to establish a frontier-quality ceiling."
        ),
    },
]
MODELS = [spec["model"] for spec in MODEL_SPECS]
MODEL_SPEC_BY_ID = {spec["model"]: spec for spec in MODEL_SPECS}


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "openmerit-invoice-benchmark/2.0"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def public_model_snapshot() -> dict:
    """Fetch and validate current public catalog and endpoint metadata."""
    catalog = fetch_json(OPENROUTER_MODELS_URL)
    catalog_by_id = {item["id"]: item for item in catalog.get("data", [])}
    selected = []

    overlap = sorted(set(MODELS) & set(ROUND1_MODELS))
    if overlap:
        raise RuntimeError(f"Round-two models overlap round one: {overlap}")
    if len(MODELS) != 5 or len(set(MODELS)) != 5:
        raise RuntimeError("Round two must contain exactly five distinct models")

    for spec in MODEL_SPECS:
        model = spec["model"]
        item = catalog_by_id.get(model)
        if item is None:
            raise RuntimeError(f"Model is not in the current OpenRouter catalog: {model}")
        modalities = item.get("architecture", {}).get("input_modalities") or []
        if "image" not in modalities:
            raise RuntimeError(f"Model does not currently advertise image input: {model}")

        endpoint_url = (
            "https://openrouter.ai/api/v1/models/"
            f"{urllib.parse.quote(model, safe='/')}/endpoints"
        )
        endpoint_payload = fetch_json(endpoint_url)
        endpoints = endpoint_payload.get("data", {}).get("endpoints") or []
        live_endpoints = [endpoint for endpoint in endpoints if endpoint.get("status") == 0]
        schema_endpoints = [
            endpoint
            for endpoint in live_endpoints
            if {"response_format", "structured_outputs"}.issubset(
                set(endpoint.get("supported_parameters") or [])
            )
        ]
        if not schema_endpoints:
            raise RuntimeError(
                f"No live endpoint currently advertises strict structured outputs: {model}"
            )

        selected.append(
            {
                **spec,
                "catalog": item,
                "endpoint_url": endpoint_url,
                "live_endpoint_count": len(live_endpoints),
                "strict_schema_endpoint_count": len(schema_endpoints),
                "endpoints": endpoints,
            }
        )

    return {
        "verified_at": utc_now(),
        "source": OPENROUTER_MODELS_URL,
        "required_capabilities": [
            "image input",
            "response_format",
            "structured_outputs",
            "at least one live endpoint",
        ],
        "round_one_models_excluded": ROUND1_MODELS,
        "models": selected,
    }


def comparison_cost(summary: dict, expected_runs: int) -> tuple[float | None, str]:
    if summary["successful_runs"] == expected_runs:
        return summary["total_cost_usd"], "observed"
    mean_cost = summary.get("mean_cost_usd")
    if mean_cost is None:
        return None, "unavailable; no response usage was captured"
    return mean_cost * expected_runs, "projected from successful responses"


def add_reliability_metrics(summaries: list[dict], runs: list[dict]) -> None:
    for summary in summaries:
        model_runs = [run for run in runs if run["model"] == summary["model"]]
        total = len(model_runs)
        failed_runs = sum(run["status"] != "ok" for run in model_runs)
        valid_outputs = sum(bool(run.get("json_valid")) for run in model_runs)
        failure_reasons = collections.Counter(
            run.get("error", "unspecified failure")
            for run in model_runs
            if run["status"] != "ok"
        )
        summary.update(
            {
                "planned_runs": total,
                "failed_runs": failed_runs,
                "failure_rate": failed_runs / total if total else 0.0,
                "failure_reasons": dict(failure_reasons),
                "valid_outputs": valid_outputs,
                "invalid_output_runs": total - valid_outputs,
                "valid_output_rate": valid_outputs / total if total else 0.0,
            }
        )
        projected_cost, cost_basis = comparison_cost(summary, total)
        summary["comparison_cost_usd"] = projected_cost
        summary["comparison_cost_basis"] = cost_basis


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="Validate current public availability/pricing without making paid calls",
    )
    args = parser.parse_args()

    manifest_path = DATA_DIR / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit("Run prepare_data.py first")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if len(manifest.get("rows") or []) != 10:
        raise SystemExit("Round two requires the existing manifest to contain exactly 10 invoices")

    snapshot = public_model_snapshot()
    if args.verify_only:
        for item in snapshot["models"]:
            pricing = item["catalog"]["pricing"]
            print(
                f"{item['model']} | {item['role']} | "
                f"prompt={pricing.get('prompt')} | completion={pricing.get('completion')} | "
                f"live_strict_endpoints={item['strict_schema_endpoint_count']}"
            )
        return

    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise SystemExit("Set OPENROUTER_API_KEY in the environment")

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    run_stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    raw_path = RESULTS_DIR / f"runs_round2_{run_stamp}.jsonl"
    summary_path = RESULTS_DIR / f"summary_round2_{run_stamp}.json"
    catalog_path = RESULTS_DIR / f"model_catalog_round2_{run_stamp}.json"
    collisions = [path for path in (raw_path, summary_path, catalog_path) if path.exists()]
    if collisions:
        raise SystemExit(f"Refusing to overwrite existing artifacts: {collisions}")
    catalog_path.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")

    runs: list[dict] = []
    total_runs = len(MODELS) * len(manifest["rows"])
    for model in MODELS:
        spec = MODEL_SPEC_BY_ID[model]
        for invoice in manifest["rows"]:
            expected = json.loads(
                (DATA_DIR / invoice["ground_truth"]).read_text(encoding="utf-8")
            )
            print(
                f"RUN {len(runs) + 1:02d}/{total_runs}: "
                f"{model} x {invoice['invoice_id']}",
                flush=True,
            )
            run = {
                "benchmark_round": 2,
                "model": model,
                "model_role": spec["role"],
                "invoice_id": invoice["invoice_id"],
                "row_idx": invoice["row_idx"],
                "quality": invoice["quality"],
                "template": invoice["template"],
                "started_at": utc_now(),
            }
            try:
                response, latency, attempts = invoke(
                    api_key, make_request(model, DATA_DIR / invoice["image"])
                )
                content = content_from_response(response)
                actual = None
                parse_error = None
                try:
                    actual = parse_json(content)
                except (json.JSONDecodeError, TypeError) as exc:
                    parse_error = str(exc)
                usage = response.get("usage") or {}
                run.update(
                    {
                        "status": "ok",
                        "completed_at": utc_now(),
                        "latency_seconds": latency,
                        "attempts": attempts,
                        "response_id": response.get("id"),
                        "served_model": response.get("model"),
                        "provider": response.get("provider"),
                        "usage": usage,
                        "cost_usd": usage.get("cost"),
                        "json_valid": actual is not None,
                        "parse_error": parse_error,
                        "prediction": actual,
                        "raw_content": content if actual is None else None,
                        "score": score(expected, actual),
                    }
                )
            except Exception as exc:  # Preserve failures as benchmark observations.
                run.update(
                    {
                        "status": "error",
                        "completed_at": utc_now(),
                        "error": str(exc),
                        "latency_seconds": None,
                        "attempts": 3,
                        "usage": {},
                        "cost_usd": None,
                        "json_valid": False,
                        "prediction": None,
                        "score": score(expected, None),
                    }
                )
            runs.append(run)
            with raw_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(run, ensure_ascii=False) + "\n")
            print(
                f"  {run['status']} | {run['latency_seconds']}s | "
                f"cost={run['cost_usd']} | "
                f"accuracy={run['score']['exact_leaf_accuracy']:.3f}",
                flush=True,
            )

    summaries = summarize(runs)
    add_reliability_metrics(summaries, runs)
    pareto_input = []
    for summary in summaries:
        item = dict(summary)
        item["total_cost_usd"] = summary["comparison_cost_usd"]
        pareto_input.append(item)

    report = {
        "created_at": utc_now(),
        "benchmark_round": 2,
        "dataset": manifest["dataset"],
        "dataset_revision": manifest["dataset_revision"],
        "invoice_count": len(manifest["rows"]),
        "model_count": len(MODELS),
        "run_count": len(runs),
        "model_selection": MODEL_SPECS,
        "request_contract": {
            "prompt": PROMPT,
            "output_schema": OUTPUT_SCHEMA,
            "temperature": 0,
            "max_tokens": 2500,
            "reasoning": {"effort": "minimal"},
        },
        "quality_metric": "micro-averaged strict typed exact match over union of JSON leaf paths",
        "latency_metric": "median and p95 client-observed end-to-end seconds",
        "cost_metric": "OpenRouter response usage.cost summed over 10 successful runs",
        "summaries": summaries,
        "rankings": {
            "cost": [
                item["model"]
                for item in sorted(
                    summaries,
                    key=lambda item: item["comparison_cost_usd"]
                    if item["comparison_cost_usd"] is not None
                    else math.inf,
                )
            ],
            "latency": [
                item["model"]
                for item in sorted(
                    summaries,
                    key=lambda item: item["median_latency_seconds"]
                    if item["median_latency_seconds"] is not None
                    else math.inf,
                )
            ],
            "quality": [
                item["model"]
                for item in sorted(
                    summaries,
                    key=lambda item: (
                        -item["exact_leaf_accuracy"],
                        -item["exact_document_rate"],
                    ),
                )
            ],
            "valid_output": [
                item["model"]
                for item in sorted(
                    summaries,
                    key=lambda item: (
                        -item["valid_output_rate"],
                        item["failure_rate"],
                    ),
                )
            ],
        },
        "pareto_layers": pareto_layers(pareto_input),
        "raw_runs_file": raw_path.name,
        "model_catalog_file": catalog_path.name,
    }
    summary_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {raw_path}")
    print(f"Wrote {summary_path}")
    print(f"Wrote {catalog_path}")


if __name__ == "__main__":
    main()
