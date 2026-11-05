import { handleEvaluations, type EvaluationNamespace } from './evaluation-routes.ts';

export const connectionTool = {
  name: 'scout_connection', title: 'Manage your evaluation connection',
  description: 'Manage the Langfuse connection for this authenticated account without a browser. Requires a separately approved scout:connections device key; recommendation keys cannot manage connections. First authorize with openmerit connect langfuse --authorize --no-open and approve its device code. For configure, send only non-secret settings as config. Supply the Viewer key pair through client-controlled X-Langfuse-Public-Key and X-Langfuse-Secret-Key HTTP headers, never tool arguments or chat. Clients that cannot inject secrets safely should run openmerit connect langfuse --config mappings.json with LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY injected by a secret manager, or --stdin with protected JSON input. Status never returns keys or mappings. Sync reads mapped aggregate scores only. Disconnect deletes credentials and imported aggregates; clear also deletes reported aggregates. Neither deletes conversations. Ask the user before configure, disconnect or clear. Set confirm true only for a deletion the user approved.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['status', 'configure', 'sync', 'disconnect', 'clear'] },
    confirm: { type: 'boolean', description: 'Required true for disconnect or clear after explicit user consent.' },
    config: { type: 'object', additionalProperties: false, required: ['region', 'from', 'tagPrefix', 'mappings', 'models'], properties: {
      region: { type: 'string', enum: ['us', 'eu', 'hipaa'] }, from: { type: 'string', description: 'YYYY-MM-DD inclusive start date.' },
      tagPrefix: { type: 'string', maxLength: 120 },
      mappings: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false,
        required: ['metric', 'modelKey', 'task', 'traceName', 'level', 'kind', 'higherIsBetter'], properties: {
          metric: { type: 'string' }, modelKey: { type: 'string' }, task: { type: 'string' }, traceName: { type: 'string' },
          level: { type: 'string', enum: ['task', 'agent', 'environment'] }, kind: { type: 'string', enum: ['quality', 'usd', 'seconds'] }, higherIsBetter: { type: 'boolean' },
        } } },
      models: { type: 'object', maxProperties: 100, additionalProperties: { type: 'string' } },
    } },
  } },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export async function callConnectionTool(args: unknown, request: Request, namespace: EvaluationNamespace | undefined, user: string) {
  const failure = (text: string) => ({ content: [{ type: 'text', text }], isError: true });
  if (!object(args) || Object.keys(args).some(key => !['action', 'config', 'confirm'].includes(key))) return failure('Provide action, optional non-secret config, and confirm for deletion. Never send keys in tool arguments.');
  const { action, config, confirm } = args;
  if (typeof action !== 'string' || !['status', 'configure', 'sync', 'disconnect', 'clear'].includes(action)) return failure('Choose status, configure, sync, disconnect or clear.');
  if (confirm !== undefined && typeof confirm !== 'boolean') return failure('confirm must be a boolean.');
  if ((action === 'disconnect' || action === 'clear') && confirm !== true) return failure('Ask the user to approve deletion, then pass confirm: true.');
  if (action !== 'configure' && config !== undefined) return failure('config is only accepted for configure.');
  if (action === 'configure' && (!object(config) || Object.keys(config).some(key => !['region', 'from', 'tagPrefix', 'mappings', 'models'].includes(key)))) return failure('Provide non-secret region, from, tagPrefix, mappings and models only. Never send keys in tool arguments.');
  const path = action === 'clear' ? 'evaluations' : action === 'sync' ? 'langfuse/sync' : 'langfuse';
  const method = action === 'status' ? 'GET' : action === 'disconnect' || action === 'clear' ? 'DELETE' : 'POST';
  if (action === 'configure' && (!request.headers.get('X-Langfuse-Public-Key') || !request.headers.get('X-Langfuse-Secret-Key'))) return failure('Supply the Viewer key pair through client-controlled X-Langfuse-Public-Key and X-Langfuse-Secret-Key headers, or use openmerit connect langfuse --config mappings.json with secret-manager-injected credentials. Never paste keys in chat.');
  const response = await handleEvaluations(new Request(new URL(`/connect/api/${path}`, request.url), { method,
    ...(action === 'configure' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...config as Record<string, unknown>,
      publicKey: request.headers.get('X-Langfuse-Public-Key'), secretKey: request.headers.get('X-Langfuse-Secret-Key') }) } : {}),
  }), namespace, user);
  const value: unknown = await response.json();
  return response.ok ? { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false }
    : failure(object(value) && typeof value.error === 'string' ? value.error : 'Evaluation connection failed.');
}
