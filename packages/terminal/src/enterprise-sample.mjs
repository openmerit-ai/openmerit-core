import { sampleSnapshot } from './sample.mjs';

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
export const ASSIGNMENTS = [
  { purpose: 'Document analysis', before: rate('GPT-5.4', 'OpenAI', 2.5, 15, openai('gpt-5.4')), after: rate('GPT-5.4 mini', 'OpenAI', .75, 4.5, openai('gpt-5.4-mini')) },
  { purpose: 'Classification & extraction', before: rate('GPT-5.4 mini', 'OpenAI', .75, 4.5, openai('gpt-5.4-mini')), after: rate('GPT-5.4 nano', 'OpenAI', .2, 1.25, openai('gpt-5.4-nano')) },
  { purpose: 'Review & synthesis', before: rate('Claude Opus 4.6', 'Anthropic', 5, 25, anthropic), after: rate('Claude Sonnet 4.6', 'Anthropic', 3, 15, anthropic) },
  { purpose: 'Triage & summarization', before: rate('Claude Sonnet 4.6', 'Anthropic', 3, 15, anthropic), after: rate('Claude Haiku 4.5', 'Anthropic', 1, 5, anthropic) },
  { purpose: 'Research summaries', before: rate('Gemini 2.5 Pro', 'Google', 1.25, 10, google), after: rate('Gemini 2.5 Flash', 'Google', .3, 2.5, google) },
  { purpose: 'Metadata enrichment', before: rate('Gemini 2.5 Flash', 'Google', .3, 2.5, google), after: rate('Gemini 2.5 Flash-Lite', 'Google', .1, .4, google) },
  { purpose: 'Short-form generation', before: rate('gpt-oss-120b', 'Groq', .15, .6, groq, 'OpenAI'), after: rate('gpt-oss-20b', 'Groq', .075, .3, groq, 'OpenAI') },
  { purpose: 'Structured responses', before: rate('GLM-5.3', 'Baseten', 1.4, 4.4, baseten, 'Z.ai'), after: rate('GLM-5.3-Flash', 'Baseten', .15, .5, baseten, 'Z.ai') },
  { purpose: 'Multilingual processing', before: rate('Mistral Medium 3.5', 'Mistral', 1.5, 7.5, mistral), after: rate('Mistral Small 4', 'Mistral', .15, .6, mistral) },
];
export const PRICES = [...new Map(ASSIGNMENTS.flatMap(pair => [pair.before, pair.after]).map(price => [`${price.provider}:${price.name}`, price])).values()];
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
    ['GPT-5', ASSIGNMENTS[0].before], ['GPT-5 mini', ASSIGNMENTS[1].before], ['GPT-5 nano', ASSIGNMENTS[1].after],
    ['Claude Sonnet 4.5', ASSIGNMENTS[3].before], ['Claude Opus 4.1', ASSIGNMENTS[2].before], ['Claude Haiku 3.5', ASSIGNMENTS[3].after],
    ['DeepSeek R1', ASSIGNMENTS[7].before], ['Mistral Medium 3', ASSIGNMENTS[8].before],
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

export function demoSnapshot(now = Date.now(), stage = 'before') {
  if (!['before', 'after'].includes(stage)) throw new Error('Unknown comparison stage');
  const data = enterpriseSnapshot(now);
  data.project = { name: 'openmerit-demo', scope: 'Illustrative model assignment comparison' };
  data.simulation = { ...data.simulation, kind: 'comparison-groups', stage, assignments: ASSIGNMENTS };
  const models = new Map(), deployments = new Map();
  // Preserve every request group's task, timing, volume and tokens in both states.
  // Stable assignment IDs let the UI follow model changes without changing providers.
  data.records.forEach((record, index) => {
    const assignment = ASSIGNMENTS[Number(record.taskId.match(/task-(\d+)/)[1]) % ASSIGNMENTS.length];
    const price = assignment[stage];
    const assignmentId = ASSIGNMENTS.indexOf(assignment);
    record.assignmentId = assignmentId;
    record.model = price.name; record.modelCreator = price.creator; record.provider = price.provider;
    record.location = 'cloud'; record.status = 'completed'; record.durationMs = null;
    if (!record.outputTokens) record.outputTokens = (80 + index * 37 % 1600) * REQUESTS_PER_GROUP;
    record.cost = tokenCost(price, record.inputTokens, record.outputTokens);
    record.beforeCost = tokenCost(assignment.before, record.inputTokens, record.outputTokens);
    record.afterCost = tokenCost(assignment.after, record.inputTokens, record.outputTokens);
    record.routeKind = ['direct', 'router', 'gateway'][index % 3];
    record.route = record.routeKind === 'direct' ? `${price.provider} API` : record.routeKind === 'router' ? 'router.application' : 'llm-gateway';
    record.path = [{ name: record.route, kind: record.routeKind }];
    if (record.routeKind !== 'direct') record.path.push({ name: `${price.provider} API`, kind: 'direct' });
    record.deploymentId = `demo-deployment-${assignmentId}`;
    models.set(assignmentId, { id: `demo-model-${assignmentId}`, name: price.name, provider: price.provider, modelCreator: price.creator, sourceId: 'sample-activity', location: 'cloud', state: 'observed' });
    deployments.set(assignmentId, { id: record.deploymentId, name: `${price.provider.toLowerCase()}-project-01`, model: price.name, modelCreator: price.creator, provider: price.provider, location: 'cloud', servingMode: 'shared', state: 'configured', sourceId: 'inventory', poolIds: [`pool-${price.provider.toLowerCase()}`] });
  });
  data.models = [...models.values()]; data.deployments = [...deployments.values()];
  const providers = [...new Set(data.models.map(model => model.provider))];
  data.inventory = [...providers.map(name => ({ name, kind: 'provider', location: 'cloud', state: 'configured', sourceId: 'inventory' })), { name: 'router.application', kind: 'router', location: 'cloud', state: 'configured' }, { name: 'llm-gateway', kind: 'gateway', location: 'cloud', state: 'configured' }];
  data.capacityPools = data.capacityPools.filter(pool => providers.some(name => pool.id === `pool-${name.toLowerCase()}`));
  data.hosts = []; data.runtimeStats = []; delete data.machine;
  data.sources = data.sources.filter(source => ['sample-activity', 'sample-capacity', 'inventory'].includes(source.id));
  const capacitySource = data.sources.find(source => source.id === 'sample-capacity');
  capacitySource.note = 'Fictional provider quota readings, held identical in both stages. They do not establish a change in latency, throughput or available capacity.';
  data.sources.find(source => source.id === 'sample-activity').note += ' Before and after are illustrative assignments, not results from an OpenMerit evaluation. Quality, latency, and hardware savings have not been measured.';
  return data;
}
