/** Stable audit-event boundary for decision evidence. */

import { randomUUID } from "node:crypto";
import { appendJsonl, paths } from "./store.js";
import type { Recommendation, TrialPoint } from "./types.js";

export type MeritEvent = {
  schemaVersion: 1;
  id: string;
  ts: string;
  source: string;
} & (
  | { type: "trial.completed"; payload: TrialPoint }
  | { type: "recommendation.created"; payload: Recommendation }
);

export interface EventSink {
  readonly id: string;
  emit(event: MeritEvent): void;
}

export class LocalJsonlEventSink implements EventSink {
  readonly id = "local-jsonl";
  emit(event: MeritEvent): void { appendJsonl(paths.events(), event); }
}

export function meritEvent<T extends MeritEvent["type"]>(
  type: T,
  payload: Extract<MeritEvent, { type: T }>["payload"],
  source = "openmerit",
): Extract<MeritEvent, { type: T }> {
  return { schemaVersion: 1, id: randomUUID(), ts: new Date().toISOString(), source, type, payload } as
    Extract<MeritEvent, { type: T }>;
}
