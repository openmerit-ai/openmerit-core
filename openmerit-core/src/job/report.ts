// A job's result and its report: scores and picks, never raw model outputs. The same result goes to
// the coding agent through openmerit_result, to /api/runs/:id as JSON, and to /api/r/:id.md as Markdown.
import type { CatalogueModel, ResolvedGuardrails } from "../engine/index.ts";
import { agentBundle } from "../connectors/agent-bundle.ts";
import { OPENROUTER, type Option, type Provisional } from "./pool.ts";
import type { TaskBundle } from "../ranking/index.ts";

export interface MeasuredModel {
  model: string;
  endpoint: string;
  endpointModel: string;
  role: "baseline" | "candidate";
  /** How the search reached it. */
  stage: "baseline" | "search" | "neighbour" | "challenger";
  eci: number | null;
  /** False for a model outside the catalogue, placed by measurement only. */
  inCatalogue: boolean;
  funding: "openmerit" | "customer";
  status: "measured" | "screened_out" | "unavailable";
  passes: number;
  total: number;
  costPerCallUsd: number | null;
  costIsEstimate: boolean;
  latencyMs: number | null;
  qualified: boolean;
  note: string;
}

export interface Edit { file: string; line: number; before: string; after: string }

export interface AgentEvalSummary { status: "checked" | "missing"; passed: boolean; warning: string | null; baseline: { passes: number; total: number } | null; tried: { model: string; passes: number; total: number; passed: boolean }[] }

/**
 * What fixes one of a result's notices, which it names by its exact text. raise_budget sets the task's
 * budget per job and runs again; rerun runs again; open is a page at app.openmerit.ai, such as
 * Connections; ask_agent is an instruction for the coding agent, which only it can carry out.
 */
export type Fix =
  | { kind: "raise_budget"; notice: string; budgetUsd: number }
  | { kind: "rerun"; notice: string }
  | { kind: "open"; notice: string; label: string; path: string }
  | { kind: "ask_agent"; notice: string; prompt: string };

export interface JobResult {
  /** `stopped`: the budget ran out before the finalists were measured; `failed`: a step failed for good. The report has what was measured until then. */
  /** `below_floor`: the current model passed under 80% of its own eval, which therefore cannot tell models apart. */
  /** `not_accepted`: after the last round of the grading loop, the eval still disagreed with a person's grades. */
  status: "picked" | "keep_current" | "baseline_failed" | "below_floor" | "no_cases" | "no_candidates" | "agent_eval_failed" | "not_accepted" | "stopped" | "failed";
  /** Up to 20 cases the current model failed, each with the grader's one redacted sentence. Absent from reports saved before it was added. */
  failedCases?: { caseId: string; kind: string; reason: string }[];
  /** Cases no model was measured on, because the eval has no mocked result for one of the task's tools; the case writer fixes them. Absent from older reports. */
  invalidCases?: { caseId: string; reason: string }[];
  /** The current model's passes per kind of case: typical, edge, guardrail, example. Absent from older reports. */
  baselineByKind?: { kind: string; passes: number; total: number }[];
  pick: { model: string; endpoint: string; endpointModel: string; passes: number; total: number; costPerCallUsd: number | null; savingPerCallUsd: number | null } | null;
  /** Up to three qualified models, cheapest measured cost first. */
  top: MeasuredModel[];
  /** Measured models that missed the current model's pass rate by at most one case per run. Absent from reports saved before it was added. */
  nearMisses?: MeasuredModel[];
  baseline: MeasuredModel | null;
  candidates: MeasuredModel[];
  search: { pool: number; unplaced: number; samples: string[]; finalists: string[]; challengers: string[]; shortfall: string | null };
  agentEval: AgentEvalSummary | null;
  edit: { edits: Edit[]; instructions: string | null };
  spend: { openmeritUsd: number; customerUsd: number };
  guardrails: ResolvedGuardrails;
  notices: string[];
  /** Fixes for some of the notices. Absent from reports saved before they were added. */
  fixes?: Fix[];
  reportUrl: string;
  catalogueVersion: string;
  cases: { total: number; fromExamples: number; written: number };
  /** The eval version the run measured on; runs on different versions are not comparable. Absent from reports saved before evals had versions. */
  evalVersion?: number;
  /** The evidence each decision used, by openmerit/engine's quality rule, such as "Grader: the expected labels of your examples, from agent-bundle". Absent from reports saved before it was added. */
  basedOn?: string[];
  /**
   * The grading loop, when a person graded the run's answers: how many rounds it took, whether they
   * accepted the eval, and the bar the result was measured against. With the `criteria` bar the pick is
   * the cheapest model that meets the eval's checks, even when it costs more, and `summary` says so in
   * one sentence. Absent when nobody graded, as for watch jobs and evals OpenMerit wrote no case of.
   */
  grading?: { rounds: number; accepted: boolean; bar: "current" | "criteria"; failedChecks: string[]; summary: string | null };
  /** The question that asks a person to approve the switch, as the CLI asks it; null with no pick. Absent from older reports. */
  approval?: { id: string; kind: "confirm"; default: false; prompt: string; detail: string } | null;
}

