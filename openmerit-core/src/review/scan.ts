// The repository review's first step (review/index.ts): find model and endpoint usages in a checkout without changing it. Reads only
// files Git does not ignore (or, outside Git, skips dependency and build directories), minus the
// repository's `scan.exclude` patterns. A JSON, YAML or TOML file that names many models is data (a catalogue,
// saved results, a dataset), not configuration, and is skipped. Snippets are redacted: anything
// shaped like a key or token is replaced before it is shown, stored or sent.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, matchesGlob, relative } from "node:path";
import { catalogueIndex, type Catalogue } from "../engine/catalogue.ts";
import { redact } from "../engine/redact.ts";

export interface Usage {
  id: string;
  kind: "model" | "endpoint";
  file: string;
  line: number;
  /** The literal value (model ID or URL), or the expression for a dynamic use. Redacted. */
  value: string;
  /** Set when the value is computed at run time (an environment variable, a variable, a function call). */
  dynamic: boolean;
  /** Environment variable a dynamic use reads, when the code names one. */
  envVar?: string;
  /** Catalogue model this literal names, or null for an unknown model or an endpoint. */
  catalogueId: string | null;
  /** The line, redacted. */
  snippet: string;
}

export interface ScanResult {
  files: number;
  usages: Usage[];
  /** Catalogue models found, with their usage IDs. */
  models: { catalogueId: string | null; value: string; usageIds: string[] }[];
  /** JSON files skipped as data because they name more than MAX_DATA_FILE_MODELS models. */
  skipped: string[];
}

export interface ScanOptions {
  /** Glob patterns, relative to the repository root, of files or directories not to scan. */
  exclude?: string[];
}

const TEXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rb", ".java", ".kt", ".rs", ".php", ".cs", ".swift",
  ".ex", ".exs", ".scala", ".dart", ".lua", ".vue", ".svelte", ".astro", ".groovy", ".gradle", ".kts", ".r", ".jl", ".clj", ".fs",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".properties", ".env", ".example", ".sh", ".tf", ".bicep"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".venv", "venv", "__pycache__", "target", ".openmerit", "coverage", ".amp"]);
const SKIP_FILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|Cargo\.lock|go\.sum)$|\.min\.(js|mjs|cjs)$/;
const MAX_BYTES = 512_000;
/** More model usages than this in one JSON, YAML or TOML file make it data rather than configuration. */
export const MAX_DATA_FILE_MODELS = 20;

const SUPPORT = /(^|\/)(tests?|specs?|__tests__|__mocks__|mocks?|fixtures?|testdata|cassettes|vcr_cassettes|snapshots?|__snapshots__|docs?|[\w.-]*results)\/|(^|\/)(test_[^/]+|[^/]+_test\.\w+|[^/]+\.(test|spec)\.\w+|[^/]+_spec\.rb|conftest\.py)$/i;
/** Tests, fixtures, recorded responses, docs and saved results: they name models, but no production task runs there. */
export const isSupportFile = (file: string) => SUPPORT.test(file);
const EXAMPLE = /(^|\/)(examples?|samples?|demos?|cookbooks?|notebooks?|scripts|benchmarks?|playground|tutorials?)\//i;
/** Examples, demos, scripts and benchmarks: the application's code, but less often its production path. */
export const isExampleFile = (file: string) => EXAMPLE.test(file);

/** True when `file` matches a pattern, or sits in a directory a pattern names. */
const excluded = (file: string, patterns: readonly string[]) => patterns.some(pattern => matchesGlob(file, pattern) || matchesGlob(file, `${pattern.replace(/\/+$/, "")}/**`));

export function listFiles(root: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
    return out.split("\0").filter(Boolean).filter(file => !file.split("/").some(part => SKIP_DIRS.has(part)));
  } catch {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name)); }
        else if (entry.isFile()) files.push(relative(root, join(dir, entry.name)));
      }
    };
    walk(root);
    return files;
  }
}

