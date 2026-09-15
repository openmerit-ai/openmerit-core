#!/usr/bin/env node
/** Run the second OpenRouter invoice benchmark without touching round-one results. */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DATA_DIR,
  MODELS as ROUND1_MODELS,
  OUTPUT_SCHEMA,
  PROMPT,
  RESULTS_DIR,
  content_from_response,
  invoke,
  make_request,
  pareto_layers,
  parse_json,
  score,
  summarize,
  utc_now,
} from "./benchmark.ts";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

const MODEL_SPECS = [
  {
    model: "google/gemma-4-26b-a4b-it",
    role: "very cheap open model",
    selection_reason:
      "Open-weight, small active parameter count, image input, and native " +
      "structured-output support at very low catalog pricing.",
  },
  {
    model: "qwen/qwen3-vl-235b-a22b-instruct",
    role: "document/OCR-oriented model",
    selection_reason:
      "Open-weight VLM explicitly positioned for document parsing, charts, " +
      "tables, and other text-rich visual inputs.",
  },
  {
    model: "xiaomi/mimo-v2.5",
    role: "strong general VLM",
    selection_reason:
      "Modern native omnimodal model with low pricing and structured-output " +
      "support, adding a distinct provider and architecture.",
  },
  {
    model: "x-ai/grok-4.6",
    role: "strong general VLM",
    selection_reason:
      "High-end general multimodal model with native structured outputs and " +
      "a provider family not represented in round one.",
  },
  {
    model: "openai/gpt-6-astra",
    role: "frontier model",
    selection_reason:
      "Current OpenAI flagship with image input and native structured outputs, " +
      "included to establish a frontier-quality ceiling.",
  },
];
export const MODELS = MODEL_SPECS.map((spec) => spec.model);
const MODEL_SPEC_BY_ID = Object.fromEntries(
  MODEL_SPECS.map((spec) => [spec.model, spec]),
);

