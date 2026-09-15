#!/usr/bin/env node
/** Visibility-audit and stratify the second invoice benchmark. */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EXCLUDED_QUALITY_FIELDS, project_visible } from "./audit_results.ts";
import {
  DATA_DIR,
  OUTPUT_SCHEMA,
  RESULTS_DIR,
  pareto_layers,
  score,
  summarize,
} from "./benchmark.ts";
import { MODELS, add_reliability_metrics } from "./benchmark_round2.ts";

/** Python type(value).__name__ for JSON-shaped values. */
function pyTypeName(value: any): string {
  if (value === null) return "NoneType";
  if (Array.isArray(value)) return "list";
  if (typeof value === "object") return "dict";
  if (typeof value === "string") return "str";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  return typeof value;
}

/** Python repr of a list of strings: ['string', 'null']. */
function pyListRepr(values: string[]): string {
  return "[" + values.map((value) => `'${value}'`).join(", ") + "]";
}

function isPlainObject(value: any): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Python Path.stem: drop the final dot-suffix (leading dots are not suffixes). */
function pyStem(name: string): string {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(0, index) : name;
}

/** Python str.splitlines() for the \n / \r\n / \r cases. */
function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

export function schema_errors(value: any, schema: any, path = "$"): string[] {
  const errors: string[] = [];
  let allowedTypes: string[] = schema["type"] ?? [];
  if (typeof allowedTypes === "string") {
    allowedTypes = [allowedTypes];
  }

  const typeChecks: Record<string, (item: any) => boolean> = {
    object: (item) => isPlainObject(item),
    array: (item) => Array.isArray(item),
    string: (item) => typeof item === "string",
    // Python: isinstance(item, (int, float)) and not isinstance(item, bool).
    // JS booleans are never typeof "number", so this mirrors the exclusion.
    number: (item) => typeof item === "number",
    null: (item) => item === null,
  };
  if (allowedTypes.length && !allowedTypes.some((name) => typeChecks[name](value))) {
    return [
      `${path}: expected ${pyListRepr(allowedTypes)}, found ${pyTypeName(value)}`,
    ];
  }

  if (isPlainObject(value) && allowedTypes.includes("object")) {
    const properties = schema["properties"] || {};
    const required = new Set<string>(schema["required"] || []);
    const keys = new Set(Object.keys(value));
    const missing = [...required].filter((key) => !keys.has(key)).sort();
    const extra =
      schema["additionalProperties"] === false
        ? [...keys].filter((key) => !(key in properties)).sort()
        : [];
    for (const key of missing) {
      errors.push(`${path}.${key}: required property missing`);
    }
    for (const key of extra) {
      errors.push(`${path}.${key}: additional property not allowed`);
    }
    for (const key of [...keys].filter((key) => key in properties).sort()) {
      errors.push(...schema_errors(value[key], properties[key], `${path}.${key}`));
    }
  } else if (Array.isArray(value) && allowedTypes.includes("array")) {
    const itemSchema = schema["items"];
    if (itemSchema) {
      for (let index = 0; index < value.length; index++) {
        errors.push(
          ...schema_errors(value[index], itemSchema, `${path}[${index}]`),
        );
      }
    }
  }
  return errors;
}

export function add_schema_metrics(summaries: any[], runs: any[]): void {
  for (const summary of summaries) {
    const modelRuns = runs.filter((run) => run["model"] === summary["model"]);
    const valid = modelRuns.filter((run) => run["schema_valid"]).length;
    summary["schema_valid_outputs"] = valid;
    summary["schema_valid_rate"] = modelRuns.length
      ? valid / modelRuns.length
      : 0.0;
  }
}

export function summarize_slice(runs: any[]): any {
  const summary = summarize(runs)[0];
  add_reliability_metrics([summary], runs);
  add_schema_metrics([summary], runs);
  return summary;
}

