// `createMeasure`: the Ranking's measure function, the seam Scout Model Binary Search searches over.
// It runs a candidate on the given cases and grades each output, and returns only pass or fail per
// case, with a failed case's one-sentence reason, the candidate's cost and its mean latency per
// case: never the outputs.
//
// Ledger keys are `<key>/<run>/<endpoint>/<model>/<case>/call-<n>` (and `/judge`), so a workflow step
// that replays with the same run is charged once. A deliberate repeat passes a different `run`.
import { CandidateUnavailable } from "../engine/index.ts";
import type { ModelClient } from "./clients.ts";
import { oneSentence, type Grader } from "./graders.ts";
import type { Ledger } from "../engine/index.ts";
import { invalidCases, runCase, type CaseFailure, type CaseRun } from "./runner.ts";
import type { Case, TaskBundle } from "./types.ts";

export interface CaseResult {
  caseId: string;
  pass: boolean;
  /** Why the case failed before grading; absent when the grader decided. */
  failure?: CaseFailure;
  /** Why a failed case failed, in one redacted sentence: the grader's reason, or the failure's. */
  reason?: string;
  /** The spec's checks (C…, G…, S…) it failed, when the grader named them. */
  failedChecks?: string[];
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

const failureReason = (ran: { failure?: CaseFailure; status?: number; error?: string }) => oneSentence(
  ran.failure === "tool_loop" ? "It kept calling tools past the limit and never answered."
    : ran.failure === "truncated" ? "It stopped at the output token limit before answering."
      : `The call failed${ran.status ? ` (HTTP ${ran.status})` : ""}: ${ran.error ?? "no answer"}.`);

export function createMeasure(input: {
  bundle: TaskBundle; cases: readonly Case[]; client: ModelClient; grader: Grader; ledger: Ledger;
  /** The job's idempotency prefix, such as its ID. */
  key: string;
  signal?: AbortSignal; maxTokens?: number; concurrency?: number;
  /**
   * Called as each case finishes, in the order they finish, such as to show progress. `run` has the
   * candidate's output and Pi transcript, for the caller's run artifact; the measure keeps neither.
   */
  onCase?: (result: CaseResult, run: Pick<CaseRun, "output" | "toolCalls" | "transcript" | "refused"> | null) => void;
}): Measure {
  const byId = new Map(input.cases.map(item => [item.id, item]));
  const invalid = new Map(invalidCases(input.bundle, input.cases).map(item => [item.caseId, item.reason]));
  return async (candidate, caseIds, options = {}) => {
    const ids = [...new Set(caseIds)];
    const unknown = ids.filter(id => !byId.has(id));
    if (unknown.length) throw new Error(`Unknown case IDs: ${unknown.join(", ")}`);
    // An invalid case counts for no model: the host leaves it out (invalidCases) before it measures.
    const unrunnable = ids.filter(id => invalid.has(id));
    if (unrunnable.length) throw new Error(`Cases the eval cannot run: ${unrunnable.map(id => `${id} (${invalid.get(id)})`).join("; ")}`);
    const run = options.run ?? "0";
    type Outcome = { result: CaseResult; costUsd: number; costIsEstimate: boolean; latencyMs: number | null; graderCostUsd: number; rejected?: string };
    const outcomes = new Array<Outcome>(ids.length);
    const settle = (index: number, outcome: Outcome, ran: CaseRun | null = null) => {
      outcomes[index] = outcome;
      input.onCase?.(outcome.result, ran && { output: ran.output, toolCalls: ran.toolCalls, transcript: ran.transcript, refused: ran.refused });
    };
    let next = 0;
    // Once a call gets no answer at all, the candidate takes no new case: each would wait out the same timeout.
    let silent: string | null = null;
    // When a case throws, such as a refused budget, the other workers take no new case.
    const worker = async () => {
      try { await work(); } catch (error) { next = ids.length; throw error; }
    };
    const work = async () => {
      while (next < ids.length) {
        const index = next++;
        input.signal?.throwIfAborted();
        const caseItem = byId.get(ids[index]!)!;
        if (silent !== null) {
          settle(index, { result: { caseId: caseItem.id, pass: false, failure: "error", reason: oneSentence(`Not run: ${silent}`) }, costUsd: 0, costIsEstimate: false, latencyMs: null, graderCostUsd: 0, rejected: silent });
          continue;
        }
        const key = `${input.key}/${run}/${candidate.endpoint}/${candidate.model}/${caseItem.id}`;
        const ran = await runCase({ bundle: input.bundle, caseItem, client: input.client, candidate, ledger: input.ledger, key, ...(input.signal ? { signal: input.signal } : {}), ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}) });
        const answered = ran.failure !== "error";
        if (ran.failure === "error" && (ran.status ?? 0) === 0) silent ??= ran.error ?? "it did not answer";
        const base = { costUsd: ran.costUsd, costIsEstimate: ran.costIsEstimate, latencyMs: answered ? ran.latencyMs : null };
        if (ran.output === null) {
          settle(index, { ...base, result: { caseId: caseItem.id, pass: false, failure: ran.failure ?? "error", reason: failureReason(ran) }, graderCostUsd: 0, ...(ran.failure === "error" && rejects(ran.status ?? 0) ? { rejected: ran.error ?? `HTTP ${ran.status}` } : {}) }, ran);
          continue;
        }
        let grade;
        try {
          grade = await input.grader.grade({ bundle: input.bundle, caseItem, output: ran.output, toolCalls: ran.toolCalls, transcript: ran.transcript, refused: ran.refused, ledger: input.ledger, key, ...(input.signal ? { signal: input.signal } : {}) });
        } catch (error) {
          // By name, as the engine's errors are, since a host may load its own copy.
          if (!(error instanceof Error && error.name === "Ungradable")) throw error;
          settle(index, { ...base, result: { caseId: caseItem.id, pass: false, failure: "ungradable", reason: oneSentence(error.message) }, graderCostUsd: 0 }, ran);
          continue;
        }
        settle(index, { ...base, result: { caseId: caseItem.id, pass: grade.pass, ...(grade.pass ? {} : { reason: grade.reason ?? "The grader failed the answer.", ...(grade.failed?.length ? { failedChecks: grade.failed } : {}) }) }, graderCostUsd: grade.costUsd }, ran);
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
