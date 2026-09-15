#!/usr/bin/env node
/** Benchmark five OpenRouter vision models on structured invoice extraction. */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(ROOT, "data");
export const RESULTS_DIR = join(ROOT, "results");
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export const MODELS = [
  "qwen/qwen3.5-9b",
  "deepseek/deepseek-v4-flash-vision-exp",
  "google/gemini-3.8-flash",
  "openai/gpt-5.6-sol",
  "anthropic/claude-sonnet-5",
];

const LINE_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: { type: ["string", "null"] },
    quantity: { type: ["number", "null"] },
    unit_price: { type: ["number", "null"] },
    amount: { type: ["number", "null"] },
  },
  required: [
    "description",
    "quantity",
    "unit_price",
    "amount",
  ],
} as const;

export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    supplier_name: { type: ["string", "null"] },
    customer_name: { type: ["string", "null"] },
    invoice_number: { type: ["string", "null"] },
    po_number: { type: ["string", "null"] },
    document_date: { type: ["string", "null"] },
    due_date: { type: ["string", "null"] },
    document_currency: { type: ["string", "null"] },
    document_total_net: { type: ["number", "null"] },
    document_total_tax: { type: ["number", "null"] },
    document_total_amount: { type: ["number", "null"] },
    line_items: { type: "array", items: LINE_ITEM_SCHEMA },
  },
  required: [
    "supplier_name",
    "customer_name",
    "invoice_number",
    "po_number",
    "document_date",
    "due_date",
    "document_currency",
    "document_total_net",
    "document_total_tax",
    "document_total_amount",
    "line_items",
  ],
} as const;

export const PROMPT = `Extract the invoice into the required JSON schema using only the image.

Rules:
- Copy names, identifiers, and descriptions exactly as printed.
- Return dates as YYYY-MM-DD, regardless of the printed date format.
- Return currency as its three-letter ISO code.
- Return monetary values and quantities as JSON numbers without currency symbols or grouping separators.
- Preserve line-item order and include every printed line item exactly once.
- Use null only when a scalar field is not present. Never infer a missing value.
- document_total_net is the subtotal/net amount before tax; document_total_amount is the final amount including tax.
- Return only the schema-conforming JSON object.`;

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

function isPlainObject(value: any): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python == semantics: bools coerce to numbers (True == 1), ints == floats. */
function pyEqual(a: any, b: any): boolean {
  if (typeof a === "boolean" || typeof b === "boolean") {
    if (typeof a === "boolean" && typeof b === "boolean") return a === b;
    if (typeof a === "number" && typeof b === "boolean") return a === Number(b);
    if (typeof a === "boolean" && typeof b === "number") return Number(a) === b;
    return false;
  }
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => pyEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && pyEqual(a[k], b[k]));
  }
  return false;
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

export function utc_now(): string {
  // Divergence from Python: datetime.now(timezone.utc).isoformat() emits
  // "+00:00" with microseconds; Date.toISOString() emits "Z" with milliseconds.
  return new Date().toISOString();
}

export function percentile(values: number[], fraction: number): number {
  if (values.length === 0) {
    return NaN;
  }
  const ordered = [...values].sort((a, b) => a - b);
  const rank = (ordered.length - 1) * fraction;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) {
    return ordered[low];
  }
  return ordered[low] * (high - rank) + ordered[high] * (rank - low);
}

export function flatten(value: any, path = ""): Record<string, any> {
  if (isPlainObject(value)) {
    let flattened: Record<string, any> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      flattened = Object.assign(flattened, flatten(child, childPath));
    }
    return flattened;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { [`${path}.__length__`]: 0 };
    }
    let flattened: Record<string, any> = { [`${path}.__length__`]: value.length };
    for (let index = 0; index < value.length; index++) {
      flattened = Object.assign(flattened, flatten(value[index], `${path}[${index}]`));
    }
    return flattened;
  }
  return { [path]: value };
}

export function exact_value(expected: any, actual: any): boolean {
  // JSON has one number type: 1 and 1.0 are semantically the same value.
  if (typeof expected === "boolean" || typeof actual === "boolean") {
    return typeof expected === typeof actual && expected === actual;
  }
  if (typeof expected === "number" && typeof actual === "number") {
    return expected === actual;
  }
  return typeof expected === typeof actual && expected === actual;
}

