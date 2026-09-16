/** Build policy-gated recommendations from a task's frontier + the harness's current model. */

import { createHash } from "node:crypto";
import { paretoFrontier, pickBest, pickFallback } from "./frontier.js";
import { gate, providerAllowed, type Policy } from "./policy.js";
import type { Recommendation, TrialPoint } from "./types.js";
import { pointKey, routeLabel } from "./routes.js";

export function buildRecommendation(
  taskKey: string,
  taskLabel: string,
  currentModel: string | null,
  points: TrialPoint[],
  policy: Policy,
  sessionFile: string | null = null,
  currentRoute = currentModel ? points.find((p) => p.model === currentModel)?.route ?? null : null,
): Recommendation | null {
  const scored = points.filter((p) => p.score > 0);
  if (scored.length === 0) return null;

  const best = pickBest(scored);
  if (!best) return null;
  if (currentModel && best.model === currentModel &&
      (!currentRoute || pointKey(best) === `${currentRoute.provider}:${currentRoute.modelId}`)) return null;

  const current = currentModel ? scored.find((p) => currentRoute
    ? pointKey(p) === `${currentRoute.provider}:${currentRoute.modelId}`
    : p.model === currentModel) : undefined;
  const scoreGain = current ? best.score - current.score : 0;
  // pickBest may choose a cheaper or faster model at equal quality.
  if (current && scoreGain < 0) return null;

  const priceKnown = best.priceKnown !== false && (!current || current.priceKnown !== false);
  const priceRatio = priceKnown && current && current.price > 0 ? best.price / current.price : 1;
  const frontierModels = paretoFrontier(scored).map(pointKey);
  const onFrontier = frontierModels.includes(pointKey(best));

  const fb = pickFallback(scored, best, policy.fallback.min_score);
  const decision = gate(policy, {
    scoreGain,
    priceRatio,
    priceKnown,
    onFrontier,
    providerOk: providerAllowed(policy, best.model, best.route?.provider),
    baselineMeasured: !!current,
    sessionBound: !!sessionFile,
  });

  const bestLabel = best.route ? routeLabel(best.route) : best.model;
  const reason =
    `${bestLabel} scores ${best.score.toFixed(2)} vs ` +
    (current ? `${current.score.toFixed(2)} for ${current.model}` : "no baseline measured") +
    ` (${scoreGain > 0 ? `quality gain ${scoreGain.toFixed(2)}` : "equal measured quality"}), ` +
    (best.priceKnown === false ? "with unknown price" : `at $${best.price.toFixed(2)}/M`) +
    (current && priceKnown ? ` (${priceRatio.toFixed(2)}x current price)` : "") +
    (best.why ? `. Judge: ${best.why}` : "");

  return {
    schemaVersion: 1,
    id: createHash("sha1")
      .update(`${taskKey}:${pointKey(best)}:${Date.now()}`)
      .digest("hex")
      .slice(0, 10),
    ts: new Date().toISOString(),
    taskKey,
    taskLabel,
    sessionFile,
    currentModel,
    currentRoute,
    recommended: { model: best.model, route: best.route, reason },
    fallback: fb
      ? {
          model: fb.model,
          route: fb.route,
          reason: `score ${fb.score.toFixed(2)} ` +
            (fb.priceKnown === false ? "with unknown price" : `at $${fb.price.toFixed(2)}/M`) +
            (fb.latencyMs ? `, ~${Math.round(fb.latencyMs)}ms` : ""),
        }
      : null,
    evidence: {
      scoreGain: Math.round(scoreGain * 1000) / 1000,
      priceRatio: Math.round(priceRatio * 100) / 100,
      priceKnown,
      onFrontier,
      trials: scored.length,
    },
    policy: decision,
    status: "pending",
  };
}
