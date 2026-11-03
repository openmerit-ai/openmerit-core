// What a conversation turn takes and returns, shared by the HTTP API and the agent.
import { components, type Component } from './recommendation.ts';
import type { Answer } from './tools.ts';

export type BriefEdits = Partial<Record<Component, string>>;
export interface TurnRequest {
  message?: string;
  // Components of the task brief the user rewrote in place; an empty string removes one.
  brief?: BriefEdits;
  skip?: boolean;
  // Catalogue endpoint IDs the project can use. Fixed by the first turn; omitted means the whole catalogue.
  endpointIds?: string[];
}
// Where a conversation comes from. The web page splits work into at most three
// tasks so its answer stays readable; coding agents get as many as the work needs.
export type Channel = 'web' | 'agent';
export const taskLimits: Record<Channel, number | null> = { web: 3, agent: null };
export type TurnAnswer = Answer | { kind: 'message'; text: string } | { kind: 'error'; message: string };
export interface AgentState { busy: boolean; turns: number; skipped: boolean; progress: string[]; answer: TurnAnswer | null }

// The user's turn as the model reads it. Brief edits are labelled so the transcript shows where they came from.
export function turnText(request: TurnRequest): string {
  const parts: string[] = [];
  if (request.message?.trim()) parts.push(request.message.trim());
  const edited = components.filter(c => request.brief?.[c] !== undefined);
  if (edited.length) parts.push(`I edited your task brief. Treat these components as stated by me:\n${edited.map(c => `- ${c}: ${request.brief?.[c]?.trim() || 'none'}`).join('\n')}`);
  if (request.skip) parts.push('Skip the remaining clarifying questions. Recommend now, and list the assumptions you made.');
  return parts.join('\n\n');
}