export function score(
  expected: Record<string, any>,
  actual: Record<string, any> | null,
): Record<string, any> {
  if (actual === null) {
    const expectedFlat = flatten(expected);
    return {
      exact_document: false,
      matched_leaves: 0,
      total_union_leaves: Object.keys(expectedFlat).length,
      exact_leaf_accuracy: 0.0,
      scalar_accuracy: 0.0,
      line_item_accuracy: 0.0,
    };
  }

  const expectedFlat = flatten(expected);
  const actualFlat = flatten(actual);
  const paths = new Set([...Object.keys(expectedFlat), ...Object.keys(actualFlat)]);
  let matches = 0;
  for (const path of paths) {
    if (
      path in expectedFlat &&
      path in actualFlat &&
      exact_value(expectedFlat[path], actualFlat[path])
    ) {
      matches += 1;
    }
  }
  const scalarPaths = Object.keys(expectedFlat).filter(
    (path) => !path.startsWith("line_items"),
  );
  const itemPaths = [...paths].filter((path) => path.startsWith("line_items"));
  const scalarMatches = scalarPaths.filter(
    (path) => path in actualFlat && exact_value(expectedFlat[path], actualFlat[path]),
  ).length;
  const itemMatches = itemPaths.filter(
    (path) =>
      path in expectedFlat &&
      path in actualFlat &&
      exact_value(expectedFlat[path], actualFlat[path]),
  ).length;
  return {
    exact_document: pyEqual(expected, actual),
    matched_leaves: matches,
    total_union_leaves: paths.size,
    exact_leaf_accuracy: paths.size ? matches / paths.size : 1.0,
    scalar_accuracy: scalarPaths.length ? scalarMatches / scalarPaths.length : 1.0,
    line_item_accuracy: itemPaths.length ? itemMatches / itemPaths.length : 1.0,
  };
}

export function make_request(model: string, imagePath: string): Record<string, any> {
  const imageB64 = readFileSync(imagePath).toString("base64");
  return {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: PROMPT },
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${imageB64}` },
          },
        ],
      },
    ],
    temperature: 0,
    max_tokens: 2500,
    reasoning: { effort: "minimal" },
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "invoice_extraction",
        strict: true,
        schema: OUTPUT_SCHEMA,
      },
    },
  };
}

export async function invoke(
  apiKey: string,
  payload: Record<string, any>,
  retries = 3,
): Promise<[any, number, number]> {
  const encoded = JSON.stringify(payload);
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const started = performance.now();
    let response: Response;
    try {
      response = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/openmerit/openmerit",
          "X-Title": "OpenMerit Invoice OCR Benchmark",
        },
        body: encoded,
        signal: AbortSignal.timeout(180_000),
      });
    } catch (exc) {
      // Network failure or abort timeout (Python URLError / TimeoutError): retry.
      lastError = exc;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 2 ** (attempt - 1) * 1000));
      }
      continue;
    }
    if (!response.ok) {
      const errorBody = await response.text();
      lastError = new Error(`HTTP ${response.status}: ${errorBody.slice(0, 1000)}`);
      if (response.status < 500 && response.status !== 429) {
        break;
      }
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 2 ** (attempt - 1) * 1000));
      }
      continue;
    }
    // Divergence from Python: a JSON parse failure of the response body
    // propagates like json.load raising outside the retry tuple.
    const body = await response.json();
    return [body, (performance.now() - started) / 1000, attempt];
  }
  const rendered = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`OpenRouter request failed after ${retries} attempts: ${rendered}`);
}

export function content_from_response(response: any): string {
  const content = response["choices"][0]["message"]["content"];
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (isPlainObject(part) ? (part["text"] ?? "") : ""))
      .join("");
  }
  throw new TypeError(`Unexpected response content: ${pyTypeName(content)}`);
}

export function parse_json(content: string): Record<string, any> {
  let stripped = content.trim();
  if (stripped.startsWith("```")) {
    const lines = stripped.split(/\r\n|\r|\n/);
    stripped = lines.slice(1, -1).join("\n");
  }
  const parsed = JSON.parse(stripped);
  if (!isPlainObject(parsed)) {
    throw new TypeError("Model output is not a JSON object");
  }
  return parsed;
}

/**
 * Python 3.12+ builtin sum() over floats: Neumaier compensated summation
 * (CPython bltinmodule.c float fast path), starting from int 0.
 */
