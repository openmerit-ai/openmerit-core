#!/usr/bin/env python3
"""Visibility-audit and stratify the second invoice benchmark."""

from __future__ import annotations

import argparse
import copy
import json
import math
import pathlib
from typing import Any

from audit_results import EXCLUDED_QUALITY_FIELDS, project_visible
from benchmark import DATA_DIR, OUTPUT_SCHEMA, RESULTS_DIR, pareto_layers, score, summarize
from benchmark_round2 import MODELS, add_reliability_metrics


def schema_errors(value: Any, schema: dict, path: str = "$") -> list[str]:
    errors = []
    allowed_types = schema.get("type", [])
    if isinstance(allowed_types, str):
        allowed_types = [allowed_types]

    type_checks = {
        "object": lambda item: isinstance(item, dict),
        "array": lambda item: isinstance(item, list),
        "string": lambda item: isinstance(item, str),
        "number": lambda item: isinstance(item, (int, float))
        and not isinstance(item, bool),
        "null": lambda item: item is None,
    }
    if allowed_types and not any(type_checks[name](value) for name in allowed_types):
        return [f"{path}: expected {allowed_types}, found {type(value).__name__}"]

    if isinstance(value, dict) and "object" in allowed_types:
        properties = schema.get("properties") or {}
        required = set(schema.get("required") or [])
        missing = sorted(required - set(value))
        extra = sorted(set(value) - set(properties)) if schema.get("additionalProperties") is False else []
        errors.extend(f"{path}.{key}: required property missing" for key in missing)
        errors.extend(f"{path}.{key}: additional property not allowed" for key in extra)
        for key in sorted(set(value) & set(properties)):
            errors.extend(schema_errors(value[key], properties[key], f"{path}.{key}"))
    elif isinstance(value, list) and "array" in allowed_types:
        item_schema = schema.get("items")
        if item_schema:
            for index, item in enumerate(value):
                errors.extend(schema_errors(item, item_schema, f"{path}[{index}]"))
    return errors


def add_schema_metrics(summaries: list[dict], runs: list[dict]) -> None:
    for summary in summaries:
        model_runs = [run for run in runs if run["model"] == summary["model"]]
        valid = sum(bool(run.get("schema_valid")) for run in model_runs)
        summary["schema_valid_outputs"] = valid
        summary["schema_valid_rate"] = valid / len(model_runs) if model_runs else 0.0


def summarize_slice(runs: list[dict]) -> dict:
    summary = summarize(runs)[0]
    add_reliability_metrics([summary], runs)
    add_schema_metrics([summary], runs)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("runs", nargs="?", help="Round-two raw runs JSONL; defaults to latest")
    args = parser.parse_args()

    if args.runs:
        runs_path = pathlib.Path(args.runs)
    else:
        candidates = sorted(RESULTS_DIR.glob("runs_round2_*.jsonl"))
        if not candidates:
            raise SystemExit("No round-two raw run files found")
        runs_path = candidates[-1]

    if not runs_path.name.startswith("runs_round2_"):
        raise SystemExit("audit_round2.py accepts only runs_round2_*.jsonl artifacts")
    runs = [json.loads(line) for line in runs_path.read_text(encoding="utf-8").splitlines()]
    counts = {model: sum(run["model"] == model for run in runs) for model in MODELS}
    if len(runs) != 50 or any(count != 10 for count in counts.values()):
        raise SystemExit(
            "Round two is incomplete; expected exactly 10 invoice observations for each "
            f"of five models, found {counts}"
        )

    for run in runs:
        expected_path = DATA_DIR / f"{run['invoice_id']}_ground_truth.json"
        expected = json.loads(expected_path.read_text(encoding="utf-8"))
        run["score"] = score(project_visible(expected), project_visible(run.get("prediction")))
        run["schema_errors"] = (
            schema_errors(run["prediction"], OUTPUT_SCHEMA)
            if run.get("prediction") is not None
            else ["$: no parsed JSON object"]
        )
        run["schema_valid"] = not run["schema_errors"]

    summaries = summarize(runs)
    add_reliability_metrics(summaries, runs)
    add_schema_metrics(summaries, runs)
    for summary in summaries:
        model_runs = [run for run in runs if run["model"] == summary["model"]]
        quality_breakdown = {}
        for label in ("clean", "faded", "bad_scan"):
            subset = [run for run in model_runs if run["quality"] == label]
            quality_breakdown[label] = summarize_slice(subset)
        degraded = [run for run in model_runs if run["quality"] in {"faded", "bad_scan"}]
        quality_breakdown["degraded_combined"] = summarize_slice(degraded)
        summary["quality_breakdown"] = quality_breakdown

    pareto_input = copy.deepcopy(summaries)
    for summary in pareto_input:
        summary["total_cost_usd"] = summary["comparison_cost_usd"]

    def numeric_cost(item: dict) -> float:
        value = item.get("comparison_cost_usd")
        return value if value is not None else math.inf

    def numeric_latency(item: dict) -> float:
        value = item.get("median_latency_seconds")
        return value if value is not None else math.inf

    report = {
        "raw_runs_file": runs_path.name,
        "benchmark_round": 2,
        "run_count": len(runs),
        "runs_per_model": counts,
        "visibility_audit": {
            "excluded_quality_fields": sorted(EXCLUDED_QUALITY_FIELDS),
            "reason": (
                "The selected images do not render latent PO metadata in four rows; "
                "a fifth image labels a PO-like value only as Reference. This is the "
                "same audit projection used in round one."
            ),
        },
        "quality_metric": (
            "micro-averaged strict JSON leaf-value match after excluding fields not "
            "visibly supported by the rendered images"
        ),
        "degraded_scan_definition": "the three faded plus three bad_scan invoices",
        "summaries": summaries,
        "rankings": {
            "cost": [item["model"] for item in sorted(summaries, key=numeric_cost)],
            "latency": [item["model"] for item in sorted(summaries, key=numeric_latency)],
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
                        -item["schema_valid_rate"],
                        item["failure_rate"],
                    ),
                )
            ],
            "degraded_scan_quality": [
                item["model"]
                for item in sorted(
                    summaries,
                    key=lambda item: (
                        -item["quality_breakdown"]["degraded_combined"][
                            "exact_leaf_accuracy"
                        ],
                        -item["quality_breakdown"]["degraded_combined"][
                            "exact_document_rate"
                        ],
                    ),
                )
            ],
            "bad_scan_quality": [
                item["model"]
                for item in sorted(
                    summaries,
                    key=lambda item: (
                        -item["quality_breakdown"]["bad_scan"]["exact_leaf_accuracy"],
                        -item["quality_breakdown"]["bad_scan"]["exact_document_rate"],
                    ),
                )
            ],
        },
        "pareto_layers": pareto_layers(pareto_input),
    }

    stamp = runs_path.stem.removeprefix("runs_round2_")
    output_path = RESULTS_DIR / f"audited_summary_round2_{stamp}.json"
    if output_path.exists():
        raise SystemExit(f"Refusing to overwrite existing artifact: {output_path}")
    output_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(output_path)


if __name__ == "__main__":
    main()
