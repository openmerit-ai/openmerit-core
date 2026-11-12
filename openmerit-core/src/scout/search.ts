import { randomInt } from "node:crypto";
import type { Candidate } from "./candidates.ts";

/**
 * Scout Model Binary Search, from the ScoutBM prototype:
 * 1. Rank candidates by ECI, ascending, and draw `sampleSize` labelled items once.
 * 2. Binary search: a model "performs well" only when it passes every sampled item. Passing moves
 *    to weaker (cheaper-on-capability) models, failing moves to stronger ones. The search pick is
 *    the weakest model that passed.
 * 3. Screen the nearest neighbours on the same samples (weaker first at equal distance; once a
 *    weaker one fails, only stronger ones) until there are `finalists` passing models.
 * 4. Finals: every finalist runs every dataset item. The caller decides the winner from the
 *    recorded results (Langfuse), falling back to `orderFinals`.
 */

export interface EvalItem {
  id: string;
  input: unknown;
  expectedOutput: unknown;
  metadata?: Record<string, unknown> | null;
}

export interface Outcome {
  itemId: string;
  pass: boolean;
  /** What the candidate produced, recorded as the experiment item's output. */
  output?: unknown;
  /** Measured provider cost of this item, when known. */
  costUsd?: number | null;
  latencyMs?: number;
  usage?: { input: number; output: number; total: number } | null;
  /** Why the item passed or failed, in a sentence. */
  comment?: string;
  startMs?: number;
  endMs?: number;
  /** Which repeat of a final this was, from 1. Screens run once and leave it unset. */
  repeat?: number;
}

export type Stage = "search" | "neighbour" | "challenger" | "final";

/**
 * Thrown by an evaluator when this one candidate cannot run, such as a provider rejecting the model
 * (400/404) or the balance not covering its request (402). The candidate is skipped and listed as
 * untested; the search goes on without it. Any other throw stops the search.
 */
export class CandidateUnavailable extends Error {
  override readonly name = "CandidateUnavailable";
}

/** By name, so an evaluator module can throw its own `CandidateUnavailable` without importing OpenMerit. */
const unavailableError = (error: unknown): error is Error => error instanceof Error && error.name === "CandidateUnavailable";

/** Runs one item on one candidate. Throw on transport, auth, billing or harness failures: they never count as quality failures. */
export type Evaluate = (candidate: Candidate, item: EvalItem, context: { stage: Stage; signal?: AbortSignal }) => Promise<Omit<Outcome, "itemId">>;

export interface Trial {
  stage: Stage;
  candidate: Candidate;
  outcomes: Outcome[];
  passes: number;
  /** Screens: every sample passed. Finals: always true. */
  accepted: boolean;
  /** Runs of each item: 1 for screens, `repeats` for finals. `outcomes` holds items × runs. */
  runs: number;
}