/** The change that applies the pick: the agent bundle connector's Change port, openmerit/engine's `proposeEdit` on the bundle's code refs, which the CLI's Configure step uses too. */
export function proposeEdit(bundle: TaskBundle, pick: Option, baselineEndpoint: string | null, find: (id: string) => CatalogueModel | null): JobResult["edit"] {
  const change = agentBundle({ bundle, baselineEndpoint, find }).change.propose(bundle.task, { model: pick.model, endpoint: pick.endpoint, endpointModel: pick.endpointModel, onOpenRouter: pick.endpoint === OPENROUTER });
  return { edits: change.edits.map(({ file, line, before, after }) => ({ file, line, before, after })), instructions: change.instructions };
}

/** What the coding agent and the app read beside a result: the one-line reason, and whether each top model is cheaper per call than the current one. */
export function explain(result: JobResult): { reason: string; top: (MeasuredModel & { cheaperThanCurrent: boolean | null })[]; nearMisses: (MeasuredModel & { cheaperThanCurrent: boolean | null })[] } {
  const baseline = result.baseline;
  const cheaper = (item: MeasuredModel) => ({ ...item, cheaperThanCurrent: baseline?.costPerCallUsd == null || item.costPerCallUsd === null ? null : item.costPerCallUsd < baseline.costPerCallUsd });
  return { reason: reasonFor(result, baseline?.model ?? "the current model"), top: result.top.map(cheaper), nearMisses: (result.nearMisses ?? []).map(cheaper) };
}

/** The near misses in one sentence, or null when there are none. */
export function nearMissLine(result: JobResult): string | null {
  const misses = result.nearMisses ?? [];
  if (!misses.length || !result.baseline) return null;
  return `Near misses, within one case per run of the current model's ${result.baseline.passes}/${result.baseline.total}: ${misses.map(item => `\`${item.model}\` passed ${item.passes}/${item.total} at ${usd(item.costPerCallUsd)} a call`).join("; ")}.`;
}

const usd = (value: number | null) => (value === null ? "unknown" : value < 0.01 ? `$${value.toFixed(5)}` : `$${value.toFixed(4)}`);
const rate = (passes: number, total: number) => (total ? `${passes}/${total} (${Math.round((passes / total) * 100)}%)` : "none");

/** One line saying what the run concluded and why, for the report and for the coding agent. */
export function reasonFor(result: JobResult, current: string): string {
  const pick = result.pick;
  if (pick) return `Switch from \`${current}\` to \`${pick.model}\` on ${pick.endpoint}: it passed ${rate(pick.passes, pick.total)} of the cases at ${usd(pick.costPerCallUsd)} a call${pick.savingPerCallUsd !== null ? pick.savingPerCallUsd < 0 ? `, ${usd(-pick.savingPerCallUsd)} more than now` : `, ${usd(pick.savingPerCallUsd)} less than now` : ""}.${result.grading?.summary ? ` ${result.grading.summary}` : ""}`;
  if (result.status === "keep_current") {
    if (result.grading?.bar === "criteria" && result.grading.summary) return `Keep \`${current}\`: ${result.grading.summary}`;
    const best = result.top[0];
    const baseline = result.baseline;
    return best && baseline
      ? `Keep \`${current}\`: ${best.model} passed ${best.passes}/${best.total} but costs ${usd(best.costPerCallUsd)} per call against ${usd(baseline.costPerCallUsd)}, and no measured model was both as accurate and cheaper.`
      : `Keep \`${current}\`: no cheaper model passed as many cases${baseline ? ` as its ${baseline.passes}/${baseline.total}` : ""}.`;
  }
  return {
    baseline_failed: `\`${current}\` could not be measured or passed none of the cases, so there is nothing to compare against.`,
    below_floor: `\`${current}\` passed under 80% of its own eval, so the eval cannot tell models apart and no model is recommended. Its failed cases say why.`,
    no_cases: "No case has a known correct answer, so nothing was measured.",
    no_candidates: "No allowed model is cheaper than the current one.",
    agent_eval_failed: "Every qualified switch failed the agent's eval, so none is proposed.",
    not_accepted: "After the last round of grading, the eval still disagreed with your grades, so no model is recommended. Run the task again to start over.",
    stopped: "The run stopped at its budget before the finalists were measured, so it proposes no switch. The models below are what it measured until then.",
    failed: "The run failed before it finished, so it proposes no switch. The models below are what it measured until then.",
    picked: "",
  }[result.status];
}

