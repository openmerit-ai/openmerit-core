// Scout Model Binary Search, from the ScoutBM prototype, over any ladder: options ordered weakest
// to strongest, such as catalogue models by ECI (`order`) or a vendor's named tiers.
// 1. Screens all run on the same few sampled items.
// 2. Binary search: an option "performs well" only when it passes every sampled item. Passing moves
//    to weaker options, failing moves to stronger ones. The search pick is the weakest option that
//    passed.
// 3. Screen the nearest neighbours on the same samples (weaker first at equal distance; once a
//    weaker one fails, only stronger ones) until there are `finalists` passing options.
// 4. Challengers: after the finals, a stronger option at the same or a lower list price than the
//    leading finalist could be the better buy, but the neighbour rule never reaches it; screen the
//    cheapest few. Options the ladder cannot place, such as a fine-tune without an ECI, are always
//    challengers. The caller runs finals and challengers on every item.
// A screen throws CandidateUnavailable when the option cannot run at all (the provider rejects it):
// it is skipped as untested and the search goes on. Any other throw stops the search.

export class CandidateUnavailable extends Error {
  override readonly name = "CandidateUnavailable";
}

const unavailable = (error: unknown): error is Error => error instanceof Error && error.name === "CandidateUnavailable";

export const SAMPLE_SIZE = 5;
export const FINALISTS = 5;
export const CHALLENGERS = 3;

/** One option on a ladder. `price` is a list price used only to choose challengers; null when unknown or not per token. */
export interface Rung { key: string; price: number | null }
/** A catalogue option placed by its Epoch Capabilities Index. */
export interface Ranked extends Rung { eci: number }
export type Stage = "search" | "neighbour" | "challenger";

export interface SearchResult<T extends Rung> {
  /** The weakest option that passed every sample during the binary search. */
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

/** Options other than the pick, nearest on the ladder first; at equal distance the weaker one comes first. */
export function outward<T extends Rung>(ladder: readonly T[], pick: T): T[] {
  const index = ladder.findIndex(item => item.key === pick.key);
  if (index < 0) throw new Error("The pick is not in the ranking");
  const out: T[] = [];
  for (let distance = 1; out.length < ladder.length - 1; distance++) {
    if (ladder[index - distance]) out.push(ladder[index - distance]!);
    if (ladder[index + distance]) out.push(ladder[index + distance]!);
  }
  return out;
}

/** Searches `ladder` in the order given, weakest first; sort catalogue models with `order` first. */
export async function binarySearch<T extends Rung>(ladder: readonly T[], screen: (candidate: T, stage: Stage) => Promise<boolean>, finalistCount = FINALISTS): Promise<SearchResult<T>> {
  const ordered = [...ladder];
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
      // Untested, not failed: drop it from the ladder and search the same range without it.
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

export interface ChallengerOptions<T extends Rung> {
  count?: number;
  /**
   * How strong an option is; only options stronger than the leader can be challengers, and the
   * strongest goes first at equal price. Defaults to the position on the ladder; pass the ECI for
   * catalogue models, so options with the leader's ECI do not count as stronger.
   */
  strength?: (option: T) => number;
  /** Options the ladder cannot place, such as fine-tunes without an ECI: every untried one is a challenger, after the placed ones. */
  unplaced?: readonly T[];
}

/** Untried options stronger than the leader and no dearer by list price, cheapest first, then every untried unplaced option. */
export function challengers<T extends Rung>(ladder: readonly T[], leader: T, tried: ReadonlySet<string>, options: ChallengerOptions<T> = {}): T[] {
  const position = new Map(ladder.map((item, index) => [item.key, index]));
  const strength = options.strength ?? ((item: T) => position.get(item.key)!);
  const unplaced = (options.unplaced ?? []).filter(item => !tried.has(item.key));
  if (leader.price === null) return unplaced;
  const placed = ladder.filter(item => strength(item) > strength(leader) && item.price !== null && item.price <= leader.price! && !tried.has(item.key))
    .sort((a, b) => a.price! - b.price! || strength(b) - strength(a)).slice(0, options.count ?? CHALLENGERS);
  return [...placed, ...unplaced];
}
