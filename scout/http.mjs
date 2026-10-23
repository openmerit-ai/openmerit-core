import { indexStatus, recommend } from './rank.mjs';
import { validateSelection } from './selection.mjs';

export const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } });
// Reject retired agent endpoints before auth, redirects or asset/SPA fallback.
// Only the canonical /scout/mcp endpoint is served; aliases and OAuth discovery stay retired.
export const isRetiredAgentPath = path => /^\/scout\/(?:(?:alpha|v1|v2)\/)+mcp(?:\/|$)/.test(path) || path.startsWith('/scout/mcp/') || /^\/scout\/(?:(?:alpha|v1|v2)\/)*\.well-known\/oauth-protected-resource(?:\/|$)/.test(path) || /^\/\.well-known\/oauth-protected-resource(?:\/|$)/.test(path);
export async function handleAPI(request, index, refresh = {}, recommendTask = (index, prompt, modelIds, endpointIds) => recommend(index, prompt, Date.now(), null, undefined, modelIds ?? null, endpointIds ?? null)) {
  const path = new URL(request.url).pathname;
  if (path === '/scout/api/status') {
    if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405, { Allow: 'GET' });
    return json({ ...indexStatus(index), ...refresh });
  }
  if (path !== '/scout/api/recommend') return json({ error: 'Not found.' }, 404);
  if (request.method !== 'POST') return json({ error: 'Send POST with {"prompt":"your task"}.' }, 405, { Allow: 'POST' });
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: 'Use application/json.' }, 415);
  if (Number(request.headers.get('content-length')) > 18_000) return json({ error: 'Request is too large.' }, 413);
  try {
    const body = await readJSON(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['prompt', 'modelIds', 'endpointIds'].includes(k))) return json({ error: 'Provide prompt and optionally modelIds or endpointIds.' }, 400);
    validateSelection(body.modelIds); validateSelection(body.endpointIds, 'endpointIds');
    const result = await recommendTask(index, body.prompt, body.modelIds, body.endpointIds);
    return json({ ...result, ...refresh }, 200, result.elapsedMs == null ? {} : { 'Server-Timing': `scout;dur=${result.elapsedMs}` });
  } catch (error) { return json({ error: error instanceof SyntaxError ? 'Invalid JSON.' : error.message }, error.status ?? 400, error.status === 429 ? { 'Retry-After': '2' } : {}); }
}

export async function readJSON(request) {
  const fail = (message, status) => { const error = new Error(message); error.status = status; throw error; };
  if (Number(request.headers.get('content-length')) > 18_000) fail('Request is too large.', 413);
  const reader = request.body?.getReader(); let bytes = 0, text = ''; const decoder = new TextDecoder();
  if (!reader) fail('Provide a JSON body.', 400);
  while (true) {
    const { done, value } = await reader.read(); if (done) break; bytes += value.length;
    if (bytes > 18_000) { await reader.cancel(); fail('Request is too large.', 413); }
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}
