// A task's result: what the evaluation measured, which models qualify, the Top 3, the near misses
// and the pick, built from `evaluateTask`'s output by the same rules for the CLI and the cloud app.
// Hosts keep their own stored shapes: the CLI's run history names latency `meanLatencyMs`, and the
// cloud app's reports name cost `costPerCallUsd`, since one case there is one call. Those are field
// renames at the host's edge; every value is decided here.
import { type EvaluateResult, type Evaluated, type Rules, type Score, type Shortfall } from "./evaluate.ts";
import type { Rung, Stage } from "./search.ts";

/** One model's figures in a task's result. Passes and totals count every item run (items × repeats). */
export interface ModelResult extends Score {
  model: string;
  endpoint: string;
  /** The model as its endpoint names it. */
  endpointModel: string;
  role: "baseline" | "candidate";
  stage: "baseline" | Stage;
  eci: number | null;
  /** `unmeasured`: it passed its screen, but its full runs did not finish. */
  status: "measured" | "screened_out" | "unavailable" | "unmeasured";
  qualified: boolean;
  shortfall: Shortfall;
  /** Why it is unavailable, or why it did not qualify; empty when it qualified with a measured cost. */
  note: string;
}

export interface TaskResult {
  /** The evaluation's status (`evaluateTask`); `pick` says whether a switch is proposed. */
  status: EvaluateResult<Rung>["status"];
  baseline: ModelResult;
  /** Every candidate tried, in the order it was first tried. */
  candidates: ModelResult[];
  /** Up to three qualified models, cheapest per item first. */
  top: ModelResult[];
  /** The Top 3 that cost less per item than the current model. */
  cheaper: ModelResult[];
  /** The cheapest of `cheaper`: the switch to propose, or null to keep the current model. */
  pick: ModelResult | null;
  /** Measured models that missed the current model's score by at most one item per run. */
  nearMisses: ModelResult[];
  samples: string[];
  finalists: string[];
  challengers: string[];
  /** Why the search found no model that passed its screen, when it found none. */
  searchShortfall: string | null;
  /**
   * `criteria` once a person marked the current model's own answers wrong: models were measured against
   * the accepted Eval's checks, and `pick` is the cheapest model that meets them, even above the current
   * model's price. `current` otherwise.
   */
  bar: "current" | "criteria";
  /** With the criteria bar: the checks the current model misses, and the result in one plain sentence. */
  failedChecks?: string[];
  summary?: string;
}

/** The parts of an option a result shows. */
export interface Described { model: string; endpoint: string; endpointModel: string; eci: number | null }

/** Why a measured model did not qualify, in the report's words; empty when it qualified with a measured cost. */
export function qualificationNote(item: { shortfall: Shortfall; passes: number; total: number; costPerItemUsd: number | null; regressed?: readonly string[] }, baseline: { passes: number; total: number }, rules: Rules = {}): string {
  if (item.shortfall === "score") return `passed ${item.passes}/${item.total} vs the current model's ${baseline.passes}/${baseline.total}`;
  if (item.shortfall === "regressed") return `failed ${item.regressed?.length ? item.regressed.join(", ") : "a case"}, which the current model passed in every run`;
  if (item.shortfall === "criteria") return "misses your checks";
  if (item.shortfall === "threshold") return `below the eval's required pass rate ${rules.threshold}`;
  if (item.shortfall === "latency") return `slower than the ${rules.maxLatencyMs} ms latency limit`;
  if (item.shortfall === null && item.costPerItemUsd === null) return "qualifies; cost not measured";
  return "";
}

/** Whether a model costs less per item than the current one; null when either cost is unknown. */
export const cheaperThanCurrent = (item: { costPerItemUsd: number | null }, baseline: { costPerItemUsd: number | null } | null): boolean | null =>
  baseline?.costPerItemUsd == null || item.costPerItemUsd === null ? null : item.costPerItemUsd < baseline.costPerItemUsd;

/** One tried option's result. `baseline` is the current model's passes and total, for the note. */
export function modelResult<T>(item: Evaluated<T>, described: Described, baseline: { passes: number; total: number }, rules: Rules = {}): ModelResult {
  // evaluateTask qualified it against the same rules; the note only words it.
  const note = item.reason ?? (item.status === "measured" ? qualificationNote(item, baseline, rules) : "");
  return {
    ...described, passes: item.passes, total: item.total, score: item.score, costPerItemUsd: item.costPerItemUsd, costIsEstimate: item.costIsEstimate, latencyMs: item.latencyMs,
    role: "candidate", stage: item.stage, status: item.status, qualified: item.qualified, shortfall: item.shortfall, note,
  };
}

/** The current model's result from its runs' totals. */
export const baselineResult = (figures: Score, described: Described): ModelResult => ({ ...described, ...figures, role: "baseline", stage: "baseline", status: "measured", qualified: false, shortfall: null, note: "" });

/** The task's result from an evaluation. `describe` names an option as the host shows it; `current` is the current model. */
export function taskResult<T extends Rung>(evaluated: EvaluateResult<T>, describe: (option: T) => Described, current: Described, rules: Rules = {}): TaskResult {
  const { runs: _runs, ...figures } = evaluated.baseline;
  const results = new Map<Evaluated<T>, ModelResult>();
  const of = (item: Evaluated<T>): ModelResult => {
    let found = results.get(item);
    if (!found) results.set(item, found = modelResult(item, describe(item.option), evaluated.baseline, rules));
    return found;
  };
  const cheaper = evaluated.cheaper.map(of), top = evaluated.top.map(of);
  const failedChecks = evaluated.baseline.failedChecks;
  // Against the criteria, a current model that misses them is replaced by the cheapest model that meets them, whatever it costs.
  const pick = failedChecks?.length ? top[0] ?? null : cheaper[0] ?? null;
  return {
    status: evaluated.status, baseline: baselineResult(figures, current), candidates: evaluated.candidates.map(of), top, cheaper, pick, nearMisses: evaluated.nearMisses.map(of),
    samples: evaluated.samples, finalists: evaluated.search?.finalists.map(option => describe(option).model) ?? [], challengers: evaluated.challenged.map(option => describe(option).model),
    searchShortfall: evaluated.search?.shortfall ?? null,
    bar: failedChecks ? "criteria" : "current",
    ...(failedChecks ? { failedChecks, summary: criteriaSummary(failedChecks, figures, pick) } : {}),
  };
}

/** The criteria bar's result in one sentence, such as "Your current model fails 2 of your checks (C1, G2); the cheapest model that passes them is Y, at $0.40 more per 1,000 calls." */
export function criteriaSummary(failedChecks: readonly string[], baseline: { costPerItemUsd: number | null }, pick: Pick<ModelResult, "model" | "costPerItemUsd"> | null): string {
  if (!failedChecks.length) return pick ? `Your current model passes your checks; ${pick.model} passes them too, for less.` : "Your current model passes your checks, and no cheaper model OpenMerit tried does.";
  const fails = `Your current model fails ${failedChecks.length} of your checks (${failedChecks.join(", ")})`;
  if (!pick) return `${fails}, and no model OpenMerit tried passes them.`;
  const delta = pick.costPerItemUsd === null || baseline.costPerItemUsd === null ? null : (pick.costPerItemUsd - baseline.costPerItemUsd) * 1000;
  const price = delta === null ? "at a cost OpenMerit could not measure" : `at $${Math.abs(delta).toFixed(2)} ${delta >= 0 ? "more" : "less"} per 1,000 calls`;
  return `${fails}; the cheapest model that passes them is ${pick.model}, ${price}.`;
}