/** Configuration files, where a model is often written without quotes: `model: gpt-4o`, `OPENAI_MODEL=gpt-4o-mini`. */
const CONFIG = /(\.(ya?ml|toml|ini|cfg|properties|env|example|sh)|(^|\/)\.env(\.[\w-]+)?|(^|\/)Dockerfile)$/;
const UNQUOTED = /\b(?:\w*model\w*|engine|deployment)\b\s*(?::|=)\s*([\w.:/@-]+)\s*(?:#.*)?$/i;

const isText = (file: string) => TEXT.has(extname(file)) || /(^|\/)\.env(\.[\w-]+)?$/.test(file) || /(^|\/)Dockerfile$/.test(file);

const STRING = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const MODEL_KEY = /\b(?:\w*model\w*|engine|deployment)\b["']?\s*(?::|=|=>|,)\s*/i;
const DYNAMIC = /\b(\w*model\w*)\b["']?\s*(?::|=(?!=))\s*([^"'`\s,;)}\]][^,;)}\]\n]*)/i;
const ENV = /(?:process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[["']([A-Z][A-Z0-9_]*)["']\]|import\.meta\.env\.([A-Z][A-Z0-9_]*)|os\.environ(?:\.get)?\(?\[?["']([A-Z][A-Z0-9_]*)["']|os\.getenv\(["']([A-Z][A-Z0-9_]*)["']|Deno\.env\.get\(["']([A-Z][A-Z0-9_]*)["']|\$\{?([A-Z][A-Z0-9_]*MODEL[A-Z0-9_]*)\}?)/;
const URL_PATTERN = /https?:\/\/[^\s"'`<>)]+/g;
const ENDPOINT_HOSTS = /(api\.openai\.com|openrouter\.ai|api\.anthropic\.com|generativelanguage\.googleapis\.com|openai\.azure\.com|api\.together\.xyz|api\.groq\.com|api\.mistral\.ai|api\.deepseek\.com|api\.fireworks\.ai|bedrock|localhost:\d+\/v1|\/v1\/?$)/;
const BASE_URL_KEY = /\b(base_?url|baseURL|api_?base|endpoint)\b["']?\s*(?::|=(?!=))\s*([^\n,;]+)/i;

/** Scans the repository. Deterministic; no model is called. */
/** The text files a scan reads: not ignored by Git, not lockfiles or minified, not under `exclude`. */
export function sourceFiles(root: string, exclude: readonly string[] = []): string[] {
  return listFiles(root).filter(file => isText(file) && !SKIP_FILES.test(file) && !excluded(file, exclude));
}

export function scanRepo(root: string, catalogue: Catalogue, options: ScanOptions = {}): ScanResult {
  const index = catalogueIndex(catalogue);
  const usages: Usage[] = [];
  const skipped: string[] = [];
  const files = sourceFiles(root, options.exclude ?? []);
  let scanned = 0;
  for (const file of files) {
    const path = join(root, file);
    let text: string;
    try {
      if (statSync(path).size > MAX_BYTES) continue;
      text = readFileSync(path, "utf8");
    } catch { continue; }
    if (text.includes("\0")) continue;
    scanned++;
    const before = usages.length;
    const lines = text.split("\n");
    lines.forEach((raw, lineIndex) => {
      if (raw.length > 2000) return;
      const line = lineIndex + 1;
      const snippet = redact(raw.trim()).slice(0, 240);
      const add = (usage: Omit<Usage, "id" | "file" | "line" | "snippet">) => {
        if (usages.some(item => item.file === file && item.line === line && item.kind === usage.kind && item.value === usage.value)) return;
        usages.push({ id: `u${usages.length + 1}`, file, line, snippet, ...usage });
      };
      let literalModel = false;
      for (const match of raw.matchAll(STRING)) {
        const value = match[2]!;
        // catalogue:<endpoint>:<model> is how OpenMerit's own saved results name a model, not a model an app calls.
        if (value.length < 3 || value.length > 120 || /\s/.test(value) || value.startsWith("catalogue:")) continue;
        const model = index.find(value);
        const keyed = MODEL_KEY.test(raw.slice(Math.max(0, match.index! - 40), match.index!));
        if (model && (keyed || value.includes("/") || /\d/.test(value))) {
          literalModel = true;
          const env = ENV.exec(raw);
          const envVar = env?.slice(1).find(Boolean);
          add({ kind: "model", value: redact(value), dynamic: !!envVar, ...(envVar ? { envVar } : {}), catalogueId: model.id });
        } else if (keyed && /^[\w.:/@-]+$/.test(value) && !/^[A-Z][A-Z0-9_]*$/.test(value) && /[a-z]/i.test(value) && /\d|gpt|claude|gemini|llama|mistral|qwen|deepseek/i.test(value) && !/^https?:/.test(value)) {
          literalModel = true;
          add({ kind: "model", value: redact(value), dynamic: false, catalogueId: null });
        }
      }
      const bare = !literalModel && CONFIG.test(file) ? UNQUOTED.exec(raw) : null;
      const configured = bare ? index.find(bare[1]!) : null;
      if (bare && configured) {
        literalModel = true;
        add({ kind: "model", value: redact(bare[1]!), dynamic: false, catalogueId: configured.id });
      }
      if (!literalModel) {
        const dynamic = DYNAMIC.exec(raw);
        if (dynamic && !/^(true|false|null|undefined|None|\d)/.test(dynamic[2]!) && !/\b(type|interface|import|from|def|class)\b/.test(raw.slice(0, dynamic.index)) && !/^\s*(\/\/|#|\*)/.test(raw)
          && !/[:]\s*(string|number|Model|ModelRef)\b/.test(raw)) {
          const env = ENV.exec(raw);
          const envVar = env?.slice(1).find(Boolean);
          let expression = dynamic[2]!.trim().replace(/[\s,;]+$/, "").slice(0, 120);
          expression += ")".repeat(Math.max(0, (expression.match(/\(/g) ?? []).length - (expression.match(/\)/g) ?? []).length));
          if (envVar || /^[A-Za-z_$][\w$.[\]"'()]*$/.test(expression)) add({ kind: "model", value: redact(expression), dynamic: true, ...(envVar ? { envVar } : {}), catalogueId: null });
        }
      }
      for (const match of raw.matchAll(URL_PATTERN)) {
        const url = match[0].replace(/[.,]+$/, "");
        if (ENDPOINT_HOSTS.test(url)) add({ kind: "endpoint", value: redact(url), dynamic: false, catalogueId: null });
      }
      const base = BASE_URL_KEY.exec(raw);
      if (base && !URL_PATTERN.test(base[2]!)) {
        const env = ENV.exec(base[2]!);
        const envVar = env?.slice(1).find(Boolean);
        if (envVar) add({ kind: "endpoint", value: redact(base[2]!.trim().replace(/[\s,;]+$/, "").slice(0, 120)), dynamic: true, envVar, catalogueId: null });
      }
      URL_PATTERN.lastIndex = 0;
    });
    // This file's usages are the last ones added, so dropping them keeps usage IDs sequential.
    if ([".json", ".yaml", ".yml", ".toml"].includes(extname(file)) && usages.slice(before).filter(usage => usage.kind === "model").length > MAX_DATA_FILE_MODELS) {
      usages.length = before;
      skipped.push(file);
      scanned--;
    }
  }
  const groups = new Map<string, ScanResult["models"][number]>();
  for (const usage of usages.filter(item => item.kind === "model" && !item.dynamic || item.kind === "model" && item.catalogueId)) {
    const key = usage.catalogueId ?? `?${usage.value}`;
    const group = groups.get(key) ?? { catalogueId: usage.catalogueId, value: usage.catalogueId ?? usage.value, usageIds: [] };
    group.usageIds.push(usage.id);
    groups.set(key, group);
  }
  // Models the application's own code uses come first: a model named only in tests is rarely the one in production.
  const byId = new Map(usages.map(usage => [usage.id, usage]));
  const app = (group: ScanResult["models"][number]) => group.usageIds.filter(id => !isSupportFile(byId.get(id)!.file)).length;
  return { files: scanned, usages, models: [...groups.values()].sort((a, b) => app(b) - app(a) || b.usageIds.length - a.usageIds.length || a.value.localeCompare(b.value)), skipped };
}

/** A few lines around a usage, redacted, for the harness. */
export function context(root: string, usage: Pick<Usage, "file" | "line">, radius = 6): string {
  try {
    const lines = readFileSync(join(root, usage.file), "utf8").split("\n");
    const start = Math.max(0, usage.line - 1 - radius);
    return lines.slice(start, usage.line + radius).map((line, offset) => `${start + offset + 1}${start + offset + 1 === usage.line ? ">" : " "} ${redact(line).slice(0, 300)}`).join("\n");
  } catch { return ""; }
}
