// The candidate pool: OpenRouter offers the catalogue's ranked models, and only models a customer
// lists by name are measured as challengers without an ECI.
import assert from "node:assert/strict";
import { test } from "node:test";
import { plannedSteps } from "../../src/server/actors/job.ts";
import { buildPool, catalogueChanges, couldBeat, type EndpointInfo } from "../../src/job/pool.ts";
import type { Catalogue, CatalogueModel } from "../../src/engine/index.ts";
import type { TaskBundle } from "../../src/ranking/index.ts";
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

test("a catalogue refresh re-runs a watched task only for a new or cheaper model as capable as its current one and cheaper than its pick", () => {
  // The current model, openai/gpt-5.4: ECI 157.85 at $17.50 per million tokens (input plus output).
  const current = catalogue.models.find(model => model.id === "openai/gpt-5.4")!;
  const model = (id: string, eci: number | null, inputPerM: number, outputPerM: number): CatalogueModel => ({ ...current, id, aliases: [], name: id, eci, inputPerM, outputPerM });
  const pick = model("test/pick", 160, 1, 4);
  const before: Catalogue = { ...catalogue, version: "2026-11-27", models: [...catalogue.models, pick, model("test/dearer", 170, 6, 6), model("test/unrated", null, 0.1, 0.1)] };
  const after: Catalogue = {
    ...before, version: "2026-11-28",
    models: [
      ...before.models.map(item => item.id === "test/dearer" ? { ...item, inputPerM: 1, outputPerM: 1 } // cheaper, and now under the pick
        : item.id === "test/unrated" ? { ...item, eci: 150 } // newly rated, but less capable than the current model
          : item.id === "test/pick" ? { ...item, inputPerM: 0.5 } // the pick itself got cheaper
            : item.id === current.id ? { ...item, inputPerM: 3 } : item), // a price rise
      model("test/new-strong", 158, 0.2, 0.8), // new, as capable, cheaper than the pick
      model("test/new-weak", 120, 0.01, 0.01), // new and cheapest, but less capable
      model("test/new-mid", 170, 3, 3), // new and capable, but dearer than the pick
    ],
  };
  const changed = catalogueChanges(before, after);
  assert.deepEqual(changed.filter(id => id.startsWith("test/") || id === current.id).sort(), ["test/dearer", "test/new-mid", "test/new-strong", "test/new-weak", "test/pick", "test/unrated"], "a price rise is no change");
  assert.deepEqual(catalogueChanges(before, { ...before, version: "2026-11-28" }), [], "a new day with the same models is no change");

  const beat = (input: Partial<Parameters<typeof couldBeat>[0]>) => couldBeat({ catalogue: after, endpoints: [openrouter], bundle: bundle() as TaskBundle, guardrails: {}, wide: false, pick: "test/pick", changed, ...input }).sort();
  assert.deepEqual(beat({}), ["test/dearer", "test/new-strong"]);
  // Without a pick, the current model is the one to beat: any capable model under its price that is new or cheaper counts.
  assert.deepEqual(beat({ pick: null }), ["test/dearer", "test/new-mid", "test/new-strong", "test/pick"]);
  // The task's guardrails narrow it as a job's pool does.
  assert.deepEqual(beat({ guardrails: { allowedModels: ["test/new-strong"] } }), ["test/new-strong"]);
  assert.deepEqual(beat({ changed: [] }), []);
});
