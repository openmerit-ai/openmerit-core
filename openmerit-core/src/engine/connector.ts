// Connections: each declares which ports it fills, and the core runs the same flow for all of them,
// connect, list, evaluate, approve. Connections read only by default; writing through one is a
// separate opt-in (`writes`), and nothing changes until a person approves the change.
import type { ProposedChange, EditTarget } from "./change.ts";
import type { EvaluateInput } from "./evaluate.ts";
import type { EvidencePart } from "./evidence.ts";
import type { Rung } from "./search.ts";

/**
 * - `list`: the tasks the connection can see, with their current model (the Source port).
 * - `evidence`: prompts, cases, graders, spend and code refs about a task.
 * - `measure`: runs a model on a task's cases (the Measure port).
 * - `change`: proposes, and once approved records, the change that applies a pick (the Change port).
 */
export type Capability = "list" | "evidence" | "measure" | "change";

/** A task a connection can see. `skipped` says why it cannot be measured, such as "script task, no model". */
export interface ListedTask { name: string; currentModel: string | null; skipped?: string }

export interface Connector {
  /** The connection's kind, as evidence sources name it, such as `eval-command`. */
  id: string;
  capabilities: readonly Capability[];
  /** Whether it may write through the connection once a change is approved. False unless the user opted in. */
  writes: boolean;
  list?: () => ListedTask[] | Promise<ListedTask[]>;
  evidence?: (task: string) => EvidencePart | Promise<EvidencePart>;
  measure?: MeasurePort<Rung>;
  change?: ChangePort;
}

/** The Measure port: `evaluateTask`'s measure and sample, which a connection that can run models fills. */
export type MeasurePort<T extends Rung> = Pick<EvaluateInput<T>, "measure" | "sample">;

/** Who approved a change, and when (ISO 8601). */
export interface Approval { by: string; at: string }

export interface ApprovedChange extends ProposedChange { target: EditTarget; approval: Approval }

/** The Change port: the change that applies a pick; `apply` exists only on a connection that writes. */
export interface ChangePort {
  /** The change that switches `task` to `target`. */
  propose: (task: string, target: EditTarget) => ProposedChange;
  apply?: (change: ApprovedChange) => Promise<void>;
}

/** Records a person's approval of a change. Nothing is applied: a writing connection applies it after this. */
export function approve(change: ProposedChange, target: EditTarget, approval: Approval): ApprovedChange {
  if (!approval.by.trim()) throw new Error("An approval needs the person who approved it.");
  if (Number.isNaN(Date.parse(approval.at))) throw new Error(`An approval needs the time it was given, not ${JSON.stringify(approval.at)}.`);
  return { ...change, target, approval: { by: approval.by.trim(), at: new Date(approval.at).toISOString() } };
}

export const APPROVAL_PROMPT = "Should OpenMerit configure this? Yes / No.";

/** The task's name as a question ID. */
export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "task";

/** The question that asks a person to approve switching a task to the pick. Both hosts ask it the same way. */
export function approvalQuestion(task: string, current: string, pick: { model: string; endpoint: string }) {
  return { id: `configure_${slug(task)}`, kind: "confirm" as const, default: false as const, prompt: APPROVAL_PROMPT, detail: `${task}: ${current} → ${pick.model} (${pick.endpoint})` };
}
