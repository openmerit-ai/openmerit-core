// Hardware is supplied by existing exporters, never discovered on the network.
const label = value => typeof value === 'string' ? value.slice(0, 160).replace(/[\x00-\x1f]/g, '') : '';
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const percent = value => number(value) !== null && value <= 100 ? value : null;
const list = (value, max) => Array.isArray(value) ? value.slice(0, max).filter(item => item && typeof item === 'object') : [];
const unique = items => items.filter(item => item.id && items.filter(other => other.id === item.id).length === 1);

export function normalizeHosts(value, now = Date.now()) {
  return unique(list(value?.hosts, 64).map(host => {
    const at = typeof host.observedAt === 'string' ? Date.parse(host.observedAt) : NaN;
    const observedAt = Number.isFinite(at) && at <= now ? new Date(at).toISOString() : null;
    const memoryTotal = number(host.memoryTotal), used = number(host.memoryUsed);
    return {
      id: label(host.id), name: label(host.name) || label(host.hostname) || label(host.id),
      nameField: label(host.name) ? 'name' : label(host.hostname) ? 'hostname' : 'id', hostname: label(host.hostname),
      site: label(host.site), rack: label(host.rack),
      chip: label(host.chip), cores: number(host.cores), platform: label(host.platform), arch: label(host.arch),
      sourceId: 'hardware', observedAt, memoryTotal, memoryUsed: observedAt && used !== null && (memoryTotal === null || used <= memoryTotal) ? used : null,
      cpuPercent: observedAt ? percent(host.cpuPercent) : null,
      accelerators: unique(list(host.accelerators, 16).map(device => {
        const total = number(device.memoryTotal), used = number(device.memoryUsed);
        return { id: label(device.id), name: label(device.name) || 'Accelerator', memoryTotal: total,
          memoryUsed: observedAt && used !== null && (total === null || used <= total) ? used : null,
          utilization: observedAt ? percent(device.utilization) : null };
      })),
      // A catalog or model name alone never establishes residency.
      residencyReported: Boolean(observedAt && Array.isArray(host.loadedModels)),
      loadedModels: observedAt ? unique(list(host.loadedModels, 100).map(model => ({ id: label(model.id), name: label(model.name), provider: label(model.provider), runtime: label(model.runtime), memoryBytes: number(model.memoryBytes), memoryKind: ['accelerator', 'system', 'unified'].includes(model.memoryKind) ? model.memoryKind : 'unknown', deploymentId: label(model.deploymentId) || null })).filter(model => model.name)) : [],
      history: [],
    };
  }).filter(host => host.id !== 'this-machine'));
}

export function hostState(host, interval = 15, now = Date.now()) {
  const at = Date.parse(host.observedAt);
  if (!Number.isFinite(at) || at > now) return 'unknown';
  return now - at > interval * 3000 ? 'stale' : 'sampled';
}

// Re-reading a file does not add a sample or freshen its measurement time.
export function retainHostHistory(hosts, histories) {
  for (const id of histories.keys()) if (!hosts.some(host => host.id === id)) histories.delete(id);
  return hosts.map(host => {
    let history = histories.get(host.id) ?? [];
    const lastAt = Date.parse(history.at(-1)?.at);
    const at = Date.parse(host.observedAt);
    if (!Number.isFinite(at) || at < lastAt) history = [];
    if (Number.isFinite(at)) {
      const sample = { at: host.observedAt, cpuPercent: host.cpuPercent, memoryUsed: host.memoryUsed };
      if (at === lastAt) history[history.length - 1] = sample;
      else history.push(sample);
    }
    history = history.slice(-240);
    histories.set(host.id, history);
    return { ...host, history: [...history] };
  });
}
