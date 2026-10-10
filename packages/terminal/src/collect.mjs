import { open, readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import os from 'node:os';
import { historyExtent } from './history.mjs';
import { discoverProject, discoveryCandidates } from './discovery.mjs';
import { createBackgroundIndex } from './repository-background.mjs';
import { createProjectActivity } from './project-activity.mjs';
import { reconcileActivity } from './activity-merge.mjs';
import { modelCreators } from './services.mjs';
import { collectionLimits, configurationLimits, hardwareLimits, limitNote } from './coverage.mjs';
import { normalizeHosts, retainHostHistory, hostState } from './hardware.mjs';
import { StringDecoder } from 'node:string_decoder';
import { checkpointForRead, checkpointMatches } from './log-continuity.mjs';
import { normalizePath, normalizeDeployments, normalizePools, normalizeCapacity, poolIds } from './topology.mjs';

const MAX_READ = 4 * 1024 * 1024;
const MAX_RECORDS = 10_000;
const text = (value, fallback = '') => typeof value === 'string' ? value.slice(0, 160).replace(/[\x00-\x1f]/g, '') : fallback;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const inside = (root, path) => { const part = relative(root, path); return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
function localOrigin(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Runtime URLs must be HTTP loopback origins without credentials or paths.');
  return url.origin;
}

// A projection, never a passthrough: prompts, responses, headers and credentials
// cannot reach the terminal through an imported record.
export function normalizeRecord(value, sourceId) {
  // Development usage is outside the application's scope, even in an explicit export.
  if (!value || typeof value !== 'object' || value.scope === 'development' || !text(value.id) || !text(value.model)) return null;
  const occurredAt = date(value.occurredAt);
  if (!occurredAt) return null;
  let path = normalizePath(value.path);
  const route = text(value.route) || path[0]?.name || 'Unattributed route';
  const routeKind = ['direct', 'local', 'router', 'gateway', 'unknown'].includes(value.routeKind) ? value.routeKind : path[0]?.kind ?? null;
  if (path.length && (path[0].name !== route || path[0].kind !== routeKind)) path = [];
  return {
    id: text(value.id), sourceId, occurredAt,
    requestId: text(value.requestId) || null,
    agentId: text(value.agentId) || null, agent: text(value.agent) || null,
    taskId: text(value.taskId) || null, task: text(value.task) || null,
    deploymentId: text(value.deploymentId) || null, path,
    model: text(value.model), modelCreator: text(value.modelCreator) || null, provider: text(value.provider) || 'Unattributed',
    workload: text(value.workload) || 'Unattributed workload',
    scope: ['application', 'agent', 'evaluation'].includes(value.scope) ? value.scope : 'application',
    route, routeKind,
    location: ['local', 'private', 'cloud'].includes(value.location) ? value.location : 'unknown',
    status: ['completed', 'running', 'failed'].includes(value.status) ? value.status : 'unknown',
    inputTokens: number(value.inputTokens), outputTokens: number(value.outputTokens), cacheReadTokens: number(value.cacheReadTokens),
    durationMs: number(value.durationMs), cost: number(value.cost),
    costKind: ['reported', 'estimated'].includes(value.costKind) ? value.costKind : 'unknown',
    currency: value.currency === 'USD' ? 'USD' : 'unknown',
  };
}

export class JsonlReader {
  constructor(root, path) { this.root = root; this.path = path; this.offset = 0; this.identity = ''; this.pending = ''; this.decoder = new StringDecoder('utf8'); this.records = new Map(); this.invalid = 0; this.truncated = false; this.mtime = 0; this.checkpoint = null; }
  async read(projectAudit = false) {
    try {
      const canonicalRoot = await realpath(this.root);
      const canonical = await realpath(this.path);
      if (!inside(canonicalRoot, canonical)) throw new Error('Source must remain inside this project.');
      if (!(await stat(canonical)).isFile()) throw new Error('Source must be a regular file.');
      const handle = await open(canonical, 'r');
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error('Source must be a regular file.');
        const identity = `${info.dev}:${info.ino}`;
        if (identity !== this.identity || info.size < this.offset || (info.size === this.offset && info.mtimeMs !== this.mtime) || !await checkpointMatches(handle, this.checkpoint)) {
          this.offset = 0; this.pending = ''; this.decoder = new StringDecoder('utf8'); this.records.clear(); this.invalid = 0; this.truncated = false; this.checkpoint = null;
        }
        this.identity = identity;
        let skipFirst = false;
        if (info.size - this.offset > MAX_READ) { this.offset = info.size - MAX_READ; this.pending = ''; this.decoder = new StringDecoder('utf8'); this.truncated = true; skipFirst = true; }
        const buffer = Buffer.alloc(Math.min(MAX_READ, info.size - this.offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
        this.checkpoint = checkpointForRead(buffer.subarray(0, bytesRead), this.offset, this.checkpoint);
        this.offset += bytesRead; this.mtime = info.mtimeMs;
        const lines = (this.pending + this.decoder.write(buffer.subarray(0, bytesRead))).split('\n');
        this.pending = lines.pop() ?? '';
        if (skipFirst) lines.shift();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            let raw = JSON.parse(line);
            if (projectAudit) {
              if (raw.type !== 'automation_signal_recorded' || raw.data?.signalType !== 'product_task_completed') continue;
              const data = raw.data;
              raw = { id: data.signalId ?? raw.id, occurredAt: raw.occurredAt, model: data.modelId, workload: data.targetId, ...data.telemetry };
            }
            const record = normalizeRecord(raw, projectAudit ? 'openmerit' : 'activity');
            if (!record) { this.invalid++; continue; }
            this.records.delete(record.id);
            this.records.set(record.id, projectAudit ? { ...record, kind: 'task-summary', status: 'unknown' } : record);
            if (this.records.size > MAX_RECORDS) { this.records.delete(this.records.keys().next().value); this.truncated = true; }
          } catch { this.invalid++; }
        }
        if (this.pending.length > 128 * 1024) { this.pending = ''; this.invalid++; }
        return { state: 'connected', records: [...this.records.values()], invalid: this.invalid, truncated: this.truncated };
      } finally { await handle.close(); }
    } catch (error) {
      // Never keep deleted or unreadable source data looking current.
      this.records.clear(); this.offset = 0; this.pending = ''; this.identity = ''; this.decoder = new StringDecoder('utf8'); this.checkpoint = null;
      return { state: error.code === 'ENOENT' ? 'not_found' : 'unavailable', records: [], invalid: 0, truncated: false };
    }
  }
}

export async function loadConfig(root) {
  const path = resolve(root, '.openmerit/terminal.json');
  let raw;
  try {
    if (!inside(await realpath(root), await realpath(path))) throw new Error('Terminal configuration must remain inside this project.');
    if ((await stat(path)).size > 128 * 1024) throw new Error('Terminal configuration exceeds 128 KiB.');
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') raw = {}; else throw new Error('Cannot read .openmerit/terminal.json. Check its JSON and project-local path.'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Terminal configuration must be a JSON object.');
  const activityFile = text(raw.activityFile, '.openmerit/inference.jsonl');
  if (!inside(resolve(root), resolve(root, activityFile))) throw new Error('activityFile must be inside this project.');
  const capacityFile = text(raw.capacityFile, '.openmerit/capacity.json');
  if (!inside(resolve(root), resolve(root, capacityFile))) throw new Error('capacityFile must be inside this project.');
  const hardwareFile = text(raw.hardwareFile, '.openmerit/hosts.json');
  if (!inside(resolve(root), resolve(root, hardwareFile))) throw new Error('hardwareFile must be inside this project.');
  if (raw.ollama !== undefined && raw.ollama !== false && (typeof raw.ollama !== 'string' || !raw.ollama.trim())) throw new Error('ollama must be a loopback URL or false.');
  const endpoint = typeof raw.ollama === 'string' ? text(raw.ollama) : null;
  if (endpoint) localOrigin(endpoint);
  const runtimes = Array.isArray(raw.runtimes) ? raw.runtimes.slice(0, 8).map((runtime, index) => {
    if (!runtime || !['openai-compatible', 'vllm', 'ollama'].includes(runtime.type)) throw new Error('Runtime type must be openai-compatible, vllm, or ollama.');
    const url = localOrigin(runtime.url);
    return { id: `runtime-${index}`, name: text(runtime.name) || (runtime.type === 'ollama' ? 'Ollama' : url), type: runtime.type, url, ...runtimePlacement(runtime) };
  }) : [];
  const inventory = Array.isArray(raw.inventory) ? raw.inventory.slice(0, 100).filter(item => item && typeof item === 'object').map(item => ({
    name: text(item.name), modelCreator: text(item.modelCreator) || null, provider: text(item.provider, 'Unattributed'),
    kind: ['model', 'provider', 'gateway', 'router', 'runtime'].includes(item.kind) ? item.kind : 'model',
    serviceType: ['model-api', 'inference-cloud'].includes(item.serviceType) ? item.serviceType : null,
    location: ['local', 'private', 'cloud'].includes(item.location) ? item.location : 'unknown',
    poolIds: poolIds(item.poolIds),
  })).filter(item => item.name) : [];
  return { limits: configurationLimits(raw), discovery: raw.discovery !== false, activityFile, capacityFile, hardwareFile, ollama: endpoint, ollamaDisabled: raw.ollama === false, inventory, runtimes, deployments: normalizeDeployments(raw.deployments), capacityPools: normalizePools(raw.capacityPools) };
}

async function exportSnapshot(root, path, key, normalize, limit = 128 * 1024) {
  try {
    const canonical = await realpath(resolve(root, path));
    if (!inside(await realpath(root), canonical)) throw new Error('Outside project');
    const info = await stat(canonical);
    if (!info.isFile() || info.size > limit) throw new Error('Invalid export');
    const handle = await open(canonical, 'r');
    let raw;
    try { const buffer = Buffer.alloc(limit + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); if (bytesRead > limit) throw new Error('Too large'); raw = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')); } finally { await handle.close(); }
    if (!Array.isArray(raw?.[key])) throw new Error('Missing entries');
    const limits = key === 'hosts' ? hardwareLimits(raw) : collectionLimits(raw, { pools: 100 });
    return { state: limits.length ? 'partial' : 'connected', limits, truncated: limits.length > 0, [key]: normalize(raw) };
  } catch (error) { return { state: error.code === 'ENOENT' ? 'not_found' : 'unavailable', [key]: [] }; }
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(1800), redirect: 'error' });
  if (!response.ok) throw new Error('Source unavailable');
  // Bound response size even when content-length is missing.
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_READ) throw new Error('Response too large'); chunks.push(value); }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}
async function fetchJson(url) { return JSON.parse(await fetchText(url)); }

