// The agent-eval rule. A task's eval asks whether one call still does its job; an agent's eval asks
// whether the whole agent still gets the right outcome. Agent cases are expensive, so the agent
// eval takes no part in the binary search. After each task's search:
// 1. Check the task's pick with every other task unchanged, then, while it fails, its next finalists
//    in order. A switch passes when the agent passes at least as many case runs as with its current
//    models, and meets the agent's minimum pass rate.
// 2. When more than one task switches, check all the passing switches together. If they fail
//    together, keep the largest saving first and add each next one only when the agent still passes
//    with it; the rest are reported as not compatible.

export interface AgentRun { results: { caseId: string; pass: boolean }[]; costUsd: number }
export interface AgentScore { passes: number; total: number; costUsd: number }
/** A model option for one task, with what switching to it saves (any unit, compared across tasks). */
export interface AgentOption { key: string; savingUsd: number }
export interface Switch<O extends AgentOption> { task: string; option: O; score: AgentScore | null }

export interface AgentEvalInput<O extends AgentOption> {
  /** Each task's options: its pick first, then the finalists to fall back to, in order. */
  tasks: readonly { task: string; options: readonly O[] }[];
  /** Runs the whole agent on its cases with these tasks switched; other tasks keep their current model. Null when the agent has no eval. */
  measure: ((assignment: ReadonlyMap<string, O>) => Promise<AgentRun>) | null;
  /** The agent's minimum pass rate, 0 to 1. */
  minPassRate?: number;
  /** Without an agent eval: propose each pick with a warning, or propose nothing. */
  required?: "warn" | "required";
}

export interface AgentEvalResult<O extends AgentOption> {
  /** missing: the agent has no eval (or it ran no cases), so no switch was checked. */
  status: "checked" | "missing";
  /** The agent with every task on its current model. */
  baseline: AgentScore | null;
  tasks: { task: string; accepted: O | null; tried: { option: O; score: AgentScore; passed: boolean }[] }[];
  /** The switches to propose, largest saving first. */
  proposed: Switch<O>[];
  /** Switches that passed alone but failed with the proposed ones. */
  incompatible: Switch<O>[];
  /** The proposed switches run together; null when fewer than two are proposed. */
  together: AgentScore | null;
  warning?: string;
}

const score = (run: AgentRun): AgentScore => ({ passes: run.results.filter(item => item.pass).length, total: run.results.length, costUsd: run.costUsd });
const bySaving = <O extends AgentOption>(a: Switch<O>, b: Switch<O>) => b.option.savingUsd - a.option.savingUsd || a.task.localeCompare(b.task);

export async function checkAgent<O extends AgentOption>(input: AgentEvalInput<O>): Promise<AgentEvalResult<O>> {
  const minPassRate = input.minPassRate ?? 0;
  const baselineRun = input.measure ? score(await input.measure(new Map())) : null;
  if (!input.measure || !baselineRun?.total) {
    const picks = input.tasks.flatMap(item => (item.options[0] ? [{ task: item.task, option: item.options[0], score: null }] : [])).sort(bySaving);
    const required = input.required === "required";
    return {
      status: "missing", baseline: baselineRun, tasks: input.tasks.map(item => ({ task: item.task, accepted: null, tried: [] })),
      proposed: required ? [] : picks, incompatible: [], together: null,
      warning: required ? "The agent has no eval, and the guardrails require one, so no switch is proposed." : "The agent has no eval, so these switches were checked only by their tasks' evals.",
    };
  }
  const measure = input.measure, baseline = baselineRun;
  const passes = (result: AgentScore) => result.passes >= baseline.passes && result.passes / result.total >= minPassRate - 1e-9;

  const tasks: AgentEvalResult<O>["tasks"] = [];
  const accepted: Switch<O>[] = [];
  for (const { task, options } of input.tasks) {
    const tried: AgentEvalResult<O>["tasks"][number]["tried"] = [];
    let chosen: Switch<O> | null = null;
    for (const option of options) {
      const result = score(await measure(new Map([[task, option]])));
      tried.push({ option, score: result, passed: passes(result) });
      if (passes(result)) { chosen = { task, option, score: result }; break; }
    }
    tasks.push({ task, accepted: chosen?.option ?? null, tried });
    if (chosen) accepted.push(chosen);
  }
  accepted.sort(bySaving);
  if (accepted.length < 2) return { status: "checked", baseline, tasks, proposed: accepted, incompatible: [], together: null };

  const assignment = (switches: readonly Switch<O>[]) => new Map(switches.map(item => [item.task, item.option]));
  const all = score(await measure(assignment(accepted)));
  if (passes(all)) return { status: "checked", baseline, tasks, proposed: accepted, incompatible: [], together: all };

  const [first, ...rest] = accepted;
  const kept = [first!], incompatible: Switch<O>[] = [];
  let together: AgentScore | null = null;
  for (const next of rest) {
    const result = score(await measure(assignment([...kept, next])));
    if (passes(result)) { kept.push(next); together = result; } else incompatible.push(next);
  }
  return { status: "checked", baseline, tasks, proposed: kept, incompatible, together };
}
