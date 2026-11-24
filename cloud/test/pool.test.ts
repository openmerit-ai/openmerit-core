// The candidate pool: OpenRouter offers the catalogue's ranked models, and only models a customer
// lists by name are measured as challengers without an ECI.
import assert from "node:assert/strict";
import { test } from "node:test";
import { plannedSteps } from "../src/actors/job.ts";
import { buildPool, type EndpointInfo } from "../../openmerit-core/src/job/pool.ts";
import type { TaskBundle } from "../../openmerit-core/src/ranking/index.ts";
import { bundle, catalogue } from "./helpers.ts";

const openrouter: EndpointInfo = { id: "openrouter", kind: "openrouter", baseUrl: "https://openrouter.test/v1", allowedModels: "all", funding: "openmerit" };
const unranked = catalogue.models.filter(model => model.eci === null);

test("OpenRouter's whole catalogue leaves models without an ECI out, and a model a customer lists is still a challenger", () => {
  assert.ok(unranked.length > 0, "the catalogue has models without an ECI");
  const only = buildPool({ catalogue, endpoints: [openrouter], bundle: bundle() as TaskBundle, guardrails: {} });
  assert.deepEqual(only.unplaced, []);
  assert.ok(only.ranked.length > 0);
  assert.ok(only.notices.some(notice => notice.startsWith(`${unranked.length} catalogue models without an ECI left out`)), only.notices.join("\n"));

  const fineTune: EndpointInfo = { id: "acme", kind: "openai-compatible", baseUrl: "https://acme.test/v1", allowedModels: ["acme/fine-tune-1"], funding: "customer" };
  const listedOnOpenRouter: EndpointInfo = { ...openrouter, allowedModels: [unranked[0]!.id] };
  const withCustomer = buildPool({ catalogue, endpoints: [openrouter, fineTune], bundle: bundle() as TaskBundle, guardrails: {} });
  assert.deepEqual(withCustomer.unplaced.map(item => [item.endpoint, item.model]), [["acme", "acme/fine-tune-1"]]);
  const listed = buildPool({ catalogue, endpoints: [listedOnOpenRouter], bundle: bundle() as TaskBundle, guardrails: {} });
  assert.deepEqual(listed.unplaced.map(item => item.model), [unranked[0]!.id]);
});

test("a job's planned steps: the current model's runs, about log₂ of the ladder in screens, the finalists' runs and the challengers", () => {
  // 100 ranked, 3 repeats: 3 baseline runs, 7 probes + 6 screens, 5 finalists × 3 runs, 3 challengers × (1 screen + 3 runs); the unplaced on top.
  assert.equal(plannedSteps(100, 0, 3), 3 + 13 + 15 + 12);
  assert.equal(plannedSteps(100, 2, 3), 43 + 2 * 4);
  assert.equal(plannedSteps(100, 0, 1), 1 + 13 + 5 + 3 * 2);
  assert.equal(plannedSteps(2, 0, 3), 3 + 2 + 2 * 3 + 2 * 4);
  assert.equal(plannedSteps(0, 1, 3), 3 + 4);
});
