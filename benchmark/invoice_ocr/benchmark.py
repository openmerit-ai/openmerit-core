#!/usr/bin/env python3
"""Benchmark five OpenRouter vision models on structured invoice extraction."""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import math
import os
import pathlib
import statistics
import time
import urllib.error
import urllib.request
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
RESULTS_DIR = ROOT / "results"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

MODELS = [
    "qwen/qwen3.5-9b",
    "deepseek/deepseek-v4-flash-vision-exp",
    "google/gemini-3.8-flash",
    "openai/gpt-5.6-sol",
    "anthropic/claude-sonnet-5",
]

LINE_ITEM_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "description": {"type": ["string", "null"]},
        "quantity": {"type": ["number", "null"]},
        "unit_price": {"type": ["number", "null"]},
        "amount": {"type": ["number", "null"]},
    },
    "required": [
        "description",
        "quantity",
        "unit_price",
        "amount",
    ],
}

OUTPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "supplier_name": {"type": ["string", "null"]},
        "customer_name": {"type": ["string", "null"]},
        "invoice_number": {"type": ["string", "null"]},
        "po_number": {"type": ["string", "null"]},
        "document_date": {"type": ["string", "null"]},
        "due_date": {"type": ["string", "null"]},
        "document_currency": {"type": ["string", "null"]},
        "document_total_net": {"type": ["number", "null"]},
        "document_total_tax": {"type": ["number", "null"]},
        "document_total_amount": {"type": ["number", "null"]},
        "line_items": {"type": "array", "items": LINE_ITEM_SCHEMA},
    },
    "required": [
        "supplier_name",
        "customer_name",
        "invoice_number",
        "po_number",
        "document_date",
        "due_date",
        "document_currency",
        "document_total_net",
        "document_total_tax",
        "document_total_amount",
        "line_items",
    ],
}

PROMPT = """Extract the invoice into the required JSON schema using only the image.

Rules:
- Copy names, identifiers, and descriptions exactly as printed.
- Return dates as YYYY-MM-DD, regardless of the printed date format.
- Return currency as its three-letter ISO code.
- Return monetary values and quantities as JSON numbers without currency symbols or grouping separators.
- Preserve line-item order and include every printed line item exactly once.
- Use null only when a scalar field is not present. Never infer a missing value.
- document_total_net is the subtotal/net amount before tax; document_total_amount is the final amount including tax.
- Return only the schema-conforming JSON object."""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return math.nan
    ordered = sorted(values)
    rank = (len(ordered) - 1) * fraction
    low = math.floor(rank)
    high = math.ceil(rank)
    if low == high:
        return ordered[low]
    return ordered[low] * (high - rank) + ordered[high] * (rank - low)


def flatten(value: Any, path: str = "") -> dict[str, Any]:
    if isinstance(value, dict):
        flattened: dict[str, Any] = {}
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else key
            flattened.update(flatten(child, child_path))
        return flattened
    if isinstance(value, list):
        if not value:
            return {f"{path}.__length__": 0}
        flattened = {f"{path}.__length__": len(value)}
        for index, child in enumerate(value):
            flattened.update(flatten(child, f"{path}[{index}]"))
        return flattened
    return {path: value}


def exact_value(expected: Any, actual: Any) -> bool:
    # JSON has one number type: 1 and 1.0 are semantically the same value.
    if isinstance(expected, bool) or isinstance(actual, bool):
        return type(expected) is type(actual) and expected == actual
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        return expected == actual
    return type(expected) is type(actual) and expected == actual