export function parseRuntimeMetrics(body) {
  const names = { num_requests_running: 'running', num_requests_waiting: 'waiting', prompt_tokens_total: 'inputTokens', generation_tokens_total: 'outputTokens', request_success_total: 'finished', kv_cache_usage_perc: 'cachePercent' };
  const result = {};
  for (const line of body.split('\n')) {
    const match = line.match(/^vllm:(\w+)(?:\{[^}]*\})?\s+([\d.eE+-]+)(?:\s|$)/);
    if (!match || !names[match[1]]) continue;
    const value = Number(match[2]); if (!Number.isFinite(value) || value < 0) continue;
    const key = names[match[1]];
    if (key === 'cachePercent') { if (value <= 1) result[key] = Math.max(result[key] ?? 0, value * 100); }
    else result[key] = (result[key] ?? 0) + value;
  }
  return result;
}

function runtimePlacement(runtime = {}) {
  const hostId = text(runtime.hostId) || null;
  return { hostId, location: hostId === 'this-machine' ? 'local' : ['local', 'private', 'cloud'].includes(runtime.location) ? runtime.location : 'unknown', servingMode: ['shared', 'dedicated', 'self-hosted'].includes(runtime.servingMode) ? runtime.servingMode : 'unknown' };
}
async function runtimeSnapshot(runtime) {
  const placement = runtimePlacement(runtime);
  const source = { id: runtime.id, name: runtime.name, endpointInventory: true, detail: runtime.url, ...placement,
    access: runtime.discoverySource ? 'Project declaration' : 'Project configuration', discoverySource: runtime.discoverySource, discoveryField: runtime.discoveryField };
  if (runtime.type === 'ollama') {
    const snapshot = await ollamaSnapshot(runtime.url, runtime.id, runtime.name);
    return { ...snapshot, source: { ...source, kind: 'Model runtime', state: snapshot.state, limits: snapshot.limits, truncated: snapshot.truncated, note: snapshot.note + ' Shared runtime inventory; the endpoint does not identify its physical host.', coverage: ['Model catalog', 'Loaded models'] },
      models: snapshot.models.map(model => ({ ...model, location: placement.location })), stats: null };
  }
  const [catalog, metrics] = await Promise.allSettled([fetchJson(`${runtime.url}/v1/models`), ['vllm', 'discover'].includes(runtime.type) ? fetchText(`${runtime.url}/metrics`) : Promise.resolve(null)]);
  const connected = catalog.status === 'fulfilled' && Array.isArray(catalog.value?.data);
  const counters = metrics.status === 'fulfilled' && metrics.value ? parseRuntimeMetrics(metrics.value) : {};
  const identifiedRuntime = runtime.type === 'vllm' || runtime.identifiedName?.startsWith('vLLM · ') || Object.keys(counters).length > 0;
  const name = runtime.identifiedName || (runtime.type === 'discover' && identifiedRuntime ? `vLLM · ${new URL(runtime.url).host}` : runtime.name);
  const limits = connected ? collectionLimits({ models: catalog.value.data }, { models: 100 }) : [];
  return {
    source: { ...source, name, kind: identifiedRuntime ? 'Model runtime' : 'Model endpoint', state: connected ? (limits.length || identifiedRuntime && !Object.keys(counters).length ? 'partial' : 'connected') : Object.keys(counters).length ? 'partial' : 'unavailable', limits, truncated: limits.length > 0,
      note: 'Project endpoint inventory. Available models and counters cover all clients; they do not establish application usage or physical host placement.' + limitNote(limits), coverage: ['Model catalog', ...(Object.keys(counters).length ? ['Runtime counters'] : [])] },
    models: connected ? catalog.value.data.slice(0, 100).filter(item => item && text(item.id)).map(item => ({ id: `${runtime.id}:${text(item.id)}`, name: text(item.id), provider: name, location: placement.location, state: 'available', sourceId: runtime.id, memoryBytes: null })) : [],
    stats: Object.keys(counters).length ? { name, sourceId: runtime.id, hostId: placement.hostId, ...counters } : null,
  };
}

