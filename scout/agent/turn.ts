// What a conversation turn takes and returns, shared by the HTTP API and the agent.
import { components, type Component, type Measurement, type MeasurementInput } from './recommendation.ts';
import type { Answer } from './tools.ts';

export type BriefEdits = Partial<Record<Component, string>>;
export interface TurnRequest {
  message?: string;
  // Components of the task brief the user rewrote in place; an empty string removes one.
  brief?: BriefEdits;
  skip?: boolean;
  // Catalogue endpoint IDs the project can use. Fixed by the first turn; omitted means the whole catalogue.
  endpointIds?: string[];
  // Aggregate results the user measured with their own evals, such as candidate runs of Scout's evaluation plan.
  results?: MeasurementInput[];
}
// Where a conversation comes from. The web page splits work into at most three
// tasks so its answer stays readable; coding agents get as many as the work needs.
export type Channel = 'web' | 'agent';
export const taskLimits: Record<Channel, number | null> = { web: 3, agent: null };
export type TurnAnswer = Answer | { kind: 'message'; text: string } | { kind: 'error'; message: string };
export interface AgentState { busy: boolean; turns: number; skipped: boolean; progress: string[]; answer: TurnAnswer | null }

// One measured result as the model reads it, with the ID it cites.
export const measurementLine = (r: Measurement) =>
  `- measured:${r.id} · ${r.model} · ${r.level} level${r.task ? `, task "${r.task}"` : ''} (${r.scope}) · ${r.metric} = ${r.value} (${r.higherIsBetter ? 'higher' : 'lower'} is better) · ${r.samples} ${r.samples === 1 ? 'sample' : 'samples'} · ${r.source}`;

// The user's turn as the model reads it. Brief edits and measured results are labelled so the transcript shows where they came from.
export function turnText(request: TurnRequest, measured: readonly Measurement[] = []): string {
  const parts: string[] = [];
  if (request.message?.trim()) parts.push(request.message.trim());
  if (measured.length) parts.push(`I measured these results with my own evals (aggregates only). Use them as evidence ahead of public benchmarks, cite them as measured:<id>, and recommend again:\n${measured.map(measurementLine).join('\n')}`);
  const edited = components.filter(c => request.brief?.[c] !== undefined);
  if (edited.length) parts.push(`I edited your task brief. Treat these components as stated by me:\n${edited.map(c => `- ${c}: ${request.brief?.[c]?.trim() || 'none'}`).join('\n')}`);
  if (request.skip) parts.push('Skip the remaining clarifying questions. Recommend now, and list the assumptions you made.');
  return parts.join('\n\n');
}