export interface SearchOptions {
  dataset: readonly EvalItem[];
  /** Ascending by ECI, as `rankCandidates` returns them. */
  candidates: readonly Candidate[];
  evaluate: Evaluate;
  sampleSize?: number;
  finalists?: number;
  /** Items evaluated at once within one probe. Default 5. */
  concurrency?: number;
  /** Runs of every item per finalist, so a model that passes by chance does not tie a reliable one (default 3). */
  repeats?: number;
  /** Untested stronger models no dearer than the leading finalist to screen after the finals (default 3; 0 turns it off). */
  challengers?: number;
  /** Called after every probe, screen and final, for example to record it in Langfuse. A throw stops the search. */
  onTrial?: (trial: Trial) => Promise<void> | void;
  pickIndex?: (remaining: number) => number;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface SearchResult {
  status: "selected" | "no_passing_model" | "stopped";
  error?: string;
  criterion: string;
  sampleIds: string[];
  ordered: Candidate[];
  /** The weakest model that passed every sample during the binary search. */
  selected: Candidate | null;
  trials: Trial[];
  finals: Trial[];
  /** Candidates skipped because they could not run; untested, not failed. */
  unavailable: { model: string; stage: Stage; reason: string }[];
  shortfall?: string;
  finalRule: string;
  limitation: string;
}

export const SAMPLE_SIZE = 5;
export const FINALISTS = 5;

export async function scoutSearch(input: SearchOptions): Promise<SearchResult> {
  const sampleSize = input.sampleSize ?? SAMPLE_SIZE;
  const finalistCount = input.finalists ?? FINALISTS;
  if (input.dataset.length < sampleSize) throw new Error(`Scout needs an eval dataset with at least ${sampleSize} labelled items; it has ${input.dataset.length}`);
  if (new Set(input.dataset.map(item => item.id)).size !== input.dataset.length) throw new Error("Dataset item IDs must be unique");
  if (!input.candidates.length) throw new Error("No ECI-ranked candidate models are runnable with the connected providers");
  if (new Set(input.candidates.map(item => item.model)).size !== input.candidates.length) throw new Error("Candidate models must be unique");
  const ordered = [...input.candidates].sort((a, b) => a.eci - b.eci || a.model.localeCompare(b.model));
  const pool = [...input.dataset];
  const samples: EvalItem[] = [];
  const pick = input.pickIndex ?? randomInt;
  for (let count = 0; count < sampleSize; count++) {
    const index = pick(pool.length);
    if (!Number.isInteger(index) || index < 0 || index >= pool.length) throw new Error("Invalid random sample index");
    samples.push(pool.splice(index, 1)[0]!);
  }
  const repeats = input.repeats ?? 3;
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("repeats must be a positive integer");
  const log = input.log ?? (() => {});
  const trials: Trial[] = [];
  const finals: Trial[] = [];
  const unavailable: SearchResult["unavailable"] = [];
  let selected: Candidate | null = null;
  const result = (status: SearchResult["status"], error?: string): SearchResult => ({
    status, ...(error ? { error } : {}),
    criterion: `${sampleSize}/${sampleSize} sampled items pass`, sampleIds: samples.map(item => item.id), ordered, selected, trials, finals, unavailable,
    ...(status === "selected" && finals.length < finalistCount ? { shortfall: `Only ${finals.length} finalists: no further model passed the screen within the neighbour rule (once a weaker neighbour fails, only stronger models are tried)` } : {}),
    finalRule: `Finalists are the search pick and the nearest models by ECI that also pass the same ${sampleSize} samples (${finalistCount} in all; once a weaker neighbour fails, only stronger ones are tried), plus up to ${input.challengers ?? 3} untested challengers with a higher ECI and no higher list price than the leading finalist that pass the samples. Each runs every dataset item ${repeats} times; the winner has the most passes over all runs in Langfuse, then the lower measured cost per run, then the lower ECI.`,
    limitation: `Binary search assumes task quality rises with ECI; models it skips are untested. Screens run each sample once, so a model can be screened out by one unlucky run. ${repeats} runs per final item narrow chance differences but do not remove them, and the result is only as representative as the eval dataset.`,
  });

  const run = async (stage: Stage, candidate: Candidate, items: readonly EvalItem[]): Promise<Trial> => {
    const runs = stage === "final" ? repeats : 1;
    // Repeat-major order, so an interrupted final has whole repeats rather than one item run many times.
    const tasks = Array.from({ length: runs }, (_, r) => items.map(item => ({ item, repeat: r + 1 }))).flat();
    const outcomes: Outcome[] = new Array(tasks.length);
    let next = 0;
    const worker = async () => {
      while (next < tasks.length) {
        const index = next++;
        const { item, repeat } = tasks[index]!;
        const startMs = Date.now();
        const outcome = await input.evaluate(candidate, item, { stage, ...(input.signal ? { signal: input.signal } : {}) });
        if (typeof outcome?.pass !== "boolean") throw new Error("Evaluator must return { pass: boolean } or throw on infrastructure failure");
        outcomes[index] = { startMs, endMs: Date.now(), latencyMs: Date.now() - startMs, ...outcome, itemId: item.id, ...(runs > 1 ? { repeat } : {}) };
      }
    };
    await Promise.all(Array.from({ length: Math.min(input.concurrency ?? 5, tasks.length) }, worker));
    const passes = outcomes.filter(item => item.pass).length;
    const trial: Trial = { stage, candidate, outcomes, passes, runs, accepted: stage === "final" || passes === tasks.length };
    log(`${stage.padEnd(9)} ${candidate.model} (ECI ${candidate.eci.toFixed(1)}): ${passes}/${tasks.length}${runs > 1 ? ` over ${runs} runs of ${items.length} items` : ""}${stage === "final" ? "" : trial.accepted ? " pass" : " fail"}`);
    await input.onTrial?.(trial);
    return trial;
  };
  const failure = (stage: string, candidate: Candidate, error: unknown) =>
    result("stopped", `${stage} ${candidate.model}: ${error instanceof Error ? error.message : String(error)}`);
  const skip = (stage: Stage, candidate: Candidate, error: Error) => {
    unavailable.push({ model: candidate.model, stage, reason: error.message });
    log(`${"skipped".padEnd(9)} ${candidate.model}: ${error.message.slice(0, 200)}`);
  };

  let lower = 0, upper = ordered.length - 1;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = ordered[middle]!;
    try {
      const trial = await run("search", candidate, samples);
      trials.push(trial);
      if (trial.accepted) { selected = candidate; upper = middle - 1; } else lower = middle + 1;
    } catch (error) {
      if (!unavailableError(error)) return failure("search", candidate, error);
      // Untested, not failed: drop it from the ranking and search the same range without it.
      skip("search", candidate, error);
      ordered.splice(middle, 1);
      upper -= 1;
    }
  }
  if (!selected) return result("no_passing_model");

