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
}

/** The parts of an option a result shows. */
export interface Described { model: string; endpoint: string; endpointModel: string; eci: number | null }

/** Why a measured model did not qualify, in the report's words; empty when it qualified with a measured cost. */
export function qualificationNote(item: { shortfall: Shortfall; passes: number; total: number; costPerItemUsd: number | null }, baseline: { passes: number; total: number }, rules: Rules = {}): string {
  if (item.shortfall === "score") return `passed ${item.passes}/${item.total} vs the current model's ${baseline.passes}/${baseline.total}`;
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
  const cheaper = evaluated.cheaper.map(of);
  return {
    status: evaluated.status, baseline: baselineResult(figures, current), candidates: evaluated.candidates.map(of), top: evaluated.top.map(of), cheaper, pick: cheaper[0] ?? null, nearMisses: evaluated.nearMisses.map(of),
    samples: evaluated.samples, finalists: evaluated.search?.finalists.map(option => describe(option).model) ?? [], challengers: evaluated.challenged.map(option => describe(option).model),
    searchShortfall: evaluated.search?.shortfall ?? null,
  };
}
