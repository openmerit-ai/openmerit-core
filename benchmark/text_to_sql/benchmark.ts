/** Benchmark OpenRouter coding models on deterministic SQLite text-to-SQL tasks.
 * See benchmark/PORTING.md; run with `node benchmark.ts`. */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(ROOT, "data");
export const RESULTS_DIR = join(ROOT, "results");
export const SCHEMA_PATH = join(DATA_DIR, "schema.sql");
export const SEED_PATH = join(DATA_DIR, "seed.sql");
export const TASKS_PATH = join(DATA_DIR, "tasks.json");
const SQLITE_WORKER_PATH = join(ROOT, "sqlite_worker.ts");
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

export const PREVIOUS_INVOICE_MODELS = [
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
];

export const MODEL_SPECS = [
  {
    model: "inception/mercury-2.5",
    role: "ultra-cheap fast reasoning model",
    selection_reason:
      "Diffusion-language architecture optimized for low latency, included to " +
      "test whether its speed translates to executable SQL.",
  },
  {
    model: "qwen/qwen3-coder-30b-a3b-instruct",
    role: "cheap open coding model",
    selection_reason:
      "Open-weight code-specialized mixture-of-experts model with very low " +
      "catalog pricing and native structured outputs.",
  },
  {
    model: "mistralai/codestral-2508",
    role: "code specialist",
    selection_reason:
      "Dedicated Mistral code-generation model, providing a specialist baseline " +
      "from a different model family.",
  },
  {
    model: "moonshotai/kimi-k2.7-code",
    role: "strong agentic coding model",
    selection_reason:
      "Large coding-focused model designed for end-to-end programming tasks and " +
      "multi-step code reasoning.",
  },
  {
    model: "anthropic/claude-opus-5",
    role: "frontier coding/reasoning model",
    selection_reason:
      "Current Anthropic flagship, included as a frontier quality ceiling for " +
      "complex analytical SQL.",
  },
];
export const MODELS = MODEL_SPECS.map((item) => item.model);
export const MODEL_SPEC_BY_ID: Record<string, any> = Object.fromEntries(
  MODEL_SPECS.map((item) => [item.model, item]),
);

export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { sql: { type: "string" } },
  required: ["sql"],
};

export const PROMPT_TEMPLATE = `Write one read-only SQLite 3 query for the task below.

Database schema:
\`\`\`sql
{schema}
\`\`\`

Task:
{question}

Rules:
- Return JSON matching the required schema, with the SQL query in the \`sql\` field.
- Return one SELECT statement; a WITH or WITH RECURSIVE query is allowed.
- Do not use PRAGMA, ATTACH, or any data-changing statement.
- Use only the supplied schema and the task's definitions.
- Use the exact output column names and ordering requested by the task.
- Do not add explanation or Markdown to the SQL string.
`;

// --- Python-semantics helpers (porting layer, no Python counterparts) ---

function isPlainObject(v: any): v is Record<string, any> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Python == semantics: bools coerce to numbers (True == 1), ints == floats. */
export function pyEqual(a: any, b: any): boolean {
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
    const ka = Object.keys(a),
      kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && pyEqual(a[k], b[k]));
  }
  return false;
}

/** Python truthiness: None/False/0/""/[]/{} are falsy. */
function pyTruthy(x: any): boolean {
  if (x === null || x === undefined || x === false || x === 0 || x === "") return false;
  if (Array.isArray(x) && x.length === 0) return false;
  if (isPlainObject(x) && Object.keys(x).length === 0) return false;
  return true;
}

/** Python `or` chain: first truthy operand, else the last operand. */
function pyOr(...xs: any[]): any {
  for (const x of xs) if (pyTruthy(x)) return x;
  return xs[xs.length - 1];
}

/** Python repr() of a string (single quotes; double quotes if it contains ' but not "). */
function pyStrRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + quote;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += "\\x" + code.toString(16).padStart(2, "0");
    else out += ch;
  }
  return quote + out + quote;
}

/** Python repr() for the values we format (strings, lists, dicts, None, bools). */
export function pyRepr(v: any): string {
  if (typeof v === "string") return pyStrRepr(v);
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (typeof v === "object") {
    return `{${Object.entries(v)
      .map(([k, x]) => `${pyStrRepr(k)}: ${pyRepr(x)}`)
      .join(", ")}}`;
  }
  return String(v);
}

