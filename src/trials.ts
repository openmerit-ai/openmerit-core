/** Budget accounting and rubric generation for controlled comparisons. */

import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { parseObj } from "./judge.js";
import { paths, readJsonReport, writeJson } from "./store.js";
import type { Policy } from "./policy.js";
import type { ModelRoute } from "./types.js";
import type { MeritChatClient } from "./providers.js";
import { estimateRouteCost } from "./routes.js";

interface Ledger {
  date: string;
  trials: number;
  usd: number;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function budgetOk(policy: Policy): { ok: boolean; reason?: string } {
  const report = readJsonReport<Ledger>(paths.ledger(), { date: today(), trials: 0, usd: 0 });
  if (!report.valid) return { ok: false, reason: "trial ledger is malformed; run `openmerit doctor`" };
  const ledger = report.value;
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
  route: ModelRoute,
  inputBytes: number,
): { ok: boolean; estimatedUsd?: number; reason?: string } {
  const inputTokens = Math.ceil(inputBytes / 4);
  const outputTokens = Math.min(route.maxTokens ?? 4096, 4096);
  const estimate = estimateRouteCost(route, inputTokens, outputTokens);
  if (!estimate.known) return { ok: false, reason: "route price is unknown" };
  const estimatedUsd = estimate.usd;
  if (estimatedUsd > policy.budgets.max_usd_per_trial) return {
    ok: false,
    estimatedUsd,
    reason: `estimated trial cost $${estimatedUsd.toFixed(4)} exceeds $${policy.budgets.max_usd_per_trial.toFixed(4)} limit`,
  };
  return { ok: true, estimatedUsd };
}

function withLedgerLock<T>(fn: () => T): T {
  const lock = `${paths.ledger()}.lock`;
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  const started = Date.now();
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lock, "wx");
      writeFileSync(fd, token);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock);
      } catch { /* another process released it */ }
      if (Date.now() - started > 2_000) throw new Error("trial ledger is busy; refusing an unlocked update");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      if (existsSync(lock) && readFileSync(lock, "utf8") === token) unlinkSync(lock);
    } catch { /* a stale-lock recovery raced with cleanup */ }
  }
}

export function recordTrialSpend(usd: number): void {
  withLedgerLock(() => {
    const report = readJsonReport<Ledger>(paths.ledger(), { date: today(), trials: 0, usd: 0 });
    if (!report.valid) throw new Error("trial ledger is malformed; refusing to reset spend");
    let ledger = report.value;
    if (ledger.date !== today()) ledger = { date: today(), trials: 0, usd: 0 };
    ledger.trials += 1;
    ledger.usd = Math.round((ledger.usd + usd) * 1e6) / 1e6;
    writeJson(paths.ledger(), ledger);
  });
}

/** Record non-candidate merit-loop spend without consuming a trial slot. */
export function recordMeritSpend(usd: number): void {
  if (!(usd > 0)) return;
  withLedgerLock(() => {
    const report = readJsonReport<Ledger>(paths.ledger(), { date: today(), trials: 0, usd: 0 });
    if (!report.valid) throw new Error("trial ledger is malformed; refusing to reset spend");
    let ledger = report.value;
    if (ledger.date !== today()) ledger = { date: today(), trials: 0, usd: 0 };
    ledger.usd = Math.round((ledger.usd + usd) * 1e6) / 1e6;
    writeJson(paths.ledger(), ledger);
  });
}

const RUBRIC_PROMPT = `Write a compact grading rubric for answers to the task below.
It must list the concrete criteria for a score of 1.0 and how to deduct.
TASK: {task}
Return ONLY json: {{"rubric": "<text>"}}`;

/** Derive (and cache) a grading rubric for a task that came from traces. */
export async function ensureRubric(
  client: MeritChatClient,
  judgeModel: ModelRoute,
  task: string,
  cache: Map<string, string>,
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
