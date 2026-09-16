/** Stable boundaries for trace inputs and telemetry outputs. */

import { randomUUID } from "node:crypto";
import { appendJsonl, paths } from "./store.js";
import { ingestNewTraces } from "./traces.js";
import type { Recommendation, TaskObservation, TrialPoint } from "./types.js";

export interface ObservationSource {
  readonly id: string;
  read(): TaskObservation[];
}

export type MeritEvent = {
  schemaVersion: 1;
  id: string;
  ts: string;
  source: string;
} & (
  | { type: "observation.recorded"; payload: TaskObservation }
  | { type: "trial.completed"; payload: TrialPoint & { taskKey?: string; sessionFile?: string } }
  | { type: "recommendation.created"; payload: Recommendation }
);

export interface EventSink {
  readonly id: string;
  emit(event: MeritEvent): void;
}

export class PiTraceObservationSource implements ObservationSource {
  readonly id = "pi-jsonl";
  constructor(private readonly sessionsDir?: string) {}
  read(): TaskObservation[] { return ingestNewTraces(this.sessionsDir); }
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