/** Python str()/f-string conversion: None/True/False spellings; containers use repr. */
function pyStr(v: any): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) || isPlainObject(v)) return pyRepr(v);
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

/** Python urllib.parse.quote(s, safe="/") semantics. */
function pyQuote(s: string): string {
  return s
    .split("/")
    .map(encodeURIComponent)
    .join("/")
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Python type(x).__name__ for JSON-ish values. */
function pyTypeName(v: any): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  return "dict";
}

/** raise SystemExit(msg) */
function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const sleep = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000));

/** Python 3.12+ builtin sum() over floats: Neumaier (improved Kahan–Babuška)
 * compensation, matching CPython's float fast path in builtin_sum. */
function pyFloatSum(xs: number[]): number {
  let total = 0.0;
  let c = 0.0;
  for (const x of xs) {
    const t = total + x;
    if (Math.abs(total) >= Math.abs(x)) {
      c += total - t + x;
    } else {
      c += x - t + total;
    }
    total = t;
  }
  if (c !== 0) total += c; // CPython adds the compensation only when it is non-zero.
  return total;
}

/** math.fsum: correctly rounded summation via Shewchuk's partial-sums algorithm
 * (port of CPython math_fsum, finite-input path; benchmark data is always finite). */
function fsum(xs: number[]): number {
  const p: number[] = [];
  let n = 0;
  for (const x0 of xs) {
    let x = x0;
    let i = 0;
    for (let j = 0; j < n; j++) {
      let y = p[j];
      if (Math.abs(x) < Math.abs(y)) {
        const t = x;
        x = y;
        y = t;
      }
      const hi = x + y;
      const yr = hi - x;
      const lo = y - yr;
      if (lo !== 0.0) p[i++] = lo;
      x = hi;
    }
    n = i;
    if (x !== 0.0) {
      p[n++] = x;
    }
  }
  let hi = 0.0;
  if (n > 0) {
    hi = p[--n];
    let lo = 0.0;
    while (n > 0) {
      const x = hi;
      const y = p[--n];
      hi = x + y;
      const yr = hi - x;
      lo = y - yr;
      if (lo !== 0.0) break;
    }
    // Half-even rounding fix-up across multiple partials (as in CPython).
    if (n > 0 && ((lo < 0.0 && p[n - 1] < 0.0) || (lo > 0.0 && p[n - 1] > 0.0))) {
      const y = lo * 2.0;
      const x = hi + y;
      const yr = x - hi;
      if (y === yr) hi = x;
    }
  }
  return hi;
}

/** statistics.fmean (Python 3.12+ computes it as fsum(data) / n). */
function fmean(xs: number[]): number {
  return fsum(xs) / xs.length;
}

/** statistics.median */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Three-way comparator (avoids NaN from Infinity - Infinity in subtraction comparators). */
function cmp(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// --- Benchmark implementation ---

export function utc_now(): string {
  // Divergence from Python: datetime.isoformat() emits "+00:00" with microseconds;
  // Date.toISOString() emits "Z" with milliseconds. Affects only newly generated timestamps.
  return new Date().toISOString();
}

export function file_sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export async function fetch_json(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { "User-Agent": "openmerit-text-to-sql-benchmark/1.0" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 1000)}`);
  return res.json();
}

export async function public_model_snapshot(): Promise<any> {
  const catalog = await fetch_json(OPENROUTER_MODELS_URL);
  const catalogById = new Map<string, any>(
    (catalog.data ?? []).map((item: any): [string, any] => [item.id, item]),
  );
  const overlap = MODELS.filter((m) => PREVIOUS_INVOICE_MODELS.includes(m)).sort();
  if (overlap.length) {
    throw new Error(`Text-to-SQL slate overlaps the invoice benchmarks: ${pyRepr(overlap)}`);
  }
  if (MODELS.length !== 5 || new Set(MODELS).size !== 5) {
    throw new Error("The benchmark must contain exactly five distinct models");
  }

  const selected: any[] = [];
  for (const spec of MODEL_SPECS) {
    const model = spec.model;
    const item = catalogById.get(model);
    if (item === undefined) {
      throw new Error(`Model is not in the current OpenRouter catalog: ${model}`);
    }
    const modalities: string[] = item.architecture?.input_modalities ?? [];
    if (!modalities.includes("text")) {
      throw new Error(`Model does not currently advertise text input: ${model}`);
    }

    const endpoint_url = `https://openrouter.ai/api/v1/models/${pyQuote(model)}/endpoints`;
    const payload = await fetch_json(endpoint_url);
    const endpoints: any[] = payload.data?.endpoints ?? [];
    const live = endpoints.filter((endpoint) => endpoint.status === 0);
    const strict = live.filter((endpoint) => {
      const params = new Set<string>(endpoint.supported_parameters ?? []);
      return params.has("response_format") && params.has("structured_outputs");
    });
    if (!strict.length) {
      throw new Error(
        `No live endpoint currently advertises strict structured outputs: ${model}`,
      );
    }
    selected.push({
      ...spec,
      catalog: item,
      endpoint_url,
      live_endpoint_count: live.length,
      strict_schema_endpoint_count: strict.length,
      endpoints,
    });
  }

  return {
    verified_at: utc_now(),
    source: OPENROUTER_MODELS_URL,
    previous_invoice_models_excluded: PREVIOUS_INVOICE_MODELS,
    required_capabilities: [
      "text input",
      "response_format",
      "structured_outputs",
      "at least one live endpoint",
    ],
    models: selected,
  };
}

