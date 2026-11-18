// Runs one eval unit: the task's existing eval command for one model and item set, routed through
// the metering proxy. The eval contract (README "Eval contract"):
// - OpenMerit sets OPENMERIT_MODEL (the model as the endpoint names it), OPENMERIT_BASE_URL and
//   OPENMERIT_API_KEY (the proxy), the same values as OPENAI_BASE_URL and OPENAI_API_KEY,
//   OPENMERIT_ITEMS (comma-separated dataset item IDs; empty for every item), OPENMERIT_EXPERIMENT
//   (the experiment name to record under) and OPENMERIT_RESULT (a file path). `{{model}}`,
//   `{{items}}` and `{{experiment}}` in the command or in `env` values become the same values.
// - Per-item results come from the Langfuse experiment the eval records (read back by the caller),
//   or from {"items": [{"id", "pass"}]} written to $OPENMERIT_RESULT or printed as stdout's last JSON line.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { redact } from "../engine/redact.ts";

export interface EvalCommand {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface EvalOutcome {
  ok: boolean;
  exitCode: number;
  durationMs: number;
  /** Per-item results the eval reported itself, or null when it reported none. */
  items: { id: string; pass: boolean }[] | null;
  /** Last lines of output, redacted, kept only when the eval failed. */
  log?: string;
  error?: string;
}

function lastJson(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.trim().split("\n").reverse()) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try { const value: unknown = JSON.parse(text); if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>; } catch { /* keep looking */ }
  }
  return null;
}

function reportedItems(result: Record<string, unknown> | null): EvalOutcome["items"] {
  if (!result || !Array.isArray(result.items)) return null;
  const items = result.items.flatMap(raw => {
    const item = raw as { id?: unknown; pass?: unknown; passed?: unknown };
    const pass = typeof item.pass === "boolean" ? item.pass : item.passed;
    return (typeof item.id === "string" || typeof item.id === "number") && typeof pass === "boolean" ? [{ id: String(item.id), pass }] : [];
  });
  return items.length ? items : null;
}

export async function runEval(spec: EvalCommand, input: { root: string; model: string; baseUrl: string; token: string; items: readonly string[] | null; experiment: string; env?: Record<string, string | undefined>; signal?: AbortSignal }): Promise<EvalOutcome> {
  const dir = mkdtempSync(join(tmpdir(), "openmerit-eval-"));
  const resultPath = join(dir, "result.json");
  const items = (input.items ?? []).join(",");
  const fill = (text: string) => text.replaceAll("{{model}}", input.model).replaceAll("{{items}}", items).replaceAll("{{experiment}}", input.experiment);
  const base = input.env ?? process.env;
  // Model calls go through the proxy with its one-unit token, never with the endpoint's own key.
  // Other credentials (the app's Langfuse keys, for example) stay, so the eval records as it always does.
  const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(base).filter(([key]) => !/^(OPENAI|OPENROUTER)_API_KEY$/.test(key)));
  Object.assign(env, {
    OPENMERIT_MODEL: input.model, OPENMERIT_BASE_URL: input.baseUrl, OPENMERIT_API_KEY: input.token, OPENMERIT_RESULT: resultPath,
    OPENMERIT_ITEMS: items, OPENMERIT_EXPERIMENT: input.experiment, OPENAI_BASE_URL: input.baseUrl, OPENAI_API_KEY: input.token,
  }, Object.fromEntries(Object.entries(spec.env ?? {}).map(([key, value]) => [key, fill(value)])));
  const started = Date.now();
  try {
    const { code, stdout, stderr } = await new Promise<{ code: number; stdout: string; stderr: string }>((done, fail) => {
      const child = spawn("sh", ["-c", fill(spec.command)], { cwd: resolve(input.root, spec.cwd ?? "."), env, stdio: ["ignore", "pipe", "pipe"], ...(input.signal ? { signal: input.signal } : {}) });
      let out = "", err = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), spec.timeoutMs ?? 1_800_000);
      child.stdout.on("data", chunk => { out += chunk; if (out.length > 2_000_000) out = out.slice(-1_000_000); });
      child.stderr.on("data", chunk => { err += chunk; if (err.length > 200_000) err = err.slice(-100_000); });
      child.on("error", fail);
      child.on("close", status => { clearTimeout(timer); done({ code: status ?? 1, stdout: out, stderr: err }); });
    });
    let result: Record<string, unknown> | null = null;
    try { result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>; } catch { result = lastJson(stdout); }
    const outcome = { exitCode: code, durationMs: Date.now() - started, items: reportedItems(result) };
    if (code !== 0) return { ok: false, ...outcome, log: redact(`${stderr}\n${stdout}`.trim().split("\n").slice(-12).join("\n")).slice(-2000), error: `eval exited with ${code}` };
    return { ok: true, ...outcome };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
