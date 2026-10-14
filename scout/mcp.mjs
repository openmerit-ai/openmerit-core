import { recommend } from './rank.mjs';
import { json, readJSON } from './http.mjs';

const versions = ['2025-03-26', '2025-06-18', '2025-11-25'];
const tool = {
  name: 'scout_models', title: 'Find models for a task',
  description: 'Get up to five available language models in rank order. Matching measured task profiles use observed accuracy, charges and request time; other tasks use public benchmarks and reference estimates. The task description is sent to OpenAI Decisions for interpretation; Scout does not store it or execute the recommended models. Inspect ranking.mode, the tested pool and sample size, freshness, requirements, warnings, memory configurations and evidence. This is a shortlist, not a guarantee of task accuracy.',
  inputSchema: { type: 'object', properties: { prompt: { type: 'string', minLength: 1, maxLength: 4000, description: 'Describe what the selected model needs to do, including input and output formats.' } }, required: ['prompt'], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

// Stateless Streamable HTTP. No sessions, SDK runtime or open SSE streams.
export async function handleMCP(request, index, state = {}, recommendTask = recommend) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'Origin not allowed.' }, 403);
  if (request.method !== 'POST') return json({ error: 'Use POST. This server does not open SSE streams.' }, 405, { Allow: 'POST' });
  const version = request.headers.get('mcp-protocol-version');
  if (version && !versions.includes(version)) return json({ error: 'Unsupported MCP protocol version.', supported: versions }, 400);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: 'Use application/json.' }, 415);
  let message;
  try { message = await readJSON(request); }
  catch (error) { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: error.message } }, error.status ?? 400); }
  const { id, method, params = {} } = message ?? {};
  const fail = (code, message, status = 200) => json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, status);
  if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof method !== 'string' || (id !== undefined && typeof id !== 'string' && !Number.isSafeInteger(id))) return fail(-32600, 'Invalid JSON-RPC request.', 400);
  if (id === undefined) {
    if (['notifications/initialized', 'notifications/cancelled'].includes(method)) return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
    return fail(-32600, 'Unrecognized notification.', 400);
  }
  const reply = result => json({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return reply({ protocolVersion: versions.includes(params?.protocolVersion) ? params.protocolVersion : versions.at(-1), capabilities: { tools: {} }, serverInfo: { name: 'scout-by-openmerit', version: '0.1.0' }, instructions: 'Use scout_models before choosing a model for a task. Respect evidence limitations and freshness warnings.' });
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools: [tool] });
  if (method !== 'tools/call') return fail(-32601, 'Method not found.');
  if (params?.name !== tool.name) return fail(-32602, 'Unknown tool.');
  const args = params.arguments;
  if (!args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).some(k => k !== 'prompt')) return fail(-32602, 'Provide only a prompt.');
  try {
    const result = { ...await recommendTask(index, args.prompt), ...state };
    // Keep agent context small; the JSON API exposes the complete evidence list.
    result.recommendations = result.recommendations.map(m => ({ ...m, evidenceCount: m.evidence.length, evidence: m.evidence.slice(0, 4) }));
    delete result.wordCloud;
    return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
  } catch (error) { return reply({ content: [{ type: 'text', text: error.message }], isError: true }); }
}
