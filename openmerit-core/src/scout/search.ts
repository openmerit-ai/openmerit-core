// Scout Model Binary Search, from the ScoutBM prototype:
// 1. Rank candidates by ECI, ascending. Screens all run on the same few sampled items.
// 2. Binary search: a model "performs well" only when it passes every sampled item. Passing moves
//    to weaker (cheaper-on-capability) models, failing moves to stronger ones. The search pick is
//    the weakest model that passed.
// 3. Screen the nearest neighbours on the same samples (weaker first at equal distance; once a
//    weaker one fails, only stronger ones) until there are `finalists` passing models.
// 4. Challengers: after the finals, a stronger model at the same or a lower list price than the
//    leading finalist could be the better buy, but the neighbour rule never reaches it; screen the
//    cheapest few. The caller runs finals and challengers on every item.
// A screen throws CandidateUnavailable when the model cannot run at all (the provider rejects it):
// it is skipped as untested and the search goes on. Any other throw stops the search.

export class CandidateUnavailable extends Error {
  override readonly name = "CandidateUnavailable";
}

const unavailable = (error: unknown): error is Error => error instanceof Error && error.name === "CandidateUnavailable";

export const SAMPLE_SIZE = 5;
export const FINALISTS = 5;
export const CHALLENGERS = 3;

export interface Ranked { key: string; eci: number; price: number | null }
export type Stage = "search" | "neighbour" | "challenger";

export interface SearchResult<T extends Ranked> {
  /** The weakest model that passed every sample during the binary search. */
  selected: T | null;
  /** The pick and its passing neighbours, nearest first. */
  finalists: T[];
  trials: { stage: Stage; candidate: T; accepted: boolean }[];
  /** Skipped because they could not run: untested, not failed. */
  unavailable: { candidate: T; stage: Stage; reason: string }[];
  shortfall?: string;
}

/** Ascending ECI; equal scores fall back to the key purely for repeatability. */
export const order = <T extends Ranked>(candidates: readonly T[]): T[] => [...candidates].sort((a, b) => a.eci - b.eci || a.key.localeCompare(b.key));

/** Models other than the pick, nearest by rank first; at equal distance the weaker one comes first. */
export function outward<T extends Ranked>(ordered: readonly T[], pick: T): T[] {
  const index = ordered.findIndex(item => item.key === pick.key);
  if (index < 0) throw new Error("The pick is not in the ranking");
  const out: T[] = [];
  for (let distance = 1; out.length < ordered.length - 1; distance++) {
    if (ordered[index - distance]) out.push(ordered[index - distance]!);
    if (ordered[index + distance]) out.push(ordered[index + distance]!);
  }
  return out;
}

export async function binarySearch<T extends Ranked>(candidates: readonly T[], screen: (candidate: T, stage: Stage) => Promise<boolean>, finalistCount = FINALISTS): Promise<SearchResult<T>> {
  const ordered = order(candidates);
  const trials: SearchResult<T>["trials"] = [];
  const skipped: SearchResult<T>["unavailable"] = [];
  let selected: T | null = null;

  let lower = 0, upper = ordered.length - 1;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = ordered[middle]!;
    try {
      const accepted = await screen(candidate, "search");
      trials.push({ stage: "search", candidate, accepted });
      if (accepted) { selected = candidate; upper = middle - 1; } else lower = middle + 1;
    } catch (error) {
      if (!unavailable(error)) throw error;
      // Untested, not failed: drop it from the ranking and search the same range without it.
      skipped.push({ candidate, stage: "search", reason: error.message });
      ordered.splice(middle, 1);
      upper -= 1;
    }
  }
  if (!selected) return { selected: null, finalists: [], trials, unavailable: skipped };

  const screened = new Map(trials.map(trial => [trial.candidate.key, trial.accepted]));
  const finalists = [selected];
  const pickAt = ordered.indexOf(selected);
  let lookBelow = true;
  for (const candidate of outward(ordered, selected)) {
    if (finalists.length === finalistCount) break;
    const below = ordered.indexOf(candidate) < pickAt;
    if (below && !lookBelow) continue;
    let accepted = screened.get(candidate.key);
    if (accepted === undefined) {
      try {
        accepted = await screen(candidate, "neighbour");
        trials.push({ stage: "neighbour", candidate, accepted });
      } catch (error) {
        if (!unavailable(error)) throw error;
        skipped.push({ candidate, stage: "neighbour", reason: error.message });
        continue;
      }
    }
    if (accepted) finalists.push(candidate);
    else if (below) lookBelow = false;
  }
  return {
    selected, finalists, trials, unavailable: skipped,
    ...(finalists.length < finalistCount ? { shortfall: `Only ${finalists.length} finalists: no further model passed the screen within the neighbour rule (once a weaker neighbour fails, only stronger models are tried).` } : {}),
  };
}

/** Untested models stronger than the leader and no dearer by list price, cheapest first. */
export function challengers<T extends Ranked>(ordered: readonly T[], leader: T, tried: ReadonlySet<string>, count = CHALLENGERS): T[] {
  if (leader.price === null) return [];
  return ordered.filter(item => item.eci > leader.eci && item.price !== null && item.price <= leader.price! && !tried.has(item.key))
    .sort((a, b) => a.price! - b.price! || b.eci - a.eci).slice(0, count);
}
