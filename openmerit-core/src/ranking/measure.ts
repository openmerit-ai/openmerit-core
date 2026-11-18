// `createMeasure`: the Ranking's measure function, the seam Scout Model Binary Search searches over.
// It runs a candidate on the given cases and grades each output, and returns only pass or fail per
// case, the candidate's cost and its mean latency per case: never the outputs.
//
// Ledger keys are `<key>/<run>/<endpoint>/<model>/<case>/call-<n>` (and `/judge`), so a workflow step
// that replays with the same run is charged once. A deliberate repeat passes a different `run`.
import { CandidateUnavailable } from "../engine/index.ts";
import type { ModelClient } from "./clients.ts";
import type { Grader } from "./graders.ts";
import type { Ledger } from "../engine/index.ts";
import { runCase, type CaseFailure } from "./runner.ts";
import type { Case, TaskBundle } from "./types.ts";

export interface CaseResult {
  caseId: string;
  pass: boolean;
  /** Why the case failed before grading; absent when the grader decided. */
  failure?: CaseFailure;
}

export interface MeasureResult {
  results: CaseResult[];
  /** What the candidate's calls cost. The grader's calls are not in it. */
  costUsd: number;
  costIsEstimate: boolean;
  /** Mean time per case the candidate answered, over all its calls for the case; null when it answered none. */
  latencyMs: number | null;
  /** What grading cost, such as the judge's calls: metered, but not the candidate's. */
  graderCostUsd: number;
}

export type Measure = (candidate: { model: string; endpoint: string }, caseIds: readonly string[], options?: { run?: string }) => Promise<MeasureResult>;

/** Cases run at the same time for one candidate. */
export const CASE_CONCURRENCY = 4;

/** Statuses that mean the endpoint will not run this model at all, rather than that one call failed. */
const rejects = (status: number) => status === 0 || status === 400 || status === 401 || status === 403 || status === 404 || status === 422;

export function createMeasure(input: {
  bundle: TaskBundle; cases: readonly Case[]; client: ModelClient; grader: Grader; ledger: Ledger;
  /** The job's idempotency prefix, such as its ID. */
  key: string;
  signal?: AbortSignal; maxTokens?: number; concurrency?: number;
}): Measure {
  const byId = new Map(input.cases.map(item => [item.id, item]));
  return async (candidate, caseIds, options = {}) => {
    const ids = [...new Set(caseIds)];
    const unknown = ids.filter(id => !byId.has(id));
    if (unknown.length) throw new Error(`Unknown case IDs: ${unknown.join(", ")}`);
    const run = options.run ?? "0";
    const outcomes = new Array<{ result: CaseResult; costUsd: number; costIsEstimate: boolean; latencyMs: number | null; graderCostUsd: number; rejected?: string }>(ids.length);
    let next = 0;
    // When a case throws, such as a refused budget, the other workers take no new case.
    const worker = async () => {
      try { await work(); } catch (error) { next = ids.length; throw error; }
    };
    const work = async () => {
      while (next < ids.length) {
        const index = next++;
        input.signal?.throwIfAborted();
        const caseItem = byId.get(ids[index]!)!;
        const key = `${input.key}/${run}/${candidate.endpoint}/${candidate.model}/${caseItem.id}`;
        const ran = await runCase({ bundle: input.bundle, caseItem, client: input.client, candidate, ledger: input.ledger, key, ...(input.signal ? { signal: input.signal } : {}), ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}) });
        const answered = ran.failure !== "error";
        const base = { costUsd: ran.costUsd, costIsEstimate: ran.costIsEstimate, latencyMs: answered ? ran.latencyMs : null };
        if (ran.output === null) {
          outcomes[index] = { ...base, result: { caseId: caseItem.id, pass: false, failure: ran.failure ?? "error" }, graderCostUsd: 0, ...(ran.failure === "error" && rejects(ran.status ?? 0) ? { rejected: ran.error ?? `HTTP ${ran.status}` } : {}) };
          continue;
        }
        const grade = await input.grader.grade({ bundle: input.bundle, caseItem, output: ran.output, toolCalls: ran.toolCalls, ledger: input.ledger, key, ...(input.signal ? { signal: input.signal } : {}) });
        outcomes[index] = { ...base, result: { caseId: caseItem.id, pass: grade.pass }, graderCostUsd: grade.costUsd };
      }
    };
    await Promise.all(Array.from({ length: Math.min(input.concurrency ?? CASE_CONCURRENCY, ids.length) }, worker));

    // A candidate the endpoint refused on every case is untested, not failed: the search skips it.
    const rejected = outcomes.find(item => item.rejected)?.rejected;
    if (ids.length && outcomes.every(item => item.rejected)) throw new CandidateUnavailable(`${candidate.model} on ${candidate.endpoint}: ${rejected}`);
    const timed = outcomes.flatMap(item => (item.latencyMs === null ? [] : [item.latencyMs]));
    return {
      results: outcomes.map(item => item.result),
      costUsd: outcomes.reduce((sum, item) => sum + item.costUsd, 0),
      costIsEstimate: outcomes.some(item => item.costIsEstimate),
      latencyMs: timed.length ? timed.reduce((sum, value) => sum + value, 0) / timed.length : null,
      graderCostUsd: outcomes.reduce((sum, item) => sum + item.graderCostUsd, 0),
    };
  };
}
