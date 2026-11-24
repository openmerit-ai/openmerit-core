// The edit a job proposes: only the model ID string literal in a code ref changes, written as the
// pick's endpoint calls the model, and a ref without one gets an instruction instead.
import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogueIndex } from "../src/engine.ts";
import type { Option } from "../../openmerit-core/src/job/pool.ts";
import { proposeEdit } from "../../openmerit-core/src/job/report.ts";
import type { TaskBundle } from "../../openmerit-core/src/ranking/index.ts";
import { catalogue } from "./helpers.ts";

const { find } = catalogueIndex(catalogue);
const pick: Option = { key: "inclusionai/ling-3.0-flash", model: "inclusionai/ling-3.0-flash", endpoint: "openrouter", endpointModel: "inclusionai/ling-3.0-flash", eci: 148.16, price: 0.084, funding: "openmerit", inCatalogue: true };
const task = (spelling: string, current = "anthropic/claude-sonnet-5.5"): TaskBundle => ({
  task: "ticket classifier", current: { model: current }, prompt: { messages: [{ role: "user", content: "{{ticket}}" }] }, output: { kind: "label", labels: ["billing"] },
  codeRefs: [{ file: "src/classify.ts", line: 3, spelling }],
});

test("an edit replaces only the model ID literal, with the full ID on OpenRouter, and says when the literal is a fallback", () => {
  const fallback = proposeEdit(task('process.env.CLASSIFIER_MODEL ?? "gpt-4.1-mini"'), pick, "openrouter", find);
  assert.deepEqual(fallback.edits.map(edit => edit.after), ['process.env.CLASSIFIER_MODEL ?? "inclusionai/ling-3.0-flash"']);
  assert.match(fallback.instructions ?? "", /The code's literal is a fallback; production's model comes from elsewhere \(for example an environment variable\)\. Set it to `inclusionai\/ling-3\.0-flash`\./);

  const plain = proposeEdit(task('"anthropic/claude-sonnet-5.5"'), pick, "openrouter", find);
  assert.deepEqual(plain.edits.map(edit => [edit.before, edit.after]), [['"anthropic/claude-sonnet-5.5"', '"inclusionai/ling-3.0-flash"']]);
  assert.equal(plain.instructions, null);
  // A bare literal of the current model still gets the full ID, since OpenRouter needs it.
  assert.deepEqual(proposeEdit(task("model: 'claude-sonnet-5.5',"), pick, "openrouter", find).edits.map(edit => edit.after), ["model: 'inclusionai/ling-3.0-flash',"]);

  const none = proposeEdit(task("process.env.CLASSIFIER_MODEL"), pick, "openrouter", find);
  assert.deepEqual(none.edits, []);
  assert.match(none.instructions ?? "", /`src\/classify\.ts:3` \(`process\.env\.CLASSIFIER_MODEL`\) holds no model ID string, so it is not edited: set the model it gives ticket classifier to `inclusionai\/ling-3\.0-flash`/);

  // On the customer's own endpoint, the edit uses the name that endpoint calls the model by.
  const own: Option = { ...pick, key: "acme/fine-tune-1", model: "acme/fine-tune-1", endpoint: "acme", endpointModel: "fine-tune-1", eci: null, inCatalogue: false };
  const moved = proposeEdit(task('"claude-sonnet-5.5"'), own, "openrouter", find);
  assert.deepEqual(moved.edits.map(edit => edit.after), ['"fine-tune-1"']);
  assert.match(moved.instructions ?? "", /Call it on your endpoint acme instead of openrouter\./);
});
