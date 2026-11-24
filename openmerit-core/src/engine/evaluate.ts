// Scout's task evaluation: the one policy the local CLI and the cloud app both run, so a task gets the
// same verdict from either. The caller supplies `measure`, its only side effect, and `sample`, so a
// replay draws the same samples; everything else is decided here.
// 1. The current model runs every item `repeats` times. When it passes less than `floor` of its own
//    eval (80% by default), the eval cannot tell models apart, and nothing is screened or recommended. Once fewer than `sampleSize` items have passed
//    in every run so far, it stops early: another run cannot add any, and the search cannot screen.
// 2. `sample` picks the screening items from those it passed in every run, and as many again for a
//    retry: an option that misses exactly one sampled item is screened once more on the retry items,
//    since one miss in five is as likely chance as weakness. The caller should draw the same items for
//    the same eval (`stableSample`), so runs of one eval search the same way.
// 3. Scout Model Binary Search over the ladder (`binarySearch`), then the finalists run every item
//    `repeats` times. The leader is the finalist with the best score, then the lowest measured cost.
// 4. Challengers (`challengers`), capped at the leader's list price, or at the current model's when no
//    qualified finalist costs less per item than it does. Each is screened first, and one that passes
//    runs every item `repeats` times. Then a provisional pick, such as the model the task's last run
//    picked, gets the same treatment when no qualified model is cheaper than the current one yet, or
//    when its list price is under the cheapest qualified model's: a caller that showed it never keeps
//    the current model, or recommends a dearer model, without measuring it.
// 5. A model qualifies when it scores at least what the current model scores, meets the threshold and
//    is within the latency limit. The Top 3 are the qualified ones, cheapest per item first.
import { binarySearch, challengers, CHALLENGERS, FINALISTS, SAMPLE_SIZE, type Rung, type SearchResult, type Stage } from "./search.ts";

export const DEFAULT_REPEATS = 3;
export const TOP = 3;
/** The least share of its own eval the current model must pass for the eval to rank other models. */
export const EVAL_FLOOR = 0.8;

/** Passes over item runs for one kind of item, such as typical, edge or guardrail cases. */
export interface KindRate { kind: string; passes: number; total: number }

/**
 * One measured run: pass or fail per item, and what the candidate's calls cost (null when unknown).
 * `checks` names the spec's checks (C…, G…, S…) each failed item failed, when its grader named them.
 */
export interface Measurement { items: Readonly<Record<string, boolean>>; costUsd: number | null; costIsEstimate?: boolean; latencyMs?: number | null; checks?: Readonly<Record<string, readonly string[]>> }

/** The share of cases a model must pass each criterion on, unless the task sets `criteriaPassRate`. */
export const CRITERIA_PASS_RATE = 0.9;

/** A task's criteria (C…) and the checks every case must pass: its guardrails (G…) and step checks (S…). */
export interface Criteria { criteria: readonly string[]; guardrails: readonly string[]; passRate?: number }

/**
 * Whether runs meet the task's criteria: every guardrail and step check passes on every item run, and
 * each criterion on at least `passRate` of them. A failed item run whose grader named no check, such
 * as a wrong label or a failed call, counts against every criterion. `failed` lists the checks missed.
 */
export function meetsCriteria(runs: readonly Measurement[], spec: Criteria): { meets: boolean; failed: string[] } {
  const rate = spec.passRate ?? CRITERIA_PASS_RATE;
  let total = 0;
  const misses = new Map<string, number>();
  for (const run of runs) for (const [item, pass] of Object.entries(run.items)) {
    total++;
    if (pass) continue;
    const named = run.checks?.[item]?.length ? run.checks[item]! : spec.criteria;
    for (const check of new Set(named)) misses.set(check, (misses.get(check) ?? 0) + 1);
  }
  const failed = [
    ...spec.guardrails.filter(check => misses.has(check)),
    ...spec.criteria.filter(check => total && (total - (misses.get(check) ?? 0)) / total < rate - 1e-9),
  ];
  return { meets: total > 0 && !failed.length, failed };
}