function main(): void {
  const prog = basename(process.argv[1] ?? "audit_round2.ts");
  const usage = `usage: ${prog} [-h] [runs]`;
  let runsArg: string | undefined;
  for (const arg of process.argv.slice(2)) {
    if (arg === "-h" || arg === "--help") {
      console.log(usage);
      process.exit(0);
    } else if (arg.startsWith("-")) {
      console.error(usage);
      console.error(`${prog}: error: unrecognized arguments: ${arg}`);
      process.exit(2);
    } else if (runsArg === undefined) {
      runsArg = arg;
    } else {
      console.error(usage);
      console.error(`${prog}: error: unrecognized arguments: ${arg}`);
      process.exit(2);
    }
  }

  let runsPath: string;
  if (runsArg !== undefined) {
    runsPath = runsArg;
  } else {
    const candidates = readdirSync(RESULTS_DIR)
      .filter((name) => /^runs_round2_.*\.jsonl$/.test(name))
      .sort();
    if (candidates.length === 0) {
      die("No round-two raw run files found");
    }
    runsPath = join(RESULTS_DIR, candidates[candidates.length - 1]);
  }

  if (!basename(runsPath).startsWith("runs_round2_")) {
    die("audit_round2.ts accepts only runs_round2_*.jsonl artifacts");
  }
  const runs = splitLines(readFileSync(runsPath, "utf8")).map((line) =>
    JSON.parse(line),
  );
  const counts: Record<string, number> = {};
  for (const model of MODELS) {
    counts[model] = runs.filter((run) => run["model"] === model).length;
  }
  if (runs.length !== 50 || Object.values(counts).some((count) => count !== 10)) {
    // Divergence from Python: the f-string rendered a dict repr; JSON here.
    // Error text only.
    die(
      "Round two is incomplete; expected exactly 10 invoice observations for " +
        `each of five models, found ${JSON.stringify(counts)}`,
    );
  }

  for (const run of runs) {
    const expectedPath = join(DATA_DIR, `${run["invoice_id"]}_ground_truth.json`);
    const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
    run["score"] = score(
      project_visible(expected),
      project_visible(run["prediction"] ?? null),
    );
    run["schema_errors"] =
      run["prediction"] !== null && run["prediction"] !== undefined
        ? schema_errors(run["prediction"], OUTPUT_SCHEMA)
        : ["$: no parsed JSON object"];
    run["schema_valid"] = run["schema_errors"].length === 0;
  }

  const summaries = summarize(runs);
  add_reliability_metrics(summaries, runs);
  add_schema_metrics(summaries, runs);
  for (const summary of summaries) {
    const modelRuns = runs.filter((run) => run["model"] === summary["model"]);
    const qualityBreakdown: Record<string, any> = {};
    for (const label of ["clean", "faded", "bad_scan"]) {
      const subset = modelRuns.filter((run) => run["quality"] === label);
      qualityBreakdown[label] = summarize_slice(subset);
    }
    const degraded = modelRuns.filter(
      (run) => run["quality"] === "faded" || run["quality"] === "bad_scan",
    );
    qualityBreakdown["degraded_combined"] = summarize_slice(degraded);
    summary["quality_breakdown"] = qualityBreakdown;
  }

  const paretoInput = structuredClone(summaries);
  for (const summary of paretoInput) {
    summary["total_cost_usd"] = summary["comparison_cost_usd"];
  }

  const numericCost = (item: any): number => item["comparison_cost_usd"] ?? Infinity;
  const numericLatency = (item: any): number =>
    item["median_latency_seconds"] ?? Infinity;

  const report = {
    raw_runs_file: basename(runsPath),
    benchmark_round: 2,
    run_count: runs.length,
    runs_per_model: counts,
    visibility_audit: {
      excluded_quality_fields: [...EXCLUDED_QUALITY_FIELDS].sort(),
      reason:
        "The selected images do not render latent PO metadata in four rows; " +
        "a fifth image labels a PO-like value only as Reference. This is the " +
        "same audit projection used in round one.",
    },
    quality_metric:
      "micro-averaged strict JSON leaf-value match after excluding fields not " +
      "visibly supported by the rendered images",
    degraded_scan_definition: "the three faded plus three bad_scan invoices",
    summaries,
    rankings: {
      cost: [...summaries]
        .sort((a, b) => numericCost(a) - numericCost(b))
        .map((item) => item["model"]),
      latency: [...summaries]
        .sort((a, b) => numericLatency(a) - numericLatency(b))
        .map((item) => item["model"]),
      quality: [...summaries]
        .sort(
          (a, b) =>
            b["exact_leaf_accuracy"] - a["exact_leaf_accuracy"] ||
            b["exact_document_rate"] - a["exact_document_rate"],
        )
        .map((item) => item["model"]),
      valid_output: [...summaries]
        .sort(
          (a, b) =>
            b["valid_output_rate"] - a["valid_output_rate"] ||
            b["schema_valid_rate"] - a["schema_valid_rate"] ||
            a["failure_rate"] - b["failure_rate"],
        )
        .map((item) => item["model"]),
      degraded_scan_quality: [...summaries]
        .sort(
          (a, b) =>
            b["quality_breakdown"]["degraded_combined"]["exact_leaf_accuracy"] -
              a["quality_breakdown"]["degraded_combined"]["exact_leaf_accuracy"] ||
            b["quality_breakdown"]["degraded_combined"]["exact_document_rate"] -
              a["quality_breakdown"]["degraded_combined"]["exact_document_rate"],
        )
        .map((item) => item["model"]),
      bad_scan_quality: [...summaries]
        .sort(
          (a, b) =>
            b["quality_breakdown"]["bad_scan"]["exact_leaf_accuracy"] -
              a["quality_breakdown"]["bad_scan"]["exact_leaf_accuracy"] ||
            b["quality_breakdown"]["bad_scan"]["exact_document_rate"] -
              a["quality_breakdown"]["bad_scan"]["exact_document_rate"],
        )
        .map((item) => item["model"]),
    },
    pareto_layers: pareto_layers(paretoInput),
  };

  const stamp = pyStem(basename(runsPath)).replace(/^runs_round2_/, "");
  const outputPath = join(RESULTS_DIR, `audited_summary_round2_${stamp}.json`);
  if (existsSync(outputPath)) {
    die(`Refusing to overwrite existing artifact: ${outputPath}`);
  }
  // Divergence from Python: json.dumps used ensure_ascii=True (\uXXXX escapes);
  // JSON.stringify writes raw UTF-8. Parsed content is identical.
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
  console.log(outputPath);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
