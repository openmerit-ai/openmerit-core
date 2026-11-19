// A job's result and its report: scores and picks, never raw model outputs. The same result goes to
// the coding agent through openmerit_result, to /api/runs/:id as JSON, and to /api/r/:id.md as Markdown.
import type { ResolvedGuardrails } from "./engine.ts";
import type { Option, Provisional } from "./pool.ts";
import type { TaskBundle } from "../../openmerit-core/src/ranking/index.ts";

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

export interface JobResult {
  /** `stopped`: the budget ran out before the finalists were measured; the report has what was measured until then. */
  status: "picked" | "keep_current" | "baseline_failed" | "no_cases" | "no_candidates" | "agent_eval_failed" | "stopped";
  pick: { model: string; endpoint: string; endpointModel: string; passes: number; total: number; costPerCallUsd: number | null; savingPerCallUsd: number | null } | null;
  /** Up to three qualified models, cheapest measured cost first. */
  top: MeasuredModel[];
  baseline: MeasuredModel | null;
  candidates: MeasuredModel[];
  search: { pool: number; unplaced: number; samples: string[]; finalists: string[]; challengers: string[]; shortfall: string | null };
  agentEval: AgentEvalSummary | null;
  edit: { edits: Edit[]; instructions: string | null };
  spend: { openmeritUsd: number; customerUsd: number };
  guardrails: ResolvedGuardrails;
  notices: string[];
  reportUrl: string;
  catalogueVersion: string;
  cases: { total: number; fromExamples: number; written: number };
}

/** The change that applies the pick: model-ID edits where the code names the current model, else instructions. */
export function proposeEdit(bundle: TaskBundle, pick: Option, baselineEndpoint: string | null): JobResult["edit"] {
  const bare = (id: string) => id.split("/").at(-1)!;
  const spell = (spelling: string) => (pick.endpoint !== "openrouter" ? pick.endpointModel : spelling.includes("/") ? pick.model : bare(pick.model));
  const edits = (bundle.codeRefs ?? []).map(ref => ({ file: ref.file, line: ref.line, before: ref.spelling, after: spell(ref.spelling) })).filter(edit => edit.before !== edit.after);
  const moves = baselineEndpoint !== null && pick.endpoint !== baselineEndpoint;
  const instructions = !edits.length || moves
    ? [
      !edits.length ? `Set the model for ${bundle.task} to \`${spell(bundle.current.model)}\`.` : null,
      moves ? `Call it on ${pick.endpoint === "openrouter" ? "OpenRouter (https://openrouter.ai/api/v1)" : `your endpoint ${pick.endpoint}`} instead of ${baselineEndpoint}.` : null,
    ].filter(Boolean).join(" ")
    : null;
  return { edits, instructions };
}

const usd = (value: number | null) => (value === null ? "unknown" : value < 0.01 ? `$${value.toFixed(5)}` : `$${value.toFixed(4)}`);
const rate = (passes: number, total: number) => (total ? `${passes}/${total} (${Math.round((passes / total) * 100)}%)` : "none");

/** One line saying what the run concluded and why, for the report and for the coding agent. */
export function reasonFor(result: JobResult, current: string): string {
  const pick = result.pick;
  if (pick) return `Switch from \`${current}\` to \`${pick.model}\` on ${pick.endpoint}: it passed ${rate(pick.passes, pick.total)} of the cases at ${usd(pick.costPerCallUsd)} a call${pick.savingPerCallUsd !== null ? `, ${usd(pick.savingPerCallUsd)} less than now` : ""}.`;
  if (result.status === "keep_current") {
    const best = result.top[0];
    const baseline = result.baseline;
    return best && baseline
      ? `Keep \`${current}\`: ${best.model} passed ${best.passes}/${best.total} but costs ${usd(best.costPerCallUsd)} per call against ${usd(baseline.costPerCallUsd)}, and no measured model was both as accurate and cheaper.`
      : `Keep \`${current}\`: no cheaper model passed as many cases${baseline ? ` as its ${baseline.passes}/${baseline.total}` : ""}.`;
  }
  return {
    baseline_failed: `\`${current}\` could not be measured or passed none of the cases, so there is nothing to compare against.`,
    no_cases: "No case has a known correct answer, so nothing was measured.",
    no_candidates: "No allowed model is cheaper than the current one.",
    agent_eval_failed: "Every qualified switch failed the agent's eval, so none is proposed.",
    stopped: "The run stopped at its budget before the finalists were measured, so it proposes no switch. The models below are what it measured until then.",
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
  lines.push("", "## Models", "", "| Model | Endpoint | Paid by | Stage | Passed | Cost per call | Latency | Qualified |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const item of [result.baseline, ...result.candidates].filter((value): value is MeasuredModel => value !== null)) {
    lines.push(`| \`${item.model}\`${item.inCatalogue ? "" : " (measured only)"} | ${item.endpoint} | ${item.funding === "openmerit" ? "OpenMerit" : "you"} | ${item.stage} | ${item.status === "unavailable" ? "unavailable" : rate(item.passes, item.total)} | ${usd(item.costPerCallUsd)}${item.costIsEstimate ? " (estimate)" : ""} | ${item.latencyMs === null ? "–" : `${item.latencyMs} ms`} | ${item.role === "baseline" ? "current" : item.qualified ? "yes" : "no"} |`);
  }
  lines.push("", `Searched ${result.search.pool} ranked models${result.search.unplaced ? ` and ${result.search.unplaced} placed by measurement only` : ""} on ${result.search.samples.length} sample cases, then finalists and challengers on all ${result.cases.total} cases (${result.cases.fromExamples} from your examples, ${result.cases.written} written).`);
  if (result.search.shortfall) lines.push("", result.search.shortfall);
  if (result.agentEval) lines.push("", "## Agent eval", "", result.agentEval.status === "missing" ? result.agentEval.warning ?? "The agent has no eval." : `${result.agentEval.passed ? "Passed" : "Failed"}: the agent passed ${result.agentEval.baseline ? rate(result.agentEval.baseline.passes, result.agentEval.baseline.total) : "?"} with its current models.`);
  lines.push("", "## Spend", "", `OpenMerit-paid ${usd(result.spend.openmeritUsd)}, paid on your endpoints ${usd(result.spend.customerUsd)}.`);
  const from = Object.entries(result.guardrails.from);
  if (from.length) lines.push("", "## Guardrails", "", ...from.map(([key, level]) => `- ${key}: ${JSON.stringify((result.guardrails.effective as Record<string, unknown>)[key])}, from the ${level} level`));
  if (result.guardrails.rejected.length) lines.push("", "Not applied:", ...result.guardrails.rejected.map(item => `- ${item.key} at the ${item.level} level: ${item.reason}`));
  if (result.notices.length) lines.push("", "## Notes", "", ...result.notices.map(notice => `- ${notice}`));
  return `${lines.join("\n")}\n`;
}