/** What a measure call runs: the current model, a screen on the samples, or a full run of every item. */
export interface MeasureCall {
  role: "baseline" | "screen" | "final";
  /** How the option was reached; `baseline` for the current model. */
  stage: Stage | "baseline";
  /** 1-based; a screen is 1, and 2 for its retry on the retry items. */
  repeat: number;
  /** The provisional pick's screen and runs. */
  provisional?: true;
}

/**
 * Thrown by `measure` while it measures a challenger or the provisional pick, such as when the budget
 * refuses it: the challengers end there, and the result still ranks what was measured.
 */
export class EndChallengers extends Error {
  override readonly name = "EndChallengers";
}

// By name, as search.ts does, since a caller may load its own copy of the engine.
const unavailable = (error: unknown): error is Error => error instanceof Error && error.name === "CandidateUnavailable";
const ends = (error: unknown): error is Error => error instanceof Error && error.name === "EndChallengers";

/** Totals over some runs. `score` is passes over total item runs; `costPerItemUsd` is null when any run's cost is unknown. */
export interface Score { passes: number; total: number; score: number | null; costPerItemUsd: number | null; costIsEstimate: boolean; latencyMs: number | null }

/** Why a measured model did not qualify, or null when it did. `criteria`: it missed the task's criteria. */
export type Shortfall = "unmeasured" | "score" | "criteria" | "threshold" | "latency" | null;

export interface Rules {
  /** The lowest pass rate (0 to 1) that qualifies, such as an eval's own threshold. */
  threshold?: number | null;
  maxLatencyMs?: number | null;
}

/** An option the evaluation tried. Its score is the full runs' once measured, else its screen's. */
export interface Evaluated<T> extends Score {
  option: T;
  stage: Stage;
  provisional: boolean;
  /** `unmeasured`: it passed its screen, but its full runs did not finish (measure returned null). */
  status: "measured" | "screened_out" | "unavailable" | "unmeasured";
  screen: Measurement | null;
  runs: Measurement[];
  reason: string | null;
  qualified: boolean;
  shortfall: Shortfall;
}

/** What an evaluation has measured so far; pass one in to read it when `measure` throws part-way. */
export interface Progress<T> { baseline: Measurement[]; tried: Map<string, Evaluated<T>> }
export const newProgress = <T>(): Progress<T> => ({ baseline: [], tried: new Map() });

export interface EvaluateInput<T extends Rung> {
  /** The candidates, weakest first. */
  ladder: readonly T[];
  /** Options the ladder cannot place, such as fine-tunes without an ECI: always challengers. */
  unplaced?: readonly T[];
  /** How strong an option is, such as its ECI: challengers must be stronger than the leader. */
  strength: (option: T) => number;
  /** Every item, or null when the current model's first run says which there are. */
  items: readonly string[] | null;
  repeats: number;
  rules?: Rules;
  /** The current model's list price, the challengers' ceiling when no finalist is cheaper in use. */
  baselinePrice: number | null;
  provisional?: T | null;
  sampleSize?: number;
  /** The floor (default EVAL_FLOOR); null when the eval is the customer's own, whose threshold decides. */
  floor?: number | null;
  /** Each item's kind, for the current model's pass rate per kind. */
  kinds?: Readonly<Record<string, string>>;
  /**
   * The bar once a person has marked the current model's own answers wrong: a model qualifies when it
   * meets these criteria, not the current model's score, and the current model is one candidate among
   * the others. No floor applies, screens sample every item, and challengers have no price ceiling, so
   * the cheapest model that meets them is found even when it costs more than the current one. The
   * caller's ladder must not be limited to models cheaper than the current one.
   */
  criteria?: Criteria | null;
  /**
   * Runs `option` (null: the current model) on `items` (null: the items the caller's eval runs). Throws
   * CandidateUnavailable when the option cannot run, and EndChallengers to end the challengers. Returns
   * null when a full run will not be measured, which leaves the option unmeasured; any other throw stops
   * the evaluation.
   */
  measure: (option: T | null, items: readonly string[] | null, call: MeasureCall) => Promise<Measurement | null>;
  /** Picks up to `count` screening items from `reliable`, the same ones on a replay: the screen's items, then the retry's. */
  sample: (reliable: readonly string[], count: number) => readonly string[] | Promise<readonly string[]>;
  progress?: Progress<T>;
  /** Called as the evaluation goes, such as to show the search path while it runs. */
  on?: {
    trial?: (trial: { stage: Stage; option: T; measurement: Measurement; accepted: boolean }) => void;
    skipped?: (skipped: { option: T; stage: Stage | "final"; reason: string }) => void;
    searched?: (search: SearchResult<T>) => void;
    /** The challengers about to be tried, before any of them is screened. */
    challengers?: (options: readonly T[]) => void;
    /** A challenger that passed its screen, before its full runs. */
    challenger?: (option: T) => void;
  };
}

