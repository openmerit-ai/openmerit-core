import { sampleSnapshot } from './sample.mjs';
import { WORKLOADS, CATALOG, CONFIGURED_SERVICES, preferenceFor, selectReplacement } from './demo-policy.mjs';

// Published standard, uncached text-token rates in USD per million tokens.
// This catalog belongs to the fictional hosted demonstration, never live billing.
export const PRICE_DATE = '2026-10-10';
const openai = model => `https://developers.openai.com/api/docs/models/${model}`;
const anthropic = 'https://platform.claude.com/docs/en/about-claude/pricing';
const google = 'https://ai.google.dev/gemini-api/docs/pricing';
const groq = 'https://console.groq.com/docs/models';
const baseten = 'https://www.baseten.co/pricing/';
const mistral = 'https://docs.mistral.ai/inference/pricing';
const rate = (name, provider, input, output, source, creator = provider) => ({ name, provider, input, output, source, creator });
export const PRICES = [
  rate('GPT-5.4', 'OpenAI', 2.5, 15, openai('gpt-5.4')),
  rate('GPT-5.4 mini', 'OpenAI', .75, 4.5, openai('gpt-5.4-mini')),
  rate('GPT-5.4 nano', 'OpenAI', .2, 1.25, openai('gpt-5.4-nano')),
  rate('Claude Opus 4.6', 'Anthropic', 5, 25, anthropic),
  rate('Claude Sonnet 4.6', 'Anthropic', 3, 15, anthropic),
  rate('Claude Haiku 4.5', 'Anthropic', 1, 5, anthropic),
  rate('Gemini 2.5 Pro', 'Google', 1.25, 10, google),
  rate('Gemini 2.5 Flash', 'Google', .3, 2.5, google),
  rate('Gemini 2.5 Flash-Lite', 'Google', .1, .4, google),
  rate('gpt-oss-120b', 'Groq', .15, .6, groq, 'OpenAI'),
  rate('gpt-oss-20b', 'Groq', .075, .3, groq, 'OpenAI'),
  rate('GLM-5.3', 'Baseten', 1.4, 4.4, baseten, 'Z.ai'),
  rate('GLM-5.3-Flash', 'Baseten', .15, .5, baseten, 'Z.ai'),
  rate('Mistral Medium 3.5', 'Mistral', 1.5, 7.5, mistral),
  rate('Mistral Small 4', 'Mistral', .15, .6, mistral),
];
export function tokenCost(price, input, output) {
  if (!price || !Number.isFinite(input) || !Number.isFinite(output)) return null;
  return (input * price.input + output * price.output) / 1_000_000;
}
const priceFor = (provider, model) => PRICES.find(price => price.provider === provider && price.name === model);
const REQUESTS_PER_GROUP = 1000;

// A bounded set of explicit synthetic groups, not millions of duplicated rows.
// Tokens and cost are group totals. The request count is sample-only metadata.
export function enterpriseSnapshot(now = Date.now()) {
  const data = sampleSnapshot(now);
  data.simulation = { kind: 'enterprise-groups', days: 30, requestsPerGroup: REQUESTS_PER_GROUP, priceDate: PRICE_DATE, prices: PRICES };
  data.project = { name: 'enterprise-sample', scope: 'Fictional enterprise environment' };
  const replacements = new Map([
    ['GPT-5', priceFor('OpenAI', 'GPT-5.4')], ['GPT-5 mini', priceFor('OpenAI', 'GPT-5.4 mini')], ['GPT-5 nano', priceFor('OpenAI', 'GPT-5.4 nano')],
    ['Claude Sonnet 4.5', priceFor('Anthropic', 'Claude Sonnet 4.6')], ['Claude Opus 4.1', priceFor('Anthropic', 'Claude Opus 4.6')], ['Claude Haiku 3.5', priceFor('Anthropic', 'Claude Haiku 4.5')],
    ['DeepSeek R1', priceFor('Baseten', 'GLM-5.3')], ['Mistral Medium 3', priceFor('Mistral', 'Mistral Medium 3.5')],
  ]);
  const rename = (item, field) => { const price = replacements.get(item[field]); if (price) { item[field] = price.name; item.modelCreator = price.creator; } };
  data.models.forEach(item => rename(item, 'name'));
  data.deployments.forEach(item => { rename(item, 'model'); if (item.provider === 'Baseten') item.servingMode = 'shared'; });
  data.records.forEach((record, index) => {
    rename(record, 'model');
    record.sampleRequests = REQUESTS_PER_GROUP;
    record.occurredAt = new Date(now - (now - Date.parse(record.occurredAt)) * 30).toISOString();
    const shard = index % 5 + 1;
    record.agentId += `.worker-${shard}`;
    if (record.agent) record.agent += `.worker-${shard}`;
    record.taskId += `-partition-${shard}`;
    record.inputTokens *= REQUESTS_PER_GROUP;
    if (record.status === 'running') { record.status = 'completed'; record.outputTokens = 800; }
    if (record.outputTokens != null) record.outputTokens *= REQUESTS_PER_GROUP;
    record.cacheReadTokens = 0;
    record.cost = tokenCost(priceFor(record.provider, record.model), record.inputTokens, record.outputTokens);
    record.costKind = 'estimated';
    record.requestId = null;
  });
  for (const source of data.sources) {
    if (source.id === 'sample-activity') {
      source.records = 9_600_000;
      source.detail = 'Fictional request groups · 30 days';
      source.note = '9.6 million fictional requests represented by 9,600 groups of 1,000. Tokens and spend are group totals. Published uncached text-token prices are applied where available; other costs are unknown. No application or provider was contacted.';
    }
  }
  return data;
}

