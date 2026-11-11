import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Evaluate } from "../search.ts";

/**
 * An evaluator that runs a candidate through the user's own harness, such as a deployed agent's
 * HTTP API, and checks the result against the labelled item. A module's default export is one of these.
 */
export interface EvaluatorPlugin {
  name: string;
  /** Pi providers the harness can run, such as ["openrouter"]. Candidates are drawn only from these. */
  providers?: string[];
  /** The harness calls tools, so models without tool calls are not candidates. */
  tools?: boolean;
  /** Score name recorded per item in Langfuse, ideally the customer's own metric (e.g. `enrollment-correct`). */
  passScore?: string;
  /** Experiment metadata key `model_<role>`. */
  role?: string;
  /** Items evaluated at once within one probe. */
  concurrency?: number;
  create(context: { env: Record<string, string | undefined>; log: (line: string) => void }): Evaluate | Promise<Evaluate>;
}

/** Imports a `.ts` or `.js` evaluator module from the user's project. Node.js 22.19 strips its types. */
export async function loadEvaluatorPlugin(path: string, cwd = process.cwd()): Promise<EvaluatorPlugin> {
  const loaded = await import(pathToFileURL(resolve(cwd, path)).href) as { default?: unknown };
  const plugin = loaded.default as EvaluatorPlugin | undefined;
  if (!plugin || typeof plugin !== "object" || typeof plugin.create !== "function" || typeof plugin.name !== "string") {
    throw new Error(`${path} must default-export an evaluator: { name, create(context) => evaluate }`);
  }
  return plugin;
}