def score(expected: dict, actual: dict | None) -> dict:
    if actual is None:
        expected_flat = flatten(expected)
        return {
            "exact_document": False,
            "matched_leaves": 0,
            "total_union_leaves": len(expected_flat),
            "exact_leaf_accuracy": 0.0,
            "scalar_accuracy": 0.0,
            "line_item_accuracy": 0.0,
        }

    expected_flat = flatten(expected)
    actual_flat = flatten(actual)
    paths = set(expected_flat) | set(actual_flat)
    matches = sum(
        1
        for path in paths
        if path in expected_flat
        and path in actual_flat
        and exact_value(expected_flat[path], actual_flat[path])
    )
    scalar_paths = [path for path in expected_flat if not path.startswith("line_items")]
    item_paths = [path for path in paths if path.startswith("line_items")]
    scalar_matches = sum(
        1
        for path in scalar_paths
        if path in actual_flat
        and exact_value(expected_flat[path], actual_flat[path])
    )
    item_matches = sum(
        1
        for path in item_paths
        if path in expected_flat
        and path in actual_flat
        and exact_value(expected_flat[path], actual_flat[path])
    )
    return {
        "exact_document": expected == actual,
        "matched_leaves": matches,
        "total_union_leaves": len(paths),
        "exact_leaf_accuracy": matches / len(paths) if paths else 1.0,
        "scalar_accuracy": scalar_matches / len(scalar_paths) if scalar_paths else 1.0,
        "line_item_accuracy": item_matches / len(item_paths) if item_paths else 1.0,
    }


def make_request(model: str, image_path: pathlib.Path) -> dict:
    image_b64 = base64.b64encode(image_path.read_bytes()).decode("ascii")
    return {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": PROMPT},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"},
                    },
                ],
            }
        ],
        "temperature": 0,
        "max_tokens": 2500,
        "reasoning": {"effort": "minimal"},
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "invoice_extraction",
                "strict": True,
                "schema": OUTPUT_SCHEMA,
            },
        },
    }


def invoke(api_key: str, payload: dict, retries: int = 3) -> tuple[dict, float, int]:
    encoded = json.dumps(payload).encode("utf-8")
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        request = urllib.request.Request(
            OPENROUTER_URL,
            data=encoded,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/openmerit/openmerit",
                "X-Title": "OpenMerit Invoice OCR Benchmark",
            },
            method="POST",
        )
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                body = json.load(response)
            return body, time.perf_counter() - started, attempt
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
            last_error = exc
            if isinstance(exc, urllib.error.HTTPError):
                error_body = exc.read().decode("utf-8", "replace")
                last_error = RuntimeError(f"HTTP {exc.code}: {error_body[:1000]}")
                if exc.code < 500 and exc.code != 429:
                    break
            if attempt < retries:
                time.sleep(2 ** (attempt - 1))
    raise RuntimeError(f"OpenRouter request failed after {retries} attempts: {last_error}")


def content_from_response(response: dict) -> str:
    content = response["choices"][0]["message"]["content"]
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(part.get("text", "") for part in content if isinstance(part, dict))
    raise TypeError(f"Unexpected response content: {type(content).__name__}")


def parse_json(content: str) -> dict:
    stripped = content.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        stripped = "\n".join(lines[1:-1])
    parsed = json.loads(stripped)
    if not isinstance(parsed, dict):
        raise TypeError("Model output is not a JSON object")
    return parsed


def summarize(runs: list[dict]) -> list[dict]:
    summaries = []
    for model in dict.fromkeys(run["model"] for run in runs):
        model_runs = [run for run in runs if run["model"] == model]
        latencies = [run["latency_seconds"] for run in model_runs if run["status"] == "ok"]
        valid_runs = [run for run in model_runs if run["status"] == "ok"]
        total_matches = sum(run["score"]["matched_leaves"] for run in model_runs)
        total_leaves = sum(run["score"]["total_union_leaves"] for run in model_runs)
        costs = [run["cost_usd"] for run in valid_runs if run["cost_usd"] is not None]
        summaries.append(
            {
                "model": model,
                "successful_runs": len(valid_runs),
                "json_valid_rate": sum(run["json_valid"] for run in model_runs) / len(model_runs),
                "exact_documents": sum(run["score"]["exact_document"] for run in valid_runs),
                "exact_document_rate": sum(run["score"]["exact_document"] for run in valid_runs)
                / len(model_runs),
                "exact_leaf_accuracy": total_matches / total_leaves if total_leaves else 0.0,
                "mean_scalar_accuracy": statistics.fmean(
                    run["score"]["scalar_accuracy"] for run in model_runs
                )
                if model_runs
                else 0.0,
                "mean_line_item_accuracy": statistics.fmean(
                    run["score"]["line_item_accuracy"] for run in model_runs
                )
                if model_runs
                else 0.0,
                "total_cost_usd": sum(costs) if costs else None,
                "mean_cost_usd": statistics.fmean(costs) if costs else None,
                "mean_latency_seconds": statistics.fmean(latencies) if latencies else None,
                "median_latency_seconds": statistics.median(latencies) if latencies else None,
                "p95_latency_seconds": percentile(latencies, 0.95) if latencies else None,
                "prompt_tokens": sum(run["usage"].get("prompt_tokens", 0) for run in valid_runs),
                "completion_tokens": sum(
                    run["usage"].get("completion_tokens", 0) for run in valid_runs
                ),
            }
        )
    return summaries


