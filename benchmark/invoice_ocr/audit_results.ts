#!/usr/bin/env node
/** Rescore a run after the documented image/label visibility audit. */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { pareto_layers, score, summarize } from "./benchmark.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT, "data");
const RESULTS_DIR = join(ROOT, "results");

// The selected source rows carry PO values in latent record metadata for four
// invoices whose rendered images do not show a PO. Another invoice visibly says
// "Reference", which is not a PO even though its value begins with "PO". Keep
// the field in raw model outputs for transparency, but exclude it from the fair
// vision/OCR quality score.
export const EXCLUDED_QUALITY_FIELDS = new Set(["po_number"]);

export function project_visible<T extends Record<string, any> | null | undefined>(
  document: T,
): T {
  if (document === null || document === undefined) {
    return document;
  }
  const projected = structuredClone(document);
  for (const field of EXCLUDED_QUALITY_FIELDS) {
    delete projected[field];
  }
  return projected;
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

function main(): void {
  const prog = basename(process.argv[1] ?? "audit_results.ts");
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
      .filter((name) => /^runs_.*\.jsonl$/.test(name))
      .sort();
    if (candidates.length === 0) {
      die("No raw run files found");
    }
    runsPath = join(RESULTS_DIR, candidates[candidates.length - 1]);
  }

  const runs = splitLines(readFileSync(runsPath, "utf8")).map((line) =>
    JSON.parse(line),
  );
  for (const run of runs) {
    const expectedPath = join(DATA_DIR, `${run["invoice_id"]}_ground_truth.json`);
    const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
    run["score"] = score(
      project_visible(expected),
      project_visible(run["prediction"] ?? null),
    );
  }

  const summaries = summarize(runs);
  for (const summary of summaries) {
    let comparisonCost: any;
    let costBasis: string;
    if (summary["successful_runs"] === 10) {
      comparisonCost = summary["total_cost_usd"];
      costBasis = "observed";
    } else {
      comparisonCost = summary["mean_cost_usd"] * 10;
      costBasis = "projected from successful responses";
    }
    summary["comparison_cost_usd"] = comparisonCost;
    summary["comparison_cost_basis"] = costBasis;
  }

  const costAdjusted = structuredClone(summaries);
  for (const summary of costAdjusted) {
    summary["total_cost_usd"] = summary["comparison_cost_usd"];
  }

  const report = {
    raw_runs_file: basename(runsPath),
    run_count: runs.length,
    visibility_audit: {
      excluded_quality_fields: [...EXCLUDED_QUALITY_FIELDS].sort(),
      reason:
        "The selected images do not render latent PO metadata in four rows; " +
        "a fifth image labels a PO-like value only as Reference.",
    },
    quality_metric:
      "micro-averaged strict JSON leaf-value match after excluding fields not " +
      "visibly supported by the rendered images",
    summaries,
    rankings: {
      cost: [...summaries]
        .sort((a, b) => a["comparison_cost_usd"] - b["comparison_cost_usd"])
        .map((item) => item["model"]),
      latency: [...summaries]
        .sort((a, b) => a["median_latency_seconds"] - b["median_latency_seconds"])
        .map((item) => item["model"]),
      quality: [...summaries]
        .sort(
          (a, b) =>
            b["exact_leaf_accuracy"] - a["exact_leaf_accuracy"] ||
            b["exact_document_rate"] - a["exact_document_rate"],
        )
        .map((item) => item["model"]),
    },
    pareto_layers: pareto_layers(costAdjusted),
  };

  const stamp = pyStem(basename(runsPath)).replace(/^runs_/, "");
  const outputPath = join(RESULTS_DIR, `audited_summary_${stamp}.json`);
  // Divergence from Python: json.dumps used ensure_ascii=True (\uXXXX escapes);
  // JSON.stringify writes raw UTF-8. Parsed content is identical.
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
  console.log(outputPath);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