async function ollamaSnapshot(endpoint, sourceId = 'ollama', provider = 'Ollama') {
  if (!endpoint) return { state: 'disabled', models: [], note: 'Local runtime discovery is disabled.' };
  const [tags, ps] = await Promise.allSettled([fetchJson(`${endpoint.replace(/\/$/, '')}/api/tags`), fetchJson(`${endpoint.replace(/\/$/, '')}/api/ps`)]);
  const tagsOk = tags.status === 'fulfilled' && Array.isArray(tags.value?.models);
  const psOk = ps.status === 'fulfilled' && Array.isArray(ps.value?.models);
  if (!tagsOk && !psOk) return { state: 'unavailable', models: [], note: 'Ollama did not return valid inventory at the configured local address.' };
  const installedEntries = tagsOk ? tags.value.models.filter(item => item && typeof item === 'object') : [];
  const loadedEntries = psOk ? ps.value.models.filter(item => item && typeof item === 'object') : [];
  const installed = installedEntries.slice(0, 100), loaded = loadedEntries.slice(0, 100);
  const limits = collectionLimits({ installedModels: installedEntries, loadedModels: loadedEntries }, { installedModels: 100, loadedModels: 100 });
  const all = new Map([...installed, ...loaded].map(model => [text(model.name ?? model.model), model]));
  return {
    state: tagsOk && psOk && !limits.length ? 'connected' : 'partial', limits, truncated: limits.length > 0, residencyReported: psOk,
    note: 'Installed and loaded models. Request history is not exposed by this source.' + limitNote(limits),
    models: [...all].filter(([name]) => name).map(([name, model]) => ({ id: `${sourceId}:${name}`, name, provider, location: 'unknown', state: loaded.some(item => (item.name ?? item.model) === name) ? 'loaded' : (psOk && !limits.some(item => item.collection === 'loadedModels') ? 'installed' : 'unknown'), memoryBytes: number(model.size_vram), parameters: text(model.details?.parameter_size) || null, quantization: text(model.details?.quantization_level) || null, sourceId })),
  };
}

