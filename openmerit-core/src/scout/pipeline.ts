import { randomUUID } from "node:crypto";
import type { ExperimentResult, LangfuseConnector, PassRule } from "../connectors/langfuse/index.ts";
import type { Candidate } from "./candidates.ts";
import { compareFinals, meanCost, scoutSearch, type EvalItem, type Evaluate, type SearchResult, type Trial } from "./search.ts";

export interface DatasetSource {
  /** An existing Langfuse dataset, such as the customer's `sahra-enrollments`. */
  langfuseDataset?: string;
  /** Local labelled items; pushed to Langfuse as `name` before evaluation so every run is an experiment on it. */
  local?: { name: string; description?: string; items: EvalItem[] };
}

export interface ScoutRunOptions {
  task: string;
  dataset: DatasetSource;
  candidates: Candidate[];
  evaluate: Evaluate;
  /** Score name each recorded item carries; the pass rule reads it back from Langfuse. */
  passScore?: string;
  /** Experiment metadata key for the candidate: `model_<role>`. */
  role?: string;
  langfuse: LangfuseConnector | null;
  sampleSize?: number;
  finalists?: number;
  /** See SearchOptions.challengers. */
  challengers?: number;
  /** See SearchOptions.repeats. */
  repeats?: number;
  concurrency?: number;
  log?: (line: string) => void;
  signal?: AbortSignal;
  /** Injected for tests. */
  pickIndex?: (remaining: number) => number;
  langfuseTimeoutMs?: number;
}

export interface FinalVerdict {
  model: string;
  eci: number;
  eciSource: string;
  listPrice: number | null;
  /** Passes as Langfuse reports them; local passes when Langfuse is not connected. */
  passes: number;
  /** Item runs: dataset items × repeats. */
  total: number;
  /** Runs of each item. */
  runs: number;
  /** Passes per item over the repeats, e.g. { "APP-2005": 2 } when it passed 2 of 3 runs. */
  passesByItem: Record<string, number>;
  /** Mean measured cost per item run in USD: Langfuse's recorded generation cost when available. */
  costPerItemUsd: number | null;
  localPasses: number;
  verifiedInLangfuse: boolean;
  missingScores: string[];
  /** One Langfuse experiment per repeat (Langfuse allows one result per dataset item per experiment). */
  experimentIds: string[];
  experimentId: string | null;
  experimentUrl: string | null;
  /** Items that failed at least one run. */
  failedItems: string[];
}

export interface ScoutReport {
  scout: "OpenMerit Scout";
  runId: string;
  task: string;
  createdAt: string;
  dataset: { name: string; source: "langfuse" | "local"; size: number; datasetId: string | null; url: string | null };
  candidates: number;
  search: Omit<SearchResult, "ordered" | "trials" | "finals" | "unavailable"> & {
    unavailable: SearchResult["unavailable"];
    trials: { stage: string; model: string; eci: number; eciSource: string; passes: number; total: number; accepted: boolean; costUsd: number | null; experimentUrl: string | null }[];
  };
  finals: FinalVerdict[];
  recommendation: FinalVerdict | null;
  runnerUp: FinalVerdict | null;
  why: string;
  spend: {
    measuredUsd: number; unknownCostItems: number; evaluations: number;
    /** OpenRouter account credit used between the start and the end of the run (account-wide: concurrent use counts too). */
    openRouterCreditsUsd?: number;
  };
  langfuse: { baseUrl: string; project: string | null; experiments: number } | null;
  limitations: string[];
}

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/**
 * Scout end to end: dataset → binary search over ECI-ranked candidates → finals on every item,
 * each probe and final recorded as a Langfuse experiment → the winner from Langfuse's results.
 */
