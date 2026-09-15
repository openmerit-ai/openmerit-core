/** Re-execute and audit a text-to-SQL benchmark run.
 * Run with `node audit_results.ts [runs]`. */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  MODELS,
  RESULTS_DIR,
  TASKS_PATH,
  execute_sql,
  expected_results,
  load_tasks,
  pareto_layers,
  pyEqual,
  pyRepr,
  score_result,
  summarize,
  validate_output,
} from "./benchmark.ts";

/** raise SystemExit(msg) */
function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Three-way comparator (avoids NaN from Infinity - Infinity in subtraction comparators). */
function cmp(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function main(): void {
  const prog = basename(process.argv[1] ?? "audit_results.ts");
  const positionals: string[] = [];
  for (const arg of process.argv.slice(2)) {
    if (arg === "-h" || arg === "--help") {
      console.log(`usage: ${prog} [-h] [runs]`);
      process.exit(0);
    } else if (arg.startsWith("-")) {
      console.error(`usage: ${prog} [-h] [runs]`);
      console.error(`${prog}: error: unrecognized arguments: ${arg}`);
      process.exit(2);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > 1) {
    console.error(`usage: ${prog} [-h] [runs]`);
    console.error(`${prog}: error: unrecognized arguments: ${positionals.slice(1).join(" ")}`);
    process.exit(2);
  }

  let runsPath: string;
  if (positionals.length) {
    runsPath = positionals[0];
  } else {
    const candidates = readdirSync(RESULTS_DIR)
      .filter((f) => /^runs_.*\.jsonl$/.test(f))
      .sort();
    if (!candidates.length) {
      die("No text-to-SQL raw run files found");
    }
    runsPath = join(RESULTS_DIR, candidates[candidates.length - 1]);
  }

  const lines = readFileSync(runsPath, "utf8").split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const runs = lines.map((line) => JSON.parse(line));
  const tasks = load_tasks();
  const taskById = new Map<string, any>(tasks.map((task) => [task.task_id, task]));
  const expectedByTask = expected_results(tasks);
  const modelCounts: Record<string, number> = {};
  for (const model of MODELS) {
    modelCounts[model] = runs.filter((run) => run.model === model).length;
  }
  const pairCount = new Set(runs.map((run) => `${run.model} ${run.task_id}`)).size;
  if (
    runs.length !== 50 ||
    pairCount !== 50 ||
    Object.values(modelCounts).some((count) => count !== 10)
  ) {
    die(
      "Run is incomplete; expected 50 unique pairs and 10 tasks per model, " +
        `found run_count=${runs.length}, pair_count=${pairCount}, counts=${pyRepr(modelCounts)}`,
    );
  }

  for (const run of runs) {
    const taskId = run.task_id;
    if (!taskById.has(taskId)) {
      die(`Unknown task in raw results: ${taskId}`);
    }
    const expected = expectedByTask[taskId];
    if (!pyEqual(run.expected_result ?? null, expected)) {
      die(`Ground-truth drift detected for ${taskId}`);
    }

    const prediction = run.prediction ?? null;
    const schemaErrors = validate_output(prediction);
    run.schema_valid = schemaErrors.length === 0;
    run.schema_errors = schemaErrors;
    let actual: Record<string, any> | null = null;
    let executionError: string | null = null;
    if (!schemaErrors.length) {
      try {
        actual = execute_sql(prediction.sql);
      } catch (e) {
        // Python caught (sqlite3.Error, ValueError); any Error here is the same branch.
        executionError = e instanceof Error ? e.message : String(e);
      }
    }
    run.execution_success = actual !== null;
    run.audited_execution_error = executionError;
    run.actual_result = actual;
    run.score = score_result(expected, actual);
  }

  const summaries = summarize(runs);
  for (const summary of summaries) {
    const modelRuns = runs.filter((run) => run.model === summary.model);
    summary.difficulty_breakdown = {};
    for (const difficulty of ["easy", "medium", "hard"]) {
      const subset = modelRuns.filter((run) => run.difficulty === difficulty);
      if (subset.length) {
        summary.difficulty_breakdown[difficulty] = summarize(subset)[0];
      }
    }
  }

  const taskSummaries: any[] = [];
  for (const task of tasks) {
    const subset = runs.filter((run) => run.task_id === task.task_id);
    taskSummaries.push({
      task_id: task.task_id,
      difficulty: task.difficulty,
      skills: task.skills,
      schema_valid_models: subset.reduce((n, run) => n + Number(run.schema_valid), 0),
      execution_success_models: subset.reduce(
        (n, run) => n + Number(run.execution_success),
        0,
      ),
      exact_result_models: subset.reduce((n, run) => n + Number(run.score.exact_result), 0),
      exact_models: subset.filter((run) => run.score.exact_result).map((run) => run.model),
    });
  }

  const report = {
    raw_runs_file: basename(runsPath),
    benchmark: "deterministic SQLite analytical text-to-SQL",
    run_count: runs.length,
    unique_model_task_pairs: pairCount,
    runs_per_model: modelCounts,
    task_definition_file: basename(TASKS_PATH),
    audit:
      "Recomputed every reference result and re-executed every schema-valid " +
      "predicted query in a fresh read-only in-memory database",
    quality_metric:
      "micro-averaged strict typed exact match over the union of result JSON " +
      "leaf paths, including column names, row order, and values",
    summaries,
    task_summaries: taskSummaries,
    rankings: {
      cost: [...summaries]
        .sort((a, b) =>
          cmp(a.comparison_cost_usd ?? Infinity, b.comparison_cost_usd ?? Infinity),
        )
        .map((item) => item.model),
      latency: [...summaries]
        .sort((a, b) =>
          cmp(a.median_latency_seconds ?? Infinity, b.median_latency_seconds ?? Infinity),
        )
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
    pareto_layers: pareto_layers(summaries),
  };

  let stem = basename(runsPath).replace(/\.[^.]*$/, "");
  if (stem.startsWith("runs_")) stem = stem.slice("runs_".length);
  const outputPath = join(RESULTS_DIR, `audited_summary_${stem}.json`);
  if (existsSync(outputPath)) {
    die(`Refusing to overwrite existing artifact: ${outputPath}`);
  }
  // Divergence from Python: json.dumps used default ensure_ascii=True (\uXXXX escapes);
  // JSON.stringify writes raw UTF-8. Parsed content is identical.
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
  console.log(outputPath);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
