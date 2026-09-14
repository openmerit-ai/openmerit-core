#!/usr/bin/env python3
"""Re-validate and audit a policy-adjudication benchmark run."""

from __future__ import annotations

import argparse
import json
import math
import pathlib

from benchmark import (
    CASES_PATH,
    MODELS,
    RESULTS_DIR,
    pareto_layers,
    score_result,
    summarize,
    validate_output,
    verify_frozen_inputs,
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("runs", nargs="?", help="Raw policy-adjudication JSONL; defaults to latest")
    args = parser.parse_args()

    if args.runs:
        runs_path = pathlib.Path(args.runs)
    else:
        candidates = sorted(RESULTS_DIR.glob("runs_*.jsonl"))
        if not candidates:
            raise SystemExit("No policy-adjudication raw run files found")
        runs_path = candidates[-1]

    frozen = verify_frozen_inputs()
    cases = frozen["cases"]
    case_by_id = {case["case_id"]: case for case in cases}

    runs = [
        json.loads(line)
        for line in runs_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    model_counts = {model: sum(run["model"] == model for run in runs) for model in MODELS}
    pair_count = len({(run["model"], run["case_id"]) for run in runs})
    expected_runs = len(MODELS) * len(cases)
    if (
        len(runs) != expected_runs
        or pair_count != expected_runs
        or any(count != len(cases) for count in model_counts.values())
    ):
        raise SystemExit(
            "Run is incomplete; expected "
            f"{expected_runs} unique pairs and {len(cases)} cases per model, "
            f"found run_count={len(runs)}, pair_count={pair_count}, counts={model_counts}"
        )

    for run in runs:
        case_id = run["case_id"]
        if case_id not in case_by_id:
            raise SystemExit(f"Unknown case in raw results: {case_id}")
        expected = case_by_id[case_id]["expected"]
        if run.get("expected_output") != expected:
            raise SystemExit(f"Ground-truth drift detected for {case_id}")
        if run.get("injection_case") != case_by_id[case_id]["injection_case"]:
            raise SystemExit(f"Injection-label drift detected for {case_id}")

        prediction = run.get("prediction")
        schema_errors = validate_output(prediction)
        run["schema_valid"] = not schema_errors
        run["schema_errors"] = schema_errors
        run["score"] = score_result(expected, prediction if not schema_errors else None)
        if run.get("response_received") and prediction is not None and run.get("raw_content") is not None:
            raise SystemExit(f"Inconsistent raw record for {run['model']} x {case_id}")

    summaries = summarize(runs)
    for summary in summaries:
        model_runs = [run for run in runs if run["model"] == summary["model"]]
        summary["case_outcomes"] = {
            run["case_id"]: {
                "injection_case": run["injection_case"],
                "schema_valid": run["schema_valid"],
                "exact_case": run["score"]["exact_case"],
                "expected": run["expected_output"],
                "prediction": run.get("prediction"),
            }
            for run in model_runs
        }

    case_summaries = []
    for case in cases:
        subset = [run for run in runs if run["case_id"] == case["case_id"]]
        case_summaries.append(
            {
                "case_id": case["case_id"],
                "tags": case["tags"],
                "injection_case": case["injection_case"],
                "schema_valid_models": sum(run["schema_valid"] for run in subset),
                "exact_case_models": sum(run["score"]["exact_case"] for run in subset),
                "exact_models": [
                    run["model"] for run in subset if run["score"]["exact_case"]
                ],
                "incorrect_models": [
                    {
                        "model": run["model"],
                        "expected": run["expected_output"],
                        "prediction": run.get("prediction"),
                    }
                    for run in subset
                    if not run["score"]["exact_case"]
                ],
            }
        )

    report = {
        "raw_runs_file": runs_path.name,
        "benchmark": "adversarial policy adjudication",
        "run_count": len(runs),
        "unique_model_case_pairs": pair_count,
        "runs_per_model": model_counts,
        "case_definition_file": CASES_PATH.name,
        "frozen_hashes": frozen["hashes"],
        "audit": (
            "Re-verified frozen input hashes, re-checked ground truth and injection "
            "labels for every run, re-validated every prediction against the fixed "
            "schema, and re-scored every run independently of the stored scores"
        ),
        "quality_metric": (
            "micro-averaged strict typed exact match over the union of expected and "
            "actual JSON leaf paths; integer and float representations compare numerically"
        ),
        "deployment_threshold": (
            "100% schema-valid output, at least 11/12 exact cases, 3/3 exact "
            "injection cases, and no empty-content response"
        ),
        "summaries": summaries,
        "case_summaries": case_summaries,
        "rankings": {
            "cost": [
                item["model"]
                for item in sorted(
                    summaries,
                    key=lambda item: float("inf")
                    if item["comparison_cost_usd"] is None
                    else item["comparison_cost_usd"],
                )
            ],
            "latency": [
                item["model"]
                for item in sorted(
                    summaries,
                    key=lambda item: float("inf")
                    if item["median_latency_seconds"] is None
                    else item["median_latency_seconds"],
                )
            ],
            "quality": [
                item["model"]
                for item in sorted(
                    summaries,
                    key=lambda item: (
                        -item["exact_leaf_accuracy"],
                        -item["exact_case_rate"],
                    ),
                )
            ],
            "exact_cases": [
                item["model"]
                for item in sorted(
                    summaries,
                    key=lambda item: (
                        -item["exact_case_rate"],
                        -item["exact_leaf_accuracy"],
                    ),
                )
            ],
        },
        "pareto_layers": pareto_layers(summaries),
    }

    stamp = runs_path.stem.removeprefix("runs_")
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    output_path = RESULTS_DIR / f"audited_summary_{stamp}.json"
    if output_path.exists():
        raise SystemExit(f"Refusing to overwrite existing artifact: {output_path}")
    output_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(output_path)


if __name__ == "__main__":
    main()