export async function runScout(options: ScoutRunOptions): Promise<ScoutReport> {
  const log = options.log ?? (() => {});
  const runId = `scout-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 4)}`;
  const passScore = options.passScore ?? "correct";
  const role = options.role ?? "candidate";
  const lf = options.langfuse;

  let items: EvalItem[];
  let datasetName: string;
  let datasetId: string | null = null;
  if (options.dataset.langfuseDataset) {
    if (!lf) throw new Error("A Langfuse dataset needs a Langfuse connection (LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL)");
    datasetName = options.dataset.langfuseDataset;
    items = (await lf.getDatasetItems(datasetName)).map(item => ({ id: item.id, input: item.input, expectedOutput: item.expectedOutput, metadata: item.metadata }));
    datasetId = (await lf.getDataset(datasetName)).id;
  } else if (options.dataset.local) {
    datasetName = options.dataset.local.name;
    items = options.dataset.local.items;
    if (lf) {
      const pushed = await lf.ensureDataset({
        name: datasetName, ...(options.dataset.local.description ? { description: options.dataset.local.description } : {}),
        metadata: { source: "openmerit-scout" },
        items: items.map(item => ({ id: item.id, input: item.input, expectedOutput: item.expectedOutput, ...(item.metadata ? { metadata: item.metadata } : {}) })),
      });
      datasetId = pushed.datasetId;
    }
  } else throw new Error("Scout needs a labelled dataset: a Langfuse dataset name or local items");
  log(`Dataset ${datasetName}: ${items.length} items${datasetId ? ` (Langfuse ${datasetId})` : " (local only)"}`);
  log(`${options.candidates.length} ECI-ranked candidates · run ${runId}`);

  const urls = new Map<Trial, { experimentId: string; url: string }[]>();
  const project = lf ? await lf.check() : null;
  const onTrial = async (trial: Trial) => {
    if (!lf || !datasetId) return;
    const stage = trial.stage === "final" ? "final" : "screen";
    const recordings: { experimentId: string; url: string }[] = [];
    for (let repeat = 1; repeat <= trial.runs; repeat++) {
    const suffix = trial.runs > 1 ? `-r${repeat}` : "";
    const experimentId = `${runId}-${stage}${suffix}-${slug(trial.candidate.model)}`;
    const recorded = await lf.recordExperimentItems({
      datasetId, experimentId, experimentName: `scout ${stage}${trial.runs > 1 ? ` run ${repeat}/${trial.runs}` : ""} ${trial.candidate.model} ${runId}`, traceName: "openmerit-scout-eval",
      metadata: { [`model_${role}`]: trial.candidate.model, scout_run: runId, stage, ...(trial.runs > 1 ? { repeat, repeats: trial.runs } : {}), eci: trial.candidate.eci, eci_source: trial.candidate.eciSource, task: options.task.slice(0, 200) },
      items: trial.outcomes.filter(outcome => (outcome.repeat ?? 1) === repeat).map(outcome => {
        const item = items.find(entry => entry.id === outcome.itemId)!;
        return {
          itemId: outcome.itemId, model: trial.candidate.model, input: item.input, output: outcome.output ?? null,
          startMs: outcome.startMs ?? Date.now(), endMs: outcome.endMs ?? Date.now(),
          ...(outcome.usage ? { usage: outcome.usage } : {}), ...(typeof outcome.costUsd === "number" ? { costUsd: outcome.costUsd } : {}),
          metadata: { stage: trial.stage, scout_run: runId, eci: trial.candidate.eci, ...(trial.runs > 1 ? { repeat } : {}) },
          scores: [{ name: passScore, value: outcome.pass, dataType: "BOOLEAN" as const, ...(outcome.comment ? { comment: outcome.comment } : {}) }],
        };
      }),
    });
    recordings.push({ experimentId, url: recorded.url });
    }
    urls.set(trial, recordings);
  };

  const search = await scoutSearch({
    dataset: items, candidates: options.candidates, evaluate: options.evaluate, onTrial, log,
    ...(options.sampleSize ? { sampleSize: options.sampleSize } : {}), ...(options.finalists ? { finalists: options.finalists } : {}),
    ...(options.challengers !== undefined ? { challengers: options.challengers } : {}),
    ...(options.repeats !== undefined ? { repeats: options.repeats } : {}),
    ...(options.concurrency ? { concurrency: options.concurrency } : {}), ...(options.pickIndex ? { pickIndex: options.pickIndex } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  // The decision: read every final back from Langfuse, so the recommendation rests on the recorded experiment.
  const rule: PassRule = { score: passScore, equals: true };
  const finals: FinalVerdict[] = [];
  for (const trial of search.finals) {
    const recorded = urls.get(trial) ?? [];
    const readbacks: ExperimentResult[] = [];
    if (lf && recorded.length) {
      log(`Reading ${trial.candidate.model} back from Langfuse (${recorded.length} experiments)…`);
      for (const { experimentId } of recorded) {
        readbacks.push(await lf.waitForExperiment({ experimentId, pass: rule, includeCost: true, since: new Date(Date.now() - 86_400_000) },
          { expectItems: items.length, timeoutMs: options.langfuseTimeoutMs ?? 300_000 }));
      }
    }
    const verified = readbacks.length > 0 && readbacks.length === recorded.length;
    const results = verified
      ? readbacks.flatMap(readback => readback.items.map(item => ({ itemId: item.itemId, pass: item.passed })))
      : trial.outcomes.map(outcome => ({ itemId: outcome.itemId, pass: outcome.pass }));
    const passesByItem: Record<string, number> = {};
    for (const item of items) passesByItem[item.id] = 0;
    for (const result of results) if (result.pass) passesByItem[result.itemId] = (passesByItem[result.itemId] ?? 0) + 1;
    const langfuseCost = verified && readbacks.every(readback => readback.costUsd != null) ? readbacks.reduce((sum, readback) => sum + readback.costUsd!, 0) : null;
    finals.push({
      model: trial.candidate.model, eci: trial.candidate.eci, eciSource: trial.candidate.eciSource, listPrice: trial.candidate.price,
      passes: results.filter(result => result.pass).length, total: results.length, runs: trial.runs, passesByItem,
      costPerItemUsd: langfuseCost !== null && results.length ? langfuseCost / results.length : meanCost(trial.outcomes),
      localPasses: trial.passes, verifiedInLangfuse: verified, missingScores: readbacks.flatMap(readback => readback.missingScores),
      experimentIds: recorded.map(item => item.experimentId), experimentId: recorded[0]?.experimentId ?? null, experimentUrl: recorded[0]?.url ?? null,
      failedItems: Object.entries(passesByItem).filter(([, passes]) => passes < trial.runs).map(([id]) => id),
    });
  }
  const asTrial = (verdict: FinalVerdict): Trial => {
    const trial = search.finals.find(item => item.candidate.model === verdict.model)!;
    return { ...trial, passes: verdict.passes, outcomes: trial.outcomes.map(outcome => ({ ...outcome, costUsd: verdict.costPerItemUsd })) };
  };
  finals.sort((a, b) => compareFinals(asTrial(a), asTrial(b)));
  // A stopped run has no recommendation: its finals are incomplete and listed only as evidence.
  const [recommendation = null, runnerUp = null] = search.status === "selected" ? finals : [];

  const all = [...search.trials, ...search.finals].flatMap(trial => trial.outcomes);
  const limitations = [
    search.limitation,
    "ECI is Epoch's published capability index. Models without a published score use ScoutBM's estimated or calibrated ECI from the bundled CSV, which carries 2–4 points of error; models with neither are not candidates (see `unranked`).",
    ...(lf ? [] : ["Langfuse is not connected: results were not recorded or verified in Langfuse."]),
    ...(search.shortfall ? [search.shortfall] : []),
    ...(search.status === "stopped" && finals.length ? [`The run stopped, so the ${finals.length} finals shown are partial and no model is recommended.`] : []),
    ...(search.unavailable.length ? [`${search.unavailable.length} candidates could not run (provider rejected the model or the balance did not cover it) and are untested: ${search.unavailable.map(item => item.model).join(", ")}.`] : []),
    ...(finals.some(item => item.localPasses !== item.passes) ? ["Langfuse and local pass counts differ for at least one finalist; Langfuse's count was used."] : []),
  ];
  return {
    scout: "OpenMerit Scout", runId, task: options.task, createdAt: new Date().toISOString(),
    dataset: { name: datasetName, source: options.dataset.langfuseDataset ? "langfuse" : "local", size: items.length, datasetId, url: project && datasetId ? `${lf!.baseUrl}/project/${project.projectId}/datasets/${datasetId}` : null },
    candidates: options.candidates.length,
    search: {
      status: search.status, ...(search.error ? { error: search.error } : {}), criterion: search.criterion, sampleIds: search.sampleIds, selected: search.selected, unavailable: search.unavailable,
      finalRule: search.finalRule, limitation: search.limitation, ...(search.shortfall ? { shortfall: search.shortfall } : {}),
      trials: search.trials.map(trial => ({
        stage: trial.stage, model: trial.candidate.model, eci: trial.candidate.eci, eciSource: trial.candidate.eciSource, passes: trial.passes, total: trial.outcomes.length,
        accepted: trial.accepted, costUsd: meanCost(trial.outcomes) === null ? null : meanCost(trial.outcomes)! * trial.outcomes.length, experimentUrl: urls.get(trial)?.[0]?.url ?? null,
      })),
    },
    finals, recommendation, runnerUp,
    why: explain(search, recommendation, runnerUp),
    spend: { measuredUsd: all.reduce((sum, item) => sum + (item.costUsd ?? 0), 0), unknownCostItems: all.filter(item => typeof item.costUsd !== "number").length, evaluations: all.length },
    langfuse: lf && project ? { baseUrl: lf.baseUrl, project: project.projectName, experiments: [...urls.values()].reduce((sum, list) => sum + list.length, 0) } : null,
    limitations,
  };
}

function explain(search: SearchResult, best: FinalVerdict | null, next: FinalVerdict | null): string {
  if (search.status === "stopped") return `The search stopped without a verdict: ${search.error}`;
  if (search.status === "no_passing_model") return `No candidate passed all ${search.sampleIds.length} sampled items, so Scout recommends none. Improve the prompt or harness, or check the labels.`;
  if (!best) return "No finalist was evaluated.";
  const cost = (value: number | null) => (value === null ? "unknown cost" : `$${value.toFixed(5)}/item`);
  const head = `${best.model} passed ${best.passes}/${best.total} item runs (${best.runs} per item) in Langfuse at ${cost(best.costPerItemUsd)} (ECI ${best.eci.toFixed(1)}).`;
  if (!next) return head;
  const tie = next.passes === best.passes;
  return `${head} ${tie ? "Tied on passes with" : "Ahead of"} ${next.model} (${next.passes}/${next.total}, ${cost(next.costPerItemUsd)})${tie ? `; ${best.costPerItemUsd !== null && next.costPerItemUsd !== null && best.costPerItemUsd !== next.costPerItemUsd ? "lower measured cost" : "lower ECI"} breaks the tie` : ""}.`;
}
