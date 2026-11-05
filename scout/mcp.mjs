import { json, readJSON } from './http.mjs';
import { components } from './agent/recommendation.ts';
import { converse, parseTurn } from './agent/routes.ts';

const versions = ['2025-03-26', '2025-06-18', '2025-11-25'];
const tool = {
  name: 'scout_models', title: 'Find models for your tasks',
  description: 'Talk to Scout, the same agent as the openmerit.ai/scout page. Send a task description as prompt. Scout writes a task brief (input, work, output, criteria, constraints) and either asks clarifying questions or splits the work into tasks, one per model it needs, with no limit on the number of tasks, and returns up to five ranked models for each task. When the result status is needs_answers, show the brief and questions to the user, then call again with the same conversationId and brief set to the components rewritten with their answers, or skip: true to let Scout assume. When it is recommended, read tasks[].models; each model\'s cost names the cheapest eligible endpointId and the providerModelId to call. Each task also has an evaluation: the checks, sample size and early-stop rule for measuring its candidates with the project\'s own evals. Run the candidates as extra runs of evals the project already has (or a minimal one the user agrees to), then call again with the conversationId and results set to the aggregate scores, and Scout recommends again with those measurements ranked above public benchmarks. Send a follow-up prompt with the conversationId to refine. Pass endpointIds on the first call to limit every task to the project\'s inventory; they stay fixed for the conversation, and an empty list allows none. A turn usually takes one to three minutes; if a call is interrupted, call again with only the conversationId to read the outcome. The task text reaches Workers AI, Workers AI web search and OpenAI (benchmark search embeddings); the conversation is stored for your account. Never send secrets, source files or real customer records. Scout does not execute the recommended models. Quality is Scout\'s estimate from public benchmarks unless a model\'s quality.measured is true, when it rests on results you reported. Results are stored with this conversation for your account and inform only your recommendations; send aggregates only, never inputs, outputs or customer records.',
  inputSchema: { type: 'object', properties: {
    prompt: { type: 'string', minLength: 1, maxLength: 4000, description: 'The work the models need to do, including input and output formats; or a follow-up message in an existing conversation.' },
    conversationId: { type: 'string', maxLength: 36, description: 'The conversationId from an earlier result, to continue that conversation.' },
    brief: { type: 'object', additionalProperties: false, properties: Object.fromEntries(components.map(c => [c, { type: 'string', maxLength: 1000 }])), description: 'Brief components rewritten with the user\'s answers to Scout\'s questions. An empty string removes one.' },
    skip: { type: 'boolean', description: 'Skip the remaining clarifying questions; Scout recommends with stated assumptions.' },
    results: { type: 'array', minItems: 1, maxItems: 50, description: 'Aggregate results you measured with your own evals, such as the candidate runs of a task\'s evaluation. Aggregates only: never inputs, outputs or records.', items: { type: 'object', additionalProperties: false, required: ['level', 'scope', 'model', 'metric', 'value', 'higherIsBetter', 'samples', 'source'], properties: {
      level: { type: 'string', enum: ['task', 'agent', 'environment'], description: 'task: one model call; agent: one agent run; environment: the end-to-end outcome.' },
      task: { type: 'string', maxLength: 200, description: 'The title of the Scout task this measures, when it measures one task.' },
      scope: { type: 'string', maxLength: 200, description: 'What was measured, such as "adjudication agent" or "claims pipeline".' },
      model: { type: 'string', maxLength: 200, description: 'The catalogue model ID or endpoint ID that was measured.' },
      metric: { type: 'string', maxLength: 200 },
      value: { type: 'number' },
      higherIsBetter: { type: 'boolean' },
      samples: { type: 'integer', minimum: 1 },
      source: { type: 'string', maxLength: 200, description: 'Where it was measured, such as the eval platform and experiment name.' },
    } } },
    endpointIds: { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string', maxLength: 160 }, description: 'Catalogue endpoint IDs the project can use, on the first call only. Every shortlist is limited to them; an empty list allows none. Omit to search the whole catalogue.' },
  }, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

const next = {
  clarification: 'Show the brief and questions to the user. Call scout_models again with this conversationId and brief set to the components rewritten with their answers, or skip: true. Do not answer for the user from guesses.',
  recommendation: 'Present each task\'s shortlist with its trade-offs and its evaluation, and let the user choose. Offer to measure the candidates with the project\'s existing evals as the evaluation describes, then report the aggregate results with this conversationId and results. To refine, call scout_models with this conversationId and a prompt.',
};
// The coding agent's view of a turn: the answer, without the progress log the page animates.
function result(body) {
  const { conversationId, busy, answer } = body;
  if (busy || !answer) return { conversationId, status: 'working', next: 'Scout is still working. Call scout_models again with only this conversationId to read the outcome.' };
  if (answer.kind === 'clarification') return { conversationId, status: 'needs_answers', brief: answer.brief, questions: answer.questions, next: next.clarification };
  if (answer.kind === 'recommendation') return { conversationId, status: 'recommended', brief: answer.brief, assumptions: answer.assumptions, catalogueVersion: answer.catalogueVersion, tasks: answer.tasks, next: next.recommendation };
  if (answer.kind === 'message') return { conversationId, status: 'message', text: answer.text };
  return { conversationId, status: 'error', error: answer.message };
}

// Stateless Streamable HTTP. No sessions, SDK runtime or open SSE streams.
// Every tool call is one turn of a Scout agent conversation (agent/), keyed by the device key's user.
export async function handleMCP(request, conversations, userId, observe = () => {}) {
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
  observe(method, method === 'initialize' ? params?.clientInfo?.name : undefined, method === 'tools/call' ? params?.name : undefined, method === 'initialize' ? params?.clientInfo?.version : undefined);
  if (id === undefined) {
    if (['notifications/initialized', 'notifications/cancelled'].includes(method)) return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
    return fail(-32600, 'Unrecognized notification.', 400);
  }
  const reply = result => json({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return reply({ protocolVersion: versions.includes(params?.protocolVersion) ? params.protocolVersion : versions.at(-1), capabilities: { tools: {} }, serverInfo: { name: 'OpenMerit', version: '0.1.0' }, instructions: 'OpenMerit currently provides Scout only. Consult scout_models for new or changed application inference selections. Scout may ask clarifying questions first: relay them to the user and continue the same conversation. Pass existing authorized endpointIds to constrain recommendations; never silently fall back to unauthorized endpoints or providers. Recommendations are not executions: Scout does not run inference or grant endpoint access.' });
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools: [tool] });
  if (method !== 'tools/call') return fail(-32601, 'Method not found.');
  if (params?.name !== tool.name) return fail(-32602, 'Unknown tool.');
  const args = params.arguments;
  if (!args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).some(k => !Object.hasOwn(tool.inputSchema.properties, k))) return fail(-32602, 'Provide prompt, or conversationId with brief, skip, results or prompt.');
  const failed = text => reply({ content: [{ type: 'text', text }], isError: true });
  if (!conversations) return failed('The Scout agent is not available on this server.');
  const { prompt, ...rest } = args;
  const parsed = parseTurn({ ...rest, ...(prompt === undefined ? {} : { message: prompt }) });
  if (typeof parsed === 'string') return failed(parsed.replace(/^message\b/, 'prompt'));
  let outcome;
  // conversationId alone reads the latest outcome, for a client whose call was interrupted.
  if (parsed.conversationId && Object.keys(args).length === 1) {
    const state = await conversations.getByName(`${userId}:${parsed.conversationId}`).state();
    outcome = state.turns ? { status: 200, body: { conversationId: parsed.conversationId, ...state } } : { status: 404, body: { error: 'Conversation not found.' } };
  } else outcome = await converse(conversations, userId, parsed, 'agent');
  if (outcome.status !== 200) return failed([outcome.body.error, outcome.body.conversationId && `conversationId: ${outcome.body.conversationId}`].filter(Boolean).join(' '));
  const value = result(outcome.body);
  return reply({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: value.status === 'error' });
}