export function demoSnapshot(now = Date.now(), stage = 'before', preference = 'default') {
  if (!['before', 'after'].includes(stage)) throw new Error('Unknown comparison stage');
  preference = preferenceFor(preference).value;
  const data = enterpriseSnapshot(now);
  data.project = { name: 'insurance-tech-demo', scope: 'Fictional insurance operations application' };
  const usage = WORKLOADS.map(() => ({ inputTokens: 0, outputTokens: 0 }));
  data.records.forEach((record, index) => {
    record.assignmentId = index % WORKLOADS.length;
    if (!record.outputTokens) record.outputTokens = (80 + index * 37 % 1600) * REQUESTS_PER_GROUP;
    usage[record.assignmentId].inputTokens += record.inputTokens;
    usage[record.assignmentId].outputTokens += record.outputTokens;
  });
  const assignments = WORKLOADS.map((workload, index) => selectReplacement(workload, usage[index], preference));
  const feasible = assignments.every(pair => !pair.unresolved);
  data.simulation = { ...data.simulation, kind: 'comparison-groups', stage, preference, feasible, catalogSize: CATALOG.filter(model => CONFIGURED_SERVICES.includes(model.provider)).length, configuredServices: CONFIGURED_SERVICES, assignments, prices: [...new Map(assignments.flatMap(pair => [pair.before, pair.after]).filter(Boolean).map(model => [model.id, model])).values()] };
  const models = new Map(), deployments = new Map();
  data.records.forEach((record, index) => {
    const assignmentId = record.assignmentId, assignment = assignments[assignmentId], workload = WORKLOADS[assignmentId];
    const price = stage === 'after' && feasible ? assignment.after : assignment.before, sequence = Math.floor(index / WORKLOADS.length);
    const worker = String(sequence % 20 + 1).padStart(2, '0');
    record.workload = `services/${workload.id.replaceAll('.', '/')}`;
    record.agentId = record.agent = `${workload.id}.worker-${worker}`;
    record.task = workload.tasks[sequence % workload.tasks.length];
    record.taskId = `${workload.id}.${record.task}.batch-${Math.floor(sequence / workload.tasks.length) % 10 + 1}`;
    record.model = price.name; record.modelCreator = price.creator; record.provider = price.provider;
    record.location = 'cloud'; record.status = 'completed'; record.durationMs = null;
    record.cost = tokenCost(price, record.inputTokens, record.outputTokens);
    record.beforeCost = tokenCost(assignment.before, record.inputTokens, record.outputTokens);
    record.afterCost = tokenCost(feasible ? assignment.after : null, record.inputTokens, record.outputTokens);
    record.routeKind = ['direct', 'router', 'gateway'][index % 3];
    record.route = record.routeKind === 'direct' ? `${price.provider} API` : record.routeKind === 'router' ? 'insurance.router' : 'insurance-gateway';
    record.path = [{ name: record.route, kind: record.routeKind }];
    if (record.routeKind !== 'direct') record.path.push({ name: `${price.provider} API`, kind: 'direct' });
    record.deploymentId = `demo-deployment-${assignmentId}`;
    models.set(price.id, { id: `demo-model-${price.id}`, name: price.name, provider: price.provider, modelCreator: price.creator, sourceId: 'sample-activity', location: 'cloud', state: 'observed' });
    deployments.set(assignmentId, { id: record.deploymentId, name: workload.id, model: price.name, modelCreator: price.creator, provider: price.provider, location: 'cloud', servingMode: 'shared', state: 'configured', sourceId: 'inventory', poolIds: [`pool-${price.provider.toLowerCase()}`] });
  });
  data.models = [...models.values()]; data.deployments = [...deployments.values()];
  const providers = CONFIGURED_SERVICES;
  data.inventory = [...providers.map(name => ({ name, kind: 'provider', location: 'cloud', state: 'configured', sourceId: 'inventory' })), { name: 'insurance.router', kind: 'router', location: 'cloud', state: 'configured' }, { name: 'insurance-gateway', kind: 'gateway', location: 'cloud', state: 'configured' }];
  data.capacityPools = data.capacityPools.filter(pool => providers.some(name => pool.id === `pool-${name.toLowerCase()}`));
  data.hosts = []; data.runtimeStats = []; delete data.machine;
  data.sources = data.sources.filter(source => ['sample-activity', 'sample-capacity', 'inventory'].includes(source.id));
  data.sources.find(source => source.id === 'sample-capacity').note = 'Fictional provider quota readings, held identical in both stages. They do not establish a change in latency, throughput or available capacity.';
  data.sources.find(source => source.id === 'sample-activity').note += ' Insurance workflow and worker names are fictional declarations. Replacements pass the selected public benchmark screen, not an insurance-task evaluation. Application quality and latency have not been measured.';
  data.simulation.windows = Object.fromEntries([0, 1, 6, 24, 168, 720].map(hours => {
    const rows = data.records.filter(record => !hours || Date.parse(record.occurredAt) >= now - hours * 3600000);
    const totals = selected => ({ requests: selected.length * REQUESTS_PER_GROUP, beforeCost: selected.reduce((n, r) => n + r.beforeCost, 0), afterCost: feasible ? selected.reduce((n, r) => n + r.afterCost, 0) : null });
    return [hours, { ...totals(rows), workloads: assignments.map((pair, index) => {
      const selected = rows.filter(record => record.assignmentId === index);
      return { ...totals(selected), afterCost: pair.after ? selected.reduce((n, r) => n + tokenCost(pair.after, r.inputTokens, r.outputTokens), 0) : null };
    }) }];
  }));
  if (stage === 'after' && !feasible) {
    data.records = []; data.models = []; data.deployments = []; data.capacityPools = [];
  }
  return data;
}