function pySum(values: number[]): number {
  let result = 0.0;
  let compensation = 0.0;
  for (const x of values) {
    const t = result + x;
    if (Math.abs(result) >= Math.abs(x)) {
      compensation += (result - t) + x;
    } else {
      compensation += (x - t) + result;
    }
    result = t;
  }
  return result + compensation;
}

/** CPython math.fsum: Shewchuk's exact summation, correctly rounded. */
function fsum(values: number[]): number {
  const partials: number[] = [];
  let partialCount = 0;
  for (const original of values) {
    let x = original;
    let insertion = 0;
    for (let index = 0; index < partialCount; index++) {
      let y = partials[index];
      if (Math.abs(x) < Math.abs(y)) {
        [x, y] = [y, x];
      }
      const hi = x + y;
      const yr = hi - x;
      const lo = y - yr;
      if (lo !== 0.0) {
        partials[insertion++] = lo;
      }
      x = hi;
    }
    partialCount = insertion;
    if (x !== 0.0) partials[partialCount++] = x;
  }

  let hi = 0.0;
  let lo = 0.0;
  if (partialCount > 0) {
    hi = partials[--partialCount];
    while (partialCount > 0) {
      const x = hi;
      const y = partials[--partialCount];
      hi = x + y;
      const yr = hi - x;
      lo = y - yr;
      if (lo !== 0.0) break;
    }
    if (
      partialCount > 0 &&
      ((lo < 0.0 && partials[partialCount - 1] < 0.0) ||
        (lo > 0.0 && partials[partialCount - 1] > 0.0))
    ) {
      const y = lo * 2.0;
      const x = hi + y;
      const yr = x - hi;
      if (y === yr) hi = x;
    }
  }
  return hi;
}

/** statistics.fmean: fsum(data) / n. */
function fmean(values: number[]): number {
  return fsum(values) / values.length;
}

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

export function summarize(runs: any[]): any[] {
  const summaries: any[] = [];
  for (const model of [...new Set(runs.map((run) => run["model"]))]) {
    const modelRuns = runs.filter((run) => run["model"] === model);
    const latencies = modelRuns
      .filter((run) => run["status"] === "ok")
      .map((run) => run["latency_seconds"]);
    const validRuns = modelRuns.filter((run) => run["status"] === "ok");
    const totalMatches = modelRuns.reduce(
      (sum, run) => sum + run["score"]["matched_leaves"],
      0,
    );
    const totalLeaves = modelRuns.reduce(
      (sum, run) => sum + run["score"]["total_union_leaves"],
      0,
    );
    const costs = validRuns
      .filter((run) => run["cost_usd"] !== null && run["cost_usd"] !== undefined)
      .map((run) => run["cost_usd"]);
    const jsonValid = modelRuns.reduce(
      (sum, run) => sum + (run["json_valid"] ? 1 : 0),
      0,
    );
    const exactDocuments = validRuns.reduce(
      (sum, run) => sum + (run["score"]["exact_document"] ? 1 : 0),
      0,
    );
    summaries.push({
      model,
      successful_runs: validRuns.length,
      json_valid_rate: jsonValid / modelRuns.length,
      exact_documents: exactDocuments,
      exact_document_rate: exactDocuments / modelRuns.length,
      exact_leaf_accuracy: totalLeaves ? totalMatches / totalLeaves : 0.0,
      mean_scalar_accuracy: modelRuns.length
        ? fmean(modelRuns.map((run) => run["score"]["scalar_accuracy"]))
        : 0.0,
      mean_line_item_accuracy: modelRuns.length
        ? fmean(modelRuns.map((run) => run["score"]["line_item_accuracy"]))
        : 0.0,
      total_cost_usd: costs.length ? pySum(costs) : null,
      mean_cost_usd: costs.length ? fmean(costs) : null,
      mean_latency_seconds: latencies.length ? fmean(latencies) : null,
      median_latency_seconds: latencies.length ? median(latencies) : null,
      p95_latency_seconds: latencies.length ? percentile(latencies, 0.95) : null,
      prompt_tokens: validRuns.reduce(
        (sum, run) => sum + (run["usage"]["prompt_tokens"] ?? 0),
        0,
      ),
      completion_tokens: validRuns.reduce(
        (sum, run) => sum + (run["usage"]["completion_tokens"] ?? 0),
        0,
      ),
    });
  }
  return summaries;
}