export function renderMarkdown(input: { jobId: string; bundle: TaskBundle; result: JobResult; provisional: Provisional | null; createdAt: string }): string {
  const { result, bundle } = input;
  const lines = [
    `# OpenMerit report: ${bundle.task}`, "",
    `Job \`${input.jobId}\`, ${input.createdAt}. Catalogue ${result.catalogueVersion}.`, "",
    "## Result", "",
  ];
  lines.push(reasonFor(result, bundle.current.model));
  if (result.edit.edits.length) lines.push("", "Edits:", ...result.edit.edits.map(edit => `- \`${edit.file}:${edit.line}\`: \`${edit.before}\` → \`${edit.after}\``));
  if (result.edit.instructions) lines.push("", result.edit.instructions);
  if (result.failedCases?.length) lines.push("", `## Cases \`${bundle.current.model}\` failed`, "", ...result.failedCases.map(item => `- \`${item.caseId}\` (${item.kind}): ${item.reason}`));
  if (result.invalidCases?.length) lines.push("", "## Cases left out", "", "The eval cannot run these cases for any model, so they count in no pass rate:", "", ...result.invalidCases.map(item => `- \`${item.caseId}\`: ${item.reason}`));
  lines.push("", "## Models", "", "| Model | Endpoint | Paid by | Stage | Passed | Cost per call | Latency | Qualified |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const item of [result.baseline, ...result.candidates].filter((value): value is MeasuredModel => value !== null)) {
    lines.push(`| \`${item.model}\`${item.inCatalogue ? "" : " (measured only)"} | ${item.endpoint} | ${item.funding === "openmerit" ? "OpenMerit" : "you"} | ${item.stage} | ${item.status === "unavailable" ? "unavailable" : rate(item.passes, item.total)} | ${usd(item.costPerCallUsd)}${item.costIsEstimate ? " (estimate)" : ""} | ${item.latencyMs === null ? "–" : `${item.latencyMs} ms`} | ${item.role === "baseline" ? "current" : item.qualified ? "yes" : "no"} |`);
  }
  lines.push("", `Searched ${result.search.pool} ranked models${result.search.unplaced ? ` and ${result.search.unplaced} placed by measurement only` : ""} on ${result.search.samples.length} sample cases, then finalists and challengers on all ${result.cases.total} cases (${result.cases.fromExamples} from your examples, ${result.cases.written} written).`);
  const misses = nearMissLine(result);
  if (misses) lines.push("", misses);
  if (result.search.shortfall) lines.push("", result.search.shortfall);
  if (result.basedOn?.length) lines.push("", "Based on:", ...result.basedOn.map(line => `- ${line}`));
  if (result.agentEval) lines.push("", "## Agent eval", "", result.agentEval.status === "missing" ? result.agentEval.warning ?? "The agent has no eval." : `${result.agentEval.passed ? "Passed" : "Failed"}: the agent passed ${result.agentEval.baseline ? rate(result.agentEval.baseline.passes, result.agentEval.baseline.total) : "?"} with its current models.`);
  lines.push("", "## Spend", "", `OpenMerit-paid ${usd(result.spend.openmeritUsd)}, paid on your endpoints ${usd(result.spend.customerUsd)}.`);
  const from = Object.entries(result.guardrails.from);
  if (from.length) lines.push("", "## Guardrails", "", ...from.map(([key, level]) => `- ${key}: ${JSON.stringify((result.guardrails.effective as Record<string, unknown>)[key])}, from the ${level} level`));
  if (result.guardrails.rejected.length) lines.push("", "Not applied:", ...result.guardrails.rejected.map(item => `- ${item.key} at the ${item.level} level: ${item.reason}`));
  if (result.notices.length) lines.push("", "## Notes", "", ...result.notices.map(notice => `- ${notice}`));
  return `${lines.join("\n")}\n`;
}
