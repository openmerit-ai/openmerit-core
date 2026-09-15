/** Reuse the audited invoice benchmark scorer for its pinned image/prompt cases. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TaskImage } from "./task-input.js";

interface InvoiceBenchmark {
  PROMPT: string;
  parse_json(text: string): Record<string, unknown>;
  score(expected: Record<string, unknown>, actual: Record<string, unknown> | null): {
    exact_leaf_accuracy: number; exact_document: boolean;
  };
}

interface VisibilityAudit {
  project_visible<T extends Record<string, unknown> | null | undefined>(document: T): T;
}

function root(): string { return join(dirname(fileURLToPath(import.meta.url)), ".."); }

function fileModule(path: string): Promise<unknown> {
  return import(pathToFileURL(path).href);
}

export async function knownInvoiceScore(
  task: string, images: TaskImage[], answer: string,
): Promise<{ score: number; why: string } | null> {
  if (images.length !== 1 || images[0].mimeType !== "image/jpeg") return null;
  const benchDir = join(root(), "benchmark", "invoice_ocr");
  const benchmark = await fileModule(join(benchDir, "benchmark.ts")) as InvoiceBenchmark;
  const piPrompt = readFileSync(join(root(), "examples", "invoice-prompt.txt"), "utf8").trim();
  if (task.trim() !== benchmark.PROMPT.trim() && task.trim() !== piPrompt) return null;
  const manifest = JSON.parse(readFileSync(join(benchDir, "data", "manifest.json"), "utf8")) as {
    rows: { invoice_id: string; image: string; ground_truth: string }[];
  };
  const inputHash = createHash("sha256").update(Buffer.from(images[0].data, "base64")).digest("hex");
  const row = manifest.rows.find((r) => createHash("sha256")
    .update(readFileSync(join(benchDir, "data", r.image))).digest("hex") === inputHash);
  if (!row) return null;
  const audit = await fileModule(join(benchDir, "audit_results.ts")) as VisibilityAudit;
  const expected = JSON.parse(readFileSync(join(benchDir, "data", row.ground_truth), "utf8")) as Record<string, unknown>;
  let actual: Record<string, unknown> | null = null;
  try { actual = benchmark.parse_json(answer); } catch { /* invalid JSON scores zero */ }
  const result = benchmark.score(audit.project_visible(expected), audit.project_visible(actual));
  return {
    score: result.exact_leaf_accuracy,
    why: `pinned ${row.invoice_id}: audited exact-leaf ${result.exact_leaf_accuracy.toFixed(3)}, ` +
      `exact document=${result.exact_document}`,
  };
}