export function dominates(left: any, right: any): boolean {
  const leftValues = [
    left["total_cost_usd"] ?? Infinity,
    left["median_latency_seconds"] ?? Infinity,
    -left["exact_leaf_accuracy"],
  ];
  const rightValues = [
    right["total_cost_usd"] ?? Infinity,
    right["median_latency_seconds"] ?? Infinity,
    -right["exact_leaf_accuracy"],
  ];
  return (
    leftValues.every((a, i) => a <= rightValues[i]) &&
    leftValues.some((a, i) => a < rightValues[i])
  );
}

export function pareto_layers(summaries: any[]): string[][] {
  let remaining = [...summaries];
  const layers: string[][] = [];
  while (remaining.length) {
    const frontier = remaining.filter(
      (candidate) =>
        !remaining.some((other) => other !== candidate && dominates(other, candidate)),
    );
    frontier.sort(
      (a, b) =>
        (a["total_cost_usd"] ?? Infinity) - (b["total_cost_usd"] ?? Infinity) ||
        b["exact_leaf_accuracy"] - a["exact_leaf_accuracy"],
    );
    layers.push(frontier.map((item) => item["model"]));
    const frontierModels = new Set(frontier.map((item) => item["model"]));
    remaining = remaining.filter((item) => !frontierModels.has(item["model"]));
  }
  return layers;
}

function parseModels(argv: string[]): string[] {
  const prog = basename(process.argv[1] ?? "benchmark.ts");
  const usage = `usage: ${prog} [-h] [--models [MODELS ...]]`;
  let models: string[] | null = null;
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--models") {
      models = [];
      index += 1;
      // argparse nargs="*": consume the following non-flag tokens.
      while (index < argv.length && !argv[index].startsWith("-")) {
        const choice = argv[index];
        if (!MODELS.includes(choice)) {
          console.error(usage);
          console.error(
            `${prog}: error: argument --models: invalid choice: '${choice}' ` +
              `(choose from ${MODELS.map((model) => `'${model}'`).join(", ")})`,
          );
          process.exit(2);
        }
        models.push(choice);
        index += 1;
      }
    } else if (arg === "-h" || arg === "--help") {
      console.log(usage);
      process.exit(0);
    } else {
      console.error(usage);
      console.error(`${prog}: error: unrecognized arguments: ${arg}`);
      process.exit(2);
    }
  }
  return models ?? [...MODELS];
}

async function main(): Promise<void> {
  const models = parseModels(process.argv.slice(2));

  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    die("Set OPENROUTER_API_KEY in the environment");
  }
  const manifestPath = join(DATA_DIR, "manifest.json");
  if (!existsSync(manifestPath)) {
    die("Run prepare_data.ts first");
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  mkdirSync(RESULTS_DIR, { recursive: true });
  const runStamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const rawPath = join(RESULTS_DIR, `runs_${runStamp}.jsonl`);
  const runs: any[] = [];

  for (const model of models) {
    for (const invoice of manifest["rows"]) {
      const expected = JSON.parse(
        readFileSync(join(DATA_DIR, invoice["ground_truth"]), "utf8"),
      );
      console.log(
        `RUN ${String(runs.length + 1).padStart(2, "0")}/` +
          `${models.length * manifest["rows"].length}: ${model} × ${invoice["invoice_id"]}`,
      );
      const run: Record<string, any> = {
        model,
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
        // Preserve failures as benchmark results.
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
  const report = {
    created_at: utc_now(),
    dataset: manifest["dataset"],
    dataset_revision: manifest["dataset_revision"],
    invoice_count: manifest["rows"].length,
    model_count: models.length,
    run_count: runs.length,
    quality_metric: "micro-averaged strict typed exact match over union of JSON leaf paths",
    latency_metric: "median client-observed end-to-end seconds",
    cost_metric: "OpenRouter response usage.cost summed over 10 successful runs",
    summaries,
    rankings: {
      cost: [...summaries]
        .sort(
          (a, b) =>
            (a["total_cost_usd"] ?? Infinity) - (b["total_cost_usd"] ?? Infinity),
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
    },
    pareto_layers: pareto_layers(summaries),
    raw_runs_file: basename(rawPath),
  };
  const reportPath = join(RESULTS_DIR, `summary_${runStamp}.json`);
  // Divergence from Python: json.dumps used ensure_ascii=True (\uXXXX escapes);
  // JSON.stringify writes raw UTF-8. Parsed content is identical.
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`Wrote ${rawPath}`);
  console.log(`Wrote ${reportPath}`);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