export interface EvaluateResult<T extends Rung> {
  /**
   * `too_few_reliable`: the current model passed fewer than `sampleSize` items in every run, so nothing was screened.
   * `below_floor`: it passed less than the floor of its own eval, so the eval cannot tell models apart.
   */
  status: "ranked" | "no_qualified" | "no_passing_model" | "too_few_reliable" | "below_floor";
  /** With `criteria`, `failedChecks` lists the checks the current model misses. */
  baseline: Score & { runs: Measurement[]; byKind: KindRate[]; failedChecks?: string[] };
  items: string[];
  reliable: string[];
  samples: string[];
  search: SearchResult<T> | null;
  /** Every option tried, in the order it was first tried. */
  candidates: Evaluated<T>[];
  /** Up to TOP qualified models, cheapest per item first. */
  top: Evaluated<T>[];
  /** The Top 3 that cost less per item than the current model. */
  cheaper: Evaluated<T>[];
  /** Measured models that missed the current model's score by at most one item. */
  nearMisses: Evaluated<T>[];
  /** The challengers chosen, and those that passed their screen. */
  challenged: T[];
  challengers: T[];
  provisionalTried: boolean;
  /** Set when `measure` threw EndChallengers: what was left untried. */
  ended: { reason: string; left: T[]; provisional: boolean } | null;
}

/** Passes per kind of item over some runs, in the order kinds first appear; items without a kind are left out. */
export function byKind(runs: readonly Measurement[], kinds: Readonly<Record<string, string>> = {}): KindRate[] {
  const rates = new Map<string, KindRate>();
  for (const run of runs) for (const [item, pass] of Object.entries(run.items)) {
    const kind = kinds[item];
    if (!kind) continue;
    const rate = rates.get(kind) ?? { kind, passes: 0, total: 0 };
    rate.total++; if (pass) rate.passes++;
    rates.set(kind, rate);
  }
  return [...rates.values()];
}

/** The floor's verdict in words, for a result that recommends nothing. */
export function floorNote(baseline: { passes: number; total: number; byKind: readonly KindRate[] }, current: string, floor = EVAL_FLOOR): string {
  const kinds = baseline.byKind.length > 1 ? ` (${baseline.byKind.map(rate => `${rate.kind} ${rate.passes}/${rate.total}`).join(", ")})` : "";
  return `${current} passed ${baseline.passes} of ${baseline.total} case runs of its own eval${kinds}, under the ${Math.round(floor * 100)}% OpenMerit needs before the eval can tell models apart, so no model is recommended. Read why its cases failed: the expected answers or the checks may be wrong.`;
}

/** A screen and its retry as one measurement: every item either ran, and what both cost. */
function merge(runs: readonly Measurement[]): Measurement {
  if (runs.length === 1) return runs[0]!;
  const latencies = runs.flatMap(run => (run.latencyMs === undefined || run.latencyMs === null ? [] : [run.latencyMs]));
  return {
    items: Object.assign({}, ...runs.map(run => run.items)), checks: Object.assign({}, ...runs.map(run => run.checks ?? {})),
    costUsd: runs.some(run => run.costUsd === null) ? null : runs.reduce((sum, run) => sum + run.costUsd!, 0),
    costIsEstimate: runs.some(run => run.costIsEstimate === true), latencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
  };
}

