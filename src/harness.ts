/** Stable seam between OpenMerit's merit loop and an agent harness. */
import type { TaskFile, TaskImage } from "./task-input.js";
import type { ModelRoute } from "./types.js";

export interface HarnessTask {
  task: string;
  cwd: string;
  images: TaskImage[];
  files: TaskFile[];
}

export interface HarnessRun {
  answer: string;
  costUsd: number;
  latencyMs: number;
  errors: number;
  sessionId?: string;
  toolCalls: number;
  toolErrors: number;
  changedFiles: number;
  traceFile?: string;
}

/** A coding harness executes a candidate and exposes normalized observations. */
export interface HarnessAdapter {
  runTask(route: ModelRoute, input: HarnessTask): Promise<HarnessRun>;
}