function cpuTotals() { return os.cpus().reduce((all, cpu) => ({ idle: all.idle + cpu.times.idle, total: all.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 }); }

export function createCollector(root, config, interval = 15, { backgroundIndex = false, indexOptions } = {}) {
  const background=config.discovery&&backgroundIndex?createBackgroundIndex(root,indexOptions):null;
  let scanner=null;
  const activityReader = new JsonlReader(root, resolve(root, config.activityFile));
  const auditReader = new JsonlReader(root, resolve(root, '.openmerit/events.jsonl'));
  let previousCpu = null;
  const hardwareHistory = [];
  const hostHistories = new Map();
  const projectActivity = createProjectActivity(root, normalizeRecord, { exclude: [resolve(root, config.activityFile)] });
  let projectDiscovery = { sources: [], inventory: [], runtimes: [] }, repository = null, discoveredAt = 0;
  const knownRuntimes = new Map();
  const collect = async function collect() {
    const scan = Boolean(config.discovery) && Date.now() - discoveredAt >= 60_000;
    background?.start();
    if (scan) {
      if(!background)scanner??=(await import('./repository-index.mjs')).createRepositoryScanner(root);
      [projectDiscovery,repository]=await Promise.all([discoverProject(root),background?null:scanner()]);
      discoveredAt=Date.now();
    }
    const allCandidates = config.discovery ? discoveryCandidates(projectDiscovery, config.runtimes, config.ollama, Infinity).filter(runtime => !(config.ollamaDisabled && runtime.type === 'ollama')) : [];
    const candidates = allCandidates.slice(0, 8);
    const discoveryLimits = collectionLimits({ endpoints: allCandidates }, { endpoints: 8 });
    const localComputeLinked = Boolean(config.runtimes?.some(item => item.hostId === 'this-machine') || config.deployments?.some(item => item.hostId === 'this-machine'));
    const candidateIds = new Set(candidates.map(item => item.id));
    for (const id of knownRuntimes.keys()) if (!candidateIds.has(id)) knownRuntimes.delete(id);
    const autoRuntimes = candidates.filter(item => scan || knownRuntimes.has(item.id)).map(item => ({ ...item, identifiedName: knownRuntimes.get(item.id) }));
    const logs = config.discovery ? await projectActivity() : { records: [], sources: [] };
    const [activity, audit, ollama, runtimes, capacity, hardware] = await Promise.all([activityReader.read(), auditReader.read(true), ollamaSnapshot(config.ollama), Promise.all([...(config.runtimes ?? []), ...autoRuntimes].map(runtimeSnapshot)), exportSnapshot(root, config.capacityFile ?? '.openmerit/capacity.json', 'pools', normalizeCapacity), exportSnapshot(root, config.hardwareFile ?? '.openmerit/hosts.json', 'hosts', normalizeHosts, 256 * 1024)]);
    for (const runtime of runtimes) if (runtime.source.discoverySource && ['connected', 'partial'].includes(runtime.source.state)) knownRuntimes.set(runtime.source.id, runtime.source.name);
    // A declared endpoint must respond before its catalog becomes discovered inventory.
    for (let i = runtimes.length - 1; i >= 0; i--) if (runtimes[i].source.discoverySource && !knownRuntimes.has(runtimes[i].source.id)) runtimes.splice(i, 1);
    const now = new Date().toISOString();
    const recorded = records => records.filter(item => Date.parse(item.occurredAt) <= Date.parse(now));
    const batches = [
      { sourceId: 'activity', records: recorded(activity.records) },
      ...logs.sources.map(source => ({ sourceId: source.id, records: recorded(logs.records.filter(record => record.sourceId === source.id)) })),
    ].filter(batch => batch.records.length);
    const reconciliation = reconcileActivity(batches);
    // Task summaries are a different unit, never request-level evidence.
    const records = reconciliation.records;
    const taskSummaries = recorded(audit.records);
    const requestSources = reconciliation.sources.filter(source => source.included > 0).map(source => source.sourceId);
    const models = new Map([...ollama.models, ...runtimes.flatMap(runtime => runtime.models)].map(item => [`${item.provider}:${item.name}`, item]));
    for (const host of hardware.hosts) for (const model of host.loadedModels) {
      const key = `${model.provider || 'Unattributed'}:${model.name}`;
      const loaded = hostState(host, interval) === 'sampled';
      // A fresh resident on any exported host wins over stale host evidence.
      if (!models.has(key) || models.get(key).sourceId === 'hardware' && loaded) models.set(key, { id: key, name: model.name, modelCreator: model.modelCreator, provider: model.provider || 'Unattributed', location: 'private', state: loaded ? 'loaded' : 'unknown', sourceId: 'hardware', memoryBytes: null });
    }
    for (const item of [...config.inventory.filter(item => item.kind === 'model'), ...(config.deployments ?? []).map(item => ({ ...item, name: item.model }))]) {
      const key = `${item.provider}:${item.name}`;
      if (!models.has(key)) models.set(key, { ...item, id: key, state: 'configured', sourceId: 'inventory', memoryBytes: null });
    }
    for (const item of records) {
      const key = `${item.provider}:${item.model}`;
      if (!models.has(key)) models.set(key, { id: key, name: item.model, provider: item.provider, location: item.location, state: 'observed', sourceId: item.sourceId, memoryBytes: null });
    }
    const cpu = cpuTotals();
    const cpuPercent = previousCpu && cpu.total > previousCpu.total ? Math.max(0, Math.min(100, 100 * (1 - (cpu.idle - previousCpu.idle) / (cpu.total - previousCpu.total)))) : null;
    previousCpu = cpu;
    const memoryTotal = os.totalmem();
    const memoryUsed = memoryTotal - os.freemem();
    hardwareHistory.push({ at: now, cpuPercent, memoryUsed });
    if (hardwareHistory.length > 240) hardwareHistory.shift();
    const sources = [
      { id: 'activity', name: 'Inference activity', kind: 'Local file', state: activity.state === 'connected' && (activity.truncated || activity.invalid) ? 'partial' : activity.state, truncated: activity.truncated, invalid: activity.invalid, updatedAt: activity.state === 'connected' ? now : null, detail: config.activityFile, note: activity.truncated ? 'The bounded reader omitted older records. All time covers retained history only.' : activity.invalid ? `${activity.invalid} invalid records skipped.` : 'Application request metadata, including its agents, jobs, evaluations, and gateway.', records: activity.records.length },
      { id: 'openmerit', name: 'OpenMerit', kind: 'Project evidence', state: audit.state === 'connected' && (audit.truncated || audit.invalid) ? 'partial' : audit.state, truncated: audit.truncated, invalid: audit.invalid, updatedAt: audit.state === 'connected' ? now : null, detail: '.openmerit/events.jsonl', note: 'Task summaries are retained separately to avoid counting a task summary as an inference request. They do not contribute to request counts, tokens, spend, or request history.', summaries: taskSummaries.length },
      ...(config.ollama ? [{ id: 'ollama', name: 'Ollama', kind: 'Model runtime', endpointInventory: true, ...runtimePlacement(), limits: ollama.limits, truncated: ollama.truncated, state: ollama.state, updatedAt: ['connected', 'partial'].includes(ollama.state) ? now : null, detail: config.ollama, access: 'Project configuration', note: ollama.note + ' Explicitly linked in terminal.json. Inventory is shared by all clients of this runtime.' }] : []),
      ...(localComputeLinked ? [{ id: 'machine', name: 'This machine', kind: 'Operating system', state: 'connected', updatedAt: now, detail: `${os.platform()} · ${os.arch()}`, note: 'Shown because the project explicitly links a runtime or deployment to this-machine. CPU and memory describe the whole machine, not individual inference requests.' }] : []),
    ];
    if (config.discovery) {
      sources.push(...projectDiscovery.sources);

      sources.push(...logs.sources);
      if (discoveryLimits.length) sources.push({ id: 'runtime-discovery', name: 'Endpoint discovery coverage', kind: 'Project discovery', state: 'partial', truncated: true, limits: discoveryLimits, detail: '.env · .env.local', note: limitNote(discoveryLimits).trim() });
    }
    for (const source of sources) {
      const contribution = reconciliation.sources.find(item => item.sourceId === source.id);
      if (contribution) {
        source.activity = contribution;
        source.note += ` ${contribution.included} requests contribute to totals; ${contribution.duplicates} matching records reconciled; ${contribution.excluded} excluded because overlap could not be resolved.`;
        if (contribution.excluded) source.state = 'partial';
      }
    }
    sources.push({ id: 'hardware', name: 'Hardware export', kind: 'Local file', state: hardware.state, limits: hardware.limits, truncated: hardware.truncated, updatedAt: ['connected', 'partial'].includes(hardware.state) ? now : null, detail: config.hardwareFile ?? '.openmerit/hosts.json', note: 'Hosts, racks, accelerators, and loaded models from an existing exporter. Host timestamps determine freshness; no network discovery.' + limitNote(hardware.limits) });
    sources.push(...runtimes.map(runtime => ({ ...runtime.source, updatedAt: ['connected', 'partial'].includes(runtime.source.state) ? now : null })));
    sources.push({ id: 'capacity', name: 'Capacity export', kind: 'Local file', state: capacity.state, limits: capacity.limits, truncated: capacity.truncated, updatedAt: ['connected', 'partial'].includes(capacity.state) ? now : null, detail: config.capacityFile ?? '.openmerit/capacity.json', note: 'Pool readings retain their source timestamps. A file check does not refresh a measurement. Only declared pool IDs are accepted.' + limitNote(capacity.limits) });
    if (config.inventory.length || config.runtimes?.length || config.limits?.length || (config.deployments?.length ?? 0) || (config.capacityPools?.length ?? 0)) sources.push({ id: 'inventory', name: 'Declared environment', kind: 'Project configuration', state: config.limits?.length ? 'partial' : 'connected', limits: config.limits, truncated: Boolean(config.limits?.length), updatedAt: now, detail: '.openmerit/terminal.json', note: 'Declared models, services, deployments, and shared pools. Configuration does not prove connectivity or available capacity.' + limitNote(config.limits) });
    const capacityPools = (config.capacityPools ?? []).map(pool => ({ ...pool, ...(capacity.pools.find(item => item.id === pool.id) ?? {}) }));
    const deployments = [...(config.deployments ?? [])];
    for (const source of sources.filter(item => item.endpointInventory && item.state !== 'disabled')) {
      const poolId = `runtime:${source.id}`;
      const counters = runtimes.find(item => item.source.id === source.id)?.stats;
      const metrics = Object.fromEntries(['running', 'waiting', 'cachePercent'].filter(key => counters?.[key] != null).map(key => [key, counters[key]]));
      capacityPools.push({ id: poolId, name: source.name, kind: 'runtime', sourceId: source.id, observedAt: Object.keys(metrics).length ? now : null, metrics });
      for (const model of [...ollama.models, ...runtimes.flatMap(item => item.models)].filter(item => item.sourceId === source.id)) deployments.push({ id: `runtime:${model.id}`, name: `${model.name} / ${source.name}`, model: model.name, provider: model.provider, servingMode: source.servingMode, location: model.location, sourceId: source.id, state: model.state, hostId: source.hostId, poolIds: [poolId] });
    }
    const residentRuntimes = runtimes.filter(runtime => runtime.residencyReported && runtime.source.hostId === 'this-machine');
    const residentModels = residentRuntimes.flatMap(runtime => runtime.models).filter(model => model.state === 'loaded');
    const machine = { id: 'this-machine', projectLinked: localComputeLinked, scope: 'whole-machine', name: os.hostname(), nameField: 'hostname', hostname: os.hostname(), site: '', rack: '', sourceId: 'machine', observedAt: now, chip: text(os.cpus()[0]?.model, os.arch()), cores: os.cpus().length, platform: os.platform(), arch: os.arch(), memoryTotal, memoryUsed, cpuPercent, history: [...hardwareHistory], accelerators: [], residencyReported: residentRuntimes.length > 0, loadedModels: residentModels.map(model => ({ ...model, runtime: model.provider, memoryKind: 'accelerator', deploymentId: `runtime:${model.id}` })) };
    const hosts = [...(localComputeLinked ? [machine] : []), ...retainHostHistory(hardware.hosts, hostHistories)];
    const inventory = [...config.inventory.filter(item => item.kind !== 'model'), ...projectDiscovery.inventory].map(item => ({ ...item, sourceId: item.sourceId || 'inventory' }));
    const creatorReports = [...records, ...(config.deployments ?? []), ...config.inventory.filter(item => item.kind === 'model').map(item => ({ ...item, sourceId: 'inventory' })), ...hardware.hosts.flatMap(host => host.loadedModels.map(model => ({ ...model, sourceId: 'hardware' })))];
    const historySources = sources.filter(source => source.id === 'activity' || source.id.startsWith('project-log:') || source.id === 'project-log-coverage');
    const gaps = historySources.filter(source => source.state === 'partial' || source.state === 'unavailable' || source.truncated || source.invalid);
    const history = { ...historyExtent(records, now), retained: records.length, coverage: gaps.length || reconciliation.excluded ? 'partial' : 'available', sourceIds: historySources.filter(source => source.state !== 'not_found').map(source => source.id) };
    const snapshot = {
      schemaVersion: 1, mode: 'live', observedAt: now, interval, history,
      repository: null,
      discovery: { enabled: Boolean(config.discovery), checkedAt: discoveredAt ? new Date(discoveredAt).toISOString() : null, intervalSeconds: 60, runtimeCandidates: candidates.length, requestSource: requestSources.length > 1 ? 'combined' : requestSources[0] ?? null, requestSources, reconciliation: { duplicates: reconciliation.duplicates, excluded: reconciliation.excluded, conflicts: reconciliation.conflicts, sources: reconciliation.sources } },
      project: { name: basename(root), scope: 'Current project' },
      models: modelCreators([...models.values()], creatorReports), inventory: [...inventory, ...(config.runtimes ?? []).map(runtime => ({ name: runtime.name, kind: runtime.type === 'openai-compatible' ? 'unknown' : 'runtime', location: runtimePlacement(runtime).location, state: 'configured' }))],
      records, taskSummaries, sources, deployments, capacityPools, runtimeStats: runtimes.map(runtime => runtime.stats).filter(Boolean),
      machine, hosts,
    };
    return background?snapshot:withRepository(snapshot,repository);
  };
  let previousBase=null,previousIndex=null,composed=null;
  collect.current=snapshot=>{
    if(!background||snapshot.loading)return snapshot;
    const index=background.get();
    if(snapshot!==previousBase||index!==previousIndex){composed=withRepository(snapshot,index);previousBase=snapshot;previousIndex=index;}
    return composed;
  };
  collect.close=()=>background?.close();
  return collect;
}
function withRepository(snapshot,repository) {
  if(!repository)return snapshot;
  const models=new Map(snapshot.models.map(item=>[`${item.provider}:${item.name}`,item]));
  for(const item of repository.models){
    const key=`${item.provider}:${item.name}`,existing=models.get(key);
    models.set(key,existing?{...existing,declarationIds:[...new Set([...(existing.declarationIds??[]),...item.declarationIds])]}:item);
  }
  const phase=repository.progress?.phase,active=phase&&phase!=='complete';
  const source={id:'repository',name:'Repository index',kind:'Code & configuration',state:active||repository.summary.unresolved||repository.summary.skipped.unreadable||repository.summary.skipped.oversized?'partial':'connected',detail:`${repository.summary.filesIndexed} files · ${repository.references.length} declarations${active?' · '+(phase==='failed'?'index interrupted':'indexing'):''}`,updatedAt:repository.checkedAt,coverage:['Endpoint declarations','Model references','Call sites','Coverage gaps'],access:'Selected project',note:'Static syntax only. Source code is never executed. Declarations do not establish usage, reachability, loaded models, or physical hosts. Examples, candidates, benchmarks and fallbacks are separated. Paths and line numbers identify the evidence; prompts, credentials and raw source contents are discarded.'};
  return {...snapshot,models:[...models.values()],inventory:[...snapshot.inventory,...repository.inventory],sources:[...snapshot.sources,source],repository:{references:repository.references,issues:repository.issues,summary:repository.summary,checkedAt:repository.checkedAt,revision:repository.revision,progress:repository.progress}};
}
