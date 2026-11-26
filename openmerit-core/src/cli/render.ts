// Plain-text rendering of Scout results and history for the terminal.
import type { RunRow, State } from "../state/db.ts";
import { logTail, type ModelResult, type SearchSummary, type Step, type TaskComparison } from "../scout/workflow.ts";

// Two significant digits below a cent, so per-item costs such as $0.000023 and $0.0000088 stay apart.
const money = (value: number | null, estimate = false) => (value === null ? "unknown" : `${estimate ? "~" : ""}$${value.toFixed(value > 0 && value < 0.01 ? Math.min(10, 1 - Math.floor(Math.log10(value))) : 4)}`);
const pad = (rows: string[][]) => {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => (row[column] ?? "").length)));
  return rows.map(row => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()).join("\n");
};

function row(label: string, result: ModelResult): string[] {
  return [label, result.model, result.endpoint, result.total ? `${result.passes}/${result.total}` : "—", money(result.costPerItemUsd, result.costIsEstimate),
    result.meanLatencyMs === null ? "—" : `${Math.round(result.meanLatencyMs)} ms`, result.status === "measured" ? (result.role === "baseline" ? "baseline" : result.qualified ? "qualifies" : result.note || "below baseline") : result.note];
}

export function renderComparison(task: TaskComparison, runId?: string): string {
  if (task.status === "no_eval") return [`Task "${task.task}"`, `  Not reviewed: ${task.note}`].join("\n");
  const lines = [`Task "${task.task}"`, `  Eval: ${task.eval.command || "none"} (${task.eval.source}; per-item results reported by the eval${task.eval.threshold !== null ? `; required pass rate ${task.eval.threshold}` : ""})`];
  if (task.search) lines.push(...renderSearch(task.search));
  const header = ["", "Model", "Endpoint", "Passed", "Cost/item", "Latency/request", "Status"];
  const table = [header, ...(task.baseline ? [row("Current", task.baseline)] : []), ...task.top.map((result, index) => row(`#${index + 1}`, result))];
  lines.push(pad(table).split("\n").map(line => `  ${line}`).join("\n"));
  const others = task.candidates.filter(item => !task.top.includes(item) && !task.top.some(top => top.model === item.model));
  if (others.length) lines.push("  Other candidates:", pad([header, ...others.map(item => row("", item))]).split("\n").slice(1).map(line => `  ${line}`).join("\n"));
  lines.push(`  ${task.status === "ranked" ? "Top 3 cheapest models at least as good as the current model, measured on the same eval." : task.status === "no_qualified" ? "No finalist performed at least as well as the current model." : task.status === "non_discriminating" ? "The eval did not separate the models." : ""} ${task.note}`.trimEnd());
  if (task.top.some(item => item.costIsEstimate) || task.baseline?.costIsEstimate) lines.push("  ~ cost estimated from list prices and reported tokens; the endpoint does not report cost.");
  lines.push(`  Evidence: openmerit history ${runId ?? "<run id>"} lists every eval run: screens, retries and full runs.`);
  return lines.join("\n");
}

/** The search path: each screen, in order, with its result on the sampled items. */
export function renderSearch(search: SearchSummary): string[] {
  const pool = `${search.pool} ECI-ranked candidates${search.unranked ? ` (${search.unranked} without an ECI left out)` : ""}`;
  // A search that stopped on the current model never drew its screening items.
  const lines = [search.sampleIds.length ? `  Scout Model Binary Search over ${pool}, screening on ${search.sampleIds.length} items the current model passes:` : `  Scout Model Binary Search over ${pool}: stopped before screening any candidate.`];
  if (search.anyPrice) lines.push("    Candidates at any price: you marked the current model's answer wrong, so models that cost more than it are searched too.");
  for (const trial of search.trials) lines.push(`    ${trial.stage.padEnd(10)} ${trial.model} (ECI ${trial.eci.toFixed(1)}): ${trial.passes}/${trial.total} ${trial.accepted ? "pass" : "fail"}`);
  for (const item of search.skipped) lines.push(`    skipped    ${item.model} at ${item.stage}: ${item.reason.split("\n")[0]}`);
  if (search.pick) lines.push(`    Weakest passing model: ${search.pick}. Finalists: ${search.finalists.join(", ") || "none"}${search.challengers.length ? `. Challengers: ${search.challengers.join(", ")}` : ""}.`);
  if (search.shortfall) lines.push(`    ${search.shortfall}`);
  return lines;
}

