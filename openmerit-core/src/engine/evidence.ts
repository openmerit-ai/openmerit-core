// What is known about one task, merged from every connection, each piece with the connection it
// came from; and the quality rule that picks the strongest evidence for each decision:
// - graders, strongest first: the customer's own eval or scorer, expected outputs, parity with
//   recorded answers, user-confirmed labels, a judge, then the answers a case writer wrote;
// - cases: real ones (examples, dataset items, traces) before written ones;
// - which task first: recorded spend before the agent's request.
// The report's "Based on" lines say which evidence each decision used.
import type { CodeRef } from "./change.ts";

/** Where a piece of evidence came from: a connection, and what in it. */
export interface Source { connector: string; detail: string }

export interface Evidence<T> { value: T; source: Source }

export type GraderKind = "customer_eval" | "expected_output" | "parity" | "confirmed_label" | "judge" | "written_answer";
/** Strongest first. */
export const GRADER_STRENGTH: readonly GraderKind[] = ["customer_eval", "expected_output", "parity", "confirmed_label", "judge", "written_answer"];

export interface Grader { kind: GraderKind; description: string }
export interface Cases { kind: "real" | "written"; count: number; description: string }
export type Priority = { kind: "spend"; usdPerMonth: number } | { kind: "request" };

export interface TaskEvidence {
  task: string;
  currentModel: string;
  graders: Evidence<Grader>[];
  cases: Evidence<Cases>[];
  priority: Evidence<Priority>[];
  /** Where the code names the model, for the change. */
  refs: Evidence<CodeRef>[];
}

/** One connection's evidence about a task, before it is merged. */
export type EvidencePart = Partial<Omit<TaskEvidence, "task" | "currentModel">>;

/** A task's evidence from every connection that knows it, in the order given. */
export function mergeEvidence(task: string, currentModel: string, parts: readonly EvidencePart[]): TaskEvidence {
  return {
    task, currentModel,
    graders: parts.flatMap(part => part.graders ?? []), cases: parts.flatMap(part => part.cases ?? []),
    priority: parts.flatMap(part => part.priority ?? []), refs: parts.flatMap(part => part.refs ?? []),
  };
}

export interface Chosen { grader: Evidence<Grader> | null; cases: Evidence<Cases>[]; priority: Evidence<Priority> | null }

/**
 * The quality rule: the strongest grader; the real cases, or the written ones when there are none
 * (both when the real ones are fewer than `minCases`); spend before the agent's request.
 */
export function strongest(evidence: TaskEvidence, minCases = 0): Chosen {
  const grader = [...evidence.graders].sort((a, b) => GRADER_STRENGTH.indexOf(a.value.kind) - GRADER_STRENGTH.indexOf(b.value.kind))[0] ?? null;
  const real = evidence.cases.filter(item => item.value.kind === "real");
  const written = evidence.cases.filter(item => item.value.kind === "written");
  const realCount = real.reduce((sum, item) => sum + item.value.count, 0);
  const cases = !real.length ? written : realCount < minCases ? [...real, ...written] : real;
  const priority = evidence.priority.find(item => item.value.kind === "spend") ?? evidence.priority[0] ?? null;
  return { grader, cases, priority };
}

const from = (source: Source) => `from ${source.connector}${source.detail ? ` (${source.detail})` : ""}`;

/** One "Based on" line for each decision the chosen evidence made. */
export function basedOn(chosen: Chosen): string[] {
  const lines: string[] = [];
  if (chosen.grader) lines.push(`Grader: ${chosen.grader.value.description}, ${from(chosen.grader.source)}.`);
  if (chosen.cases.length) lines.push(`Cases: ${chosen.cases.map(item => `${item.value.description} ${from(item.source)}`).join("; ")}.`);
  if (chosen.priority) lines.push(`Priority: ${chosen.priority.value.kind === "spend" ? `$${chosen.priority.value.usdPerMonth.toFixed(2)} a month of recorded spend` : "you asked about this task"}, ${from(chosen.priority.source)}.`);
  return lines;
}