export function load_tasks(): any[] {
  const payload = JSON.parse(readFileSync(TASKS_PATH, "utf8"));
  const tasks: any[] = payload.tasks ?? [];
  if (tasks.length !== 10 || new Set(tasks.map((task) => task.task_id)).size !== 10) {
    throw new Error("The benchmark requires exactly 10 uniquely named SQL tasks");
  }
  return tasks;
}

export function build_database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  db.exec(readFileSync(SEED_PATH, "utf8"));
  db.exec("PRAGMA query_only = ON");
  return db;
}

export function execute_sql(sql: string): Record<string, any> {
  let statement = sql.trim();
  if (statement.endsWith(";")) {
    statement = statement.slice(0, -1).trimEnd();
  }
  if (statement.includes(";")) {
    throw new Error("Multiple SQL statements are not allowed");
  }
  const firstToken = statement.split(/\s+/, 1)[0].toUpperCase();
  if (firstToken !== "SELECT" && firstToken !== "WITH") {
    throw new Error("Query must start with SELECT, WITH, or WITH RECURSIVE");
  }

  // DatabaseSync has no interrupt/progress handler in Node 22. Run untrusted
  // model SQL in a child process so a recursive or pathological query can be
  // terminated at the same two-second boundary as the original evaluator.
  const result = spawnSync(process.execPath, [SQLITE_WORKER_PATH], {
    input: JSON.stringify({
      schema: readFileSync(SCHEMA_PATH, "utf8"),
      seed: readFileSync(SEED_PATH, "utf8"),
      sql: statement,
      rowLimit: 1000,
    }),
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw new Error("Query exceeded the 2-second execution timeout");
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `SQLite worker exited with status ${result.status}`);
  }
  return JSON.parse(result.stdout) as Record<string, any>;
}

export function expected_results(tasks: any[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const task of tasks) out[task.task_id] = execute_sql(task.reference_sql);
  return out;
}

export function make_request(model: string, task: any, schema_text: string): Record<string, any> {
  const prompt = PROMPT_TEMPLATE.replace(/\{schema\}|\{question\}/g, (field) =>
    field === "{schema}" ? schema_text : task.question,
  );
  return {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    max_tokens: 2000,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "sqlite_query",
        strict: true,
        schema: OUTPUT_SCHEMA,
      },
    },
  };
}

export async function invoke(
  api_key: string,
  payload: any,
  retries = 3,
): Promise<[any, number, number]> {
  const encoded = JSON.stringify(payload);
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const attemptStarted = performance.now();
    let res: Response;
    try {
      res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${api_key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/openmerit/openmerit",
          "X-Title": "OpenMerit Text-to-SQL Benchmark",
        },
        body: encoded,
        signal: AbortSignal.timeout(180_000),
      });
    } catch (e) {
      // Network errors and AbortSignal timeouts (Python URLError/TimeoutError) retry.
      lastError = e as Error;
      if (attempt < retries) await sleep(2 ** (attempt - 1));
      continue;
    }
    if (!res.ok) {
      const errorBody = await res.text();
      lastError = new Error(`HTTP ${res.status}: ${errorBody.slice(0, 1000)}`);
      if (res.status < 500 && res.status !== 429) break;
      if (attempt < retries) await sleep(2 ** (attempt - 1));
      continue;
    }
    // Like Python's json.load(response), a JSON error here is NOT retried; it propagates.
    const body = await res.json();
    return [body, (performance.now() - attemptStarted) / 1000, attempt];
  }
  throw new Error(`OpenRouter request failed after ${retries} attempts: ${lastError?.message}`);
}

