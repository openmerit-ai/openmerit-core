// Deterministic, deliberately fictional data. Never mixed with local sources.
// Rates, latencies, allocations, and utilization are illustrative, not benchmarks.
const GiB = 1024 ** 3;
const TEAMS = [
  ['Support', ['billing escalation', 'refund queue', 'onboarding tickets', 'SLA exceptions', 'customer handoff', 'incident follow-up', 'CSAT themes']],
  ['Engineering', ['checkout regression', 'API migration', 'dependency upgrade', 'flaky test suite', 'release notes', 'auth refactor', 'performance budget']],
  ['Research', ['competitor landscape', 'market signals', 'customer interviews', 'pricing study', 'industry brief', 'source verification', 'product opportunities']],
  ['Finance', ['invoice exceptions', 'expense reconciliation', 'renewal forecast', 'vendor spending', 'revenue variance', 'purchase approvals', 'quarterly narrative']],
  ['Security', ['access review', 'dependency advisory', 'policy exceptions', 'incident timeline', 'threat brief', 'audit evidence', 'service permissions']],
  ['Operations', ['capacity forecast', 'deployment checklist', 'on-call handoff', 'runbook updates', 'queue anomalies', 'availability report', 'change requests']],
  ['Sales', ['account research', 'proposal draft', 'pipeline review', 'meeting preparation', 'lead enrichment', 'deal risks', 'renewal outreach']],
  ['Legal', ['supplier terms', 'contract changes', 'policy updates', 'obligation register', 'clause comparison', 'document redaction', 'agreement summary']],
  ['Data', ['schema changes', 'quality checks', 'warehouse queries', 'catalog enrichment', 'metric definitions', 'report narrative', 'lineage review']],
  ['Knowledge', ['document ingestion', 'retrieval quality', 'index refresh', 'duplicate articles', 'citation coverage', 'search relevance', 'content freshness']],
];
// name, provider/runtime, location, typical latency, fictional rate multiplier, role
const MODEL_DEFINITIONS = [
  ['GPT-5', 'OpenAI', 'cloud', 3600, 2.2, 'generation'],
  ['Claude Sonnet 4.5', 'Anthropic', 'cloud', 4200, 2.6, 'generation'],
  ['Gemini 2.5 Flash', 'Google', 'cloud', 900, .3, 'generation'],
  ['DeepSeek R1', 'Baseten', 'cloud', 14000, .8, 'reasoning'],
  ['Mistral Medium 3', 'Mistral', 'cloud', 1800, .7, 'generation'],
  ['GPT-5 mini', 'OpenAI', 'cloud', 1400, .4, 'generation'],
  ['Claude Opus 4.1', 'Anthropic', 'cloud', 11000, 6, 'reasoning'],
  ['Gemini 2.5 Pro', 'Google', 'cloud', 7000, 1.8, 'reasoning'],
  ['GPT-5 nano', 'OpenAI', 'cloud', 480, .08, 'generation'],
  ['Claude Haiku 3.5', 'Anthropic', 'cloud', 700, .2, 'generation'],
  ['gpt-oss-120b', 'Groq', 'cloud', 2000, .25, 'generation'],
  ['qwen-3.8-27b', 'Cerebras', 'cloud', 2400, .65, 'generation'],
  ['text-embedding-3-large', 'OpenAI', 'cloud', 160, .02, 'embedding'],
  ['embed-v4', 'Cohere', 'cloud', 190, .025, 'embedding'],
  ['Qwen3 · 8B', 'Ollama', 'local', 1400, 0, 'generation'],
  ['Qwen3 · 30B', 'Ollama', 'local', 4200, 0, 'reasoning'],
  ['Llama 3.3 · 70B', 'vLLM', 'local', 3100, 0, 'generation'],
  ['Gemma 3 · 27B', 'LM Studio', 'local', 2600, 0, 'generation'],
  ['DeepSeek R1 · 14B', 'Ollama', 'local', 6200, 0, 'reasoning'],
  ['nomic-embed-text', 'Ollama', 'local', 90, 0, 'embedding'],
  ['bge-reranker-v2-m3', 'vLLM', 'local', 75, 0, 'reranking'],
];
// Explicit fictional metadata, never inferred from the serving company.
const MODEL_CREATORS = ['OpenAI', 'Anthropic', 'Google', 'DeepSeek', 'Mistral', 'OpenAI', 'Anthropic', 'Google', 'OpenAI', 'Anthropic', 'OpenAI', 'Qwen', 'OpenAI', 'Cohere', 'Qwen', 'Qwen', 'Meta', 'Google', 'DeepSeek', 'Nomic', 'BAAI'];
const ROUTERS = ['router.quality', 'router.latency', 'router.cost', 'router.private'];
const GATEWAYS = ['llm-gateway', 'llm-gateway-eu', 'batch-proxy'];
const ROLES = ['Intake', 'Research', 'Delivery', 'Review'];
const MODEL_PATHS = [
  ['direct', 'router'], ['gateway', 'router'], ['direct', 'gateway'],
  ['router', 'gateway'], ['direct'], ['direct', 'router', 'gateway'],
  ['gateway'], ['router'], ['direct'], ['gateway', 'router'],
  ['gateway', 'direct'], ['gateway'], ['direct'], ['gateway'],
  ['local', 'router'], ['local', 'router'], ['local', 'gateway'],
  ['local'], ['router', 'local'], ['local'], ['local', 'gateway'],
];
const TEAM_MODELS = [
  [2, 5, 8, 9, 14], [0, 1, 3, 5, 15, 16], [3, 6, 7, 10, 11],
  [0, 4, 7, 14, 17], [1, 3, 6, 15, 18], [2, 4, 5, 14, 16, 18],
  [1, 2, 5, 9, 11], [0, 1, 6, 7, 17], [0, 5, 10, 14, 15, 16],
  [2, 8, 11, 14, 17],
];

