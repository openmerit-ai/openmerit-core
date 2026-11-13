// Step 1 of Scout: find model and endpoint usages in the repository without changing it. Reads only
// files Git does not ignore (or, outside Git, skips dependency and build directories). Snippets are
// redacted: anything shaped like a key or token is replaced before it is shown, stored or sent.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { catalogueIndex, type Catalogue } from "../catalogue/catalogue.ts";

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
}

const TEXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rb", ".java", ".kt", ".rs", ".php", ".cs", ".swift",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".env", ".example", ".sh", ".tf"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".venv", "venv", "__pycache__", "target", ".openmerit", "coverage", ".amp"]);
const SKIP_FILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|Cargo\.lock|go\.sum)$/;
const MAX_BYTES = 512_000;

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)-(?:proj-|ant-|or-|lf-|live-|test-)?[A-Za-z0-9_-]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}\b/g, /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi,
  /((?:api[_-]?key|apikey|token|secret|password|authorization)\w*["']?\s*[:=]\s*["'])[^"'\s]{4,}(["'])/gi,
];

/** Replaces key- and token-shaped text with [redacted]. */
export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, (match, ...groups: unknown[]) => {
    const prefix = typeof groups[0] === "string" && /[:=\s]$/.test(groups[0]) ? groups[0] : typeof groups[0] === "string" && /^Bearer/i.test(groups[0]) ? groups[0] : "";
    const suffix = typeof groups[1] === "string" && /^["']$/.test(groups[1]) ? groups[1] : "";
    return prefix || suffix ? `${prefix}[redacted]${suffix}` : "[redacted]";
  });
  return out;
}

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

const isText = (file: string) => TEXT.has(extname(file)) || /(^|\/)\.env(\.[\w-]+)?$/.test(file) || /(^|\/)Dockerfile$/.test(file);

const STRING = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const MODEL_KEY = /\b(?:\w*model\w*|engine|deployment)\b["']?\s*(?::|=|=>|,)\s*/i;
const DYNAMIC = /\b(\w*model\w*)\b["']?\s*(?::|=(?!=))\s*([^"'`\s,;)}\]][^,;)}\]\n]*)/i;
const ENV = /(?:process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[["']([A-Z][A-Z0-9_]*)["']\]|import\.meta\.env\.([A-Z][A-Z0-9_]*)|os\.environ(?:\.get)?\(?\[?["']([A-Z][A-Z0-9_]*)["']|os\.getenv\(["']([A-Z][A-Z0-9_]*)["']|Deno\.env\.get\(["']([A-Z][A-Z0-9_]*)["']|\$\{?([A-Z][A-Z0-9_]*MODEL[A-Z0-9_]*)\}?)/;
const URL_PATTERN = /https?:\/\/[^\s"'`<>)]+/g;
const ENDPOINT_HOSTS = /(api\.openai\.com|openrouter\.ai|api\.anthropic\.com|generativelanguage\.googleapis\.com|openai\.azure\.com|api\.together\.xyz|api\.groq\.com|api\.mistral\.ai|api\.deepseek\.com|api\.fireworks\.ai|bedrock|localhost:\d+\/v1|\/v1\/?$)/;
const BASE_URL_KEY = /\b(base_?url|baseURL|api_?base|endpoint)\b["']?\s*(?::|=(?!=))\s*([^\n,;]+)/i;

/** Scans the repository. Deterministic; no model is called. */
export function scanRepo(root: string, catalogue: Catalogue): ScanResult {
  const index = catalogueIndex(catalogue);
  const usages: Usage[] = [];
  const files = listFiles(root).filter(file => isText(file) && !SKIP_FILES.test(file));
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
        if (value.length < 3 || value.length > 120 || /\s/.test(value)) continue;
        const model = index.find(value);
        const keyed = MODEL_KEY.test(raw.slice(Math.max(0, match.index! - 40), match.index!));
        if (model && (keyed || value.includes("/") || /\d/.test(value))) {
          literalModel = true;
          const env = ENV.exec(raw);
          const envVar = env?.slice(1).find(Boolean);
          add({ kind: "model", value: redact(value), dynamic: !!envVar, ...(envVar ? { envVar } : {}), catalogueId: model.id });
        } else if (keyed && /^[\w.:/@-]+$/.test(value) && /[a-z]/i.test(value) && /\d|gpt|claude|gemini|llama|mistral|qwen|deepseek/i.test(value) && !/^https?:/.test(value)) {
          literalModel = true;
          add({ kind: "model", value: redact(value), dynamic: false, catalogueId: null });
        }
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
  }
  const groups = new Map<string, ScanResult["models"][number]>();
  for (const usage of usages.filter(item => item.kind === "model" && !item.dynamic || item.kind === "model" && item.catalogueId)) {
    const key = usage.catalogueId ?? `?${usage.value}`;
    const group = groups.get(key) ?? { catalogueId: usage.catalogueId, value: usage.catalogueId ?? usage.value, usageIds: [] };
    group.usageIds.push(usage.id);
    groups.set(key, group);
  }
  return { files: scanned, usages, models: [...groups.values()].sort((a, b) => b.usageIds.length - a.usageIds.length || a.value.localeCompare(b.value)) };
}

/** A few lines around a usage, redacted, for the harness. */
export function context(root: string, usage: Pick<Usage, "file" | "line">, radius = 6): string {
  try {
    const lines = readFileSync(join(root, usage.file), "utf8").split("\n");
    const start = Math.max(0, usage.line - 1 - radius);
    return lines.slice(start, usage.line + radius).map((line, offset) => `${start + offset + 1}${start + offset + 1 === usage.line ? ">" : " "} ${redact(line).slice(0, 300)}`).join("\n");
  } catch { return ""; }
}