export function content_from_response(response: any): string {
  const content = response.choices[0].message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (isPlainObject(part) ? (part.text ?? "") : "")).join("");
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

export function validate_output(value: Record<string, any> | null): string[] {
  if (value === null || value === undefined) {
    return ["No parsed JSON object"];
  }
  const errors: string[] = [];
  const keys = new Set(Object.keys(value));
  if (!(keys.size === 1 && keys.has("sql"))) {
    const missing = ["sql"].filter((k) => !keys.has(k)).sort();
    const extra = [...keys].filter((k) => k !== "sql").sort();
    if (missing.length) errors.push(`Missing properties: ${pyRepr(missing)}`);
    if (extra.length) errors.push(`Additional properties: ${pyRepr(extra)}`);
  }
  if ("sql" in value && (typeof value.sql !== "string" || !value.sql.trim())) {
    errors.push("sql must be a non-empty string");
  }
  return errors;
}

export function flatten(value: any, path = ""): Record<string, any> {
  if (isPlainObject(value)) {
    const flattened: Record<string, any> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      Object.assign(flattened, flatten(child, childPath));
    }
    return flattened;
  }
  if (Array.isArray(value)) {
    if (!value.length) {
      return { [`${path}.__length__`]: 0 };
    }
    const flattened: Record<string, any> = { [`${path}.__length__`]: value.length };
    value.forEach((child, index) => {
      Object.assign(flattened, flatten(child, `${path}[${index}]`));
    });
    return flattened;
  }
  return { [path]: value };
}

export function exact_value(expected: any, actual: any): boolean {
  if (typeof expected === "boolean" || typeof actual === "boolean") {
    return typeof expected === typeof actual && expected === actual;
  }
  if (typeof expected === "number" && typeof actual === "number") {
    return expected === actual;
  }
  return typeof expected === typeof actual && expected === actual;
}

export function score_result(
  expected: Record<string, any>,
  actual: Record<string, any> | null,
): Record<string, any> {
  const expectedFlat = flatten(expected);
  if (actual === null) {
    return {
      exact_result: false,
      matched_leaves: 0,
      total_union_leaves: Object.keys(expectedFlat).length,
      exact_leaf_accuracy: 0.0,
    };
  }
  const actualFlat = flatten(actual);
  const paths = new Set([...Object.keys(expectedFlat), ...Object.keys(actualFlat)]);
  let matches = 0;
  for (const path of paths) {
    if (
      Object.hasOwn(expectedFlat, path) &&
      Object.hasOwn(actualFlat, path) &&
      exact_value(expectedFlat[path], actualFlat[path])
    ) {
      matches++;
    }
  }
  return {
    exact_result: pyEqual(expected, actual),
    matched_leaves: matches,
    total_union_leaves: paths.size,
    exact_leaf_accuracy: paths.size ? matches / paths.size : 1.0,
  };
}

export function percentile(values: number[], fraction: number): number {
  if (!values.length) return NaN;
  const ordered = [...values].sort((a, b) => a - b);
  const rank = (ordered.length - 1) * fraction;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return ordered[low];
  return ordered[low] * (high - rank) + ordered[high] * (rank - low);
}

export function comparison_cost(
  summary: any,
  expected_runs: number,
): [number | null, string] {
  const captured = summary.cost_captured_runs;
  if (captured === expected_runs) {
    return [summary.total_cost_usd, "observed"];
  }
  if (captured === 0) {
    return [null, "unavailable; no response usage was captured"];
  }
  return [
    summary.mean_cost_usd * expected_runs,
    "projected from responses with captured usage",
  ];
}

