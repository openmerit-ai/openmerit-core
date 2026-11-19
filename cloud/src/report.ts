// A job's result and its report: scores and picks, never raw model outputs. The same result goes to
// the coding agent through openmerit_result, to /api/runs/:id as JSON, and to /api/r/:id.md as Markdown.
import type { CatalogueModel, ResolvedGuardrails } from "./engine.ts";
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
  /** `stopped`: the budget ran out before the finalists were measured; `failed`: a step failed for good. The report has what was measured until then. */
  status: "picked" | "keep_current" | "baseline_failed" | "no_cases" | "no_candidates" | "agent_eval_failed" | "stopped" | "failed";
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

/** A quoted string in code: double, single or backtick quotes, with escapes. */
const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

/**
 * The change that applies the pick. Each code ref's `spelling` is the code as written; only the string
 * literal in it that names a model is replaced, keeping its quotes and the code around it, such as an
 * environment variable it falls back from. A ref with no such literal gets an instruction instead.
 * OpenRouter needs the full catalogue ID; another endpoint gets the name it calls the model by.
 */
export function proposeEdit(bundle: TaskBundle, pick: Option, baselineEndpoint: string | null, find: (id: string) => CatalogueModel | null): JobResult["edit"] {
  const id = pick.endpoint === "openrouter" ? pick.model : pick.endpointModel;
  const current = find(bundle.current.model)?.id ?? bundle.current.model;
  const names = (text: string) => find(text)?.id ?? (text.toLowerCase() === bundle.current.model.toLowerCase() ? current : null);
  const edits: Edit[] = [];
  const notes: string[] = [];
  let fallback = false;
  for (const ref of bundle.codeRefs ?? []) {
    // An older client sends the model ID alone, without its quotes: that is the literal's text.
    const unquoted = !/["'`]/.test(ref.spelling) && names(ref.spelling.trim()) !== null;
    const literal = unquoted ? null : [...ref.spelling.matchAll(LITERAL)].find(match => names(match[2]!) !== null);
    if (!unquoted && !literal) {
      notes.push(`\`${ref.file}:${ref.line}\` (\`${ref.spelling}\`) holds no model ID string, so it is not edited: set the model it gives ${bundle.task} to \`${id}\` where that value comes from.`);
      continue;
    }
    const text = unquoted ? ref.spelling.trim() : literal![2]!;
    if (names(text) !== current) fallback = true;
    const after = unquoted ? ref.spelling.replace(text, id) : `${ref.spelling.slice(0, literal!.index)}${literal![1]}${id}${literal![1]}${ref.spelling.slice(literal!.index + literal![0].length)}`;
    if (after !== ref.spelling) edits.push({ file: ref.file, line: ref.line, before: ref.spelling, after });
  }
  const moves = baselineEndpoint !== null && pick.endpoint !== baselineEndpoint;
  const parts = [
    !edits.length && !notes.length ? `Set the model for ${bundle.task} to \`${id}\`.` : null,
    ...notes,
    fallback ? `The code's literal is a fallback; production's model comes from elsewhere (for example an environment variable). Set it to \`${id}\`.` : null,
    moves ? `Call it on ${pick.endpoint === "openrouter" ? "OpenRouter (https://openrouter.ai/api/v1)" : `your endpoint ${pick.endpoint}`} instead of ${baselineEndpoint}.` : null,
  ].filter(Boolean);
  return { edits, instructions: parts.length ? parts.join(" ") : null };
}

/** What the coding agent and the app read beside a result: the one-line reason, and whether each top model is cheaper per call than the current one. */
export function explain(result: JobResult): { reason: string; top: (MeasuredModel & { cheaperThanCurrent: boolean | null })[] } {
  const baseline = result.baseline;
  return {
    reason: reasonFor(result, baseline?.model ?? "the current model"),
    top: result.top.map(item => ({ ...item, cheaperThanCurrent: baseline?.costPerCallUsd == null || item.costPerCallUsd === null ? null : item.costPerCallUsd < baseline.costPerCallUsd })),
  };
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
