#!/usr/bin/env python3
"""Benchmark OpenRouter coding models on deterministic SQLite text-to-SQL tasks."""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
import math
import os
import pathlib
import sqlite3
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
RESULTS_DIR = ROOT / "results"
SCHEMA_PATH = DATA_DIR / "schema.sql"
SEED_PATH = DATA_DIR / "seed.sql"
TASKS_PATH = DATA_DIR / "tasks.json"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"

PREVIOUS_INVOICE_MODELS = [
    "qwen/qwen3.5-9b",
    "deepseek/deepseek-v4-flash-vision-exp",
    "google/gemini-3.8-flash",
    "openai/gpt-5.6-sol",
    "anthropic/claude-sonnet-5",
    "google/gemma-4-26b-a4b-it",
    "qwen/qwen3-vl-235b-a22b-instruct",
    "xiaomi/mimo-v2.5",
    "x-ai/grok-4.6",
    "openai/gpt-6-astra",
]

MODEL_SPECS = [
    {
        "model": "inception/mercury-2.5",
        "role": "ultra-cheap fast reasoning model",
        "selection_reason": (
            "Diffusion-language architecture optimized for low latency, included to "
            "test whether its speed translates to executable SQL."
        ),
    },
    {
        "model": "qwen/qwen3-coder-30b-a3b-instruct",
        "role": "cheap open coding model",
        "selection_reason": (
            "Open-weight code-specialized mixture-of-experts model with very low "
            "catalog pricing and native structured outputs."
        ),
    },
    {
        "model": "mistralai/codestral-2508",
        "role": "code specialist",
        "selection_reason": (
            "Dedicated Mistral code-generation model, providing a specialist baseline "
            "from a different model family."
        ),
    },
    {
        "model": "moonshotai/kimi-k2.7-code",
        "role": "strong agentic coding model",
        "selection_reason": (
            "Large coding-focused model designed for end-to-end programming tasks and "
            "multi-step code reasoning."
        ),
    },
    {
        "model": "anthropic/claude-opus-5",
        "role": "frontier coding/reasoning model",
        "selection_reason": (
            "Current Anthropic flagship, included as a frontier quality ceiling for "
            "complex analytical SQL."
        ),
    },
]
MODELS = [item["model"] for item in MODEL_SPECS]
MODEL_SPEC_BY_ID = {item["model"]: item for item in MODEL_SPECS}

OUTPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {"sql": {"type": "string"}},
    "required": ["sql"],
}

