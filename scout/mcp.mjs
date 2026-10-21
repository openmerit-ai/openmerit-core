import { recommend } from './rank.mjs';
import { json, readJSON } from './http.mjs';
import { validateSelection } from './selection.mjs';

const versions = ['2025-03-26', '2025-06-18', '2025-11-25'];
const tool = {
  name: 'scout_models', title: 'Find models for your tasks',
  description: 'Get up to five ranked models per task with explicit endpoint identities. The evidence engine decomposes up to three independent tasks and resolves ambiguity internally without follow-up questions. Each task has five layers and exactly one shortlist, retained at tasks[].slots[0] for compatibility. Multi-task responses have an empty top-level recommendations array. Combinations are not jointly evaluated. Typed decision and vision tasks use a task-fit shortlist when comparable quality measurements are absent; inspect each task\'s ranking.mode and unknown metrics. Comparable calibration can supply task-quality observations; inspect each metric basis and reference assumptions. Public benchmarks are task proxies. The evidence engine selects numerical tradeoffs only within comparable scopes; missing objectives remain provisional. Compatible classification/detection/segmentation deployments can enter the task-fit five. Other Hugging Face components remain in specialists; reported results are not independently verified. The task description is sent to OpenAI for structured decomposition, Decisions interpretation and transient query embeddings; Scout stores the submitted task prompt with task categories, ordered model/endpoint choices and their supporting source evidence per task in private Cloudflare analytics for three months. Search analytics excludes account/session identifiers; Clerk handles sign-in identity separately. Personal information typed into a prompt is retained. Scout does not execute the recommended models. Inspect ranking.mode, tested pool, sample size, freshness, requirements, warnings and evidence. This is a shortlist, not a guarantee of task accuracy.',
  inputSchema: { type: 'object', properties: { prompt: { type: 'string', minLength: 1, maxLength: 4000, description: 'Describe what the selected model needs to do, including input and output formats.' }, endpointIds: { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string', maxLength: 160 }, description: 'Optional exact endpoint IDs. Filters before ranking; no provider credential fallback. Omit modelIds when selecting non-router endpoints.' }, modelIds: { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string', maxLength: 160 }, description: 'Optional project-accessible legacy OpenRouter catalogue model IDs. Filtered before ranking. Empty means no models.' } }, required: ['prompt'], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

// Stateless Streamable HTTP. No sessions, SDK runtime or open SSE streams.
export async function handleMCP(request, index, state = {}, recommendTask = (index, prompt, modelIds, endpointIds) => recommend(index, prompt, Date.now(), null, undefined, modelIds ?? null, endpointIds ?? null)) {
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
  if (!args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).some(k => !['prompt', 'modelIds', 'endpointIds'].includes(k))) return fail(-32602, 'Provide prompt and optionally modelIds or endpointIds.');
  try {
    validateSelection(args.modelIds); validateSelection(args.endpointIds, 'endpointIds');
    const result = { ...await recommendTask(index, args.prompt, args.modelIds, args.endpointIds), ...state };
    // Keep agent context small; the JSON API exposes the complete evidence list.
    for(const section of [result,...(result.tasks??[]).flatMap(t=>t.slots)]) {
      section.recommendations = section.recommendations.map(m => ({ ...m, evidenceCount: m.evidence.length, evidence: m.evidence.slice(0, 4) }));
      if (section.specialists) section.specialists.candidates = section.specialists.candidates.map(m => ({ ...m, evaluationCount: m.evaluations.length, evaluations: m.evaluations.slice(0, 4) }));
      delete section.wordCloud;
    }
    return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
  } catch (error) { return reply({ content: [{ type: 'text', text: error.message }], isError: true }); }
}
