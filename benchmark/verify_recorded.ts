#!/usr/bin/env node
/** Replay every checked-in raw run and compare it with its audited artifact. */

import { deepStrictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DATA_DIR as INVOICE_DATA_DIR,
  OUTPUT_SCHEMA as INVOICE_SCHEMA,
  RESULTS_DIR as INVOICE_RESULTS_DIR,
  pareto_layers as invoiceParetoLayers,
  score as scoreInvoice,
  summarize as summarizeInvoices,
} from "./invoice_ocr/benchmark.ts";
import {
  EXCLUDED_QUALITY_FIELDS,
  project_visible,
} from "./invoice_ocr/audit_results.ts";
import {
  add_schema_metrics,
  schema_errors,
  summarize_slice,
} from "./invoice_ocr/audit_round2.ts";
import {
  add_reliability_metrics,
  MODELS as INVOICE_ROUND2_MODELS,
} from "./invoice_ocr/benchmark_round2.ts";
import {
  RESULTS_DIR as SQL_RESULTS_DIR,
  execute_sql,
  expected_results,
  load_tasks,
  pareto_layers as sqlParetoLayers,
  score_result as scoreSql,
  summarize as summarizeSql,
  validate_output as validateSql,
} from "./text_to_sql/benchmark.ts";
import {
  CASES_PATH,
  MODELS as POLICY_MODELS,
  RESULTS_DIR as POLICY_RESULTS_DIR,
  pareto_layers as policyParetoLayers,
  score_result as scorePolicy,
  summarize as summarizePolicy,
  validate_output as validatePolicy,
  verify_frozen_inputs,
} from "./policy_adjudication/benchmark.ts";

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonl(path: string): any[] {
  return readFileSync(path, "utf8")
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function cmp(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSections(
  label: string,
  actual: Record<string, any>,
  expected: Record<string, any>,
): void {
  for (const [section, value] of Object.entries(actual)) {
    deepStrictEqual(value, expected[section], `${label}: ${section} differs`);
  }
  console.log(`${label}: PASS`);
}

function verifyInvoiceRound1(): void {
  const runs = readJsonl(
    join(INVOICE_RESULTS_DIR, "runs_20260910T211526Z.jsonl"),
  );
  for (const run of runs) {
    const expected = readJson(
      join(INVOICE_DATA_DIR, `${run.invoice_id}_ground_truth.json`),
    );
    run.score = scoreInvoice(
      project_visible(expected),
      project_visible(run.prediction ?? null),
    );
  }
  const summaries = summarizeInvoices(runs);
  for (const summary of summaries) {
    if (summary.successful_runs === 10) {
      summary.comparison_cost_usd = summary.total_cost_usd;
      summary.comparison_cost_basis = "observed";
    } else {
      summary.comparison_cost_usd = summary.mean_cost_usd * 10;
      summary.comparison_cost_basis = "projected from successful responses";
    }
  }
  const paretoInput = structuredClone(summaries);
  for (const summary of paretoInput) {
    summary.total_cost_usd = summary.comparison_cost_usd;
  }
  const actual = {
    visibility_audit: {
      excluded_quality_fields: [...EXCLUDED_QUALITY_FIELDS].sort(),
      reason:
        "The selected images do not render latent PO metadata in four rows; " +
        "a fifth image labels a PO-like value only as Reference.",
    },
    summaries,
    rankings: {
      cost: [...summaries]
        .sort((left, right) => left.comparison_cost_usd - right.comparison_cost_usd)
        .map((item) => item.model),
      latency: [...summaries]
        .sort((left, right) => left.median_latency_seconds - right.median_latency_seconds)
        .map((item) => item.model),
      quality: [...summaries]
        .sort(
          (left, right) =>
            right.exact_leaf_accuracy - left.exact_leaf_accuracy ||
            right.exact_document_rate - left.exact_document_rate,
        )
        .map((item) => item.model),
    },
    pareto_layers: invoiceParetoLayers(paretoInput),
  };
  compareSections(
    "invoice_ocr round 1",
    actual,
    readJson(join(INVOICE_RESULTS_DIR, "audited_summary_20260910T211526Z.json")),
  );
}

function verifyInvoiceRound2(): void {
  const runs = readJsonl(
    join(INVOICE_RESULTS_DIR, "runs_round2_20260910T231153Z.jsonl"),
  );
  for (const run of runs) {
    const expected = readJson(
      join(INVOICE_DATA_DIR, `${run.invoice_id}_ground_truth.json`),
    );
    run.score = scoreInvoice(
      project_visible(expected),
      project_visible(run.prediction ?? null),
    );
    run.schema_errors =
      run.prediction == null
        ? ["$: no parsed JSON object"]
        : schema_errors(run.prediction, INVOICE_SCHEMA);
    run.schema_valid = run.schema_errors.length === 0;
  }
  const summaries = summarizeInvoices(runs);
  add_reliability_metrics(summaries, runs);
  add_schema_metrics(summaries, runs);
  for (const summary of summaries) {
    const modelRuns = runs.filter((run) => run.model === summary.model);
    summary.quality_breakdown = {};
    for (const quality of ["clean", "faded", "bad_scan"]) {
      summary.quality_breakdown[quality] = summarize_slice(
        modelRuns.filter((run) => run.quality === quality),
      );
    }
    summary.quality_breakdown.degraded_combined = summarize_slice(
      modelRuns.filter((run) => run.quality === "faded" || run.quality === "bad_scan"),
    );
  }
  const paretoInput = structuredClone(summaries);
  for (const summary of paretoInput) {
    summary.total_cost_usd = summary.comparison_cost_usd;
  }
  const numericCost = (item: any) => item.comparison_cost_usd ?? Infinity;
  const numericLatency = (item: any) => item.median_latency_seconds ?? Infinity;
  const counts = Object.fromEntries(
    INVOICE_ROUND2_MODELS.map((model) => [
      model,
      runs.filter((run) => run.model === model).length,
    ]),
  );
  const actual = {
    runs_per_model: counts,
    summaries,
    rankings: {
      cost: [...summaries].sort((a, b) => numericCost(a) - numericCost(b)).map((item) => item.model),
      latency: [...summaries]
        .sort((a, b) => numericLatency(a) - numericLatency(b))
        .map((item) => item.model),
      quality: [...summaries]
        .sort(
          (a, b) =>
            b.exact_leaf_accuracy - a.exact_leaf_accuracy ||
            b.exact_document_rate - a.exact_document_rate,
        )
        .map((item) => item.model),
      valid_output: [...summaries]
        .sort(
          (a, b) =>
            b.valid_output_rate - a.valid_output_rate ||
            b.schema_valid_rate - a.schema_valid_rate ||
            a.failure_rate - b.failure_rate,
        )
        .map((item) => item.model),
      degraded_scan_quality: [...summaries]
        .sort(
          (a, b) =>
            b.quality_breakdown.degraded_combined.exact_leaf_accuracy -
              a.quality_breakdown.degraded_combined.exact_leaf_accuracy ||
            b.quality_breakdown.degraded_combined.exact_document_rate -
              a.quality_breakdown.degraded_combined.exact_document_rate,
        )
        .map((item) => item.model),
      bad_scan_quality: [...summaries]
        .sort(
          (a, b) =>
            b.quality_breakdown.bad_scan.exact_leaf_accuracy -
              a.quality_breakdown.bad_scan.exact_leaf_accuracy ||
            b.quality_breakdown.bad_scan.exact_document_rate -
              a.quality_breakdown.bad_scan.exact_document_rate,
        )
        .map((item) => item.model),
    },
    pareto_layers: invoiceParetoLayers(paretoInput),
  };
  compareSections(
    "invoice_ocr round 2",
    actual,
    readJson(
      join(INVOICE_RESULTS_DIR, "audited_summary_round2_20260910T231153Z.json"),
    ),
  );
}

function verifyTextToSql(): void {
  const runs = readJsonl(join(SQL_RESULTS_DIR, "runs_20260911T091053Z.jsonl"));
  const tasks = load_tasks();
  const expectedByTask = expected_results(tasks);
  for (const run of runs) {
    const expected = expectedByTask[run.task_id];
    const prediction = run.prediction ?? null;
    const errors = validateSql(prediction);
    run.schema_valid = errors.length === 0;
    run.schema_errors = errors;
    let result: Record<string, any> | null = null;
    if (errors.length === 0) {
      try {
        result = execute_sql(prediction.sql);
      } catch {
        result = null;
      }
    }
    run.execution_success = result !== null;
    run.actual_result = result;
    run.score = scoreSql(expected, result);
  }
  const summaries = summarizeSql(runs);
  for (const summary of summaries) {
    const modelRuns = runs.filter((run) => run.model === summary.model);
    summary.difficulty_breakdown = {};
    for (const difficulty of ["easy", "medium", "hard"]) {
      const subset = modelRuns.filter((run) => run.difficulty === difficulty);
      if (subset.length) summary.difficulty_breakdown[difficulty] = summarizeSql(subset)[0];
    }
  }
  const taskSummaries = tasks.map((task) => {
    const subset = runs.filter((run) => run.task_id === task.task_id);
    return {
      task_id: task.task_id,
      difficulty: task.difficulty,
      skills: task.skills,
      schema_valid_models: subset.filter((run) => run.schema_valid).length,
      execution_success_models: subset.filter((run) => run.execution_success).length,
      exact_result_models: subset.filter((run) => run.score.exact_result).length,
      exact_models: subset.filter((run) => run.score.exact_result).map((run) => run.model),
    };
  });
  const actual = {
    summaries,
    task_summaries: taskSummaries,
    rankings: {
      cost: [...summaries]
        .sort((a, b) => cmp(a.comparison_cost_usd ?? Infinity, b.comparison_cost_usd ?? Infinity))
        .map((item) => item.model),
      latency: [...summaries]
        .sort((a, b) => cmp(a.median_latency_seconds ?? Infinity, b.median_latency_seconds ?? Infinity))
        .map((item) => item.model),
      quality: [...summaries]
        .sort(
          (a, b) =>
            cmp(-a.exact_result_leaf_accuracy, -b.exact_result_leaf_accuracy) ||
            cmp(-a.exact_result_rate, -b.exact_result_rate),
        )
        .map((item) => item.model),
      exact_tasks: [...summaries]
        .sort(
          (a, b) =>
            cmp(-a.exact_result_rate, -b.exact_result_rate) ||
            cmp(-a.exact_result_leaf_accuracy, -b.exact_result_leaf_accuracy),
        )
        .map((item) => item.model),
    },
    pareto_layers: sqlParetoLayers(summaries),
  };
  compareSections(
    "text_to_sql",
    actual,
    readJson(join(SQL_RESULTS_DIR, "audited_summary_20260911T091053Z.json")),
  );
}

function verifyPolicyAdjudication(): void {
  const runs = readJsonl(join(POLICY_RESULTS_DIR, "runs_20260911T130245Z.jsonl"));
  const cases = verify_frozen_inputs().cases;
  const caseById = new Map(cases.map((item) => [item.case_id, item]));
  for (const run of runs) {
    const expected = caseById.get(run.case_id).expected;
    const errors = validatePolicy(run.prediction ?? null);
    run.schema_valid = errors.length === 0;
    run.schema_errors = errors;
    run.score = scorePolicy(expected, errors.length === 0 ? (run.prediction ?? null) : null);
  }
  const summaries = summarizePolicy(runs);
  for (const summary of summaries) {
    const modelRuns = runs.filter((run) => run.model === summary.model);
    summary.case_outcomes = Object.fromEntries(
      modelRuns.map((run) => [
        run.case_id,
        {
          injection_case: run.injection_case,
          schema_valid: run.schema_valid,
          exact_case: run.score.exact_case,
          expected: run.expected_output,
          prediction: run.prediction ?? null,
        },
      ]),
    );
  }
  const caseSummaries = cases.map((benchmarkCase) => {
    const subset = runs.filter((run) => run.case_id === benchmarkCase.case_id);
    return {
      case_id: benchmarkCase.case_id,
      tags: benchmarkCase.tags,
      injection_case: benchmarkCase.injection_case,
      schema_valid_models: subset.filter((run) => run.schema_valid).length,
      exact_case_models: subset.filter((run) => run.score.exact_case).length,
      exact_models: subset.filter((run) => run.score.exact_case).map((run) => run.model),
      incorrect_models: subset
        .filter((run) => !run.score.exact_case)
        .map((run) => ({
          model: run.model,
          expected: run.expected_output,
          prediction: run.prediction ?? null,
        })),
    };
  });
  const counts = Object.fromEntries(
    POLICY_MODELS.map((model) => [
      model,
      runs.filter((run) => run.model === model).length,
    ]),
  );
  const actual = {
    runs_per_model: counts,
    case_definition_file: CASES_PATH.split("/").at(-1),
    summaries,
    case_summaries: caseSummaries,
    rankings: {
      cost: [...summaries]
        .sort((a, b) => cmp(a.comparison_cost_usd ?? Infinity, b.comparison_cost_usd ?? Infinity))
        .map((item) => item.model),
      latency: [...summaries]
        .sort((a, b) => cmp(a.median_latency_seconds ?? Infinity, b.median_latency_seconds ?? Infinity))
        .map((item) => item.model),
      quality: [...summaries]
        .sort(
          (a, b) =>
            cmp(-a.exact_leaf_accuracy, -b.exact_leaf_accuracy) ||
            cmp(-a.exact_case_rate, -b.exact_case_rate),
        )
        .map((item) => item.model),
      exact_cases: [...summaries]
        .sort(
          (a, b) =>
            cmp(-a.exact_case_rate, -b.exact_case_rate) ||
            cmp(-a.exact_leaf_accuracy, -b.exact_leaf_accuracy),
        )
        .map((item) => item.model),
    },
    pareto_layers: policyParetoLayers(summaries),
  };
  compareSections(
    "policy_adjudication",
    actual,
    readJson(join(POLICY_RESULTS_DIR, "audited_summary_20260911T130245Z.json")),
  );
}

verifyInvoiceRound1();
verifyInvoiceRound2();
verifyTextToSql();
verifyPolicyAdjudication();
