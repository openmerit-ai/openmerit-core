/** Stable seam between OpenMerit's merit loop and an agent harness. */
import type { TaskFile, TaskImage } from "./task-input.js";
import type { MeritChatClient } from "./providers.js";
import type { ModelRoute, TrialPoint } from "./types.js";

export interface HarnessTask {
  task: string;
  cwd: string;
  images: TaskImage[];
  files: TaskFile[];
  /** How the harness should execute candidate runs. */
  mode?: "agent" | "inference" | "application";
  /** Harness-owned identity/configuration for an application workflow. */
  workflow?: { id: string; config?: Record<string, unknown> };
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

/** Completed task snapshot supplied by a harness integration. */
export interface SettledHarnessTask {
  task: string;
  images: TaskImage[];
  files: TaskFile[];
  model: string;
  route: ModelRoute;
  routes: ModelRoute[];
  run: HarnessRun;
  sessionFile: string;
  settledAt: string;
  sessionBytes?: number;
  cwd: string;
  usedTools: boolean;
  comparisonNonce?: string;
  mode?: "agent" | "inference" | "application";
  workflow?: { id: string; config?: Record<string, unknown> };
}

/** A coding harness executes a candidate and exposes normalized observations. */
export interface HarnessAdapter {
  runTask(route: ModelRoute, input: HarnessTask): Promise<HarnessRun>;
  /** Execute a pure model/inference task without requiring an agent loop. */
  runInference?(route: ModelRoute, input: HarnessTask): Promise<HarnessRun>;
  /** Execute the actual product/application workflow with the candidate route injected. */
  runApplication?(route: ModelRoute, input: HarnessTask): Promise<HarnessRun>;
  /** The harness owns credentials and the route used for OpenMerit's judges. */
  createInferenceClient?(onSpend?: (usd: number) => void): MeritChatClient;
  /** Normalize quality scoring and trace metadata for this harness. */
  scoreRun?(
    judgeModel: ModelRoute, task: string, rubric: string, route: ModelRoute,
    run: HarnessRun, client: MeritChatClient, source: "pi_trial" | "trace", images?: TaskImage[],
  ): Promise<HarnessScore>;
  listRoutes?(): Promise<ModelRoute[]>;
  applyRoute?(route: ModelRoute): Promise<void>;
  /** Apply a selected route to the declared application workflow. */
  applyApplicationRoute?(route: ModelRoute, input: HarnessTask): Promise<void>;
}
