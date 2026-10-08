import { open, readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import os from 'node:os';
import { configuredServices, modelCreators } from './services.mjs';
import { normalizeHosts, retainHostHistory, hostState } from './hardware.mjs';
import { StringDecoder } from 'node:string_decoder';
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
  if (!value || typeof value !== 'object' || !text(value.id) || !text(value.model)) return null;
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
    status: ['completed', 'running', 'failed'].includes(value.status) ? value.status : 'completed',
    inputTokens: number(value.inputTokens), outputTokens: number(value.outputTokens), cacheReadTokens: number(value.cacheReadTokens),
    durationMs: number(value.durationMs), cost: number(value.cost),
    costKind: value.costKind === 'estimated' ? 'estimated' : 'reported',
    currency: value.currency === 'USD' || value.currency === undefined ? 'USD' : 'unknown',
  };
}

export class JsonlReader {
  constructor(root, path) { this.root = root; this.path = path; this.offset = 0; this.identity = ''; this.pending = ''; this.decoder = new StringDecoder('utf8'); this.records = new Map(); this.invalid = 0; this.truncated = false; this.mtime = 0; }
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
        if (identity !== this.identity || info.size < this.offset || (info.size === this.offset && info.mtimeMs !== this.mtime)) {
          this.offset = 0; this.pending = ''; this.decoder = new StringDecoder('utf8'); this.records.clear(); this.invalid = 0; this.truncated = false;
        }
        this.identity = identity;
        let skipFirst = false;
        if (info.size - this.offset > MAX_READ) { this.offset = info.size - MAX_READ; this.pending = ''; this.decoder = new StringDecoder('utf8'); this.truncated = true; skipFirst = true; }
        const buffer = Buffer.alloc(Math.min(MAX_READ, info.size - this.offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
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
            this.records.set(record.id, record);
            if (this.records.size > MAX_RECORDS) { this.records.delete(this.records.keys().next().value); this.truncated = true; }
          } catch { this.invalid++; }
        }
        if (this.pending.length > 128 * 1024) { this.pending = ''; this.invalid++; }
        return { state: 'connected', records: [...this.records.values()], invalid: this.invalid, truncated: this.truncated };
      } finally { await handle.close(); }
    } catch (error) {
      // Never keep deleted or unreadable source data looking current.
      this.records.clear(); this.offset = 0; this.pending = ''; this.identity = ''; this.decoder = new StringDecoder('utf8');
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
  const endpoint = raw.ollama === false ? null : text(raw.ollama, 'http://127.0.0.1:11434');
  if (endpoint) localOrigin(endpoint);
  const runtimes = Array.isArray(raw.runtimes) ? raw.runtimes.slice(0, 8).map((runtime, index) => {
    if (!runtime || !['openai-compatible', 'vllm'].includes(runtime.type)) throw new Error('Runtime type must be openai-compatible or vllm.');
    const url = localOrigin(runtime.url);
    return { id: `runtime-${index}`, name: text(runtime.name) || url, type: runtime.type, url };
  }) : [];
  const inventory = Array.isArray(raw.inventory) ? raw.inventory.slice(0, 100).filter(item => item && typeof item === 'object').map(item => ({
    name: text(item.name), modelCreator: text(item.modelCreator) || null, provider: text(item.provider, 'Unattributed'),
    kind: ['model', 'provider', 'gateway', 'router', 'runtime'].includes(item.kind) ? item.kind : 'model',
    location: ['local', 'private', 'cloud'].includes(item.location) ? item.location : 'unknown',
    poolIds: poolIds(item.poolIds),
  })).filter(item => item.name) : [];
  return { activityFile, capacityFile, hardwareFile, ollama: endpoint, inventory, runtimes, deployments: normalizeDeployments(raw.deployments), capacityPools: normalizePools(raw.capacityPools) };
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
    return { state: 'connected', [key]: normalize(raw) };
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

async function runtimeSnapshot(runtime) {
  const [catalog, metrics] = await Promise.allSettled([fetchJson(`${runtime.url}/v1/models`), runtime.type === 'vllm' ? fetchText(`${runtime.url}/metrics`) : Promise.resolve(null)]);
  const connected = catalog.status === 'fulfilled' && Array.isArray(catalog.value?.data);
  const counters = metrics.status === 'fulfilled' && metrics.value ? parseRuntimeMetrics(metrics.value) : {};
  return {
    source: { id: runtime.id, name: runtime.name, kind: 'Local runtime', state: connected ? (runtime.type === 'vllm' && metrics.status === 'rejected' ? 'partial' : 'connected') : Object.keys(counters).length ? 'partial' : 'unavailable', detail: runtime.url, note: 'Available model inventory. Runtime counters, when present, are separate from recorded request totals.' },
    models: connected ? catalog.value.data.slice(0, 100).filter(item => item && text(item.id)).map(item => ({ id: `${runtime.id}:${text(item.id)}`, name: text(item.id), provider: runtime.name, location: 'local', state: 'available', sourceId: runtime.id, memoryBytes: null })) : [],
    stats: Object.keys(counters).length ? { name: runtime.name, sourceId: runtime.id, ...counters } : null,
  };
}

async function ollamaSnapshot(endpoint) {
  if (!endpoint) return { state: 'disabled', models: [], note: 'Local runtime discovery is disabled.' };
  const [tags, ps] = await Promise.allSettled([fetchJson(`${endpoint.replace(/\/$/, '')}/api/tags`), fetchJson(`${endpoint.replace(/\/$/, '')}/api/ps`)]);
  const tagsOk = tags.status === 'fulfilled' && Array.isArray(tags.value?.models);
  const psOk = ps.status === 'fulfilled' && Array.isArray(ps.value?.models);
  if (!tagsOk && !psOk) return { state: 'unavailable', models: [], note: 'Ollama did not return valid inventory at the configured local address.' };
  const installed = tagsOk ? tags.value.models.filter(item => item && typeof item === 'object').slice(0, 100) : [];
  const loaded = psOk ? ps.value.models.filter(item => item && typeof item === 'object').slice(0, 100) : [];
  const all = new Map([...installed, ...loaded].map(model => [text(model.name ?? model.model), model]));
  return {
    state: tagsOk && psOk ? 'connected' : 'partial', residencyReported: psOk,
    note: 'Installed and loaded models. Request history is not exposed by this source.',
    models: [...all].filter(([name]) => name).map(([name, model]) => ({ id: `ollama:${name}`, name, provider: 'Ollama', location: 'local', state: loaded.some(item => (item.name ?? item.model) === name) ? 'loaded' : (psOk ? 'installed' : 'unknown'), memoryBytes: number(model.size_vram), parameters: text(model.details?.parameter_size) || null, quantization: text(model.details?.quantization_level) || null, sourceId: 'ollama' })),
  };
}

function cpuTotals() { return os.cpus().reduce((all, cpu) => ({ idle: all.idle + cpu.times.idle, total: all.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 }); }

export function createCollector(root, config, interval = 15) {
  const activityReader = new JsonlReader(root, resolve(root, config.activityFile));
  const auditReader = new JsonlReader(root, resolve(root, '.openmerit/events.jsonl'));
  let previousCpu = null;
  const hardwareHistory = [];
  const hostHistories = new Map();
  return async function collect() {
    const [activity, audit, ollama, runtimes, capacity, hardware] = await Promise.all([activityReader.read(), auditReader.read(true), ollamaSnapshot(config.ollama), Promise.all((config.runtimes ?? []).map(runtimeSnapshot)), exportSnapshot(root, config.capacityFile ?? '.openmerit/capacity.json', 'pools', normalizeCapacity), exportSnapshot(root, config.hardwareFile ?? '.openmerit/hosts.json', 'hosts', normalizeHosts, 256 * 1024)]);
    const now = new Date().toISOString();
    // An explicit activity feed is authoritative. Do not add overlapping audit
    // summaries to it: they often describe the very same application request.
    const records = (activity.records.length ? activity.records : audit.records).filter(item => Date.parse(item.occurredAt) <= Date.now() && Date.parse(item.occurredAt) >= Date.now() - 86_400_000);
    const models = new Map([...ollama.models, ...runtimes.flatMap(runtime => runtime.models)].map(item => [`${item.provider}:${item.name}`, item]));
    for (const host of hardware.hosts) for (const model of host.loadedModels) {
      const key = `${model.provider || 'Unattributed'}:${model.name}`;
      if (!models.has(key)) models.set(key, { id: key, name: model.name, modelCreator: model.modelCreator, provider: model.provider || 'Unattributed', location: 'private', state: hostState(host, interval) === 'sampled' ? 'loaded' : 'unknown', sourceId: 'hardware', memoryBytes: null });
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
      { id: 'activity', name: 'Inference activity', kind: 'Local file', state: activity.state, updatedAt: activity.state === 'connected' ? now : null, detail: config.activityFile, note: activity.truncated ? 'Showing a bounded recent window; older records are omitted.' : activity.invalid ? `${activity.invalid} invalid records skipped.` : 'Optional metadata export from your applications, agents, or gateway.', records: activity.records.length },
      { id: 'openmerit', name: 'OpenMerit', kind: 'Project evidence', state: audit.state, updatedAt: audit.state === 'connected' ? now : null, detail: '.openmerit/events.jsonl', note: activity.records.length ? 'Activity totals use the explicit feed to avoid counting requests twice.' : 'Completed application summaries. Redacted or absent measurements stay unknown.', records: audit.records.length },
      { id: 'ollama', name: 'Ollama', kind: 'Local runtime', state: ollama.state, updatedAt: ['connected', 'partial'].includes(ollama.state) ? now : null, detail: config.ollama ?? 'Disabled', note: ollama.note },
      { id: 'machine', name: 'This machine', kind: 'Operating system', state: 'connected', updatedAt: now, detail: `${os.platform()} · ${os.arch()}`, note: 'CPU and memory describe the whole machine, not individual inference requests.' },
    ];
    sources.push({ id: 'hardware', name: 'Hardware export', kind: 'Local file', state: hardware.state, updatedAt: hardware.state === 'connected' ? now : null, detail: config.hardwareFile ?? '.openmerit/hosts.json', note: 'Hosts, racks, accelerators, and loaded models from an existing exporter. Host timestamps determine freshness; no network discovery.' });
    sources.push(...runtimes.map(runtime => ({ ...runtime.source, updatedAt: ['connected', 'partial'].includes(runtime.source.state) ? now : null })));
    sources.push({ id: 'capacity', name: 'Capacity export', kind: 'Local file', state: capacity.state, updatedAt: capacity.state === 'connected' ? now : null, detail: config.capacityFile ?? '.openmerit/capacity.json', note: 'Pool readings retain their source timestamps. A file check does not refresh a measurement. Only declared pool IDs are accepted.' });
    if (config.inventory.length || (config.deployments?.length ?? 0) || (config.capacityPools?.length ?? 0)) sources.push({ id: 'inventory', name: 'Declared environment', kind: 'Project configuration', state: 'connected', updatedAt: now, detail: '.openmerit/terminal.json', note: 'Declared models, services, deployments, and shared pools. Configuration does not prove connectivity or available capacity.' });
    const capacityPools = (config.capacityPools ?? []).map(pool => ({ ...pool, ...(capacity.pools.find(item => item.id === pool.id) ?? {}) }));
    const deployments = [...(config.deployments ?? [])];
    for (const source of sources.filter(item => item.kind === 'Local runtime' && item.state !== 'disabled')) {
      const poolId = `runtime:${source.id}`;
      const counters = runtimes.find(item => item.source.id === source.id)?.stats;
      const metrics = Object.fromEntries(['running', 'waiting', 'cachePercent'].filter(key => counters?.[key] != null).map(key => [key, counters[key]]));
      capacityPools.push({ id: poolId, name: source.name, kind: 'runtime', sourceId: source.id, observedAt: Object.keys(metrics).length ? now : null, metrics });
      for (const model of [...ollama.models, ...runtimes.flatMap(item => item.models)].filter(item => item.sourceId === source.id)) deployments.push({ id: `runtime:${model.id}`, name: `${model.name} / ${source.name}`, model: model.name, provider: model.provider, servingMode: 'self-hosted', location: 'local', sourceId: source.id, state: model.state, hostId: 'this-machine', poolIds: [poolId] });
    }
    const machine = { id: 'this-machine', name: os.hostname(), nameField: 'hostname', hostname: os.hostname(), site: '', rack: '', sourceId: 'machine', observedAt: now, chip: text(os.cpus()[0]?.model, os.arch()), cores: os.cpus().length, platform: os.platform(), arch: os.arch(), memoryTotal, memoryUsed, cpuPercent, history: [...hardwareHistory], accelerators: [], residencyReported: Boolean(ollama.residencyReported), loadedModels: ollama.models.filter(model => model.state === 'loaded').map(model => ({ ...model, runtime: 'Ollama', memoryKind: 'accelerator', deploymentId: `runtime:${model.id}` })) };
    const hosts = [machine, ...retainHostHistory(hardware.hosts, hostHistories)];
    const environment = configuredServices();
    if (environment.services.length || environment.unrecognizedEndpoints.length) sources.push({ id: 'environment', name: 'Service configuration', kind: 'Process environment', state: environment.unrecognizedEndpoints.length ? 'partial' : 'connected', updatedAt: now, detail: [...environment.services.flatMap(item => item.evidence.map(entry => entry.field)), ...environment.unrecognizedEndpoints].join(' · '), note: 'Configuration evidence only, not verified connectivity or usage. Credential values are never exported or used. Endpoint overrides are matched by known HTTPS hosts; raw URLs are not retained.' + (environment.unrecognizedEndpoints.length ? ' Unrecognized endpoint variables: ' + environment.unrecognizedEndpoints.join(', ') + '. Declare those services explicitly if needed.' : '') });
    const inventory = config.inventory.filter(item => item.kind !== 'model').map(item => {
      const detected = environment.services.find(service => service.kind === item.kind && service.name === item.name);
      return { ...item, sourceId: 'inventory', ...(detected ? { evidence: detected.evidence } : {}) };
    });
    for (const service of environment.services) if (!inventory.some(item => item.kind === service.kind && item.name === service.name)) inventory.push(service);
    const creatorReports = [...records, ...(config.deployments ?? []), ...config.inventory.filter(item => item.kind === 'model').map(item => ({ ...item, sourceId: 'inventory' })), ...hardware.hosts.flatMap(host => host.loadedModels.map(model => ({ ...model, sourceId: 'hardware' })))];
    return {
      schemaVersion: 1, mode: 'live', observedAt: now, interval,
      project: { name: basename(root), scope: 'Current project' },
      models: modelCreators([...models.values()], creatorReports), inventory: [...inventory, ...(config.runtimes ?? []).map(runtime => ({ name: runtime.name, kind: 'runtime', location: 'local', state: 'configured' }))],
      records, sources, deployments, capacityPools, runtimeStats: runtimes.map(runtime => runtime.stats && ({ ...runtime.stats, hostId: 'this-machine' })).filter(Boolean),
      machine, hosts,
    };
  };
}