export function summarize(runs: any[]): any[] {
  const summaries: any[] = [];
  for (const model of [...new Set(runs.map((run) => run.model))]) {
    const modelRuns = runs.filter((run) => run.model === model);
    const latencies = modelRuns
      .filter((run) => run.latency_seconds != null)
      .map((run) => run.latency_seconds);
    const costs = modelRuns
      .filter((run) => run.cost_usd != null)
      .map((run) => run.cost_usd);
    const totalMatches = modelRuns.reduce((n, run) => n + run.score.matched_leaves, 0);
    const totalLeaves = modelRuns.reduce((n, run) => n + run.score.total_union_leaves, 0);
    const failureReasons = new Map<string, number>();
    for (const run of modelRuns) {
      if (run.status === "ok") continue;
      const reason = pyOr(
        run.error ?? null,
        run.parse_error ?? null,
        run.schema_errors ?? null,
        "unspecified",
      );
      const key = `${run.status}: ${pyStr(reason)}`;
      failureReasons.set(key, (failureReasons.get(key) ?? 0) + 1);
    }
    const responsesReceived = modelRuns.reduce(
      (n, run) => n + Number(run.response_received ?? false),
      0,
    );
    const jsonValid = modelRuns.reduce((n, run) => n + Number(run.json_valid ?? false), 0);
    const schemaValid = modelRuns.reduce(
      (n, run) => n + Number(run.schema_valid ?? false),
      0,
    );
    const executionSuccesses = modelRuns.reduce(
      (n, run) => n + Number(run.execution_success ?? false),
      0,
    );
    const exactResultTasks = modelRuns.reduce(
      (n, run) => n + Number(run.score.exact_result),
      0,
    );
    const failedRuns = modelRuns.reduce((n, run) => n + (run.status !== "ok" ? 1 : 0), 0);
    const summary: any = {
      model,
      planned_runs: modelRuns.length,
      responses_received: responsesReceived,
      response_rate: responsesReceived / modelRuns.length,
      json_valid_outputs: jsonValid,
      json_valid_rate: jsonValid / modelRuns.length,
      schema_valid_outputs: schemaValid,
      schema_valid_rate: schemaValid / modelRuns.length,
      execution_successes: executionSuccesses,
      execution_success_rate: executionSuccesses / modelRuns.length,
      exact_result_tasks: exactResultTasks,
      exact_result_rate: exactResultTasks / modelRuns.length,
      exact_result_leaf_accuracy: totalLeaves ? totalMatches / totalLeaves : 0.0,
      failed_runs: failedRuns,
      failure_rate: failedRuns / modelRuns.length,
      failure_reasons: Object.fromEntries(failureReasons),
      total_cost_usd: costs.length ? pyFloatSum(costs) : null,
      mean_cost_usd: costs.length ? fmean(costs) : null,
      cost_captured_runs: costs.length,
      mean_latency_seconds: latencies.length ? fmean(latencies) : null,
      median_latency_seconds: latencies.length ? median(latencies) : null,
      p95_latency_seconds: latencies.length ? percentile(latencies, 0.95) : null,
      prompt_tokens: modelRuns.reduce(
        (n, run) => n + ((run.usage ?? {}).prompt_tokens ?? 0),
        0,
      ),
      completion_tokens: modelRuns.reduce(
        (n, run) => n + ((run.usage ?? {}).completion_tokens ?? 0),
        0,
      ),
    };
    const [projectedCost, basis] = comparison_cost(summary, modelRuns.length);
    summary.comparison_cost_usd = projectedCost;
    summary.comparison_cost_basis = basis;
    summaries.push(summary);
  }
  return summaries;
}

export function dominates(left: any, right: any): boolean {
  const leftValues = [
    left.comparison_cost_usd ?? Infinity,
    left.median_latency_seconds ?? Infinity,
    -left.exact_result_leaf_accuracy,
  ];
  const rightValues = [
    right.comparison_cost_usd ?? Infinity,
    right.median_latency_seconds ?? Infinity,
    -right.exact_result_leaf_accuracy,
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
        cmp(a.comparison_cost_usd ?? Infinity, b.comparison_cost_usd ?? Infinity) ||
        cmp(-a.exact_result_leaf_accuracy, -b.exact_result_leaf_accuracy),
    );
    layers.push(frontier.map((item) => item.model));
    const frontierModels = new Set(frontier.map((item) => item.model));
    remaining = remaining.filter((item) => !frontierModels.has(item.model));
  }
  return layers;
}

