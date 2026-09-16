/** Shadow trials: run candidate models against observed/declared tasks on the background track. */

import { directChatClient } from "./llm.js";
import { judge, parseObj } from "./judge.js";
import { paths, readJson, writeJson } from "./store.js";
import type { Policy } from "./policy.js";
import type { CatalogEntry, TrialPoint } from "./types.js";
import type { ModelRoute } from "./types.js";
import type { MeritChatClient } from "./providers.js";

interface Ledger {
  date: string;
  trials: number;
  usd: number;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function budgetOk(policy: Policy): { ok: boolean; reason?: string } {
  const ledger = readJson<Ledger>(paths.ledger(), { date: today(), trials: 0, usd: 0 });
  if (ledger.date !== today()) return { ok: true }; // new day resets
  if (ledger.trials >= policy.budgets.max_trials_per_day)
    return { ok: false, reason: `daily trial cap reached (${policy.budgets.max_trials_per_day})` };
  if (ledger.usd >= policy.budgets.max_usd_per_day)
    return { ok: false, reason: `daily budget exhausted ($${policy.budgets.max_usd_per_day})` };
  return { ok: true };
}

/** Conservative admission estimate for one candidate answer (rough input tokens + 4K output). */
export function trialBudgetOk(
  policy: Policy,
  entry: CatalogEntry,
  inputChars: number,
): { ok: boolean; estimatedUsd?: number; reason?: string } {
  if (entry.priceKnown === false) return { ok: false, reason: "route price is unknown" };
  const inputTokens = Math.ceil(inputChars / 4);
  const outputTokens = Math.min(entry.route?.maxTokens ?? 4096, 4096);
  const estimatedUsd = entry.pp * inputTokens + entry.pc * outputTokens;
  if (estimatedUsd > policy.budgets.max_usd_per_trial) return {
    ok: false,
    estimatedUsd,
    reason: `estimated trial cost $${estimatedUsd.toFixed(4)} exceeds $${policy.budgets.max_usd_per_trial.toFixed(4)} limit`,
  };
  return { ok: true, estimatedUsd };
}

export function recordTrialSpend(usd: number): void {
  let ledger = readJson<Ledger>(paths.ledger(), { date: today(), trials: 0, usd: 0 });
  if (ledger.date !== today()) ledger = { date: today(), trials: 0, usd: 0 };
  ledger.trials += 1;
  ledger.usd = Math.round((ledger.usd + usd) * 1e6) / 1e6;
  writeJson(paths.ledger(), ledger);
}

/** Record non-candidate merit-loop spend without consuming a trial slot. */
export function recordMeritSpend(usd: number): void {
  if (!(usd > 0)) return;
  let ledger = readJson<Ledger>(paths.ledger(), { date: today(), trials: 0, usd: 0 });
  if (ledger.date !== today()) ledger = { date: today(), trials: 0, usd: 0 };
  ledger.usd = Math.round((ledger.usd + usd) * 1e6) / 1e6;
  writeJson(paths.ledger(), ledger);
}

const RUBRIC_PROMPT = `Write a compact grading rubric for answers to the task below.
It must list the concrete criteria for a score of 1.0 and how to deduct.
TASK: {task}
Return ONLY json: {{"rubric": "<text>"}}`;

/** Derive (and cache) a grading rubric for a task that came from traces. */
export async function ensureRubric(
  key: string,
  judgeModel: string | ModelRoute,
  task: string,
  cache: Map<string, string>,
  client: MeritChatClient = directChatClient(key),
): Promise<string> {
  const hit = cache.get(task);
  if (hit) return hit;
  const { content } = await client.chat(
    judgeModel,
    RUBRIC_PROMPT.replace("{task}", task.slice(0, 8000)),
    1024,
    0,
  );
  let rubric = "Score 1.0 for a fully correct, complete, usable answer; deduct for errors, omissions, or unusable output.";
  try {
    const obj = parseObj(content);
    if (typeof obj.rubric === "string" && obj.rubric.trim()) rubric = obj.rubric;
  } catch {
    /* keep default */
  }
  cache.set(task, rubric);
  return rubric;
}

/** Run one shadow trial: generate with `model`, judge the output, return a frontier point + cost. */
export async function runTrial(
  key: string,
  judgeModel: string | ModelRoute,
  task: string,
  rubric: string,
  model: string,
  entry: CatalogEntry | undefined,
  client: MeritChatClient = directChatClient(key),
): Promise<{ point: TrialPoint; costUsd: number; error?: string }> {
  const started = Date.now();
  let gen: string;
  let usage: { prompt_tokens?: number; completion_tokens?: number } = {};
  try {
    const r = await client.chat(entry?.route ?? model, task, 4096, 0.2);
    gen = r.content;
    usage = r.usage;
  } catch (e) {
    return {
      point: {
        schemaVersion: 1, model, route: entry?.route, score: 0, price: entry?.price ?? 0,
        priceKnown: entry?.priceKnown ?? !!entry,
        ts: new Date().toISOString(), source: "shadow_trial", why: String(e).slice(0, 160),
      },
      costUsd: 0,
      error: String(e),
    };
  }
  const latencyMs = Date.now() - started;
  const costUsd =
    (entry?.pp ?? 0) * (usage.prompt_tokens ?? 0) + (entry?.pc ?? 0) * (usage.completion_tokens ?? 0);
  if (!gen.trim()) {
    return {
      point: {
        schemaVersion: 1, model, route: entry?.route, score: 0, price: entry?.price ?? 0,
        priceKnown: entry?.priceKnown ?? !!entry, latencyMs,
        ts: new Date().toISOString(), source: "shadow_trial", why: "empty response",
      },
      costUsd,
    };
  }
  let score = 0;
  let why = "judge error";
  try {
    const j = await judge(key, judgeModel, task, rubric, gen, client);
    score = j.score;
    why = j.why;
  } catch (e) {
    why = `judge error: ${String(e).slice(0, 120)}`;
  }
  return {
    point: {
      schemaVersion: 1,
      model,
      route: entry?.route,
      score,
      price: entry?.price ?? 0,
      priceKnown: entry?.priceKnown ?? !!entry,
      latencyMs,
      ts: new Date().toISOString(),
      source: "shadow_trial",
      why,
    },
    costUsd,
  };
}
