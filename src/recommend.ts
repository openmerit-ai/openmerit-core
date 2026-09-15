/** Build policy-gated recommendations from a task's frontier + the harness's current model. */

import { createHash } from "node:crypto";
import { paretoFrontier, pickBest, pickFallback } from "./frontier.js";
import { gate, providerAllowed, type Policy } from "./policy.js";
import type { Recommendation, TrialPoint } from "./types.js";

export function buildRecommendation(
  taskKey: string,
  taskLabel: string,
  currentModel: string | null,
  points: TrialPoint[],
  policy: Policy,
  sessionFile: string | null = null,
): Recommendation | null {
  const scored = points.filter((p) => p.score > 0);
  if (scored.length === 0) return null;

  const best = pickBest(scored);
  if (!best) return null;
  if (currentModel && best.model === currentModel) return null; // already on the best model

  const current = currentModel ? scored.find((p) => p.model === currentModel) : undefined;
  const scoreGain = current ? best.score - current.score : 0;
  // pickBest may choose a cheaper or faster model at equal quality.
  if (current && scoreGain < 0) return null;

  const priceRatio = current && current.price > 0 ? best.price / current.price : 1;
  const frontierModels = paretoFrontier(scored).map((p) => p.model);
  const onFrontier = frontierModels.includes(best.model);

  const fb = pickFallback(scored, best, policy.fallback.min_score);
  const decision = gate(policy, {
    scoreGain,
    priceRatio,
    onFrontier,
    providerOk: providerAllowed(policy, best.model),
    baselineMeasured: !!current,
    sessionBound: !!sessionFile,
  });

  const reason =
    `${best.model} scores ${best.score.toFixed(2)} vs ` +
    (current ? `${current.score.toFixed(2)} for ${current.model}` : "no baseline measured") +
    ` (${scoreGain > 0 ? `quality gain ${scoreGain.toFixed(2)}` : "equal measured quality"}), at $${best.price.toFixed(2)}/M` +
    (current ? ` (${priceRatio.toFixed(2)}x current price)` : "") +
    (best.why ? `. Judge: ${best.why}` : "");

  return {
    id: createHash("sha1")
      .update(`${taskKey}:${best.model}:${Date.now()}`)
      .digest("hex")
      .slice(0, 10),
    ts: new Date().toISOString(),
    taskKey,
    taskLabel,
    sessionFile,
    currentModel,
    recommended: { model: best.model, reason },
    fallback: fb
      ? {
          model: fb.model,
          reason: `score ${fb.score.toFixed(2)} at $${fb.price.toFixed(2)}/M` +
            (fb.latencyMs ? `, ~${Math.round(fb.latencyMs)}ms` : ""),
        }
      : null,
    evidence: {
      scoreGain: Math.round(scoreGain * 1000) / 1000,
      priceRatio: Math.round(priceRatio * 100) / 100,
      onFrontier,
      trials: scored.length,
    },
    policy: decision,
    status: "pending",
  };
}