/** Python urllib.parse.quote(s, safe="/") semantics. */
function pyQuote(s: string): string {
  return s
    .split("/")
    .map(encodeURIComponent)
    .join("/")
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Python repr of a list of strings: ['a', 'b']. */
function pyListRepr(values: string[]): string {
  return "[" + values.map((value) => `'${value}'`).join(", ") + "]";
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

async function fetch_json(url: string): Promise<any> {
  const response = await fetch(url, {
    headers: { "User-Agent": "openmerit-invoice-benchmark/2.0" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

/** Fetch and validate current public catalog and endpoint metadata. */
async function public_model_snapshot(): Promise<Record<string, any>> {
  const catalog = await fetch_json(OPENROUTER_MODELS_URL);
  const catalogById = new Map<string, any>(
    (catalog["data"] ?? []).map((item: any) => [item["id"], item]),
  );
  const selected: any[] = [];

  const overlap = [...new Set(MODELS.filter((m) => ROUND1_MODELS.includes(m)))].sort();
  if (overlap.length) {
    throw new Error(`Round-two models overlap round one: ${pyListRepr(overlap)}`);
  }
  if (MODELS.length !== 5 || new Set(MODELS).size !== 5) {
    throw new Error("Round two must contain exactly five distinct models");
  }

  for (const spec of MODEL_SPECS) {
    const model = spec.model;
    const item = catalogById.get(model);
    if (item === undefined) {
      throw new Error(`Model is not in the current OpenRouter catalog: ${model}`);
    }
    const modalities = item["architecture"]?.["input_modalities"] || [];
    if (!modalities.includes("image")) {
      throw new Error(`Model does not currently advertise image input: ${model}`);
    }

    const endpointUrl =
      "https://openrouter.ai/api/v1/models/" + `${pyQuote(model)}/endpoints`;
    const endpointPayload = await fetch_json(endpointUrl);
    const endpoints = (endpointPayload["data"] ?? {})["endpoints"] || [];
    const liveEndpoints = endpoints.filter(
      (endpoint: any) => endpoint["status"] === 0,
    );
    const schemaEndpoints = liveEndpoints.filter((endpoint: any) => {
      const supported = new Set(endpoint["supported_parameters"] || []);
      return supported.has("response_format") && supported.has("structured_outputs");
    });
    if (!schemaEndpoints.length) {
      throw new Error(
        `No live endpoint currently advertises strict structured outputs: ${model}`,
      );
    }

    selected.push({
      ...spec,
      catalog: item,
      endpoint_url: endpointUrl,
      live_endpoint_count: liveEndpoints.length,
      strict_schema_endpoint_count: schemaEndpoints.length,
      endpoints,
    });
  }

  return {
    verified_at: utc_now(),
    source: OPENROUTER_MODELS_URL,
    required_capabilities: [
      "image input",
      "response_format",
      "structured_outputs",
      "at least one live endpoint",
    ],
    round_one_models_excluded: ROUND1_MODELS,
    models: selected,
  };
}

export function comparison_cost(
  summary: any,
  expectedRuns: number,
): [number | null, string] {
  if (summary["successful_runs"] === expectedRuns) {
    return [summary["total_cost_usd"], "observed"];
  }
  const meanCost = summary["mean_cost_usd"] ?? null;
  if (meanCost === null) {
    return [null, "unavailable; no response usage was captured"];
  }
  return [meanCost * expectedRuns, "projected from successful responses"];
}

export function add_reliability_metrics(summaries: any[], runs: any[]): void {
  for (const summary of summaries) {
    const modelRuns = runs.filter((run) => run["model"] === summary["model"]);
    const total = modelRuns.length;
    const failedRuns = modelRuns.filter((run) => run["status"] !== "ok").length;
    const validOutputs = modelRuns.filter((run) => run["json_valid"]).length;
    // collections.Counter in first-occurrence order.
    const failureReasons = new Map<string, number>();
    for (const run of modelRuns) {
      if (run["status"] !== "ok") {
        const reason =
          run["error"] !== undefined && run["error"] !== null
            ? String(run["error"])
            : "unspecified failure";
        failureReasons.set(reason, (failureReasons.get(reason) ?? 0) + 1);
      }
    }
    summary["planned_runs"] = total;
    summary["failed_runs"] = failedRuns;
    summary["failure_rate"] = total ? failedRuns / total : 0.0;
    summary["failure_reasons"] = Object.fromEntries(failureReasons);
    summary["valid_outputs"] = validOutputs;
    summary["invalid_output_runs"] = total - validOutputs;
    summary["valid_output_rate"] = total ? validOutputs / total : 0.0;
    const [projectedCost, costBasis] = comparison_cost(summary, total);
    summary["comparison_cost_usd"] = projectedCost;
    summary["comparison_cost_basis"] = costBasis;
  }
}

async function main(): Promise<void> {
  const prog = basename(process.argv[1] ?? "benchmark_round2.ts");
  const usage = `usage: ${prog} [-h] [--verify-only]`;
  let verifyOnly = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === "--verify-only") {
      verifyOnly = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(usage);
      process.exit(0);
    } else {
      console.error(usage);
      console.error(`${prog}: error: unrecognized arguments: ${arg}`);
      process.exit(2);
    }
  }

  const manifestPath = join(DATA_DIR, "manifest.json");
  if (!existsSync(manifestPath)) {
    die("Run prepare_data.ts first");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if ((manifest["rows"] || []).length !== 10) {
    die("Round two requires the existing manifest to contain exactly 10 invoices");
  }

  const snapshot = await public_model_snapshot();
  if (verifyOnly) {
    for (const item of snapshot["models"]) {
      const pricing = item["catalog"]["pricing"];
      console.log(
        `${item["model"]} | ${item["role"]} | ` +
          `prompt=${pricing["prompt"]} | completion=${pricing["completion"]} | ` +
          `live_strict_endpoints=${item["strict_schema_endpoint_count"]}`,
      );
    }
    return;
  }

  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    die("Set OPENROUTER_API_KEY in the environment");
  }

  mkdirSync(RESULTS_DIR, { recursive: true });
  const runStamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const rawPath = join(RESULTS_DIR, `runs_round2_${runStamp}.jsonl`);
  const summaryPath = join(RESULTS_DIR, `summary_round2_${runStamp}.json`);
  const catalogPath = join(RESULTS_DIR, `model_catalog_round2_${runStamp}.json`);
  const collisions = [rawPath, summaryPath, catalogPath].filter((path) =>
    existsSync(path),
  );
  if (collisions.length) {
    // Divergence from Python: the f-string rendered PosixPath reprs; plain
    // strings here. Error text only.
    die(`Refusing to overwrite existing artifacts: ${pyListRepr(collisions)}`);
  }
  // Divergence from Python: json.dumps used ensure_ascii=True (\uXXXX escapes);
  // JSON.stringify writes raw UTF-8. Parsed content is identical.
  writeFileSync(catalogPath, JSON.stringify(snapshot, null, 2) + "\n");

  const runs: any[] = [];
  const totalRuns = MODELS.length * manifest["rows"].length;
  for (const model of MODELS) {
    const spec = MODEL_SPEC_BY_ID[model];
    for (const invoice of manifest["rows"]) {
      const expected = JSON.parse(
        readFileSync(join(DATA_DIR, invoice["ground_truth"]), "utf8"),
      );
      console.log(
        `RUN ${String(runs.length + 1).padStart(2, "0")}/${totalRuns}: ` +
          `${model} x ${invoice["invoice_id"]}`,
      );
      const run: Record<string, any> = {
        benchmark_round: 2,
        model,
        model_role: spec["role"],
        invoice_id: invoice["invoice_id"],
        row_idx: invoice["row_idx"],
        quality: invoice["quality"],
        template: invoice["template"],
        started_at: utc_now(),
      };
      try {
        const [response, latency, attempts] = await invoke(
          apiKey,
          make_request(model, join(DATA_DIR, invoice["image"])),
        );
        const content = content_from_response(response);
        let actual: Record<string, any> | null = null;
        let parseError: string | null = null;
        try {
          actual = parse_json(content);
        } catch (exc) {
          // Divergence from Python: JSON.parse SyntaxError messages differ from
          // json.JSONDecodeError str(exc); it is recorded data in parse_error.
          parseError = exc instanceof Error ? exc.message : String(exc);
        }
        const usage = response["usage"] || {};
        Object.assign(run, {
          status: "ok",
          completed_at: utc_now(),
          latency_seconds: latency,
          attempts,
          response_id: response["id"] ?? null,
          served_model: response["model"] ?? null,
          provider: response["provider"] ?? null,
          usage,
          cost_usd: usage["cost"] ?? null,
          json_valid: actual !== null,
          parse_error: parseError,
          prediction: actual,
          raw_content: actual === null ? content : null,
          score: score(expected, actual),
        });
      } catch (exc) {
        // Preserve failures as benchmark observations.
        Object.assign(run, {
          status: "error",
          completed_at: utc_now(),
          error: exc instanceof Error ? exc.message : String(exc),
          latency_seconds: null,
          attempts: 3,
          usage: {},
          cost_usd: null,
          json_valid: false,
          prediction: null,
          score: score(expected, null),
        });
      }
      runs.push(run);
      appendFileSync(rawPath, JSON.stringify(run) + "\n");
      console.log(
        `  ${run["status"]} | ${run["latency_seconds"]}s | ` +
          `cost=${run["cost_usd"]} | ` +
          `accuracy=${run["score"]["exact_leaf_accuracy"].toFixed(3)}`,
      );
    }
  }

  const summaries = summarize(runs);
  add_reliability_metrics(summaries, runs);
  const paretoInput = summaries.map((summary) => ({
    ...summary,
    total_cost_usd: summary["comparison_cost_usd"],
  }));

  const report = {
    created_at: utc_now(),
    benchmark_round: 2,
    dataset: manifest["dataset"],
    dataset_revision: manifest["dataset_revision"],
    invoice_count: manifest["rows"].length,
    model_count: MODELS.length,
    run_count: runs.length,
    model_selection: MODEL_SPECS,
    request_contract: {
      prompt: PROMPT,
      output_schema: OUTPUT_SCHEMA,
      temperature: 0,
      max_tokens: 2500,
      reasoning: { effort: "minimal" },
    },
    quality_metric: "micro-averaged strict typed exact match over union of JSON leaf paths",
    latency_metric: "median and p95 client-observed end-to-end seconds",
    cost_metric: "OpenRouter response usage.cost summed over 10 successful runs",
    summaries,
    rankings: {
      cost: [...summaries]
        .sort(
          (a, b) =>
            (a["comparison_cost_usd"] ?? Infinity) -
            (b["comparison_cost_usd"] ?? Infinity),
        )
        .map((item) => item["model"]),
      latency: [...summaries]
        .sort(
          (a, b) =>
            (a["median_latency_seconds"] ?? Infinity) -
            (b["median_latency_seconds"] ?? Infinity),
        )
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
            a["failure_rate"] - b["failure_rate"],
        )
        .map((item) => item["model"]),
    },
    pareto_layers: pareto_layers(paretoInput),
    raw_runs_file: basename(rawPath),
    model_catalog_file: basename(catalogPath),
  };
  writeFileSync(summaryPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`Wrote ${rawPath}`);
  console.log(`Wrote ${summaryPath}`);
  console.log(`Wrote ${catalogPath}`);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