export async function main(): Promise<void> {
  const prog = basename(process.argv[1] ?? "benchmark.ts");
  const unknown: string[] = [];
  let verifyOnly = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === "--verify-only") {
      verifyOnly = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(`usage: ${prog} [-h] [--verify-only]`);
      process.exit(0);
    } else {
      unknown.push(arg);
    }
  }
  if (unknown.length) {
    console.error(`usage: ${prog} [-h] [--verify-only]`);
    console.error(`${prog}: error: unrecognized arguments: ${unknown.join(" ")}`);
    process.exit(2);
  }

  const tasks = load_tasks();
  const schema_text = readFileSync(SCHEMA_PATH, "utf8");
  const expected_by_task = expected_results(tasks);
  const snapshot = await public_model_snapshot();
  if (verifyOnly) {
    for (const item of snapshot.models) {
      const pricing = item.catalog.pricing;
      console.log(
        `${item.model} | ${item.role} | ` +
          `prompt=${pyStr(pricing?.prompt ?? null)} | completion=${pyStr(pricing?.completion ?? null)} | ` +
          `live_strict_endpoints=${item.strict_schema_endpoint_count}`,
      );
    }
    for (const task of tasks) {
      const expected = expected_by_task[task.task_id];
      console.log(
        `${task.task_id} | ${task.difficulty} | ` +
          `rows=${expected.rows.length} | columns=${pyRepr(expected.columns)}`,
      );
    }
    return;
  }

  const api_key = process.env.OPENROUTER_API_KEY;
  if (!api_key) {
    die("Set OPENROUTER_API_KEY in the environment");
  }

  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const rawPath = join(RESULTS_DIR, `runs_${stamp}.jsonl`);
  const summaryPath = join(RESULTS_DIR, `summary_${stamp}.json`);
  const catalogPath = join(RESULTS_DIR, `model_catalog_${stamp}.json`);
  const collisions = [rawPath, summaryPath, catalogPath].filter((p) => existsSync(p));
  if (collisions.length) {
    // Divergence from Python: it repr'ed PosixPath objects here; we repr plain path
    // strings (error text only).
    die(`Refusing to overwrite existing artifacts: ${pyRepr(collisions)}`);
  }
  // Divergence from Python: json.dumps used default ensure_ascii=True (\uXXXX escapes);
  // JSON.stringify writes raw UTF-8. Parsed content is identical.
  writeFileSync(catalogPath, JSON.stringify(snapshot, null, 2) + "\n");

  const runs: any[] = [];
  const totalRuns = MODELS.length * tasks.length;
  for (const model of MODELS) {
    for (const task of tasks) {
      console.log(
        `RUN ${String(runs.length + 1).padStart(2, "0")}/${totalRuns}: ${model} x ${task.task_id}`,
      );
      const expected = expected_by_task[task.task_id];
      const run: any = {
        benchmark: "text_to_sql",
        model,
        model_role: MODEL_SPEC_BY_ID[model].role,
        task_id: task.task_id,
        difficulty: task.difficulty,
        skills: task.skills,
        started_at: utc_now(),
        expected_result: expected,
      };
      const requestStarted = performance.now();
      try {
        const [response, attemptLatency, attempts] = await invoke(
          api_key,
          make_request(model, task, schema_text),
        );
        const latency = (performance.now() - requestStarted) / 1000;
        const usage = response.usage ?? {};
        Object.assign(run, {
          response_received: true,
          response_id: response.id ?? null,
          served_model: response.model ?? null,
          provider: response.provider ?? null,
          usage,
          cost_usd: usage.cost ?? null,
          attempts,
          attempt_latency_seconds: attemptLatency,
          latency_seconds: latency,
        });
        let content: string | null = null;
        let contentError: Error | null = null;
        try {
          content = content_from_response(response);
        } catch (e) {
          contentError = e as Error;
        }
        if (contentError !== null) {
          Object.assign(run, {
            status: "output_error",
            error: contentError.message,
            json_valid: false,
            schema_valid: false,
            execution_success: false,
            prediction: null,
            actual_result: null,
            score: score_result(expected, null),
          });
        } else {
          const text = content as string;
          let prediction: any = null;
          let parseError: string | null = null;
          try {
            prediction = parse_json(text);
          } catch (e) {
            parseError = (e as Error).message;
          }
          const schemaErrors = validate_output(prediction);
          Object.assign(run, {
            json_valid: prediction !== null,
            schema_valid: schemaErrors.length === 0,
            parse_error: parseError,
            schema_errors: schemaErrors,
            prediction,
            raw_content: prediction === null ? text : null,
          });
          if (schemaErrors.length) {
            Object.assign(run, {
              status: "output_error",
              execution_success: false,
              actual_result: null,
              score: score_result(expected, null),
            });
          } else {
            try {
              const actual = execute_sql(prediction.sql);
              const resultScore = score_result(expected, actual);
              Object.assign(run, {
                status: "ok",
                execution_success: true,
                actual_result: actual,
                score: resultScore,
              });
            } catch (e) {
              // Python caught (sqlite3.Error, ValueError); here any Error from
              // validation or node:sqlite lands in the same branch.
              Object.assign(run, {
                status: "query_error",
                error: (e as Error).message,
                execution_success: false,
                actual_result: null,
                score: score_result(expected, null),
              });
            }
          }
        }
      } catch (e) {
        const latency = (performance.now() - requestStarted) / 1000;
        Object.assign(run, {
          status: "request_error",
          completed_at: utc_now(),
          error: e instanceof Error ? e.message : String(e),
          response_received: false,
          latency_seconds: latency,
          attempts: 3,
          usage: {},
          cost_usd: null,
          json_valid: false,
          schema_valid: false,
          execution_success: false,
          prediction: null,
          actual_result: null,
          score: score_result(expected, null),
        });
      }
      run.completed_at = utc_now();
      runs.push(run);
      appendFileSync(rawPath, JSON.stringify(run) + "\n");
      console.log(
        `  ${run.status} | valid=${pyStr(run.schema_valid)} | ` +
          `execute=${pyStr(run.execution_success)} | ` +
          `exact=${pyStr(run.score.exact_result)} | ` +
          `latency=${run.latency_seconds.toFixed(3)}s | cost=${pyStr(run.cost_usd)}`,
      );
    }
  }

  const summaries = summarize(runs);
  // Divergence from Python: sqlite_version is queried from Node's bundled SQLite
  // (may differ from Python's sqlite3.sqlite_version); only affects newly generated reports.
  const versionDb = build_database();
  let sqliteVersion: string;
  try {
    sqliteVersion = (versionDb.prepare("SELECT sqlite_version() AS v").get() as any).v;
  } finally {
    versionDb.close();
  }
  const report = {
    created_at: utc_now(),
    benchmark: "deterministic SQLite analytical text-to-SQL",
    task_count: tasks.length,
    model_count: MODELS.length,
    run_count: runs.length,
    model_selection: MODEL_SPECS,
    dataset: {
      schema_sha256: file_sha256(SCHEMA_PATH),
      seed_sha256: file_sha256(SEED_PATH),
      tasks_sha256: file_sha256(TASKS_PATH),
      sqlite_version: sqliteVersion,
    },
    request_contract: {
      prompt_template: PROMPT_TEMPLATE,
      output_schema: OUTPUT_SCHEMA,
      temperature: 0,
      max_tokens: 2000,
    },
    quality_metric:
      "micro-averaged strict typed exact match over the union of executed " +
      "result JSON leaf paths, including column names, row order, and values",
    exact_task_metric: "deep equality of expected and executed query result JSON",
    latency_metric:
      "full client wall time including retries and retry backoff for each scheduled run",
    cost_metric: "OpenRouter response usage.cost summed over runs with captured usage",
    summaries,
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
      execution_reliability: [...summaries]
        .sort(
          (a, b) =>
            cmp(-a.execution_success_rate, -b.execution_success_rate) ||
            cmp(-a.schema_valid_rate, -b.schema_valid_rate),
        )
        .map((item) => item.model),
    },
    pareto_layers: pareto_layers(summaries),
    raw_runs_file: basename(rawPath),
    model_catalog_file: basename(catalogPath),
  };
  // Divergence from Python: json.dumps used default ensure_ascii=True; JSON.stringify
  // writes raw UTF-8. Parsed content is identical.
  writeFileSync(summaryPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`Wrote ${rawPath}`);
  console.log(`Wrote ${summaryPath}`);
  console.log(`Wrote ${catalogPath}`);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
