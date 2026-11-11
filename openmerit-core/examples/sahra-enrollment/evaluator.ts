// Scout evaluator for the Sahra Health playground's enrollment agent (fictional data only).
// It uses only what a customer exposes: the playground Worker's HTTP API and Sahra's own Langfuse
// dataset `sahra-enrollments` (item input `{ application }`, expected output `{ decision,
// declaredConditions, notDeclared? }`). Each item runs in a fresh, isolated ledger.
//
//   PLAYGROUND_URL (default http://localhost:8787), PLAYGROUND_TOKEN, LANGFUSE_* for measured cost.
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
// Copy this file into your project to adapt it; it has no runtime import from OpenMerit.
// In your project, import the type from the package instead: `import type { EvaluatorPlugin } from "openmerit"`.
import type { EvaluatorPlugin } from "../../src/scout/evaluators/module.ts";

/** Scout skips a candidate that throws this (matched by name) as untested instead of stopping. */
class CandidateUnavailable extends Error {
  override readonly name = "CandidateUnavailable";
}

interface Expected { decision: "enrolled" | "declined"; declaredConditions: string[]; notDeclared?: string[] }
interface State {
  enrollment: { decision: "enrolled" | "declined" | "pending" } | null;
  member: { declaredConditions: string[] } | null;
  workflow: { status?: string; error?: { message?: string } } | null;
}

/** The agent ended without recording a decision. Under `wrangler dev` the workflow reports only the NonRetryableError. */
const NO_DECISION = /ended without a decision|threw an? NonRetryableError/;

interface Observation { type: string; level?: string; statusMessage?: string | null; endTime?: string | null; totalCost?: number | null; metadata?: { generations?: string | number } }

/**
 * Why a run ended without a decision, from the playground's own trace: a provider error on a model
 * call (`402: …`, `404: …`) is not a quality verdict. Returns null when every model call succeeded,
 * which makes it the agent's failure.
 */
export function providerError(observations: readonly Observation[]): { status: number; message: string } | null {
  for (const row of observations) {
    if (row.type !== "GENERATION" || row.level !== "ERROR") continue;
    const message = row.statusMessage ?? "";
    const status = Number(/^(\d{3})\b/.exec(message)?.[1] ?? /\b(4\d\d|5\d\d)\b/.exec(message)?.[1] ?? 0);
    return { status, message: message.slice(0, 240) };
  }
  return null;
}

/** The playground scenario runner's checks: the decision, then declared condition prefixes. */
export function enrollmentPass(expected: Expected, state: State): { pass: boolean; comment: string } {
  const decision = state.enrollment?.decision ?? "none";
  if (decision !== expected.decision) return { pass: false, comment: `decision ${decision}, expected ${expected.decision}` };
  if (expected.decision !== "enrolled") return { pass: true, comment: `decision ${decision}` };
  const declared = state.member?.declaredConditions ?? [];
  const missing = expected.declaredConditions.filter(code => !declared.some(item => item.startsWith(code)));
  const wrong = (expected.notDeclared ?? []).filter(code => declared.some(item => item.startsWith(code)));
  return {
    pass: !missing.length && !wrong.length,
    comment: `declared ${declared.join(", ") || "none"}${missing.length ? `; missing ${missing.join(", ")}` : ""}${wrong.length ? `; should not declare ${wrong.join(", ")}` : ""}`,
  };
}