PROMPT_TEMPLATE = """Write one read-only SQLite 3 query for the task below.

Database schema:
```sql
{schema}
```

Task:
{question}

Rules:
- Return JSON matching the required schema, with the SQL query in the `sql` field.
- Return one SELECT statement; a WITH or WITH RECURSIVE query is allowed.
- Do not use PRAGMA, ATTACH, or any data-changing statement.
- Use only the supplied schema and the task's definitions.
- Use the exact output column names and ordering requested by the task.
- Do not add explanation or Markdown to the SQL string.
"""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def file_sha256(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "openmerit-text-to-sql-benchmark/1.0"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def public_model_snapshot() -> dict:
    catalog = fetch_json(OPENROUTER_MODELS_URL)
    catalog_by_id = {item["id"]: item for item in catalog.get("data", [])}
    overlap = sorted(set(MODELS) & set(PREVIOUS_INVOICE_MODELS))
    if overlap:
        raise RuntimeError(f"Text-to-SQL slate overlaps the invoice benchmarks: {overlap}")
    if len(MODELS) != 5 or len(set(MODELS)) != 5:
        raise RuntimeError("The benchmark must contain exactly five distinct models")

    selected = []
    for spec in MODEL_SPECS:
        model = spec["model"]
        item = catalog_by_id.get(model)
        if item is None:
            raise RuntimeError(f"Model is not in the current OpenRouter catalog: {model}")
        modalities = item.get("architecture", {}).get("input_modalities") or []
        if "text" not in modalities:
            raise RuntimeError(f"Model does not currently advertise text input: {model}")

        endpoint_url = (
            "https://openrouter.ai/api/v1/models/"
            f"{urllib.parse.quote(model, safe='/')}/endpoints"
        )
        payload = fetch_json(endpoint_url)
        endpoints = payload.get("data", {}).get("endpoints") or []
        live = [endpoint for endpoint in endpoints if endpoint.get("status") == 0]
        strict = [
            endpoint
            for endpoint in live
            if {"response_format", "structured_outputs"}.issubset(
                set(endpoint.get("supported_parameters") or [])
            )
        ]
        if not strict:
            raise RuntimeError(
                f"No live endpoint currently advertises strict structured outputs: {model}"
            )
        selected.append(
            {
                **spec,
                "catalog": item,
                "endpoint_url": endpoint_url,
                "live_endpoint_count": len(live),
                "strict_schema_endpoint_count": len(strict),
                "endpoints": endpoints,
            }
        )

    return {
        "verified_at": utc_now(),
        "source": OPENROUTER_MODELS_URL,
        "previous_invoice_models_excluded": PREVIOUS_INVOICE_MODELS,
        "required_capabilities": [
            "text input",
            "response_format",
            "structured_outputs",
            "at least one live endpoint",
        ],
        "models": selected,
    }


def load_tasks() -> list[dict]:
    payload = json.loads(TASKS_PATH.read_text(encoding="utf-8"))
    tasks = payload.get("tasks") or []
    if len(tasks) != 10 or len({task["task_id"] for task in tasks}) != 10:
        raise RuntimeError("The benchmark requires exactly 10 uniquely named SQL tasks")
    return tasks


def build_database() -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    connection.executescript(SEED_PATH.read_text(encoding="utf-8"))
    connection.execute("PRAGMA query_only = ON")
    return connection


def execute_sql(sql: str, timeout_seconds: float = 2.0) -> dict:
    statement = sql.strip()
    if statement.endswith(";"):
        statement = statement[:-1].rstrip()
    if ";" in statement:
        raise ValueError("Multiple SQL statements are not allowed")
    first_token = statement.split(None, 1)[0].upper() if statement else ""
    if first_token not in {"SELECT", "WITH"}:
        raise ValueError("Query must start with SELECT, WITH, or WITH RECURSIVE")

    connection = build_database()
    started = time.perf_counter()

    def progress() -> int:
        return 1 if time.perf_counter() - started > timeout_seconds else 0

    connection.set_progress_handler(progress, 1000)
    try:
        cursor = connection.execute(statement)
        rows = cursor.fetchmany(1001)
        if len(rows) > 1000:
            raise ValueError("Query result exceeds the 1000-row safety limit")
        columns = [description[0] for description in cursor.description or []]
        return {"columns": columns, "rows": [list(row) for row in rows]}
    finally:
        connection.close()


def expected_results(tasks: list[dict]) -> dict[str, dict]:
    return {task["task_id"]: execute_sql(task["reference_sql"]) for task in tasks}


def make_request(model: str, task: dict, schema_text: str) -> dict:
    prompt = PROMPT_TEMPLATE.format(schema=schema_text, question=task["question"])
    return {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        "max_tokens": 2000,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "sqlite_query",
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
                "X-Title": "OpenMerit Text-to-SQL Benchmark",
            },
            method="POST",
        )
        attempt_started = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                body = json.load(response)
            return body, time.perf_counter() - attempt_started, attempt
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
        return "".join(
            part.get("text", "") for part in content if isinstance(part, dict)
        )
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


def validate_output(value: dict | None) -> list[str]:
    if value is None:
        return ["No parsed JSON object"]
    errors = []
    if set(value) != {"sql"}:
        missing = sorted({"sql"} - set(value))
        extra = sorted(set(value) - {"sql"})
        if missing:
            errors.append(f"Missing properties: {missing}")
        if extra:
            errors.append(f"Additional properties: {extra}")
    if "sql" in value and (not isinstance(value["sql"], str) or not value["sql"].strip()):
        errors.append("sql must be a non-empty string")
    return errors


def flatten(value: Any, path: str = "") -> dict[str, Any]:
    if isinstance(value, dict):
        flattened = {}
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
    if isinstance(expected, bool) or isinstance(actual, bool):
        return type(expected) is type(actual) and expected == actual
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        return expected == actual
    return type(expected) is type(actual) and expected == actual