/** The run's outcome; `comparisons: false` leaves out the task comparisons, such as when they were shown already. */
export function renderStep(step: Step, options: { comparisons?: boolean } = {}): string {
  const lines: string[] = [];
  if (step.result && options.comparisons !== false) for (const task of step.result.tasks) lines.push(renderComparison(task, step.runId), "");
  for (const [task, configure] of Object.entries(step.result?.configuration ?? {})) {
    if (configure.decision === "no") lines.push(`"${task}": not configured; your application configuration is unchanged.`);
    else if (configure.applied) lines.push(`"${task}": configured (${configure.edits!.map(edit => `${edit.file}:${edit.line}`).join(", ")}).`);
    for (const item of configure.manual ?? []) lines.push(`"${task}" manual step: ${item}`);
  }
  lines.push(spendLine(step));
  if (step.status !== "done") lines.push(`Run ${step.runId}: ${step.status} at ${step.phase}${step.error ? ` — ${step.error}` : ""}. Resume with: openmerit scout --resume ${step.runId}`);
  else lines.push(`Run ${step.runId} saved. See it again with: openmerit history ${step.runId}`);
  return lines.join("\n");
}

export function spendLine(step: Pick<Step, "spend" | "budgetUsd" | "harnessUsage">): string {
  const spend = step.spend;
  const harness = step.harnessUsage;
  return `Eval spend: $${spend.totalUsd.toFixed(4)} of $${step.budgetUsd.toFixed(2)} over ${spend.requests} requests${spend.estimatedUsd ? ` ($${spend.estimatedUsd.toFixed(4)} estimated from list prices)` : ""}${spend.inFlight ? `, $${spend.inFlightUsd.toFixed(4)} reserved for ${spend.inFlight} request(s) of unknown cost` : ""}${spend.unknown ? `, ${spend.unknown} unpriced` : ""}.`
    + (harness ? ` Harness inference (separate from the eval budget): ${harness.calls} calls, ${harness.inputTokens + harness.outputTokens} tokens${harness.costUsd ? `, $${harness.costUsd.toFixed(4)}` : ""}${harness.unknownCost ? ` (${harness.unknownCost} calls billed by your coding-agent plan)` : ""}.` : "");
}

/** A run's selected tasks, cut to one short cell; `openmerit history <run>` lists them all. */
function tasksCell(selected: string[]): string {
  const text = selected.join(", ");
  return !text ? "—" : text.length <= 40 ? text : `${text.slice(0, 39)}… (${selected.length})`;
}

export function renderHistory(state: State, runs: RunRow[]): string {
  if (!runs.length) return "No Scout runs in this repository yet. Start one with: openmerit scout";
  return pad([["Run", "Started", "Status", "Phase", "Model", "Tasks", "Eval spend", "openmerit / catalogue"], ...runs.map(run => {
    const data = run.state as { model?: string; selected?: string[] };
    return [run.id, run.createdAt.slice(0, 16).replace("T", " "), run.status, run.phase, data.model ?? "—", tasksCell(data.selected ?? []), `$${state.spend(run.id).totalUsd.toFixed(4)} / $${run.budgetUsd.toFixed(2)}`, `${run.packageVersion} / ${run.catalogueVersion}`];
  })]);
}

export function renderRun(state: State, run: RunRow, step: Step): string {
  const section = (title: string, lines: string[], none: string) => ["", title, ...(lines.length ? lines : [`  ${none}`])];
  const lines = [
    `Run ${run.id} (${run.status === "done" ? "done" : `${run.status} at ${run.phase}`})`, `  Repository ${run.repoRoot} at ${run.revision ?? "no commit"}`,
    `  openmerit ${run.packageVersion}, catalogue ${run.catalogueVersion}, harness ${run.harness}`, "",
    renderStep(step),
    ...section("Eval runs:", state.units(run.id).map(unit => `  ${unit.status.padEnd(13)} ${unit.task} · ${unit.role} ${unit.model} on ${unit.endpoint} · run ${unit.repeat} · ${unit.attempts} attempt(s) · ${money(state.spend(run.id, unit.id).totalUsd)}${typeof unit.result?.total === "number" ? ` · ${String(unit.result.passes)}/${String(unit.result.total)} passed` : ""}${unit.error ? ` · ${unit.error.split("\n")[0]}${unit.status === "failed" ? logTail(unit.error) : ""}` : ""}`), "none"),
    ...section("Budget:", state.budgetEvents(run.id).map(event => `  ${event.at.slice(0, 19)} ${event.kind}${event.toUsd !== null ? ` $${event.fromUsd.toFixed(2)} → $${event.toUsd.toFixed(2)} (${event.scope})` : ` at $${event.spentUsd.toFixed(4)} of $${event.fromUsd.toFixed(2)}`}`), `$${run.budgetUsd.toFixed(2)} for this run; not reached or changed.`),
    ...section("Decisions:", state.decisions(run.id).map(decision => `  ${decision.at.slice(0, 19)} ${decision.kind}: ${decision.decision}${decision.kind === "configure" && (decision.detail as { diff?: string }).diff ? `\n${(decision.detail as { diff: string }).diff.split("\n").map(line => `    ${line}`).join("\n")}` : ""}`), "none"),
    ...section("Events:", state.events(run.id).map(event => `  ${event.at.slice(0, 19)} ${event.kind}: ${event.message}`), "none"),
  ];
  return lines.join("\n");
}
