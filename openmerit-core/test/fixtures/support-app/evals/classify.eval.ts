// The classifier's eval: one pass/fail per labelled ticket.
// - OPENMERIT_ITEMS (comma-separated ticket IDs) limits the run to those tickets; empty runs all.
// - Writes {"items": [{"id", "pass"}]} to $OPENMERIT_RESULT when set, and prints the accuracy.
// - When CLASSIFY_LANGFUSE_DATASET is set, records the run as a Langfuse experiment
//   named $OPENMERIT_EXPERIMENT with a boolean "correct" score per item, using the app's own
//   LANGFUSE_* keys. The dataset's item IDs are the ticket IDs.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { classify } from "../src/classify.ts";

const wanted = new Set((process.env.OPENMERIT_ITEMS ?? "").split(",").map(id => id.trim()).filter(Boolean));
const items = readFileSync(new URL("../data/tickets.jsonl", import.meta.url), "utf8").trim().split("\n")
  .map(line => JSON.parse(line) as { id: string; ticket: string; queue: string })
  .filter(item => !wanted.size || wanted.has(item.id));

const results: { id: string; pass: boolean; queue: string }[] = [];
for (const item of items) {
  const queue = await classify(item.ticket);
  results.push({ id: item.id, pass: queue === item.queue, queue });
  if (queue !== item.queue) process.stderr.write(`miss ${item.id}: expected ${item.queue}, got ${queue}\n`);
}

const dataset = process.env.CLASSIFY_LANGFUSE_DATASET;
if (dataset) {
  // Langfuse v4 experiments: one OTLP root span per item with langfuse.experiment.* attributes, then a
  // boolean "correct" score on that span. This is what the Langfuse SDKs' experiment runners send.
  const base = (process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com").replace(/\/+$/, "");
  const headers = { authorization: `Basic ${Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY ?? ""}:${process.env.LANGFUSE_SECRET_KEY ?? ""}`).toString("base64")}`, "content-type": "application/json" };
  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { ...headers, ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok || response.status === 207) throw new Error(`Langfuse ${method} ${path} HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return response.json() as Promise<Record<string, unknown>>;
  };
  const datasetId = String((await call("GET", `/api/public/v2/datasets/${encodeURIComponent(dataset)}`)).id);
  const experiment = process.env.OPENMERIT_EXPERIMENT || `classify-${new Date().toISOString()}`;
  const text = (key: string, value: string) => ({ key, value: { stringValue: value } });
  const nanos = String(BigInt(Date.now()) * 1_000_000n);
  const hex = (bytes: number) => randomBytes(bytes).toString("hex");
  const spans = [], scores = [];
  for (const result of results) {
    const traceId = hex(16), spanId = hex(8);
    const ticket = items.find(item => item.id === result.id)!;
    spans.push({ traceId, spanId, name: "ticket-classifier-eval", kind: 1, startTimeUnixNano: nanos, endTimeUnixNano: nanos, status: { code: 1 }, attributes: [
      text("langfuse.trace.name", "ticket-classifier-eval"), text("langfuse.observation.type", "span"),
      text("langfuse.observation.input", ticket.ticket), text("langfuse.observation.output", result.queue),
      text("langfuse.trace.metadata.model", process.env.CLASSIFIER_MODEL ?? ""),
      text("langfuse.experiment.id", experiment), text("langfuse.experiment.name", experiment), text("langfuse.experiment.dataset.id", datasetId),
      text("langfuse.experiment.item.id", result.id), text("langfuse.experiment.item.root_observation_id", spanId),
    ] });
    scores.push({ id: hex(16), traceId, observationId: spanId, name: "correct", value: result.pass ? 1 : 0, dataType: "BOOLEAN" });
  }
  await call("POST", "/api/public/otel/v1/traces", { resourceSpans: [{ resource: { attributes: [text("service.name", "support-app-eval")] }, scopeSpans: [{ scope: { name: "support-app-eval" }, spans }] }] }, { "x-langfuse-ingestion-version": "4" });
  await call("POST", "/api/public/scores", scores);
}

const report = { items: results.map(({ id, pass }) => ({ id, pass })) };
if (process.env.OPENMERIT_RESULT) writeFileSync(process.env.OPENMERIT_RESULT, JSON.stringify(report));
const correct = results.filter(item => item.pass).length;
process.stdout.write(`accuracy ${correct}/${results.length}\n`);