/**
 * Up to `count` items of `pool`, the same ones for the same items, whatever the pool's order: each
 * item's place is a hash of `keyOf(item)`, such as its content, so an eval screens on the same cases in
 * every run until its cases change, and an item leaving the pool moves no other item.
 */
export function stableSample(pool: readonly string[], count: number, keyOf: (item: string) => string = item => item): string[] {
  const place = (text: string) => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
    return hash;
  };
  const placed = pool.map(item => ({ item, at: place(keyOf(item)) }));
  return placed.sort((a, b) => a.at - b.at || (a.item < b.item ? -1 : a.item > b.item ? 1 : 0)).slice(0, count).map(entry => entry.item);
}

export function score(runs: readonly Measurement[]): Score {
  let passes = 0, total = 0, cost: number | null = 0;
  const latencies: number[] = [];
  for (const run of runs) {
    for (const pass of Object.values(run.items)) { total++; if (pass) passes++; }
    cost = cost === null || run.costUsd === null ? null : cost + run.costUsd;
    if (run.latencyMs !== undefined && run.latencyMs !== null) latencies.push(run.latencyMs);
  }
  return {
    passes, total, score: total ? passes / total : null, costPerItemUsd: total && cost !== null ? cost / total : null,
    costIsEstimate: runs.some(run => run.costIsEstimate === true), latencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
  };
}

/** Why a model does not qualify against the current model's score, or against `criteria` when given; null when it qualifies. */
export function shortfall(item: { measured: boolean; score: number | null; latencyMs: number | null; runs?: readonly Measurement[] }, baselineScore: number, rules: Rules = {}, criteria: Criteria | null = null): Shortfall {
  if (!item.measured || item.score === null) return "unmeasured";
  if (criteria ? !meetsCriteria(item.runs ?? [], criteria).meets : item.score < baselineScore) return criteria ? "criteria" : "score";
  if (rules.threshold !== undefined && rules.threshold !== null && item.score < rules.threshold) return "threshold";
  if (rules.maxLatencyMs !== undefined && rules.maxLatencyMs !== null && item.latencyMs !== null && item.latencyMs > rules.maxLatencyMs) return "latency";
  return null;
}

/** The TOP qualified models: cheapest per item first (unknown cost last), then the higher score, then the weaker. */
export function rankTop<M extends { costPerItemUsd: number | null; score: number | null }>(qualified: readonly M[], strength: (item: M) => number): M[] {
  return [...qualified].sort((a, b) => (a.costPerItemUsd ?? Infinity) - (b.costPerItemUsd ?? Infinity) || b.score! - a.score! || strength(a) - strength(b)).slice(0, TOP);
}

