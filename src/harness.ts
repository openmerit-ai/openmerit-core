/** Stable seam between OpenMerit's merit loop and an agent harness. */
import type { TaskFile, TaskImage } from "./task-input.js";
import type { MeritChatClient } from "./providers.js";
import type { ModelRoute, TrialPoint } from "./types.js";

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

export interface HarnessScore {
  point: TrialPoint;
  costUsd: number;
  error?: string;
  sessionId?: string;
}

/** A coding harness executes a candidate and exposes normalized observations. */
export interface HarnessAdapter {
  runTask(route: ModelRoute, input: HarnessTask): Promise<HarnessRun>;
  /** The harness owns credentials and the route used for OpenMerit's judges. */
  createInferenceClient?(onSpend?: (usd: number) => void): MeritChatClient;
  /** Normalize quality scoring and trace metadata for this harness. */
  scoreRun?(
    judgeModel: ModelRoute, task: string, rubric: string, route: ModelRoute,
    run: HarnessRun, client: MeritChatClient, source: "pi_trial" | "trace", images?: TaskImage[],
  ): Promise<HarnessScore>;
  listRoutes?(): Promise<ModelRoute[]>;
  applyRoute?(route: ModelRoute): Promise<void>;
}
