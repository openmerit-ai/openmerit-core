// The classifier's eval: one pass/fail per labelled ticket.
// - OPENMERIT_ITEMS (comma-separated ticket IDs) limits the run to those tickets; empty runs all.
// - Writes {"items": [{"id", "pass"}]} to $OPENMERIT_RESULT when set, and prints the accuracy.
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

const report = { items: results.map(({ id, pass }) => ({ id, pass })) };
if (process.env.OPENMERIT_RESULT) writeFileSync(process.env.OPENMERIT_RESULT, JSON.stringify(report));
const correct = results.filter(item => item.pass).length;
process.stdout.write(`accuracy ${correct}/${results.length}\n`);