export async function evaluateTask<T extends Rung>(input: EvaluateInput<T>): Promise<EvaluateResult<T>> {
  const { measure, strength, on = {} } = input;
  const repeats = Math.max(1, input.repeats);
  const sampleSize = input.sampleSize ?? SAMPLE_SIZE;
  const rules = input.rules ?? {};
  const progress = input.progress ?? newProgress<T>();
  const { tried } = progress;

  // 1. The current model, with the early stop.
  const reliableOf = () => Object.keys(progress.baseline[0]!.items).filter(item => progress.baseline.every(run => run.items[item] === true));
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const run = await measure(null, repeat === 1 ? input.items : input.items ?? Object.keys(progress.baseline[0]!.items), { role: "baseline", stage: "baseline", repeat });
    if (!run) throw new Error("The current model's run returned no measurement.");
    progress.baseline.push(run);
    if (reliableOf().length < sampleSize) break;
  }
  const items = input.items ? [...input.items] : Object.keys(progress.baseline[0]!.items);
  const reliable = reliableOf();
  const criteria = input.criteria ?? null;
  const baseline = { ...score(progress.baseline), runs: progress.baseline, byKind: byKind(progress.baseline, input.kinds), ...(criteria ? { failedChecks: meetsCriteria(progress.baseline, criteria).failed } : {}) };
  const result = (status: EvaluateResult<T>["status"], rest: Partial<EvaluateResult<T>> = {}): EvaluateResult<T> => ({
    status, baseline, items, reliable, samples: [], search: null, candidates: [...tried.values()], top: [], cheaper: [], nearMisses: [], challenged: [], challengers: [], provisionalTried: false, ended: null, ...rest,
  });
  const floor = criteria ? null : input.floor === undefined ? EVAL_FLOOR : input.floor;
  if (floor !== null && baseline.score !== null && baseline.score < floor - 1e-9) return result("below_floor");
  // Against the criteria, a screen may use items the current model fails: it is not the bar.
  const pool = criteria ? items : reliable;
  if (pool.length < sampleSize) return result("too_few_reliable");

  // 2. The samples, and the retry's items when the pool has as many again.
  const drawn = [...await input.sample(pool, Math.min(pool.length, 2 * sampleSize))];
  const samples = drawn.slice(0, sampleSize);
  const retry = drawn.length >= 2 * sampleSize ? drawn.slice(sampleSize, 2 * sampleSize) : [];
  const entry = (option: T, stage: Stage, provisional: boolean): Evaluated<T> => {
    let found = tried.get(option.key);
    if (!found) {
      found = { option, stage, provisional, status: "unmeasured", screen: null, runs: [], reason: null, qualified: false, shortfall: "unmeasured", ...score([]) };
      tried.set(option.key, found);
    }
    return found;
  };
  const screen = async (option: T, stage: Stage, provisional = false): Promise<boolean> => {
    const tracked = entry(option, stage, provisional);
    const flag = provisional ? { provisional: true as const } : {};
    // Against the criteria a screen passes when the samples meet them, as the full runs must.
    const passes = (run: Measurement, items: readonly string[]) => criteria ? meetsCriteria([run], criteria).meets : items.every(item => run.items[item] === true);
    const runs: Measurement[] = [];
    let accepted: boolean;
    try {
      const first = await measure(option, samples, { role: "screen", stage, repeat: 1, ...flag });
      if (!first) throw new Error(`The screen of ${option.key} returned no measurement.`);
      runs.push(first);
      accepted = passes(first, samples);
      // One miss, and not of a guardrail or step check, which every case must pass: screen once more on the retry items.
      const missed = samples.filter(item => first.items[item] !== true);
      const broke = criteria ? meetsCriteria([first], criteria).failed.some(check => criteria.guardrails.includes(check)) : false;
      if (!accepted && retry.length && missed.length === 1 && !broke) {
        const second = await measure(option, retry, { role: "screen", stage, repeat: 2, ...flag });
        if (!second) throw new Error(`The screen of ${option.key} returned no measurement.`);
        runs.push(second);
        accepted = passes(second, retry);
      }
    } catch (error) {
      if (unavailable(error)) {
        Object.assign(tracked, { status: "unavailable", reason: error.message });
        on.skipped?.({ option, stage, reason: error.message });
      }
      throw error;
    }
    const measurement = merge(runs);
    Object.assign(tracked, { screen: measurement, status: accepted ? "unmeasured" : "screened_out", ...score(runs) });
    on.trial?.({ stage, option, measurement, accepted });
    return accepted;
  };
  const full = async (option: T, stage: Stage, provisional = false): Promise<void> => {
    const tracked = entry(option, stage, provisional);
    for (let repeat = 1; repeat <= repeats; repeat++) {
      let run: Measurement | null;
      try {
        run = await measure(option, items, { role: "final", stage, repeat, ...(provisional ? { provisional: true as const } : {}) });
      } catch (error) {
        if (!unavailable(error)) throw error;
        Object.assign(tracked, { status: "unavailable", reason: error.message });
        on.skipped?.({ option, stage: "final", reason: error.message });
        return;
      }
      if (!run) return;
      tracked.runs.push(run);
    }
    Object.assign(tracked, { status: "measured", ...score(tracked.runs) });
  };

  // 3. The search and the finalists.
  const search = await binarySearch(input.ladder, (option, stage) => screen(option, stage), FINALISTS);
  on.searched?.(search);
  // With no model passing the search, only unplaced options and the provisional pick are left to try.
  for (const finalist of search.finalists) await full(finalist, tried.get(finalist.key)?.stage ?? "search");

  const baselineScore = baseline.score!;
  const qualifies = (item: Evaluated<T>) => shortfall({ measured: item.status === "measured", score: item.score, latencyMs: item.latencyMs, runs: item.runs }, baselineScore, rules, criteria) === null;
  const cheaperThanBaseline = (item: Evaluated<T>) => item.costPerItemUsd !== null && (baseline.costPerItemUsd === null || item.costPerItemUsd < baseline.costPerItemUsd);
  const finals = search.finalists.map(option => tried.get(option.key)!).filter(item => item.status === "measured");
  const leader = [...finals].sort((a, b) => b.score! - a.score! || (a.costPerItemUsd ?? Infinity) - (b.costPerItemUsd ?? Infinity) || strength(a.option) - strength(b.option))[0]?.option ?? null;

  // 4. The challengers, then the provisional pick.
  const finalCheaper = baseline.costPerItemUsd === null || finals.some(item => qualifies(item) && item.costPerItemUsd !== null && item.costPerItemUsd < baseline.costPerItemUsd!);
  const ceiling = finalCheaper || criteria || input.baselinePrice === null ? {} : { maxPrice: input.baselinePrice };
  const unplaced = input.unplaced ?? [];
  const keys = new Set(tried.keys());
  const challenged = leader ? challengers(input.ladder, leader, keys, { count: CHALLENGERS, strength, unplaced, ...ceiling }) : unplaced.filter(item => !keys.has(item.key));
  on.challengers?.(challenged);
  const passed: T[] = [];
  let ended: EvaluateResult<T>["ended"] = null;
  const challenge = async (option: T, provisional: boolean): Promise<void> => {
    try {
      if (await screen(option, "challenger", provisional)) { if (!provisional) { passed.push(option); on.challenger?.(option); } await full(option, "challenger", provisional); }
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
  };
  for (const [index, option] of challenged.entries()) {
    try { await challenge(option, false); } catch (error) {
      if (!ends(error)) throw error;
      ended = { reason: error.message, left: challenged.slice(index), provisional: false };
      break;
    }
  }
  const rank = () => {
    const candidates = [...tried.values()];
    for (const item of candidates) {
      item.shortfall = shortfall({ measured: item.status === "measured", score: item.score, latencyMs: item.latencyMs, runs: item.runs }, baselineScore, rules, criteria);
      item.qualified = item.shortfall === null;
    }
    const top = rankTop(candidates.filter(item => item.qualified), item => strength(item.option));
    return { candidates, top, cheaper: top.filter(cheaperThanBaseline) };
  };
  let ranked = rank();
  const provisional = input.provisional ?? null;
  let provisionalTried = false;
  const underCheapest = provisional?.price != null && ranked.top[0]?.option.price != null && provisional.price < ranked.top[0].option.price;
  if (provisional && !ended && (!ranked.cheaper.length || underCheapest) && !tried.has(provisional.key)) {
    provisionalTried = true;
    try { await challenge(provisional, true); } catch (error) {
      if (!ends(error)) throw error;
      ended = { reason: error.message, left: [provisional], provisional: true };
    }
    ranked = rank();
  }

  // 5. Qualification and the Top 3.
  const nearMisses = ranked.candidates.filter(item => item.shortfall === "score" && item.score !== null && (baselineScore - item.score) * items.length <= 1 + 1e-9);
  return result(ranked.top.length ? "ranked" : search.selected ? "no_qualified" : "no_passing_model", {
    samples, search, candidates: ranked.candidates, top: ranked.top, cheaper: ranked.cheaper, nearMisses, challenged, challengers: passed, provisionalTried, ended,
  });
}
