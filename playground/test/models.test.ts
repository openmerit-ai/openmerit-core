import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_ROLES, effectiveModels, overridesLabel, parseModelFlag } from "../src/models.ts";

const haiku = { provider: "openrouter", id: "anthropic/claude-haiku-5.5" } as const;

test("--model with one model overrides every agent", () => {
  const overrides = parseModelFlag("openrouter/anthropic/claude-haiku-5.5");
  assert.deepEqual(Object.keys(overrides).sort(), [...AGENT_ROLES].sort());
  for (const role of AGENT_ROLES) assert.deepEqual(overrides[role], haiku);
  assert.equal(overridesLabel(overrides), "claude-haiku-5.5");
});

test("--model with assignments overrides only the named agents", () => {
  const overrides = parseModelFlag("intake=openrouter/anthropic/claude-haiku-5.5, coding=openrouter/anthropic/claude-haiku-5.5");
  assert.deepEqual(overrides, { intake: haiku, coding: haiku });
  assert.equal(overridesLabel(overrides), "intake+coding=claude-haiku-5.5");
  const models = effectiveModels(overrides);
  assert.equal(models.intake, "openrouter/anthropic/claude-haiku-5.5");
  assert.equal(models.fraud, "openrouter/anthropic/claude-sonnet-5.5");
});

test("--model without a value keeps every recorded choice", () => {
  assert.deepEqual(parseModelFlag(undefined), {});
  assert.equal(overridesLabel({}), "recorded");
});

test("--model rejects unknown agents, repeated agents and malformed models", () => {
  assert.throws(() => parseModelFlag("billing=openrouter/x"), /Unknown agent "billing"/);
  assert.throws(() => parseModelFlag("intake=openrouter/x,intake=openrouter/y"), /named twice/);
  assert.throws(() => parseModelFlag("intake=anthropic/claude-haiku-5.5"), /openrouter\/<id>/);
  assert.throws(() => parseModelFlag("openrouter"), /openrouter\/<id>/);
  assert.throws(() => parseModelFlag("intake="), /<agent>=<provider>\/<id>/);
});
