// The provisional pick: what OpenMerit names before it has measured anything, from catalogue
// evidence alone. The measured result replaces it.

export interface Provisional { model: string; endpoint: string; reason: string; estCostPerCallUsd: number | null }

interface Placed { model: string; endpoint: string; eci: number | null; price: number | null }

/**
 * The cheapest ladder option the catalogue rates at least as capable as the current model; else the
 * current model. `costPerCall` estimates one call of the task on a model, null when its price is unknown.
 */
export function provisionalPick(input: { current: string; baseline: Placed | null; ranked: readonly Placed[]; costPerCall: (model: string) => number | null; defaultEndpoint: string }): Provisional {
  const { baseline, current } = input;
  const keep = (reason: string): Provisional => ({ model: current, endpoint: baseline?.endpoint ?? input.defaultEndpoint, reason, estCostPerCallUsd: input.costPerCall(current) });
  if (!baseline || baseline.eci === null) return keep("The catalogue has no capability index for the current model, so only measurement can find a cheaper one. Keep it for now.");
  const pick = input.ranked.filter(item => item.eci !== null && item.eci >= baseline.eci! && item.price !== null).sort((a, b) => a.price! - b.price! || b.eci! - a.eci!)[0];
  if (!pick) return keep("No cheaper allowed model rates as capable as the current one in the catalogue. Keep it for now.");
  return {
    model: pick.model, endpoint: pick.endpoint, estCostPerCallUsd: input.costPerCall(pick.model),
    reason: `Catalogue estimate, not yet measured: ECI ${pick.eci} against ${baseline.eci} for ${current}, at $${pick.price!.toFixed(2)} against $${baseline.price?.toFixed(2) ?? "?"} per million input and output tokens. The measured result replaces it.`,
  };
}