const plugin: EvaluatorPlugin = {
  name: "sahra-enrollment",
  providers: ["openrouter"],
  tools: true,
  passScore: "enrollment-correct",
  role: "enrollment",
  concurrency: 6,
  create({ env, log }) {
    const url = (env.PLAYGROUND_URL ?? "http://localhost:8787").replace(/\/+$/, "");
    const token = env.PLAYGROUND_TOKEN;
    if (!token) throw new Error("Set PLAYGROUND_TOKEN to the playground Worker's token");
    const langfuse = env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY
      ? { base: (env.LANGFUSE_BASE_URL ?? "https://us.cloud.langfuse.com").replace(/\/+$/, ""), auth: `Basic ${btoa(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`)}` }
      : null;

    /** The playground's own trace once its agent root has ended and every generation is ingested; null on timeout. */
    async function trace(traceId: string, priced: boolean): Promise<Observation[] | null> {
      if (!langfuse) return null;
      const deadline = Date.now() + 180_000;
      await delay(8_000);
      while (Date.now() < deadline) {
        const response = await fetch(`${langfuse.base}/api/public/v2/observations?traceId=${traceId}&fields=core,basic,usage,metadata&limit=100`, { headers: { authorization: langfuse.auth } });
        if (response.ok) {
          const { data = [] } = await response.json() as { data?: Observation[] };
          const root = data.find(row => row.type === "AGENT");
          const generations = data.filter(row => row.type === "GENERATION");
          const expected = Number(root?.metadata?.generations ?? NaN);
          if (root?.endTime && (generations.length === expected || root.level === "ERROR")
            && (!priced || generations.every(row => typeof row.totalCost === "number"))) return data;
        }
        await delay(response.status === 429 ? 30_000 : 8_000);
      }
      return null;
    }
    const traceCost = async (traceId: string) => {
      const data = await trace(traceId, true);
      return data ? data.filter(row => row.type === "GENERATION").reduce((sum, row) => sum + (row.totalCost ?? 0), 0) : null;
    };

    return async (candidate, item, context) => {
      if (candidate.provider !== "openrouter") throw new Error("The enrollment agent runs OpenRouter models only");
      const input = item.input as { application?: { applicationId?: string } };
      const application = input.application;
      if (!application?.applicationId) throw new Error(`Dataset item ${item.id} has no application`);
      const expected = item.expectedOutput as Expected;
      // Outlast EnrollmentFlow's own 10-minute limit and one retry, so the workflow decides the outcome.
      const signal = AbortSignal.any([AbortSignal.timeout(25 * 60_000), ...(context.signal ? [context.signal] : [])]);
      const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        const response = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? null : JSON.stringify(body), signal });
        if (!response.ok) throw new Error(`Playground ${method} ${path.split("?")[0]} HTTP ${response.status}`);
        return await response.json() as T;
      };
      const traceIdOf = (runId: string) => createHash("sha256").update(`trace:${application.applicationId}--${runId}/enrollment`).digest("hex").slice(0, 32);
      for (let attempt = 1; ; attempt++) {
        const runId = `scout-${randomUUID()}`;
        log(`  ${context.stage} ${candidate.id} ${item.id} run=${runId}`);
        await call("POST", "/admin/seed", { runId });
        await call("POST", "/enrollments", { runId, application, models: { enrollment: { provider: "openrouter", id: candidate.id } } });
        const path = `/enrollments/${encodeURIComponent(application.applicationId)}?runId=${encodeURIComponent(runId)}`;
        let verdict: { pass: boolean; comment: string; output: unknown } | null = null;
        while (!verdict) {
          const state = await call<State>("GET", path);
          const decision = state.enrollment?.decision;
          if (["errored", "terminated"].includes(state.workflow?.status ?? "")) {
            if (!NO_DECISION.test(state.workflow?.error?.message ?? "")) {
              throw new Error(`Enrollment workflow ${state.workflow?.status} (run ${runId}): ${state.workflow?.error?.message ?? "no message"}; no quality verdict`);
            }
            // Only the trace can say whether a model call failed (provider error) or the agent gave up.
            const observations = await trace(traceIdOf(runId), false);
            if (!observations) throw new Error(`Cannot tell a provider error from an agent failure for run ${runId}: its Langfuse trace did not arrive`);
            const failed = providerError(observations);
            if (failed && [400, 402, 404, 413, 422].includes(failed.status)) throw new CandidateUnavailable(`${failed.status} from the provider (run ${runId}): ${failed.message}`);
            if (failed && (failed.status === 429 || failed.status >= 500 || failed.status === 0) && attempt < 2) { log(`  retrying ${candidate.id} ${item.id} after ${failed.status || "an unclassified provider error"}`); break; }
            if (failed) throw new Error(`Provider error ${failed.status} for ${candidate.model} (run ${runId}): ${failed.message}`);
            verdict = { pass: false, comment: "the agent ended without recording a decision", output: { decision: null } };
          } else if (decision && decision !== "pending") {
            verdict = { ...enrollmentPass(expected, state), output: { decision, declaredConditions: state.member?.declaredConditions ?? [] } };
          } else if (state.workflow?.status === "complete") {
            throw new Error(`Enrollment workflow completed without a decision (run ${runId})`);
          } else await delay(1500, undefined, { signal });
        }
        if (!verdict) continue;
        // The playground's trace ID for this agent run (see its tracing.ts): sha256("trace:<app>--<runId>/enrollment").
        const traceId = traceIdOf(runId);
        // Cost decides ties between finalists, so wait for it there; screens skip the ingestion wait.
        const costUsd = context.stage === "final" ? await traceCost(traceId) : null;
        return { ...verdict, output: { ...verdict.output as object, playgroundRunId: runId, playgroundTraceId: traceId }, costUsd };
      }
    };
  },
};

export default plugin;
