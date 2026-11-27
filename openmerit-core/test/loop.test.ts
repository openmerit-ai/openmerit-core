// The grading loop's eval revision (eval/loop.ts): a round's grades change only the cases they dispute.
import assert from "node:assert/strict";
import { test } from "node:test";
import { disputedCases, reviseEval, type RunArtifact, type SampleGrade } from "../src/eval/loop.ts";
import type { Harness } from "../src/harness/harness.ts";
import type { Case, TaskBundle } from "../src/ranking/index.ts";

test("revising the eval from one disputed case keeps every other case word for word, and gives the new one a new ID", async () => {
  const bundle: TaskBundle = {
    task: "ticket classifier", current: { model: "openai/gpt-5.4" }, output: { kind: "label", labels: ["billing", "technical"] },
    prompt: { messages: [{ role: "user", content: "Which queue? {{ticket}}" }] }, criteria: ["The queue fits the ticket."],
  };
  const cases: Case[] = [
    { id: "example-1", input: { ticket: "Refund my invoice" }, expected: "billing", origin: "example" },
    ...Array.from({ length: 18 }, (_, index): Case => ({ id: `written-${index + 1}`, input: { ticket: `Ticket number ${index + 1}` }, expected: index % 2 ? "billing" : "technical", origin: "written", kind: "typical", approved: true })),
  ];
  const writes: string[] = [];
  const harness: Harness = {
    kind: "api", label: "fake", usage: { calls: 0, costUsd: 0, unknownCost: 0, inputTokens: 0, outputTokens: 0 },
    async json<T>(request: { system: string; prompt: string }): Promise<T> {
      if (request.system.includes("revising")) return { criteria: ["The queue is the one the ticket's main problem belongs to."], guardrails: [] } as T;
      writes.push(request.prompt);
      // The writer also offers a case that repeats a kept one, which must not come back as new.
      return { cases: [
        { kind: "edge", input: [{ name: "ticket", value: "Ticket number 2" }], expected: "billing", toolResults: [] },
        { kind: "edge", input: [{ name: "ticket", value: "My card was charged twice and the app crashed" }], expected: "billing", toolResults: [] },
      ] } as T;
    },
  };
  // The person disputed only written-7: the eval passed an answer they marked bad.
  const artifact: RunArtifact = { round: 1, evalVersion: 1, samples: [
    { id: "current:written-7", caseId: "written-7", kind: "typical", model: "openai/gpt-5.4", role: "current", input: "", output: "technical", toolCalls: [], pass: true, failedChecks: [] },
    { id: "current:written-3", caseId: "written-3", kind: "typical", model: "openai/gpt-5.4", role: "current", input: "", output: "technical", toolCalls: [], pass: true, failedChecks: [] },
  ] };
  const grades: SampleGrade[] = [{ sampleId: "current:written-7", verdict: "bad", note: "it is billing" }, { sampleId: "current:written-3", verdict: "good" }];
  const disputed = disputedCases(artifact, grades);
  assert.deepEqual(disputed, ["written-7"]);

  const revised = await reviseEval({ bundle, cases }, "feedback", harness, undefined, disputed);
  assert.equal(writes.length, 1);
  assert.match(writes[0]!, /Write 1 cases?/, "only one case is written, in place of the disputed one");
  const kept = cases.filter(item => item.id !== "written-7");
  assert.deepEqual(revised.cases.slice(0, kept.length), kept, "the other 18 cases are unchanged, IDs and all");
  const added = revised.cases.slice(kept.length);
  assert.equal(added.length, 1);
  assert.equal(added[0]!.input.ticket, "My card was charged twice and the app crashed");
  assert.ok(!cases.some(item => item.id === added[0]!.id), `a new ID, not ${added[0]!.id}`);
  assert.deepEqual(revised.bundle.criteria, ["The queue is the one the ticket's main problem belongs to."]);
});