def dominates(left: dict, right: dict) -> bool:
    left_values = (
        left["total_cost_usd"] if left["total_cost_usd"] is not None else math.inf,
        left["median_latency_seconds"]
        if left["median_latency_seconds"] is not None
        else math.inf,
        -left["exact_leaf_accuracy"],
    )
    right_values = (
        right["total_cost_usd"] if right["total_cost_usd"] is not None else math.inf,
        right["median_latency_seconds"]
        if right["median_latency_seconds"] is not None
        else math.inf,
        -right["exact_leaf_accuracy"],
    )
    return all(a <= b for a, b in zip(left_values, right_values)) and any(
        a < b for a, b in zip(left_values, right_values)
    )


def pareto_layers(summaries: list[dict]) -> list[list[str]]:
    remaining = list(summaries)
    layers = []
    while remaining:
        frontier = [
            candidate
            for candidate in remaining
            if not any(dominates(other, candidate) for other in remaining if other is not candidate)
        ]
        frontier.sort(
            key=lambda item: (
                item["total_cost_usd"] if item["total_cost_usd"] is not None else math.inf,
                -item["exact_leaf_accuracy"],
            )
        )
        layers.append([item["model"] for item in frontier])
        frontier_models = {item["model"] for item in frontier}
        remaining = [item for item in remaining if item["model"] not in frontier_models]
    return layers


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", nargs="*", choices=MODELS, default=MODELS)
    args = parser.parse_args()

    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise SystemExit("Set OPENROUTER_API_KEY in the environment")
    manifest_path = DATA_DIR / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit("Run prepare_data.py first")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    run_stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    raw_path = RESULTS_DIR / f"runs_{run_stamp}.jsonl"
    runs: list[dict] = []

    for model in args.models:
        for invoice in manifest["rows"]:
            expected = json.loads(
                (DATA_DIR / invoice["ground_truth"]).read_text(encoding="utf-8")
            )
            print(f"RUN {len(runs) + 1:02d}/{len(args.models) * len(manifest['rows'])}: "
                  f"{model} × {invoice['invoice_id']}", flush=True)
            run = {
                "model": model,
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
            except Exception as exc:  # Preserve failures as benchmark results.
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
                f"cost={run['cost_usd']} | accuracy={run['score']['exact_leaf_accuracy']:.3f}",
                flush=True,
            )

    summaries = summarize(runs)
    report = {
        "created_at": utc_now(),
        "dataset": manifest["dataset"],
        "dataset_revision": manifest["dataset_revision"],
        "invoice_count": len(manifest["rows"]),
        "model_count": len(args.models),
        "run_count": len(runs),
        "quality_metric": "micro-averaged strict typed exact match over union of JSON leaf paths",
        "latency_metric": "median client-observed end-to-end seconds",
        "cost_metric": "OpenRouter response usage.cost summed over 10 successful runs",
        "summaries": summaries,
        "rankings": {
            "cost": [
                item["model"]
                for item in sorted(
                    summaries,
                    key=lambda item: item["total_cost_usd"]
                    if item["total_cost_usd"] is not None
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
                    key=lambda item: (-item["exact_leaf_accuracy"], -item["exact_document_rate"]),
                )
            ],
        },
        "pareto_layers": pareto_layers(summaries),
        "raw_runs_file": raw_path.name,
    }
    report_path = RESULTS_DIR / f"summary_{run_stamp}.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {raw_path}")
    print(f"Wrote {report_path}")


if __name__ == "__main__":
    main()
