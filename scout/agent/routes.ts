// HTTP API for agent conversations, behind Scout's existing sign-in and rate limits.
//   POST /scout/api/agent        {conversationId?, message?, brief?, skip?, endpointIds?} → runs one turn;
//                                a new conversation may supply its own UUID with its first message
//   GET  /scout/api/agent/<id>   → the conversation's latest answer, or its progress while running
// Each conversation is its own Durable Object, named by the signed-in user and
// the conversation ID, so one user cannot open another's conversation. The MCP
// server (../mcp.mjs) runs coding agents' turns through the same converse().
import { json, readJSON } from '../http.mjs';
import { components } from './recommendation.ts';
import type { AgentState, BriefEdits, Channel, TurnRequest } from './turn.ts';

interface Conversation { turn(request: TurnRequest, channel?: Channel): Promise<AgentState>; state(): Promise<AgentState> }
export interface AgentNamespace { getByName(name: string): Conversation }

export const agentPath = /^\/scout\/api\/agent(?:\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}))?$/;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number) => typeof v === 'string' && v.length <= max ? v : null;

// A validated turn, or the reason the body is not one.
export function parseTurn(body: unknown): { conversationId: string | null; turn: TurnRequest } | string {
  if (!isObject(body) || Object.keys(body).some(k => !['conversationId', 'message', 'brief', 'skip', 'endpointIds'].includes(k))) return 'Send conversationId, message, brief, skip or endpointIds.';
  const conversationId = body.conversationId === undefined ? null : text(body.conversationId, 36);
  if (conversationId === null && body.conversationId !== undefined || conversationId && !agentPath.test(`/scout/api/agent/${conversationId}`)) return 'Invalid conversationId.';
  const message = body.message === undefined ? undefined : text(body.message, 4000);
  if (message === null) return 'message must be text of at most 4,000 characters.';
  const edits = body.brief === undefined ? [] : isObject(body.brief) ? Object.entries(body.brief) : null;
  if (!edits || edits.some(([key, value]) => !(components as readonly string[]).includes(key) || text(value, 1000) === null)) return 'brief maps input, work, output, criteria or constraints to text of at most 1,000 characters.';
  if (body.skip !== undefined && typeof body.skip !== 'boolean') return 'skip must be true or false.';
  const ids = body.endpointIds;
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9/_.:+-]{0,159}$/.test(id)))) return 'endpointIds must be a unique list of up to 100 catalogue endpoint IDs. An empty list allows no endpoints.';
  if (!conversationId && !message?.trim()) return 'Describe the work you want a model to do.';
  const turn: TurnRequest = { skip: body.skip === true };
  if (edits.length) turn.brief = Object.fromEntries(edits) as BriefEdits;
  if (message !== undefined) turn.message = message;
  if (Array.isArray(ids)) turn.endpointIds = ids as string[];
  return { conversationId, turn };
}

// Runs one validated turn in the user's conversation, starting it if new.
export async function converse(namespace: AgentNamespace, userId: string, parsed: { conversationId: string | null; turn: TurnRequest }, channel: Channel): Promise<{ status: number; body: Record<string, unknown> }> {
  const conversationId = parsed.conversationId ?? crypto.randomUUID();
  const conversation = namespace.getByName(`${userId}:${conversationId}`);
  // A client may name a new conversation so it can poll its progress while the first turn runs.
  if (parsed.conversationId && parsed.turn.message === undefined && !(await conversation.state()).turns) return { status: 404, body: { error: 'Conversation not found.' } };
  try { return { status: 200, body: { conversationId, ...await conversation.turn(parsed.turn, channel) } }; }
  catch (error) {
    const message = (error as Error).message;
    if (message === 'busy') return { status: 409, body: { error: 'Scout is still working on this conversation.', conversationId } };
    if (message === 'endpoints') return { status: 400, body: { error: 'endpointIds are fixed when a conversation starts. Start a new conversation to use a different inventory.', conversationId } };
    console.error('scout-agent turn failed', message);
    // The run may still finish durably; the client can read it from the conversation.
    return { status: 503, body: { error: 'Scout could not finish this turn. Please try again.', conversationId } };
  }
}

export async function handleAgent(request: Request, namespace: AgentNamespace | undefined, userId: string): Promise<Response> {
  const match = agentPath.exec(new URL(request.url).pathname);
  if (!match) return json({ error: 'Not found.' }, 404);
  if (!namespace) return json({ error: 'The Scout agent is not available on this server.' }, 503);
  const id = match[1];
  if (id) {
    if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405, { Allow: 'GET' });
    const state = await namespace.getByName(`${userId}:${id}`).state();
    return state.turns ? json({ conversationId: id, ...state }) : json({ error: 'Conversation not found.' }, 404);
  }
  if (request.method !== 'POST') return json({ error: 'Send POST with {"message":"your task"}.' }, 405, { Allow: 'POST' });
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: 'Use application/json.' }, 415);
  let body: unknown;
  try { body = await readJSON(request); } catch (error) { return json({ error: error instanceof SyntaxError ? 'Invalid JSON.' : (error as Error).message }, (error as { status?: number }).status ?? 400); }
  const parsed = parseTurn(body);
  if (typeof parsed === 'string') return json({ error: parsed }, 400);
  const { status, body: reply } = await converse(namespace, userId, parsed, 'web');
  return json(reply, status);
}
