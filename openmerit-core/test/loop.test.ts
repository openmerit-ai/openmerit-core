// The grading loop (eval/loop.ts): revision changes only the disputed cases, one dispute is tolerated, and graded answers are not asked again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advanceLoop, answerKey, disputedCases, pickSamples, reviseEval, startLoop, type RunArtifact, type SampleGrade } from "../src/eval/loop.ts";
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

test("one disputed case is tolerated and left out, unless it is the current model's answer or another case is disputed too, kept grades included", () => {
  const sample = (role: "current" | "trial", caseId: string, pass: boolean) => ({ id: `${role}:${caseId}`, caseId, kind: "typical", model: role === "current" ? "m/current" : "m/cheap", role, input: "", output: "", toolCalls: [], pass, failedChecks: [] });
  const graded = (samples: ReturnType<typeof sample>[], kept: { caseId: string; current: boolean }[] = []) => {
    const tried = advanceLoop(startLoop(1, "current", true), { type: "tried", artifact: { samples } });
    // The person grades every answer right: an answer the eval failed is a disagreement.
    return advanceLoop(tried, { type: "graded", grades: samples.map(item => ({ sampleId: item.id, verdict: "good" })), kept });
  };
  const one = graded([sample("current", "w1", true), sample("trial", "w2", false)]);
  assert.deepEqual([one.status, one.disputed], ["accepted", ["w2"]]);
  assert.equal(graded([sample("current", "w1", false), sample("trial", "w2", true)]).status, "regenerating", "never on the current model's own answer");
  assert.equal(graded([sample("trial", "w2", false), sample("trial", "w3", false)]).status, "regenerating");
  assert.equal(graded([sample("trial", "w2", false)], [{ caseId: "w4", current: false }]).status, "regenerating", "a kept grade's dispute counts");
  assert.deepEqual(graded([], [{ caseId: "w4", current: false }]).disputed, ["w4"]);
  assert.deepEqual(graded([sample("trial", "w2", true)]).disputed, []);
});

test("answers are the same for the kept grades when their JSON is, whatever the key order and spacing; text must match exactly", () => {
  const key = (output: string) => answerKey({ output, toolCalls: [] });
  assert.equal(key('{"b": 1, "a": {"y": [1, 2], "x": null}}'), key('{"a":{"x":null,"y":[1,2]},"b":1}'));
  assert.notEqual(key('{"a":[1,2]}'), key('{"a":[2,1]}'));
  assert.notEqual(key("billing"), key("billing "));
  assert.notEqual(answerKey({ output: "", toolCalls: [{ name: "f", arguments: '{"a":1}' }] }), answerKey({ output: "", toolCalls: [{ name: "f", arguments: '{"a":2}' }] }));
});

test("sampling skips graded answers and asks about rewritten cases first", () => {
  const answer = (caseId: string, pass: boolean) => ({ caseId, kind: "typical", input: { q: caseId }, output: caseId, toolCalls: [], pass, failedChecks: [] });
  const answers = ["w1", "w2", "w3", "w4", "w5"].map((id, index) => answer(id, index % 2 === 0));
  const picked = pickSamples([{ model: "m", role: "trial", answers }], 2, { skip: item => item.caseId === "w1", first: item => item.caseId === "w5" });
  assert.equal(picked.length, 2);
  assert.equal(picked[0]!.caseId, "w5");
  assert.ok(!picked.some(item => item.caseId === "w1"));
});
