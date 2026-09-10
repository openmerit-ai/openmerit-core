#!/usr/bin/env python3
"""Rescore a run after the documented image/label visibility audit."""

from __future__ import annotations

import argparse
import copy
import json
import pathlib

from benchmark import pareto_layers, score, summarize


ROOT = pathlib.Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
RESULTS_DIR = ROOT / "results"

# The selected source rows carry PO values in latent record metadata for four
# invoices whose rendered images do not show a PO. Another invoice visibly says
# "Reference", which is not a PO even though its value begins with "PO". Keep
# the field in raw model outputs for transparency, but exclude it from the fair
# vision/OCR quality score.
EXCLUDED_QUALITY_FIELDS = {"po_number"}


def project_visible(document: dict | None) -> dict | None:
    if document is None:
        return None
    projected = copy.deepcopy(document)
    for field in EXCLUDED_QUALITY_FIELDS:
        projected.pop(field, None)
    return projected


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("runs", nargs="?", help="Raw runs JSONL; defaults to latest")
    args = parser.parse_args()

    if args.runs:
        runs_path = pathlib.Path(args.runs)
    else:
        candidates = sorted(RESULTS_DIR.glob("runs_*.jsonl"))
        if not candidates:
            raise SystemExit("No raw run files found")
        runs_path = candidates[-1]

    runs = [json.loads(line) for line in runs_path.read_text(encoding="utf-8").splitlines()]
    for run in runs:
        expected_path = DATA_DIR / f"{run['invoice_id']}_ground_truth.json"
        expected = json.loads(expected_path.read_text(encoding="utf-8"))
        run["score"] = score(project_visible(expected), project_visible(run.get("prediction")))

    summaries = summarize(runs)
    for summary in summaries:
        if summary["successful_runs"] == 10:
            comparison_cost = summary["total_cost_usd"]
            cost_basis = "observed"
        else:
            comparison_cost = summary["mean_cost_usd"] * 10
            cost_basis = "projected from successful responses"
        summary["comparison_cost_usd"] = comparison_cost
        summary["comparison_cost_basis"] = cost_basis

    cost_adjusted = copy.deepcopy(summaries)
    for summary in cost_adjusted:
        summary["total_cost_usd"] = summary["comparison_cost_usd"]

    report = {
        "raw_runs_file": runs_path.name,
        "run_count": len(runs),
        "visibility_audit": {
            "excluded_quality_fields": sorted(EXCLUDED_QUALITY_FIELDS),
            "reason": (
                "The selected images do not render latent PO metadata in four rows; "
                "a fifth image labels a PO-like value only as Reference."
            ),
        },
        "quality_metric": (
            "micro-averaged strict JSON leaf-value match after excluding fields not "
            "visibly supported by the rendered images"
        ),
        "summaries": summaries,
        "rankings": {
            "cost": [
                item["model"]
                for item in sorted(summaries, key=lambda item: item["comparison_cost_usd"])
            ],
            "latency": [
                item["model"]
                for item in sorted(summaries, key=lambda item: item["median_latency_seconds"])
            ],
            "quality": [
                item["model"]
                for item in sorted(
                    summaries,
                    key=lambda item: (-item["exact_leaf_accuracy"], -item["exact_document_rate"]),
                )
            ],
        },
        "pareto_layers": pareto_layers(cost_adjusted),
    }

    stamp = runs_path.stem.removeprefix("runs_")
    output_path = RESULTS_DIR / f"audited_summary_{stamp}.json"
    output_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(output_path)


if __name__ == "__main__":
    main()