  const screened = new Map(trials.map(trial => [trial.candidate.model, trial.accepted]));
  const finalists = [selected];
  const pickAt = ordered.indexOf(selected);
  const skipped = new Set<string>();
  let lookBelow = true;
  for (const candidate of outward(ordered, selected)) {
    if (finalists.length === finalistCount) break;
    const below = ordered.indexOf(candidate) < pickAt;
    if (below && !lookBelow) continue;
    if (skipped.has(candidate.model)) continue;
    let accepted = screened.get(candidate.model);
    if (accepted === undefined) {
      try {
        const trial = await run("neighbour", candidate, samples);
        trials.push(trial);
        accepted = trial.accepted;
      } catch (error) {
        if (!unavailableError(error)) return failure("screen", candidate, error);
        skip("neighbour", candidate, error);
        skipped.add(candidate.model);
        continue;
      }
    }
    if (accepted) finalists.push(candidate);
    else if (below) lookBelow = false;
  }

  for (const candidate of finalists) {
    try {
      finals.push(await run("final", candidate, input.dataset));
    } catch (error) {
      if (!unavailableError(error)) return failure("final", candidate, error);
      skip("final", candidate, error);
    }
  }
  finals.sort(compareFinals);

  // Challengers: a stronger model at the same or a lower list price than the leader could be the
  // better buy, but the neighbour rule never reaches it. Screen the cheapest few on the same samples.
  const leader = finals[0]?.candidate;
  const tried = new Set([...trials.map(trial => trial.candidate.model), ...unavailable.map(item => item.model)]);
  const challengers = leader?.price == null ? [] : ordered
    .filter(item => item.eci > leader.eci && item.price !== null && item.price <= leader.price! && !tried.has(item.model))
    .sort((a, b) => a.price! - b.price! || b.eci - a.eci)
    .slice(0, input.challengers ?? 3);
  for (const candidate of challengers) {
    try {
      const trial = await run("challenger", candidate, samples);
      trials.push(trial);
      if (trial.accepted) finals.push(await run("final", candidate, input.dataset));
    } catch (error) {
      if (!unavailableError(error)) return failure("challenger", candidate, error);
      skip("challenger", candidate, error);
    }
  }
  finals.sort(compareFinals);
  return result("selected");
}

/** Models other than the pick, nearest by rank first; at equal distance the weaker one comes first. */
export function outward(ordered: readonly Candidate[], pick: Candidate): Candidate[] {
  const index = ordered.findIndex(item => item.model === pick.model);
  if (index < 0) throw new Error("The pick is not in the ranking");
  const out: Candidate[] = [];
  for (let distance = 1; out.length < ordered.length - 1; distance++) {
    if (ordered[index - distance]) out.push(ordered[index - distance]!);
    if (ordered[index + distance]) out.push(ordered[index + distance]!);
  }
  return out;
}

/** Mean measured cost per item, or null when any item's cost is unknown. */
export function meanCost(outcomes: readonly Pick<Outcome, "costUsd">[]): number | null {
  if (!outcomes.length || outcomes.some(item => typeof item.costUsd !== "number")) return null;
  return outcomes.reduce((sum, item) => sum + item.costUsd!, 0) / outcomes.length;
}

/** Most passes; then lower measured cost per item (list price only when a cost is unknown); then lower ECI. */
export function compareFinals(a: Trial, b: Trial): number {
  if (b.passes !== a.passes) return b.passes - a.passes;
  const ca = meanCost(a.outcomes), cb = meanCost(b.outcomes);
  if (ca !== null && cb !== null && ca !== cb) return ca - cb;
  if (ca === null || cb === null) {
    const pa = a.candidate.price ?? Infinity, pb = b.candidate.price ?? Infinity;
    if (pa !== pb) return pa - pb;
  }
  return a.candidate.eci - b.candidate.eci;
}
