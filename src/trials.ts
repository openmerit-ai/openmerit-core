/** Shadow trials: run candidate models against observed/declared tasks on the background track. */

import { chat } from "./llm.js";
import { judge, parseObj } from "./judge.js";
import { paths, readJson, writeJson } from "./store.js";
import type { Policy } from "./policy.js";
import type { CatalogEntry, TrialPoint } from "./types.js";

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

export function recordTrialSpend(usd: number): void {
  let ledger = readJson<Ledger>(paths.ledger(), { date: today(), trials: 0, usd: 0 });
  if (ledger.date !== today()) ledger = { date: today(), trials: 0, usd: 0 };
  ledger.trials += 1;
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
  judgeModel: string,
  task: string,
  cache: Map<string, string>,
): Promise<string> {
  const hit = cache.get(task);
  if (hit) return hit;
  const { content } = await chat(
    key,
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
  judgeModel: string,
  task: string,
  rubric: string,
  model: string,
  entry: CatalogEntry | undefined,
): Promise<{ point: TrialPoint; costUsd: number; error?: string }> {
  const started = Date.now();
  let gen: string;
  let usage: { prompt_tokens?: number; completion_tokens?: number } = {};
  try {
    const r = await chat(key, model, task, 4096, 0.2);
    gen = r.content;
    usage = r.usage;
  } catch (e) {
    return {
      point: {
        model, score: 0, price: entry?.price ?? 0,
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
        model, score: 0, price: entry?.price ?? 0, latencyMs,
        ts: new Date().toISOString(), source: "shadow_trial", why: "empty response",
      },
      costUsd,
    };
  }
  let score = 0;
  let why = "judge error";
  try {
    const j = await judge(key, judgeModel, task, rubric, gen);
    score = j.score;
    why = j.why;
  } catch (e) {
    why = `judge error: ${String(e).slice(0, 120)}`;
  }
  return {
    point: {
      model,
      score,
      price: entry?.price ?? 0,
      latencyMs,
      ts: new Date().toISOString(),
      source: "shadow_trial",
      why,
    },
    costUsd,
  };
}