def score_result(expected: dict, actual: dict | None) -> dict:
    expected_flat = flatten(expected)
    if actual is None:
        return {
            "exact_result": False,
            "matched_leaves": 0,
            "total_union_leaves": len(expected_flat),
            "exact_leaf_accuracy": 0.0,
        }
    actual_flat = flatten(actual)
    paths = set(expected_flat) | set(actual_flat)
    matches = sum(
        1
        for path in paths
        if path in expected_flat
        and path in actual_flat
        and exact_value(expected_flat[path], actual_flat[path])
    )
    return {
        "exact_result": expected == actual,
        "matched_leaves": matches,
        "total_union_leaves": len(paths),
        "exact_leaf_accuracy": matches / len(paths) if paths else 1.0,
    }


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


def comparison_cost(summary: dict, expected_runs: int) -> tuple[float | None, str]:
    captured = summary["cost_captured_runs"]
    if captured == expected_runs:
        return summary["total_cost_usd"], "observed"
    if captured == 0:
        return None, "unavailable; no response usage was captured"
    return (
        summary["mean_cost_usd"] * expected_runs,
        "projected from responses with captured usage",
    )


def summarize(runs: list[dict]) -> list[dict]:
    summaries = []
    for model in dict.fromkeys(run["model"] for run in runs):
        model_runs = [run for run in runs if run["model"] == model]
        latencies = [
            run["latency_seconds"]
            for run in model_runs
            if run.get("latency_seconds") is not None
        ]
        costs = [run["cost_usd"] for run in model_runs if run.get("cost_usd") is not None]
        total_matches = sum(run["score"]["matched_leaves"] for run in model_runs)
        total_leaves = sum(run["score"]["total_union_leaves"] for run in model_runs)
        failure_reasons = collections.Counter(
            f"{run['status']}: {run.get('error') or run.get('parse_error') or run.get('schema_errors') or 'unspecified'}"
            for run in model_runs
            if run["status"] != "ok"
        )
        summary = {
            "model": model,
            "planned_runs": len(model_runs),
            "responses_received": sum(run.get("response_received", False) for run in model_runs),
            "response_rate": sum(run.get("response_received", False) for run in model_runs)
            / len(model_runs),
            "json_valid_outputs": sum(run.get("json_valid", False) for run in model_runs),
            "json_valid_rate": sum(run.get("json_valid", False) for run in model_runs)
            / len(model_runs),
            "schema_valid_outputs": sum(run.get("schema_valid", False) for run in model_runs),
            "schema_valid_rate": sum(run.get("schema_valid", False) for run in model_runs)
            / len(model_runs),
            "execution_successes": sum(
                run.get("execution_success", False) for run in model_runs
            ),
            "execution_success_rate": sum(
                run.get("execution_success", False) for run in model_runs
            )
            / len(model_runs),
            "exact_result_tasks": sum(run["score"]["exact_result"] for run in model_runs),
            "exact_result_rate": sum(run["score"]["exact_result"] for run in model_runs)
            / len(model_runs),
            "exact_result_leaf_accuracy": total_matches / total_leaves if total_leaves else 0.0,
            "failed_runs": sum(run["status"] != "ok" for run in model_runs),
            "failure_rate": sum(run["status"] != "ok" for run in model_runs)
            / len(model_runs),
            "failure_reasons": dict(failure_reasons),
            "total_cost_usd": sum(costs) if costs else None,
            "mean_cost_usd": statistics.fmean(costs) if costs else None,
            "cost_captured_runs": len(costs),
            "mean_latency_seconds": statistics.fmean(latencies) if latencies else None,
            "median_latency_seconds": statistics.median(latencies) if latencies else None,
            "p95_latency_seconds": percentile(latencies, 0.95) if latencies else None,
            "prompt_tokens": sum(
                run.get("usage", {}).get("prompt_tokens", 0) for run in model_runs
            ),
            "completion_tokens": sum(
                run.get("usage", {}).get("completion_tokens", 0) for run in model_runs
            ),
        }
        projected_cost, basis = comparison_cost(summary, len(model_runs))
        summary["comparison_cost_usd"] = projected_cost
        summary["comparison_cost_basis"] = basis
        summaries.append(summary)
    return summaries