export function sampleSnapshot(now = Date.now()) {
  let seed = 41;
  const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const choose = values => values[Math.floor(random() * values.length)];
  const agents = TEAMS.flatMap(([team], teamIndex) => ROLES.map((role, index) => ({ id: `${team.toLowerCase()}.${role.toLowerCase()}`, name: index === 3 ? null : `${team.toLowerCase()}.${role.toLowerCase()}` })));
  const tasks = TEAMS.flatMap(([, subjects], teamIndex) => subjects.flatMap((subject, index) => ['Review', 'Prepare'].map((verb, variant) => ({ id: `task-${teamIndex * 14 + index * 2 + variant + 1}`, name: index % 3 === 0 ? null : `${subject.replaceAll(' ', '_').toLowerCase()}.${verb.toLowerCase()}`, teamIndex, agent: agents[teamIndex * 4 + (index * 2 + variant) % 4] }))));
  let totalTaskWeight = 0;
  const taskWeights = tasks.map((task, index) => { totalTaskWeight += [1.7, 1.5, .8, .65, 1.1, 1.4, .9, .6, 1.2, 1.8][task.teamIndex] * (.5 + index % 7 * .25); return totalTaskWeight; });
  const pickTask = () => { const target = random() * totalTaskWeight; return tasks[taskWeights.findIndex(weight => weight > target)]; };
  const records = [];
  const weights = Array.from({ length: 96 }, (_, bin) => 30 + 80 * (1 + Math.sin((bin - 24) / 15)) + (bin >= 67 && bin <= 74 ? 170 : 0) + random() * 45);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let cumulative = 0;
  for (let bin = 0; bin < 96; bin++) {
    cumulative += weights[bin];
    const end = Math.round(cumulative / totalWeight * 9600);
    while (records.length < end) {
      const index = records.length;
      const running = index >= 9576;
      const task = running ? choose(tasks.filter(task => task.agent.id === agents[(index - 9576) * 7 % agents.length].id)) : index < tasks.length ? tasks[index * 53 % tasks.length] : pickTask();
      // Cover every catalog entry, then vary model mix with retrieval and generation.
      const modelIndex = index < 21 ? index : [2, 8, 9].includes(task.teamIndex) && index % 9 === 0 ? 20 : index % 11 === 0 ? [12, 13, 19][task.teamIndex % 3] : choose(TEAM_MODELS[task.teamIndex]);
      const [model, provider, location, baseLatency, rate, role] = MODEL_DEFINITIONS[modelIndex];
      const pick = random();
      const routeKind = pick < .09 && [4, 11, 13, 20].includes(modelIndex) ? 'unknown' : choose(MODEL_PATHS[modelIndex]);
      const route = routeKind === 'unknown' ? 'Unattributed route' : routeKind === 'local' ? provider : routeKind === 'direct' ? `${provider} API` : routeKind === 'router' ? location === 'local' ? 'router.private' : choose(ROUTERS.slice(0, 3)) : choose(GATEWAYS);
      const failed = !running && random() < (bin >= 68 && bin <= 73 ? .085 : .012);
      const inputTokens = Math.round(320 + random() ** 2 * (role === 'embedding' ? 32000 : 24000));
      const outputTokens = running ? null : failed || role === 'embedding' || role === 'reranking' ? 0 : Math.round(60 + random() ** 2 * (role === 'reasoning' ? 6500 : 2400));
      const cacheReadTokens = role === 'embedding' || role === 'reranking' ? 0 : Math.round(inputTokens * (index % 5 === 0 ? .7 : random() * .35));
      const cost = location === 'local' || running || index % 19 === 0 ? null : ((inputTokens - cacheReadTokens * .8) + outputTokens * 4) * rate / 1_000_000;
      const occurredAt = running ? now - (9600 - index) * 2300 : now - (96 - bin) * 900000 + random() * 900000;
      records.push({ id: `sample-request-${index + 1}`, sourceId: 'sample-activity', requestId: `req-${String(index + 1).padStart(5, '0')}`, occurredAt: new Date(occurredAt).toISOString(), model, modelCreator: MODEL_CREATORS[modelIndex], provider, location, workload: `services/${TEAMS[task.teamIndex][0].toLowerCase()}`, scope: 'agent', agentId: task.agent.id, agent: task.agent.name, taskId: task.id, task: task.name, route, routeKind, status: running ? 'running' : failed ? 'failed' : 'completed', inputTokens, outputTokens, cacheReadTokens, durationMs: running || index % 43 === 0 ? null : Math.round(baseLatency * (.4 + random() * 1.4) * (index % 71 === 0 ? 5 : 1)), cost, currency: 'USD', costKind: index % 9 === 0 ? 'estimated' : 'reported' });
    }
  }
  const time = new Date(now).toISOString();
  const localMemory = [5.2, 18.6, 42.4, 16.8, 9.1, .27, 1.2];
  const runningModels = new Set(records.filter(item => item.status === 'running').map(item => item.model));
  const models = MODEL_DEFINITIONS.map(([name, provider, location], index) => {
    const loaded = location === 'local' && (index !== 15 && index !== 18 || runningModels.has(name));
    return { id: `sample-model-${index}`, name, modelCreator: MODEL_CREATORS[index], creatorSources: ['sample-activity'], provider, location, state: location === 'cloud' ? 'observed' : loaded ? 'loaded' : 'installed', sourceId: location === 'cloud' ? 'sample-activity' : provider === 'Ollama' ? 'ollama' : provider === 'vLLM' ? 'runtime-vllm' : 'runtime-studio', memoryBytes: loaded ? localMemory[index - 14] * GiB : null, parameters: index >= 14 ? ['8B', '30B', '70B', '27B', '14B', '137M', '568M'][index - 14] : null, quantization: index >= 14 ? index >= 19 ? 'F16' : 'Q4_K_M' : null };
  });
  const modelCounts = new Map();
  for (const record of records) modelCounts.set(`${record.provider}:${record.model}`, (modelCounts.get(`${record.provider}:${record.model}`) ?? 0) + 1);
  models.sort((a, b) => modelCounts.get(`${b.provider}:${b.name}`) - modelCounts.get(`${a.provider}:${a.name}`));
  const history = Array.from({ length: 240 }, (_, index) => ({ at: new Date(now - (239 - index) * 15000).toISOString(), cpuPercent: Math.min(97, 46 + Math.sin(index / 13) * 15 + (index > 155 && index < 184 ? 24 : 0) + random() * 12), memoryUsed: (110 + Math.sin(index / 32) * 12 + (index > 155 ? 18 : 0) + random() * 2) * GiB }));
  const providers = [...new Set(models.filter(model => model.location === 'cloud').map(model => model.provider))];
  const poolId = name => `pool-${name.toLowerCase().replaceAll(' ', '-')}`;
  const deployments = MODEL_DEFINITIONS.flatMap(([model, provider, location], index) => Array.from({ length: index < 6 ? 2 : 1 }, (_, variant) => ({ id: `deployment-${index}-${variant}`, name: location === 'local' ? `${provider.toLowerCase().replaceAll(' ', '-')}-local` : `${provider.toLowerCase()}-${variant ? 'eu-1' : 'us-1'}`, model, modelCreator: MODEL_CREATORS[index], servingMode: location === 'local' ? 'self-hosted' : provider === 'Baseten' ? 'dedicated' : 'shared', provider, location, state: location === 'local' ? models.find(item => item.name === model).state : 'configured', sourceId: location === 'cloud' ? 'inventory' : models.find(item => item.name === model).sourceId, poolIds: [poolId(provider)] })));
  records.forEach((record, index) => {
    const modelIndex = MODEL_DEFINITIONS.findIndex(([model]) => model === record.model);
    record.deploymentId = record.routeKind === 'unknown' ? null : `deployment-${modelIndex}-${modelIndex < 6 && index % 4 === 0 ? 1 : 0}`;
    record.path = record.routeKind === 'unknown' ? [] : [{ name: record.route, kind: record.routeKind }];
    if (record.routeKind === 'router') record.path.push(record.location === 'local' ? { name: record.provider, kind: 'local' } : { name: index % 4 === 0 ? 'llm-gateway-eu' : 'llm-gateway', kind: 'gateway' });
    if (['router', 'gateway'].includes(record.routeKind) && record.location === 'cloud') record.path.push({ name: `${record.provider} API`, kind: 'direct' });
    if (record.routeKind === 'gateway' && record.location === 'local') record.path.push({ name: record.provider, kind: 'local' });
  });
  const capacityPools = [
    ...providers.map((name, index) => ({ id: poolId(name), name: `${name.toLowerCase()}-project-01`, kind: 'quota', sourceId: 'sample-capacity', windowSeconds: 60, observedAt: name === 'Cohere' ? null : new Date(now - (name === 'Baseten' ? 180000 : 12000)).toISOString(), resetAt: new Date(now + 28000).toISOString(), metrics: name === 'Cohere' ? {} : { requestsUsed: [842, 318, 126, 427, 193, 256][index % 6], requestsLimit: 1000, tokensUsed: name === 'Anthropic' ? 882000 : 180000 + index * 71000, tokensLimit: 1000000, running: 8 + index * 3, concurrencyLimit: 80 } })),
    ...['Ollama', 'vLLM', 'LM Studio'].map((name, index) => ({ id: poolId(name), name: `${name} / host unspecified`, kind: 'runtime', sourceId: 'sample-capacity', observedAt: new Date(now - 8000).toISOString(), metrics: { running: [8, 18, 3][index], waiting: [2, 7, 0][index], ...(index < 2 ? { concurrencyLimit: [12, 24][index], cachePercent: [54, 86][index] } : {}), memoryUsedBytes: [33.2, 43.6, 16.8][index] * GiB, memoryTotalBytes: [64, 64, 24][index] * GiB } })),
    ...GATEWAYS.map((name, index) => ({ id: poolId(name), name, kind: 'gateway', sourceId: 'sample-capacity', observedAt: new Date(now - 11000).toISOString(), metrics: { running: [46, 14, 6][index], concurrencyLimit: [50, 40, 20][index], waiting: [4, 0, 0][index] } })),
  ];
  const hostDefinitions = [
    ['this-machine', 'devbox-01', '', '', 'AMD EPYC · 32 cores', 32, 256, ['RTX 4090', 24, 1], ['LM Studio']],
    ['gpu-01', 'gpu-01', 'dc-01', 'rack-07', 'AMD EPYC · 64 cores', 64, 256, ['NVIDIA L40S', 48, 2], ['Ollama']],
    ['gpu-02', 'gpu-02', 'dc-01', 'rack-07', 'AMD EPYC · 96 cores', 96, 512, ['NVIDIA H100', 80, 2], ['vLLM']],
    ['gpu-03', 'gpu-03', 'dc-01', 'rack-07', 'AMD EPYC · 64 cores', 64, 256, ['NVIDIA L40S', 48, 2], []],
    ['gpu-04', 'gpu-04', 'dc-02', 'rack-03', 'Intel Xeon · 48 cores', 48, 256, ['NVIDIA A100', 80, 2], []],
    ['gpu-05', 'gpu-05', 'dc-02', 'rack-03', 'Intel Xeon · 48 cores', 48, 256, ['NVIDIA A100', 80, 2], []],
  ];
  const hosts = hostDefinitions.map(([id, name, site, rack, chip, cores, ram, [gpu, vram, count], runtimes], index) => {
    const observedAt = index === 5 ? null : new Date(now - (index === 4 ? 180000 : 0)).toISOString();
    const hostHistory = observedAt ? history.map((point, i) => ({ at: new Date(Date.parse(point.at) - (index === 4 ? 180000 : 0)).toISOString(), cpuPercent: Math.max(0, Math.min(100, point.cpuPercent * [.55, 1, 1.2, .12, .4][index] + Math.sin(i / (11 + index)) * 4)), memoryUsed: point.memoryUsed * [.65, 1, 1.6, .15, .8][index] })) : [];
    const loadedModels = models.filter(model => model.state === 'loaded' && runtimes.includes(model.provider)).map(model => ({ ...model, runtime: model.provider, memoryKind: 'accelerator', deploymentId: deployments.find(deployment => deployment.model === model.name)?.id }));
    return { id, name, hostname: name, nameField: 'hostname', site, rack, chip, cores, platform: 'linux', arch: 'x64', sourceId: id === 'this-machine' ? 'machine' : 'hardware', observedAt, memoryTotal: ram * GiB, memoryUsed: hostHistory.at(-1)?.memoryUsed ?? null, cpuPercent: hostHistory.at(-1)?.cpuPercent ?? null, history: hostHistory, loadedModels, residencyReported: Boolean(observedAt),
      accelerators: Array.from({ length: count }, (_, device) => ({ id: `gpu-${device}`, name: gpu, memoryTotal: vram * GiB, memoryUsed: observedAt ? ([17.8, 35.2, 52.6, 1.2, 12][index] / count) * GiB : null, utilization: observedAt ? [32, 68, 84, 0, 21][index] + device : null })) };
  });
  for (const deployment of deployments.filter(item => item.location === 'local')) {
    const host = hosts.find(item => item.loadedModels.some(model => model.name === deployment.model));
    if (host) { deployment.hostId = host.id; deployment.name = `${host.name} / ${deployment.provider}`; deployment.location = host.id === 'this-machine' ? 'local' : 'private'; }
  }
  const privateModels = new Set(deployments.filter(item => item.location === 'private').map(item => `${item.provider}:${item.model}`));
  for (const model of models) if (privateModels.has(`${model.provider}:${model.name}`)) model.location = 'private';
  for (const record of records) if (privateModels.has(`${record.provider}:${record.model}`)) record.location = 'private';
  for (const pool of capacityPools.filter(item => item.kind === 'runtime')) {
    const host = hosts.find(item => item.loadedModels.some(model => pool.id === poolId(model.provider)));
    if (host) pool.name = `${pool.name.split(' / ')[0]} / ${host.name}`;
  }
  return { schemaVersion: 1, mode: 'sample', observedAt: time, interval: 15, project: { name: 'inference-sample', scope: 'Enterprise sample environment' }, models, deployments, capacityPools, hosts,
    runtimeStats: [{ name: 'vLLM', sourceId: 'runtime-vllm', hostId: 'gpu-02', running: 18, waiting: 7, inputTokens: 48200000, outputTokens: 9400000, finished: 74620 }],
    inventory: [
      ...['Baseten', 'Groq', 'Cerebras'].map(name => ({ name, kind: 'provider', location: 'cloud', state: 'configured', sourceId: 'environment', evidence: [{ field: `${name.toUpperCase()}_API_KEY`, basis: 'credential-name' }] })),
      ...ROUTERS.map(name => ({ name, kind: 'router', location: name === 'router.private' ? 'local' : 'cloud', state: 'observed' })),
      ...GATEWAYS.map(name => ({ name, kind: 'gateway', location: 'cloud', state: 'observed', poolIds: [poolId(name)] })),
      ...['Ollama', 'vLLM', 'LM Studio'].map(name => ({ name, kind: 'runtime', location: name === 'LM Studio' ? 'local' : 'private', state: 'observed' })),
    ], records,
    sources: [
      { id: 'environment', name: 'Service configuration', kind: 'Process environment', state: 'connected', updatedAt: time, detail: 'BASETEN_API_KEY · GROQ_API_KEY · CEREBRAS_API_KEY', note: 'Fictional examples of environment-variable evidence. No credentials were read for this sample. Configuration alone does not establish usage, deployments, or hardware.' },
      { id: 'hardware', name: 'Hardware export', kind: 'Local file', state: 'partial', updatedAt: time, detail: '.openmerit/hosts.json', note: 'Fictional fleet across two racks and a workstation. gpu-04 has stale readings; gpu-05 has not reported a reading.' },
      { id: 'sample-capacity', name: 'Capacity export', kind: 'Local file', state: 'partial', updatedAt: time, detail: '.openmerit/capacity.json', note: 'Fictional shared quotas and runtime readings. Baseten is stale; Cohere has no reading. Pool measurements cover all consumers, including work outside this project.' },
      { id: 'sample-activity', name: 'Inference activity', kind: 'Local file', state: 'connected', updatedAt: time, detail: '.openmerit/inference.jsonl', note: 'Fictional metadata for 40 agent IDs and 140 task IDs. Names represent exported fields, not discovered code. Some display names are absent. Measurements and prices are illustrative.', records: records.length },
      { id: 'ollama', name: 'Ollama', kind: 'Runtime export', state: 'connected', updatedAt: time, detail: 'gpu-01 / Ollama', note: 'Fictional private-runtime inventory and resident allocations from existing exports.' },
      { id: 'runtime-studio', name: 'LM Studio', kind: 'Local runtime', state: 'connected', updatedAt: time, detail: '127.0.0.1:1234', note: 'Fictional compatible runtime inventory.' },
      { id: 'runtime-vllm', name: 'vLLM', kind: 'Runtime export', state: 'connected', updatedAt: time, detail: 'gpu-02 / vLLM', note: 'Fictional runtime and host exports. Remote endpoints are not queried by this terminal.' },
      { id: 'machine', name: 'This machine', kind: 'Operating system', state: 'connected', updatedAt: time, detail: 'Linux · x64', note: 'Fictional whole-machine CPU and memory samples. These are not attributed to individual requests.' },
      { id: 'openmerit', name: 'OpenMerit', kind: 'Project evidence', state: 'connected', updatedAt: time, detail: '.openmerit/events.jsonl', note: 'Fictional audit source. The activity export takes precedence; request totals are not added together.', records: 140 },
      { id: 'inventory', name: 'Declared inventory', kind: 'Project configuration', state: 'connected', updatedAt: time, detail: '.openmerit/terminal.json', note: 'Fictional configuration keys for four routers, three gateways, and three local runtimes. llm-gateway is an example service name, not a built-in gateway.' },
      { id: 'batch-archive', name: 'Batch archive', kind: 'Local file', state: 'unavailable', updatedAt: null, detail: '.openmerit/archive/inference.jsonl', note: 'Fictional unavailable source. No requests from this archive are included.' },
    ],
    machine: hosts[0],
  };
}
