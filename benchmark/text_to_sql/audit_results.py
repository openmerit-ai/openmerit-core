#!/usr/bin/env python3
"""Re-execute and audit a text-to-SQL benchmark run."""

from __future__ import annotations

import argparse
import json
import pathlib
import sqlite3

from benchmark import (
    MODELS,
    RESULTS_DIR,
    TASKS_PATH,
    execute_sql,
    expected_results,
    load_tasks,
    pareto_layers,
    score_result,
    summarize,
    validate_output,
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("runs", nargs="?", help="Raw text-to-SQL JSONL; defaults to latest")
    args = parser.parse_args()

    if args.runs:
        runs_path = pathlib.Path(args.runs)
    else:
        candidates = sorted(RESULTS_DIR.glob("runs_*.jsonl"))
        if not candidates:
            raise SystemExit("No text-to-SQL raw run files found")
        runs_path = candidates[-1]

    runs = [json.loads(line) for line in runs_path.read_text(encoding="utf-8").splitlines()]
    tasks = load_tasks()
    task_by_id = {task["task_id"]: task for task in tasks}
    expected_by_task = expected_results(tasks)
    model_counts = {model: sum(run["model"] == model for run in runs) for model in MODELS}
    pair_count = len({(run["model"], run["task_id"]) for run in runs})
    if len(runs) != 50 or pair_count != 50 or any(count != 10 for count in model_counts.values()):
        raise SystemExit(
            "Run is incomplete; expected 50 unique pairs and 10 tasks per model, "
            f"found run_count={len(runs)}, pair_count={pair_count}, counts={model_counts}"
        )

    for run in runs:
        task_id = run["task_id"]
        if task_id not in task_by_id:
            raise SystemExit(f"Unknown task in raw results: {task_id}")
        expected = expected_by_task[task_id]
        if run.get("expected_result") != expected:
            raise SystemExit(f"Ground-truth drift detected for {task_id}")

        prediction = run.get("prediction")
        schema_errors = validate_output(prediction)
        run["schema_valid"] = not schema_errors
        run["schema_errors"] = schema_errors
        actual = None
        execution_error = None
        if not schema_errors:
            try:
                actual = execute_sql(prediction["sql"])
            except (sqlite3.Error, ValueError) as exc:
                execution_error = str(exc)
        run["execution_success"] = actual is not None
        run["audited_execution_error"] = execution_error
        run["actual_result"] = actual
        run["score"] = score_result(expected, actual)

    summaries = summarize(runs)
    for summary in summaries:
        model_runs = [run for run in runs if run["model"] == summary["model"]]
        summary["difficulty_breakdown"] = {}
        for difficulty in ("easy", "medium", "hard"):
            subset = [run for run in model_runs if run["difficulty"] == difficulty]
            if subset:
                summary["difficulty_breakdown"][difficulty] = summarize(subset)[0]

    task_summaries = []
    for task in tasks:
        subset = [run for run in runs if run["task_id"] == task["task_id"]]
        task_summaries.append(
            {
                "task_id": task["task_id"],
                "difficulty": task["difficulty"],
                "skills": task["skills"],
                "schema_valid_models": sum(run["schema_valid"] for run in subset),
                "execution_success_models": sum(run["execution_success"] for run in subset),
                "exact_result_models": sum(run["score"]["exact_result"] for run in subset),
                "exact_models": [
                    run["model"] for run in subset if run["score"]["exact_result"]
                ],
            }
        )

    report = {
        "raw_runs_file": runs_path.name,
        "benchmark": "deterministic SQLite analytical text-to-SQL",
        "run_count": len(runs),
        "unique_model_task_pairs": pair_count,
        "runs_per_model": model_counts,
        "task_definition_file": TASKS_PATH.name,
        "audit": (
            "Recomputed every reference result and re-executed every schema-valid "
            "predicted query in a fresh read-only in-memory database"
        ),
        "quality_metric": (
            "micro-averaged strict typed exact match over the union of result JSON "
            "leaf paths, including column names, row order, and values"
        ),
        "summaries": summaries,
        "task_summaries": task_summaries,
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
                        -item["exact_result_leaf_accuracy"],
                        -item["exact_result_rate"],
                    ),
                )
            ],
            "exact_tasks": [
                item["model"]
                for item in sorted(
                    summaries,
                    key=lambda item: (
                        -item["exact_result_rate"],
                        -item["exact_result_leaf_accuracy"],
                    ),
                )
            ],
        },
        "pareto_layers": pareto_layers(summaries),
    }

    stamp = runs_path.stem.removeprefix("runs_")
    output_path = RESULTS_DIR / f"audited_summary_{stamp}.json"
    if output_path.exists():
        raise SystemExit(f"Refusing to overwrite existing artifact: {output_path}")
    output_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(output_path)


if __name__ == "__main__":
    main()