def dominates(left: dict, right: dict) -> bool:
    left_values = (
        left["comparison_cost_usd"]
        if left["comparison_cost_usd"] is not None
        else math.inf,
        left["median_latency_seconds"]
        if left["median_latency_seconds"] is not None
        else math.inf,
        -left["exact_result_leaf_accuracy"],
    )
    right_values = (
        right["comparison_cost_usd"]
        if right["comparison_cost_usd"] is not None
        else math.inf,
        right["median_latency_seconds"]
        if right["median_latency_seconds"] is not None
        else math.inf,
        -right["exact_result_leaf_accuracy"],
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
                item["comparison_cost_usd"]
                if item["comparison_cost_usd"] is not None
                else math.inf,
                -item["exact_result_leaf_accuracy"],
            )
        )
        layers.append([item["model"] for item in frontier])
        frontier_models = {item["model"] for item in frontier}
        remaining = [item for item in remaining if item["model"] not in frontier_models]
    return layers


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="Validate tasks and current model availability without paid calls",
    )
    args = parser.parse_args()

    tasks = load_tasks()
    schema_text = SCHEMA_PATH.read_text(encoding="utf-8")
    expected_by_task = expected_results(tasks)
    snapshot = public_model_snapshot()
    if args.verify_only:
        for item in snapshot["models"]:
            pricing = item["catalog"]["pricing"]
            print(
                f"{item['model']} | {item['role']} | "
                f"prompt={pricing.get('prompt')} | completion={pricing.get('completion')} | "
                f"live_strict_endpoints={item['strict_schema_endpoint_count']}"
            )
        for task in tasks:
            expected = expected_by_task[task["task_id"]]
            print(
                f"{task['task_id']} | {task['difficulty']} | "
                f"rows={len(expected['rows'])} | columns={expected['columns']}"
            )
        return

    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise SystemExit("Set OPENROUTER_API_KEY in the environment")

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    raw_path = RESULTS_DIR / f"runs_{stamp}.jsonl"
    summary_path = RESULTS_DIR / f"summary_{stamp}.json"
    catalog_path = RESULTS_DIR / f"model_catalog_{stamp}.json"
    collisions = [path for path in (raw_path, summary_path, catalog_path) if path.exists()]
    if collisions:
        raise SystemExit(f"Refusing to overwrite existing artifacts: {collisions}")
    catalog_path.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")

    runs = []
    total_runs = len(MODELS) * len(tasks)
    for model in MODELS:
        for task in tasks:
            print(
                f"RUN {len(runs) + 1:02d}/{total_runs}: {model} x {task['task_id']}",
                flush=True,
            )
            expected = expected_by_task[task["task_id"]]
            run = {
                "benchmark": "text_to_sql",
                "model": model,
                "model_role": MODEL_SPEC_BY_ID[model]["role"],
                "task_id": task["task_id"],
                "difficulty": task["difficulty"],
                "skills": task["skills"],
                "started_at": utc_now(),
                "expected_result": expected,
            }
            request_started = time.perf_counter()
            try:
                response, attempt_latency, attempts = invoke(
                    api_key, make_request(model, task, schema_text)
                )
                latency = time.perf_counter() - request_started
                usage = response.get("usage") or {}
                run.update(
                    {
                        "response_received": True,
                        "response_id": response.get("id"),
                        "served_model": response.get("model"),
                        "provider": response.get("provider"),
                        "usage": usage,
                        "cost_usd": usage.get("cost"),
                        "attempts": attempts,
                        "attempt_latency_seconds": attempt_latency,
                        "latency_seconds": latency,
                    }
                )
                try:
                    content = content_from_response(response)
                except (KeyError, IndexError, TypeError) as exc:
                    run.update(
                        {
                            "status": "output_error",
                            "error": str(exc),
                            "json_valid": False,
                            "schema_valid": False,
                            "execution_success": False,
                            "prediction": None,
                            "actual_result": None,
                            "score": score_result(expected, None),
                        }
                    )
                else:
                    prediction = None
                    parse_error = None
                    try:
                        prediction = parse_json(content)
                    except (json.JSONDecodeError, TypeError) as exc:
                        parse_error = str(exc)
                    schema_errors = validate_output(prediction)
                    run.update(
                        {
                            "json_valid": prediction is not None,
                            "schema_valid": not schema_errors,
                            "parse_error": parse_error,
                            "schema_errors": schema_errors,
                            "prediction": prediction,
                            "raw_content": content if prediction is None else None,
                        }
                    )
                    if schema_errors:
                        run.update(
                            {
                                "status": "output_error",
                                "execution_success": False,
                                "actual_result": None,
                                "score": score_result(expected, None),
                            }
                        )
                    else:
                        try:
                            actual = execute_sql(prediction["sql"])
                        except (sqlite3.Error, ValueError) as exc:
                            run.update(
                                {
                                    "status": "query_error",
                                    "error": str(exc),
                                    "execution_success": False,
                                    "actual_result": None,
                                    "score": score_result(expected, None),
                                }
                            )
                        else:
                            result_score = score_result(expected, actual)
                            run.update(
                                {
                                    "status": "ok",
                                    "execution_success": True,
                                    "actual_result": actual,
                                    "score": result_score,
                                }
                            )
            except Exception as exc:
                latency = time.perf_counter() - request_started
                run.update(
                    {
                        "status": "request_error",
                        "completed_at": utc_now(),
                        "error": str(exc),
                        "response_received": False,
                        "latency_seconds": latency,
                        "attempts": 3,
                        "usage": {},
                        "cost_usd": None,
                        "json_valid": False,
                        "schema_valid": False,
                        "execution_success": False,
                        "prediction": None,
                        "actual_result": None,
                        "score": score_result(expected, None),
                    }
                )
            run["completed_at"] = utc_now()
            runs.append(run)
            with raw_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(run, ensure_ascii=False) + "\n")
            print(
                f"  {run['status']} | valid={run['schema_valid']} | "
                f"execute={run['execution_success']} | "
                f"exact={run['score']['exact_result']} | "
                f"latency={run['latency_seconds']:.3f}s | cost={run['cost_usd']}",
                flush=True,
            )

    summaries = summarize(runs)
    report = {
        "created_at": utc_now(),
        "benchmark": "deterministic SQLite analytical text-to-SQL",
        "task_count": len(tasks),
        "model_count": len(MODELS),
        "run_count": len(runs),
        "model_selection": MODEL_SPECS,
        "dataset": {
            "schema_sha256": file_sha256(SCHEMA_PATH),
            "seed_sha256": file_sha256(SEED_PATH),
            "tasks_sha256": file_sha256(TASKS_PATH),
            "sqlite_version": sqlite3.sqlite_version,
        },
        "request_contract": {
            "prompt_template": PROMPT_TEMPLATE,
            "output_schema": OUTPUT_SCHEMA,
            "temperature": 0,
            "max_tokens": 2000,
        },
        "quality_metric": (
            "micro-averaged strict typed exact match over the union of executed "
            "result JSON leaf paths, including column names, row order, and values"
        ),
        "exact_task_metric": "deep equality of expected and executed query result JSON",
        "latency_metric": (
            "full client wall time including retries and retry backoff for each scheduled run"
        ),
        "cost_metric": "OpenRouter response usage.cost summed over runs with captured usage",
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
                        -item["exact_result_leaf_accuracy"],
                        -item["exact_result_rate"],
                    ),
                )
            ],
            "execution_reliability": [
                item["model"]
                for item in sorted(
                    summaries,
                    key=lambda item: (
                        -item["execution_success_rate"],
                        -item["schema_valid_rate"],
                    ),
                )
            ],
        },
        "pareto_layers": pareto_layers(summaries),
        "raw_runs_file": raw_path.name,
        "model_catalog_file": catalog_path.name,
    }
    summary_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {raw_path}")
    print(f"Wrote {summary_path}")
    print(f"Wrote {catalog_path}")


if __name__ == "__main__":
    main()
