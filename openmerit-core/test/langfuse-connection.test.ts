// The cloud's Langfuse connection against a fake Langfuse API: how it groups generations into
// tasks, which recorded calls it replays for a managed prompt's version, and the change it proposes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { listTasks, proposeChange, readCases } from "../src/connectors/langfuse/connection.ts";

const connection = { baseUrl: "https://langfuse.test", publicKey: "pk-lf-1", secretKey: "sk-lf-1" };

/** A recorded call of prompt "summarize" at one version, with a leaked key in its request. */
const generation = (i: number, version: number) => ({
  id: `obs_${version}_${i}`, traceId: `trace_${version}_${i}`, type: "GENERATION", name: "summarize-call", startTime: new Date(Date.now() - (i + 1) * 60_000).toISOString(), level: "DEFAULT",
  promptName: "summarize", promptVersion: version, providedModelName: "openai/gpt-5.4",
  input: JSON.stringify([{ role: "user", content: `Summarize note ${i} (v${version}). token: "sk-proj-AbCdEfGh12345678"` }]), output: `Summary ${i}`,
});

function fakeLangfuse() {
  const paths: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const { pathname } = new URL(String(url));
    paths.push(`${init?.method ?? "GET"} ${pathname}`);
    const body = pathname === "/api/public/projects" ? { data: [{ id: "proj_1", name: "notes" }] }
      : pathname === "/api/public/v2/metrics" ? { data: [
        { traceName: "notes", name: "summarize-call", promptName: "summarize", promptVersion: 3, providedModelName: "openai/gpt-5.4", count_count: 30, sum_totalCost: 3 },
        { traceName: "notes", name: "summarize-call", promptName: "summarize", promptVersion: 2, providedModelName: "openai/gpt-5.4", count_count: 50, sum_totalCost: 2 },
        { traceName: "notes", name: "summarize-call", promptName: "summarize", promptVersion: 3, providedModelName: "openai/gpt-5-mini", count_count: 40, sum_totalCost: 0.5 },
      ] }
      : pathname === "/api/public/experiment-items" ? { data: [], meta: {} }
      : pathname === "/api/public/v2/observations" ? { data: [0, 1, 2, 3].flatMap(i => [generation(i, 2), generation(i, 3)]), meta: {} }
      : null;
    return new Response(JSON.stringify(body ?? { message: "no route" }), { status: body ? 200 : 404 });
  };
  return { fetcher, paths };
}

test("a managed prompt's versions are separate tasks, each replays only its own recorded calls, redacted, and the change names the prompt's config", async () => {
  const fake = fakeLangfuse();
  const listing = await listTasks(connection, { fetch: fake.fetcher });
  // Version 3 has more spend; its current model is the one with the most calls, whatever each model cost.
  assert.deepEqual(listing.tasks.map(task => [task.name, task.model, task.generations, task.costUsd]), [["prompt summarize v3", "openai/gpt-5-mini", 70, 3.5], ["prompt summarize v2", "openai/gpt-5.4", 50, 2]]);

  const v2 = listing.tasks[1]!;
  const read = await readCases(connection, v2, { fetch: fake.fetcher, count: 10 });
  assert.equal(read.dataset, null);
  assert.equal(read.replayed, 4);
  assert.ok(read.cases.every(item => item.origin === "trace" && item.input.messages!.includes("(v2)")), "only version 2's calls");
  assert.ok(read.cases.every(item => !item.input.messages!.includes("sk-proj-AbCdEfGh12345678")), "the recorded requests are redacted");
  assert.deepEqual((read.cases[0]!.expected as { role: string }).role, "assistant");

  const change = proposeChange(v2, { model: "openai/gpt-5-mini" }, { baseUrl: connection.baseUrl, projectId: "proj_1" });
  assert.equal(change.text, "Set prompt summarize to `openai/gpt-5-mini`");
  assert.match(change.instructions!, /^In Langfuse, set the model in the config of prompt "summarize" \(version 2\) to openai\/gpt-5-mini/);
  assert.equal(change.link, "https://langfuse.test/project/proj_1/prompts/summarize");
  assert.ok(fake.paths.every(path => path.startsWith("GET ")), "listing and reading send GET requests only");
});
