import { reconcile, reconcileInspector, morphText } from './interface.js';
import { ROUTES, routeKind, routeBreakdown, inventoryRouteKind } from './routes.mjs';
import { routeIcon } from './route-icons.mjs';
import { selectControl, selectIsOpen, closeSelect } from './select.js';
import { hostState } from '../src/hardware.mjs';
import { brandIcon, serviceIdentity, modelIdentity, identityIcon, identitySvg } from './brands.mjs';
import { reportedPath, deploymentFor, poolsFor, capacityState, capacityReadings, poolUsage } from './environment.mjs';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const compact = value => value == null ? '—' : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const integer = value => new Intl.NumberFormat('en').format(value);
const money = value => value == null ? '—' : new Intl.NumberFormat('en', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < .01 ? 4 : 2 }).format(value);
const bytes = value => value == null ? '—' : `${(value / 1024 ** 3).toFixed(1)} GiB`;
const duration = value => value == null ? '—' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
const median = values => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
const sumKnown = values => { const known = values.filter(value => typeof value === 'number'); return known.length ? known.reduce((a, b) => a + b, 0) : null; };
const time = value => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const relativeTime = value => { const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000)); return seconds < 60 ? 'just now' : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`; };
const iconPaths = { overview: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="13" y="3" width="6" height="6" rx="1"/><rect x="3" y="13" width="6" height="6" rx="1"/><rect x="13" y="13" width="6" height="6" rx="1"/>', models: '<path d="m11 2 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M2 15l9 5 9-5"/>', connections: '<rect x="2" y="8" width="5" height="6" rx="1.5"/><rect x="15" y="2" width="5" height="6" rx="1.5"/><rect x="15" y="14" width="5" height="6" rx="1.5"/><path d="M7 11h3c2 0 2-6 5-6m-5 6c2 0 2 6 5 6"/>', activity: '<path d="M2 12h4l3-7 4 13 3-6h4"/>', compute: '<rect x="5" y="5" width="12" height="12" rx="2"/><path d="M8 2v3m6-3v3M8 17v3m6-3v3M2 8h3m-3 6h3m12-6h3m-3 6h3"/><rect x="8" y="8" width="6" height="6" rx="1"/>', sources: '<circle cx="11" cy="11" r="3"/><path d="M11 2v3m0 12v3M2 11h3m12 0h3M4.6 4.6l2.1 2.1m8.6 8.6 2.1 2.1M4.6 17.4l2.1-2.1m8.6-8.6 2.1-2.1"/>', search: '<circle cx="9.5" cy="9.5" r="6"/><path d="m14 14 5 5"/>', arrow: '<path d="M4 11h14m-5-5 5 5-5 5"/>', refresh: '<path d="M18 7a8 8 0 1 0 1 8M18 2v5h-5"/>' };
const icon = name => `<svg viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] ?? iconPaths.overview}</svg>`;
const logo = '<svg viewBox="0 0 28 30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M3 27V13a11 11 0 0 1 22 0v14M8 27V13a6 6 0 0 1 12 0v14M14 16v11"/></svg>';
const pages = ['overview', 'models', 'connections', 'activity', 'compute', 'sources'];
const labels = { overview: 'Overview', models: 'Models', connections: 'Connections', activity: 'Activity', compute: 'Local compute', sources: 'Sources' };
const hostedSample = document.documentElement.hasAttribute('data-sample-preview');
const state = { data: null, page: pages.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview', hours: 24, filter: 'all', search: '', mode: hostedSample || new URLSearchParams(location.search).has('sample') ? 'sample' : 'live', info: hostedSample ? { defaultMode: 'sample', hostedSample: true } : {}, error: '', fetching: false, timer: null };
let returnFocus = null;
let mapAgent = '';
let activityPath = 'all';
let selectedHost = '';
let hostLocation = '';
let environmentCache = null;
let currentInspection = null;
let inspecting = false;
let inspectorUpdating = false;
let inspectorTab = 'deployments';
function environment() {
  if (environmentCache?.data === state.data && environmentCache.hours === state.hours) return environmentCache;
  const items = records(), pools = state.data.capacityPools ?? [], deployments = state.data.deployments ?? [];
  const usage = new Map(pools.map(pool => [pool.id, poolUsage(pool, state.data, items)]));
  environmentCache = { data: state.data, hours: state.hours, items, pools, deployments, usage };
  return environmentCache;
}

function records() { const cutoff = Date.parse(state.data.observedAt) - state.hours * 3_600_000; return state.data.records.filter(record => Date.parse(record.occurredAt) >= cutoff); }
function observedEntities(type) {
  const entities = new Map();
  for (const item of records()) {
    const id = item[`${type}Id`]; if (!id) continue;
    const entity = entities.get(id) ?? { id, name: item[type] || id, count: 0, models: new Set(), related: new Set() };
    entity.count++; entity.models.add(`${item.provider}:${item.model}`);
    const related = type === 'agent' ? item.taskId : item.agent || item.agentId || item.workload;
    if (related) entity.related.add(related);
    entities.set(id, entity);
  }
  return [...entities.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
function scopeSummary() {
  const agents = observedEntities('agent'), tasks = observedEntities('task');
  if (!agents.length && !tasks.length) return 'Models, connections, and compute. Together, in one place.';
  const connections = new Set(records().map(item => item.route).filter(route => route && route !== 'Unattributed route')).size;
  return `<span class="scope-summary" aria-label="Activity in the selected window">${agents.length ? `<button class="text-button scope-link" data-inspect="agent-list" data-key="all">${integer(agents.length)} ${agents.length === 1 ? 'agent' : 'agents'}</button>` : ''}${tasks.length ? `<button class="text-button scope-link" data-inspect="task-list" data-key="all">${integer(tasks.length)} ${tasks.length === 1 ? 'task' : 'tasks'}</button>` : ''}<span>${integer(connections)} connections</span></span>`;
}
function stats(items = records()) {
  const costs = items.filter(item => item.currency === 'USD');
  return { count: items.length, input: sumKnown(items.map(item => item.inputTokens)), output: sumKnown(items.map(item => item.outputTokens)), tokens: sumKnown(items.flatMap(item => [item.inputTokens, item.outputTokens])), cost: sumKnown(costs.map(item => item.cost)), costCount: costs.filter(item => item.cost != null).length, estimated: costs.some(item => item.cost != null && item.costKind === 'estimated'), latency: median(items.filter(item => item.status !== 'running').map(item => item.durationMs).filter(value => value != null)), failures: items.filter(item => item.status === 'failed').length };
}
function buckets(items = records(), count = 48) {
  const end = Date.parse(state.data.observedAt), start = end - state.hours * 3_600_000, step = (end - start) / count;
  const result = Array.from({ length: count }, (_, i) => ({ at: start + i * step, cloud: 0, local: 0, unknown: 0, paths: Object.fromEntries(Object.keys(ROUTES).map(kind => [kind, 0])) }));
  for (const item of items) { const index = Math.min(count - 1, Math.max(0, Math.floor((Date.parse(item.occurredAt) - start) / step))); result[index][item.location === 'private' ? 'local' : item.location]++; result[index].paths[routeKind(item, state.data)]++; }
  return result;
}
function spark(values, { color = '#b4b4b4', width = 90, height = 28, fill = false, className = '' } = {}) {
  const measured = values.filter(value => value != null);
  if (!measured.length) return `<svg class="${className}" viewBox="0 0 ${width} ${height}" aria-hidden="true"><path d="M0 ${height - 4}h${width}" stroke="#383838" stroke-dasharray="2 4"/></svg>`;
  const max = Math.max(1, ...measured);
  // A gap remains a gap. No line is interpolated across an unknown sample.
  let drawing = '', active = false;
  values.forEach((value, index) => { if (value == null) { active = false; return; } const x = index * width / Math.max(1, values.length - 1), y = height - 3 - value / max * (height - 6); drawing += `${active ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)} `; active = true; });
  return `<svg class="${className}" viewBox="0 0 ${width} ${height}" aria-hidden="true">${fill && !values.includes(null) ? `<path d="${drawing}L${width},${height} L0,${height}Z" fill="${color}" opacity=".07"/>` : ''}<path d="${drawing}" fill="none" stroke="${color}" stroke-width="1.25" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
function stateLabel(value) { return ({ connected: 'Connected', partial: 'Partial', not_found: 'Not connected', unavailable: 'Unavailable', disabled: 'Disabled', configured: 'Configured', available: 'Available', observed: 'Observed', loaded: 'Loaded', installed: 'Installed', unknown: 'Unknown', completed: 'Completed', running: 'Reported running', failed: 'Failed' })[value] ?? value; }
function stateBadge(value) { return `<span class="state ${escape(value)}"><i class="status-dot ${['connected', 'loaded'].includes(value) ? '' : ['partial', 'unavailable', 'failed'].includes(value) ? 'warning' : 'dim'}"></i>${escape(stateLabel(value))}</span>`; }

function identityLabel(name, identity, size = 16) { return `<span class="identity-label">${identityIcon(identity, size)}<span>${escape(name)}</span></span>`; }
function serviceLabel(name, size = 14) { return identityLabel(name, serviceIdentity(name), size); }
function modelLabel(model, size = 16) { return identityLabel(model.model ?? model.name, modelIdentity(model), size); }
function hostingLabel(model) { const identity = serviceIdentity(model.provider); return identity?.key === modelIdentity(model)?.key ? escape(model.provider) : identityLabel(model.provider, identity, 13); }
function poolIdentity(pool) {
  const linked = (state.data.deployments ?? []).filter(deployment => deployment.poolIds.includes(pool.id)).map(deployment => deployment.provider);
  linked.push(...state.data.inventory.filter(item => item.poolIds?.includes(pool.id)).map(item => item.name));
  const names = [...new Set(linked.map(name => name.trim().toLowerCase()))];
  const matches = names.map(serviceIdentity);
  return matches.length && matches.every(identity => identity && identity.key === matches[0]?.key) ? matches[0] : serviceIdentity(pool.name);
}
function routeBadge(kind, full = false) { const route = ROUTES[kind]; return `<span class="route-badge" data-route-kind="${kind}" style="--route-color:${route.color}">${routeIcon(kind)}${full ? route.label : route.short}</span>`; }
function routeKinds(items) { const kinds = new Set(items.map(item => routeKind(item, state.data))); return Object.keys(ROUTES).filter(kind => kinds.has(kind)); }
function routeBadges(items) { const kinds = routeKinds(items); return kinds.length ? kinds.map(kind => routeBadge(kind)).join('') : '<span class="route-unobserved">No path observed</span>'; }
function routeLegend() { const counts = routeBreakdown(records(), state.data); return `<div class="route-legend" aria-label="Request path types">${Object.keys(ROUTES).filter(kind => kind !== 'unknown' || counts.unknown).map(kind => routeBadge(kind, true)).join('')}</div>`; }
function pathSummary() {
  const items = records(), counts = routeBreakdown(items, state.data);
  const known = state.data.sources.some(source => ['activity', 'openmerit', 'sample-activity'].includes(source.id) && source.state === 'connected');
  return `<section class="path-summary" aria-label="Requests by path"><div class="path-summary-title"><h2>Request paths</h2><p>Last ${state.hours}h · recorded only</p></div><div class="path-summary-items">${Object.entries(ROUTES).filter(([kind]) => kind !== 'unknown' || counts.unknown).map(([kind, route]) => `<div class="path-summary-item" style="--route-color:${route.color}"><div>${routeBadge(kind, true)}${morphText(`path-total-${kind}`, known ? integer(counts[kind]) : '—', 'path-total')}</div><span class="path-share-track" aria-hidden="true"><i style="width:${items.length ? counts[kind] / items.length * 100 : 0}%"></i></span></div>`).join('')}</div></section>`;
}

function shell() {
  const data = state.data;
  const interrupted = Boolean(state.error) || Date.now() - Date.parse(data.observedAt) > data.interval * 3000;
  const connected = data.sources.filter(source => ['connected', 'partial'].includes(source.state)).length;
  const sourceStatus = interrupted ? 'Collection interrupted' : `${connected} of ${data.sources.length} sources`;
  const warning = interrupted || connected < data.sources.length;
  const tabs = pages.map(page => `<button id="tab-${page}" role="tab" aria-selected="${state.page === page}" aria-controls="terminal-panel" tabindex="${state.page === page ? '0' : '-1'}" data-ui-key="nav-${page}" data-page="${page}">${labels[page]}</button>`).join('');
  return `<div class="shell"><header class="terminal-header"><div class="terminal-header-inner">
    <div class="terminal-masthead"><div class="terminal-identity"><button class="brand" data-action="about" aria-label="About OpenMerit">${logo}<span class="wordmark">openmerit</span></button><span class="terminal-product">Inference Terminal</span></div>
      <div class="header-actions"><button class="environment-switch" data-action="workspace" aria-label="Choose environment" title="${escape(data.project.name)} · ${data.mode === 'sample' ? 'Sample environment' : 'Current project'}"><span class="environment-name">${escape(data.project.name)}</span>${data.mode === 'sample' ? '<span class="environment-mode">Sample</span>' : ''}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="m5 7 3 3 3-3"/></svg></button><button class="header-search" data-action="search" aria-label="Find in your environment" title="Find anything · Command K">${icon('search')}<span>Search</span><kbd>⌘ K</kbd></button></div>
    </div><div class="terminal-navigation"><nav class="terminal-tabs" role="tablist" aria-label="Terminal views">${tabs}</nav><button class="source-status ${warning ? 'attention' : ''}" data-page="sources" aria-label="${sourceStatus}. View source coverage" title="${sourceStatus} · ${data.mode === 'sample' ? 'Fictional sample' : `Every ${data.interval}s`}"><i class="status-dot ${warning ? 'warning' : ''}"></i>${morphText('coverage-count', sourceStatus)}${data.mode === 'live' && !interrupted ? `<span class="source-interval">${data.interval}s</span>` : ''}</button></div>
    </div></header><main id="main" class="main" tabindex="-1"><div id="terminal-panel" role="tabpanel" aria-labelledby="tab-${state.page}">${main()}</div></main></div>`;
}

function heading(title, description, controls = true) { return `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div>${controls ? `<div class="heading-controls"><span class="collection-time"><i class="status-dot"></i>${morphText('freshness', state.error ? 'Disconnected' : `Updated ${relativeTime(state.data.observedAt)}`)}</span><div class="segmented" role="group" aria-label="Activity window">${[1, 6, 24].map(hour => `<button data-hours="${hour}" aria-pressed="${state.hours === hour}">${hour}h</button>`).join('')}</div></div>` : ''}</div>`; }
function summary() {
  const data = stats();
  const active = new Set(records().map(item => `${item.provider}:${item.model}`)).size;
  const local = state.data.models.filter(model => ['local', 'private'].includes(model.location)).length;
  const countKnown = state.data.sources.some(source => ['activity', 'openmerit', 'sample-activity'].includes(source.id) && source.state === 'connected');
  const series = buckets().map(item => countKnown ? item.cloud + item.local + item.unknown : null);
  const values = [
    ['Models in view', state.data.models.length.toString().padStart(2, '0'), `${local} self-hosted · ${state.data.models.length - local} cloud / other`, null],
    ['Requests observed', countKnown ? integer(data.count) : '—', countKnown ? `${active} models used in the last ${state.hours}h` : 'Connect an activity source', series],
    ['Recorded tokens', compact(data.tokens), data.tokens == null ? 'No token measurements yet' : `${compact(data.input)} input · ${compact(data.output)} output`, null],
    ['Recorded spend', money(data.cost), data.cost == null ? 'Cost coverage not available' : `${data.estimated ? 'Includes estimates' : 'Reported USD'} · ${data.costCount}/${data.count} requests`, null],
  ];
  return `<section class="summary-grid" aria-label="Environment summary">${values.map(([label, value, note, chart]) => `<div class="summary"><div class="summary-label">${label}</div><div class="summary-value">${morphText(`summary-${label.toLowerCase().replaceAll(' ', '-')}`, value)}</div>${chart ? spark(chart, { className: 'summary-spark' }) : ''}<div class="summary-bottom">${note}</div></div>`).join('')}</section>`;
}

function environmentMap(expanded = false) {
  const all = records(), agents = observedEntities('agent');
  if (mapAgent && !agents.some(agent => agent.id === mapAgent)) mapAgent = '';
  const candidates = mapAgent ? all.filter(item => item.agentId === mapAgent) : all;
  const rank = (items, key) => { const counts = new Map(); for (const item of items) { const value = key(item); counts.set(value, (counts.get(value) ?? 0) + 1); } return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value]) => value); };
  const workKey = item => item.agentId ? `agent:${item.agentId}` : `workload:${item.workload}`;
  const pathKey = item => JSON.stringify([reportedPath(item, state.data)[0]]);
  const deployKey = item => deploymentFor(item, state.data)?.id ?? JSON.stringify(['unknown', item.provider, item.model]);
  const workloadOrder = rank(candidates, workKey), workloads = workloadOrder.slice(0, 4);
  const workRecords = candidates.filter(item => workloads.includes(workKey(item)));
  const paths = rank(workRecords, pathKey);
  const selectedPaths = [...new Set([...Object.keys(ROUTES).map(kind => paths.find(key => JSON.parse(key)[0].kind === kind)).filter(Boolean), ...paths])].slice(0, mapAgent ? 6 : 4);
  const pathRecords = workRecords.filter(item => selectedPaths.includes(pathKey(item)));
  const deployments = [...new Set([...selectedPaths.map(key => rank(pathRecords.filter(item => pathKey(item) === key), deployKey)[0]), ...rank(pathRecords, deployKey)])].filter(Boolean).slice(0, mapAgent ? 8 : 6);
  const scoped = pathRecords.filter(item => deployments.includes(deployKey(item)));
  const height = Math.max(300, Math.max(workloads.length, selectedPaths.length, deployments.length) * 53 + 42);
  const yFor = (i, length) => 56 + (length === 1 ? (height - 94) / 2 : i * (height - 94) / (length - 1));
  const label = (value, max = 28) => escape(value.length > max ? `${value.slice(0, max - 1)}…` : value);
  const node = (x, y, width, name, caption, attrs, route = null, identity = null) => {
    const textX = route || identity ? 38 : 12;
    const inset = route && identity ? 37 : 12;
    const max = Math.floor((width - textX - inset) / 5.7);
    return `<g class="map-node${route ? ' route-node' : ''}" role="button" tabindex="0" ${attrs} ${route ? `style="--route-color:${ROUTES[route].color}"` : ''} transform="translate(${x} ${y - 23})"><title>${escape(name)} — ${escape(caption)}</title><rect width="${width}" height="46" rx="7"/>${route ? `<g class="route-node-icon" transform="translate(10 13)">${routeIcon(route)}</g>` : ''}${identitySvg(identity, route ? width - 28 : 12, 14)}<text x="${textX}" y="19">${label(name, max)}</text><text class="sub" x="${textX}" y="34">${label(caption, max + 3)}</text></g>`;
  };
  let body = '<div class="map-empty"><h3>Your environment will take shape here.</h3><p>Connect existing activity metadata to see agents, reported paths, and identified deployments.</p><button class="text-button" data-page="sources">Connect a source →</button></div>';
  if (all.length) {
    const edges = new Map();
    for (const item of scoped) {
      const wi = workloads.indexOf(workKey(item)), ri = selectedPaths.indexOf(pathKey(item)), di = deployments.indexOf(deployKey(item));
      const wy = yFor(wi, workloads.length), ry = yFor(ri, selectedPaths.length), dy = yFor(di, deployments.length), kind = reportedPath(item, state.data)[0].kind;
      for (const [id, d] of [[`w${wi}r${ri}`, `M210 ${wy}C255 ${wy} 265 ${ry} 310 ${ry}`], [`r${ri}d${di}`, `M532 ${ry}C582 ${ry} 592 ${dy} 642 ${dy}`]]) {
        const edge = edges.get(id) ?? { d, kind, agents: new Set(), paths: new Set(), deployments: new Set() };
        edge.agents.add(workKey(item)); edge.paths.add(pathKey(item)); edge.deployments.add(deployKey(item)); edges.set(id, edge);
      }
    }
    body = `<div class="map-scroll"><svg class="environment-map deployment-map" style="--map-height:${height}px" viewBox="0 0 900 ${height}" aria-label="Observed workloads, reported entry connections, and identified deployments"><g class="map-column-labels"><text x="14" y="17">AGENTS / WORKLOADS</text><text x="310" y="17">ENTRY CONNECTION</text><text x="642" y="17">MODEL / DEPLOYMENT</text></g>${[...edges.values()].map(edge => `<path class="map-edge route-thread" style="--route-color:${ROUTES[edge.kind].color}" data-agent="${escape(JSON.stringify([...edge.agents]))}" data-path="${escape(JSON.stringify([...edge.paths]))}" data-deployment="${escape(JSON.stringify([...edge.deployments]))}" d="${edge.d}"/>`).join('')}${workloads.map((key, i) => { const item = scoped.find(item => workKey(item) === key) ?? workRecords.find(item => workKey(item) === key); return node(14, yFor(i, workloads.length), 196, item.agent || item.agentId || item.workload, `${integer(candidates.filter(record => workKey(record) === key).length)} requests · ${state.hours}h`, `data-map-type="agent" data-map-key="${escape(key)}" data-inspect="${item.agentId ? 'agent' : 'workload'}" data-key="${escape(item.agentId || item.workload)}" aria-label="Inspect ${escape(item.agent || item.agentId || item.workload)}"`); }).join('')}${selectedPaths.map((key, i) => { const first = JSON.parse(key)[0], variants = new Set(workRecords.filter(item => pathKey(item) === key).map(item => JSON.stringify(reportedPath(item, state.data)))), path = JSON.parse([...variants][0]); return node(310, yFor(i, selectedPaths.length), 222, first.name, first.name === 'Unattributed route' ? 'Connection not supplied' : variants.size > 1 ? `${ROUTES[first.kind].short} · ${variants.size} reported paths` : `${ROUTES[first.kind].short} · ${path.length} reported ${path.length === 1 ? 'hop' : 'hops'}`, `data-map-type="path" data-map-key="${escape(key)}" data-inspect="entry" data-key="${escape(key)}" aria-label="Inspect connections through ${escape(first.name)}"`, first.kind, serviceIdentity(first.name)); }).join('')}${deployments.map((key, i) => { const item = scoped.find(item => deployKey(item) === key), deployment = deploymentFor(item, state.data); return node(642, yFor(i, deployments.length), 244, item.model, deployment?.name ?? 'Deployment unidentified', `data-map-type="deployment" data-map-key="${escape(key)}" data-inspect="${deployment ? 'deployment' : 'unidentified'}" data-key="${escape(key)}" aria-label="Inspect ${escape(item.model)} at ${escape(deployment?.name ?? 'unidentified deployment')}"`, null, modelIdentity(item)); }).join('')}</svg></div>`;
  }
  const mapped = candidates.filter(item => deploymentFor(item, state.data)).length;
  return `<section class="panel environment-panel"><div class="panel-head"><div><h2>Environment map</h2><p>${mapAgent ? 'Following one agent through its environment' : `${workloads.length} of ${workloadOrder.length} workloads · last ${state.hours}h`}</p></div>${!expanded ? '<button class="panel-action" data-page="connections" aria-label="Explore environment">↗</button>' : ''}</div><div class="environment-toolbar"><label for="map-agent">Focus${selectControl({ id: 'map-agent', label: 'Focus environment on an agent', value: mapAgent, options: [{ value: '', label: 'All agents & workloads' }, ...agents.map(agent => ({ value: agent.id, label: agent.name }))] })}</label><button class="text-button" data-inspect="deployment-list" data-key="all">${environment().deployments.length} deployments ↗</button></div>${body}<div class="map-foot">${routeLegend()}<span>${integer(scoped.length)} / ${integer(candidates.length)} requests shown</span></div><div class="map-coverage">${integer(mapped)} of ${integer(candidates.length)} requests identify a deployment. Select a connection to inspect reported hops.</div><span class="map-scroll-hint">Scroll map to explore →</span></section>`;
}
function poolStatus(pool) { return capacityState(pool, state.data.interval); }
function readingValue(row) { const format = row.unit === 'bytes' ? bytes : row.unit === 'percent' ? value => value == null ? '—' : `${Math.round(value)}%` : compact; return `${format(row.value)}${row.limit != null && row.unit !== 'percent' ? ` / ${format(row.limit)}` : ''}`; }
function poolSummary(pool) {
  const readings = capacityReadings(pool), rows = readings.filter(row => row.ratio != null).sort((a, b) => b.ratio - a.ratio);
  return rows[0] ?? readings[0];
}
function capacityRow(pool) {
  const status = poolStatus(pool), reading = poolSummary(pool), usage = environment().usage.get(pool.id);
  return `<button class="capacity-row" data-inspect="pool" data-key="${escape(pool.id)}"><span class="capacity-row-title"><strong>${identityLabel(pool.name, poolIdentity(pool))}</strong><span class="capacity-status ${status}">${status === 'sampled' ? 'Sampled' : status === 'stale' ? 'Stale reading' : 'No reading'}</span></span><span class="capacity-row-reading"><span>${reading ? escape(reading.label) : 'Capacity unknown'}</span><strong>${reading ? readingValue(reading) : '—'}</strong></span><span class="capacity-track ${status}" aria-hidden="true">${reading?.ratio != null ? `<i style="transform:scaleX(${Math.min(1, reading.ratio)})"></i>` : ''}</span><span class="capacity-row-foot">${usage.agents.size} observed agents · ${pool.observedAt ? `sample ${relativeTime(pool.observedAt)}` : 'awaiting a source'}</span></button>`;
}
function capacityPanel(full = false) {
  const pools = [...environment().pools].sort((a, b) => (poolStatus(b) === 'sampled' ? poolSummary(b)?.ratio ?? -1 : -2) - (poolStatus(a) === 'sampled' ? poolSummary(a)?.ratio ?? -1 : -2));
  const known = pools.filter(pool => poolStatus(pool) === 'sampled').length;
  return `<section class="panel capacity-panel"><div class="panel-head"><div><h2>Shared capacity</h2><p>${known} of ${pools.length} pools have recent readings</p></div><button class="panel-action" data-inspect="pool-list" data-key="all" aria-label="Inspect all shared capacity pools">↗</button></div>${pools.length ? `<div class="capacity-rows">${pools.slice(0, full ? pools.length : 3).map(capacityRow).join('')}</div>` : '<p class="empty-small">Declare shared pools to connect agents with their limits. Missing readings stay unknown.</p>'}<div class="capacity-foot">Pool totals include all consumers. Sampled independently of inference.</div></section>`;
}
function deploymentList(items = records(), all = false) {
  const deployments = environment().deployments.filter(deployment => all || items.some(item => deploymentFor(item, state.data)?.id === deployment.id));
  return deployments.length ? `<div class="deployment-list">${deployments.map(deployment => { const count = items.filter(item => deploymentFor(item, state.data)?.id === deployment.id).length; return `<button class="deployment-row" data-inspect="deployment" data-key="${escape(deployment.id)}"><span><strong>${modelLabel(deployment)}</strong><small>${escape(deployment.name)} · ${escape(deployment.location)}</small></span><span>${integer(count)}<small>requests ↗</small></span></button>`; }).join('')}</div>` : '<p class="detail-note">No identified deployments in this selection. Supply a deployment ID that matches the declared model and provider.</p>';
}
function dependencyDetails(items) {
  const pools = environment().pools.filter(pool => environment().usage.get(pool.id).items.some(item => items.includes(item)));
  const identified = items.filter(item => deploymentFor(item, state.data)).length;
  const paths = [...new Map(items.map(item => { const path = reportedPath(item, state.data); return [JSON.stringify(path), path]; })).entries()];
  pools.sort((a, b) => (poolStatus(b) === 'sampled' ? poolSummary(b)?.ratio ?? -1 : -2) - (poolStatus(a) === 'sampled' ? poolSummary(a)?.ratio ?? -1 : -2));
  const tabs = `<div class="inspector-tabs" role="group" aria-label="Explore agent environment">${[['deployments', 'Deployments'], ['paths', 'Paths'], ['capacity', 'Capacity']].map(([id, name]) => `<button data-inspector-tab="${id}" aria-pressed="${inspectorTab === id}">${name}</button>`).join('')}</div>`;
  if (inspectorTab === 'paths') return `${tabs}<div class="detail-section-title"><h3>Execution paths</h3><span>${paths.length} reported</span></div><div class="path-list">${paths.map(([key, path]) => `<button class="path-row" data-inspect="path" data-key="${escape(key)}">${path.map(hop => `<span class="path-hop" style="--route-color:${ROUTES[hop.kind].color}">${routeIcon(hop.kind)}${serviceLabel(hop.name, 14)}</span>`).join('<span class="path-arrow" aria-hidden="true">→</span>')}</button>`).join('')}</div>`;
  if (inspectorTab === 'capacity') return `${tabs}<div class="detail-section-title"><h3>Shared limits & pressure</h3><span>${pools.length} pools</span></div>${pools.length ? pools.map(capacityRow).join('') : '<p class="detail-note">No shared pools are linked by the available metadata.</p>'}<p class="detail-note">Pool readings include all consumers. Shared use does not establish which agent caused pressure.</p>`;
  return `${tabs}<div class="detail-section-title"><h3>Model deployments</h3><span>${identified} / ${items.length} requests identified</span></div>${deploymentList(items)}`;
}
function modelTable(overview = false) {
  let models = state.data.models.filter(model => (state.filter === 'all' || model.location === state.filter || state.filter === 'local' && model.location === 'private') && `${model.name} ${model.provider} ${model.modelCreator ?? ""}`.toLowerCase().includes(state.search.toLowerCase()));
  if (overview) models = state.data.models.slice(0, 12);
  if (!models.length) return `<div class="empty-small">${state.search || state.filter !== 'all' ? 'No models match this view. Try another filter.' : 'No models observed yet. Start Ollama, declare an inventory, or connect an activity source to bring your environment into view.'}</div>`;
  return `<div class="table-wrap"><table class="data-table model-table"><thead><tr><th scope="col">Model / service</th><th class="state-column" scope="col">State</th><th scope="col">Requests</th><th class="trend-column" scope="col">Activity</th><th class="latency-column" scope="col">Median latency</th><th scope="col">Spend</th></tr></thead><tbody>${models.map(model => {
    const items = records().filter(item => item.model === model.name && item.provider === model.provider), metrics = stats(items);
    const hasSource = state.data.sources.some(source => ['activity', 'openmerit', 'sample-activity'].includes(source.id) && source.state === 'connected');
    return `<tr><td><button class="model-name" data-inspect="model" data-key="${escape(model.id)}">${identityIcon(modelIdentity(model))}<span><strong>${escape(model.name)}</strong><small>Served by ${hostingLabel(model)} · ${escape(model.location)}</small></span></button><div class="model-routes">${routeBadges(items)}</div></td><td class="state-column">${stateBadge(model.state)}</td><td>${morphText(`model-requests-${model.id}`, items.length ? integer(items.length) : hasSource ? '0' : '—')}</td><td class="trend-column">${spark(buckets(items, 18).map(bin => bin.cloud + bin.local + bin.unknown), { className: 'table-spark', color: routeKinds(items).length === 1 ? ROUTES[routeKinds(items)[0]].color : '#9e9e9e' })}</td><td class="latency-column">${morphText(`model-latency-${model.id}`, duration(metrics.latency))}</td><td>${morphText(`model-cost-${model.id}`, money(metrics.cost))}${metrics.estimated ? '<span title="Includes estimated cost">*</span>' : ''}</td></tr>`;
  }).join('')}</tbody></table></div><p class="table-foot">${overview ? `Showing ${models.length} of ${state.data.models.length} models. Configured, loaded, or observed.` : 'Usage is limited to connected sources and the selected window. A dash means the measurement is unavailable.'}</p>`;
}
function recentActivity() {
  const items = [...records()].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)).slice(0, 10);
  return `<section><div class="section-title"><h2>Recent activity</h2><span class="quiet" style="font-size:10px">${state.data.mode === 'sample' ? 'Sample' : 'Observed'}</span></div>${items.length ? `<ul class="activity-list">${items.map(item => `<li class="activity-item"><span class="activity-mark route-mark" style="--route-color:${ROUTES[routeKind(item, state.data)].color}" aria-hidden="true"></span><div class="activity-item-content"><strong>${escape(item.workload)}</strong><p>${modelLabel(item, 13)}${item.status === 'failed' ? ' · failed' : item.status === 'running' ? ' · running' : ''}</p><div class="recent-route">${routeBadge(routeKind(item, state.data))}<span>${serviceLabel(item.route, 12)}</span></div></div><time datetime="${item.occurredAt}">${relativeTime(item.occurredAt)}</time></li>`).join('')}</ul><button class="text-button activity-link" data-page="activity">View activity <span>→</span></button>` : '<p class="empty-small">A quiet environment.<br>Recorded inference activity will appear here.</p>'}</section>`;
}
function footer() { const sources = state.data.sources.filter(source => ['connected', 'partial'].includes(source.state)); return `<footer class="footer"><div class="source-strip"><button class="text-button" data-page="sources"><i class="status-dot"></i>${sources.length} ${sources.length === 1 ? 'source' : 'sources'} connected</button><span>${state.data.mode === 'sample' ? 'Fictional environment · no real inference' : 'Local view · passive collection'}</span></div><span class="footer-end">OPENMERIT / INFERENCE TERMINAL</span></footer>`; }
function activityChart() {
  const items = records();
  if (!items.length) return '<div class="map-empty"><h3>No activity in this window.</h3><p>Choose a longer window or connect an activity source.</p></div>';
  const bins = buckets(items, 60), counts = routeBreakdown(items, state.data);
  const values = bins.map(bin => activityPath === 'all' ? Object.values(bin.paths).reduce((a, b) => a + b, 0) : bin.paths[activityPath]);
  const max = Math.max(1, ...values), color = activityPath === 'all' ? '#b6b6b6' : ROUTES[activityPath].color;
  const bars = bins.map((bin, i) => {
    let accumulated = 0;
    const segments = Object.entries(ROUTES).filter(([kind]) => activityPath === 'all' || activityPath === kind).map(([kind, route]) => {
      const value = bin.paths[kind];
      accumulated += value;
      return value ? `<rect class="volume-bar" data-path="${kind}" x="${i * 16 + 3}" y="${124 - accumulated / max * 116}" width="10" height="${value / max * 116}" fill="${route.color}"/>` : '';
    }).join('');
    const detail = Object.entries(ROUTES).filter(([kind]) => bin.paths[kind] && (activityPath === 'all' || activityPath === kind)).map(([kind, route]) => `${bin.paths[kind]} ${route.label}`).join(', ');
    return `<g>${segments}<rect class="chart-hit" x="${i * 16}" y="0" width="16" height="128" data-bin="${i}" tabindex="${i === 0 ? '0' : '-1'}" role="img" aria-label="${time(bin.at)}: ${values[i]} requests${detail ? `. ${detail}` : ''}. Use left and right arrows to inspect."/></g>`;
  }).join('');
  const choices = [['all', { label: 'All paths', color: '#b6b6b6' }], ...Object.entries(ROUTES)];
  return `<div class="volume-chart activity-chart" style="--chart-color:${color}"><div class="volume-scale" aria-hidden="true"><span>${integer(max)}</span><span>${integer(Math.round(max / 2))}</span><span>0</span></div><div class="volume-plot"><svg viewBox="0 0 960 128" preserveAspectRatio="none" aria-label="${escape(activityPath === 'all' ? 'All paths' : ROUTES[activityPath].label)} requests per ${state.hours} minutes">${[8, 66, 124].map(y => `<line class="chart-grid" x1="0" x2="960" y1="${y}" y2="${y}" vector-effect="non-scaling-stroke"/>`).join('')}${bars}</svg><div class="volume-times" aria-hidden="true">${[0, 15, 30, 45, 59].map(i => `<span>${time(i === 59 ? state.data.observedAt : bins[i].at)}</span>`).join('')}</div></div><div class="chart-tooltip" hidden></div></div><div class="volume-paths" role="group" aria-label="Chart path">${choices.map(([kind, route]) => `<button data-activity-path="${kind}" aria-pressed="${activityPath === kind}" style="--route-color:${route.color}"><span>${kind === 'all' ? '<span class="all-paths-mark" aria-hidden="true">≋</span>' : routeIcon(kind)}${route.label}</span><strong>${integer(kind === 'all' ? items.length : counts[kind])}</strong></button>`).join('')}</div><p class="chart-caption">${state.hours}-minute intervals · select a path to isolate its volume</p>`;
}

function overviewPage() { return `${heading('Your inference environment.', scopeSummary())}${summary()}${pathSummary()}<div class="overview-top">${environmentMap()}${capacityPanel()}</div><div class="lower-grid"><section><div class="section-title"><h2>Model inventory <span class="badge-count">${state.data.models.length}</span></h2><button class="text-button" data-page="models">All models <span>→</span></button></div>${modelTable(true)}</section>${recentActivity()}</div>`; }
function modelsPage() { return `${heading('Model inventory', 'What is available, what is loaded, and what has been used.')}${pathSummary()}<div class="filter-bar"><div class="filter-tabs" role="group" aria-label="Filter models by location">${['all', 'local', 'cloud'].map(filter => `<button data-filter="${filter}" aria-pressed="${state.filter === filter}">${({ all: 'All models', local: 'Self-hosted', cloud: 'Cloud' })[filter]}</button>`).join('')}</div><input class="filter-input" id="model-search" type="search" aria-label="Search models" placeholder="Find a model…" value="${escape(state.search)}"></div><div id="model-results">${modelTable()}</div>`; }
function connectionsPage() {
  const inventory = new Map(state.data.inventory.map(item => [`${item.kind}:${item.name}`, item]));
  for (const item of records()) { if (item.route !== 'Unattributed route') inventory.set(`connection:${item.route}`, { name: item.route, kind: 'connection', location: item.location, state: 'observed' }); if (item.provider !== 'Unattributed') inventory.set(`provider:${item.provider}`, { ...inventory.get(`provider:${item.provider}`), name: item.provider, kind: 'provider', location: item.location, state: 'observed' }); }
  // Show the declared gateway/router identity once, retaining observed status.
  const grouped = new Map();
  for (const item of inventory.values()) { const old = grouped.get(item.name); grouped.set(item.name, old ? { ...old, state: item.state === 'observed' ? 'observed' : old.state } : item); }
  return `${heading('Connections', 'Workloads, gateways, providers, and the paths between them.')}${environmentMap(true)}<div class="environment-detail-grid"><section><div class="section-title"><h2>Model deployments</h2><span class="quiet">Separate instances of each model</span></div>${deploymentList(mapAgent ? records().filter(item => item.agentId === mapAgent) : records(), !mapAgent)}</section>${capacityPanel(true)}</div><div class="section-title"><h2>Connection inventory</h2></div><div class="inventory-grid">${[...grouped.values()].map(item => {
    const observed = records().filter(record => record.route === item.name);
    const kinds = routeKinds(observed);
    const declaredKind = inventoryRouteKind(item);
    const badge = kinds.length ? routeBadges(observed) : item.kind !== 'provider' && declaredKind !== 'unknown' ? routeBadge(declaredKind, true) : `<span class="route-unobserved">${escape(item.kind === 'provider' ? 'Inference service' : 'No path observed')}</span>`;
    return `<article class="inventory-card connection-card"><div class="connection-kind">${badge}</div><h3 class="connection-name">${brandIcon(item.name)}${escape(item.name)}</h3><p>${escape(item.location)} · ${item.state === 'observed' ? 'Seen in recorded activity' : item.sourceId === 'environment' ? 'Found in process environment' : 'Declared configuration'}</p>${stateBadge(item.state ?? 'configured')}${item.evidence?.length ? `<p class="connection-evidence">${item.evidence.map(entry => `${escape(entry.field)} · ${entry.basis === 'endpoint-host' ? 'known endpoint' : 'variable present'}`).join('<br>')}</p><button class="text-button" data-inspect="source" data-key="environment">Configuration source ↗</button>` : ''}</article>`;
  }).join('')}</div><p class="table-foot">Paths come from recorded metadata. Declared or environment-configured services do not prove connectivity.</p>`;
}
function activityPage() {
  const items = [...records()].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  return `${heading('Inference activity', 'Usage across your applications, agents, and evaluations.')}<section class="panel activity-panel"><div class="panel-head"><div><h2>Request volume</h2><p>${integer(items.length)} recorded requests in this window</p></div><span class="panel-meta">${stats().failures} failed</span></div>${activityChart()}</section><div class="section-title"><h2>Recorded activity</h2><span class="quiet" style="font-size:10px">${items.length > 100 ? 'Most recent 100 requests' : `${items.length} requests`}</span></div>${items.length ? `<div class="table-wrap"><table class="data-table activity-table"><thead><tr><th>Workload / task</th><th>Request path</th><th>Scope</th><th>Time</th><th>Duration</th><th>Tokens in / out</th><th>Spend</th><th>Status</th></tr></thead><tbody>${items.slice(0, 100).map(item => `<tr><td><button class="model-name" data-inspect="record" data-key="${escape(item.id)}"><span><strong>${escape(item.task || item.taskId || item.workload)}</strong><small>${item.task || item.taskId ? `${escape(item.agent || item.agentId || item.workload)} · ` : ''}${modelLabel(item, 14)}</small></span></button></td><td class="activity-route">${routeBadge(routeKind(item, state.data))}<small>${serviceLabel(item.route, 12)}</small></td><td>${escape(item.scope)}</td><td>${time(item.occurredAt)}</td><td>${duration(item.durationMs)}</td><td>${compact(item.inputTokens)} / ${compact(item.outputTokens)}</td><td>${item.currency === 'USD' ? money(item.cost) : '—'}${item.costKind === 'estimated' && item.cost != null ? '*' : ''}</td><td>${stateBadge(item.status)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty-small">Activity appears when a connected source records it.</p>'}<p class="table-foot">Metadata only. No prompts or responses. Estimated costs carry an asterisk; local hardware costs are not inferred.</p>`;
}
function computeHosts() {
  return state.data.hosts ?? [{ ...state.data.machine, id: 'this-machine', observedAt: state.data.observedAt, accelerators: [], loadedModels: state.data.models.filter(model => model.state === 'loaded') }];
}
function hardwareStatus(host) { return state.error ? 'stale' : hostState(host, state.data.interval); }
function hardwareBadge(host) { const status = hardwareStatus(host); return `<span class="hardware-status ${status}"><i class="status-dot ${status === 'stale' ? 'warning' : 'dim'}"></i>${({ sampled: 'Recent', stale: 'Stale reading', unknown: 'Awaiting data' })[status]}</span>`; }
function computePage() {
  const hosts = computeHosts(), reportedSites = [...new Set(hosts.map(host => host.site).filter(Boolean))];
  const locations = [...reportedSites, ...(reportedSites.length && hosts.some(host => !host.site) ? ['Site not supplied'] : [])];
  if (hostLocation && !locations.includes(hostLocation)) hostLocation = '';
  const visible = hosts.filter(host => !hostLocation || (host.site || 'Site not supplied') === hostLocation);
  const host = visible.find(host => host.id === selectedHost) ?? visible[0];
  if (!host) return heading('Local compute', 'No hardware inventory is available.', false);
  selectedHost = host.id;
  const fresh = hosts.filter(host => hardwareStatus(host) === 'sampled');
  const groups = new Map();
  for (const entry of visible) { const group = [entry.site || (reportedSites.length ? 'Site not supplied' : ''), entry.rack].filter(Boolean).join(' / '); if (!groups.has(group)) groups.set(group, []); groups.get(group).push(entry); }
  const loaded = host.loadedModels ?? [], status = hardwareStatus(host);
  const rows = [...groups].map(([group, entries]) => `<tbody aria-label="${escape(group)}">${group ? `<tr class="host-group"><th colspan="7" scope="rowgroup">${escape(group)}<span>${entries.length} ${entries.length === 1 ? 'host' : 'hosts'}</span></th></tr>` : ''}${entries.map(entry => `<tr class="host-row ${entry.id === host.id ? 'selected' : ''}"><td><button class="host-name" data-host="${escape(entry.id)}" aria-pressed="${entry.id === host.id}">${escape(entry.name)}${entry.id === 'this-machine' ? '<small>This machine</small>' : ''}</button></td><td>${escape(entry.chip || 'Not reported')}</td><td>${entry.cpuPercent == null ? '—' : `${entry.cpuPercent.toFixed(1)}%`}</td><td>${bytes(entry.memoryUsed)}<span class="quiet"> / ${bytes(entry.memoryTotal)}</span></td><td>${entry.accelerators?.length ? [...new Set(entry.accelerators.map(item => item.name))].map(name => `${entry.accelerators.filter(item => item.name === name).length} × ${escape(name)}`).join(' · ') : 'Not reported'}</td><td>${entry.observedAt && entry.residencyReported !== false ? entry.loadedModels?.length ?? 0 : '—'}</td><td>${hardwareBadge(entry)}</td></tr>`).join('')}</tbody>`).join('');
  return `${heading('Local compute', 'This machine and self-hosted servers from your exports.', false)}<div class="fleet-summary"><div><strong>${hosts.length}</strong><span>${hosts.length === 1 ? 'host' : 'hosts'} in view</span></div><div><strong>${hosts.reduce((total, item) => total + (item.accelerators?.length ?? 0), 0)}</strong><span>accelerators listed</span></div><div><strong>${fresh.length} <span>/ ${hosts.length}</span></strong><span>hosts with recent readings</span></div><p>Passively sampled · every ${state.data.interval}s<br>${reportedSites.length} reported sites · ${new Set(hosts.filter(item => item.rack).map(item => `${item.site}/${item.rack}`)).size} racks</p></div><div class="section-title host-inventory-heading"><div><h2>Host inventory</h2><p>Select a host to inspect its resources.</p></div>${locations.length ? selectControl({ id: 'host-location', label: 'Filter hosts by reported site', value: hostLocation, options: [{ value: '', label: 'All reported sites' }, ...locations.map(site => ({ value: site, label: site }))] }) : ''}</div><div class="table-wrap"><table class="data-table host-table"><thead><tr><th scope="col">Host</th><th scope="col">Processor</th><th scope="col">CPU</th><th scope="col">System RAM</th><th scope="col">Accelerators</th><th scope="col">Loaded</th><th scope="col">Reading</th></tr></thead>${rows}</table></div><section class="host-detail" aria-label="Selected host"><div class="section-title"><div><h2>${escape(host.name)}</h2><p>${escape([host.site, host.rack].filter(Boolean).join(' / '))}${host.site || host.rack ? ' · ' : ''}${host.observedAt ? `Last sample ${relativeTime(host.observedAt)}` : 'No measurement received'}</p></div>${hardwareBadge(host)}</div><div class="host-detail-grid"><section class="panel host-history"><div class="panel-head"><h2>Resource history</h2><span class="panel-meta">${status === 'stale' ? 'Last reported readings' : 'Whole host'}</span></div><div class="history-chart"><div data-chart="machine-history" data-host-id="${escape(host.id)}" data-ui-key="history-${escape(host.id)}"></div><p>CPU and system RAM. Host usage is not attributed to inference.</p></div></section><section class="panel host-hardware"><div class="panel-head"><h2>Hardware</h2></div><dl class="host-facts"><div><dt>Name source</dt><dd>${host.id === 'this-machine' ? (state.data.mode === 'sample' ? 'Sample · hostname' : 'Operating system · hostname') : `${escape(sourceName(host.sourceId))} · ${escape(host.nameField || 'name / id')}`}</dd></div><div><dt>Site / rack</dt><dd>${escape([host.site, host.rack].filter(Boolean).join(' / ') || 'Not supplied')}</dd></div><div><dt>Processor</dt><dd>${escape(host.chip || 'Not reported')}</dd></div><div><dt>Cores / architecture</dt><dd>${host.cores ?? '—'} / ${escape(host.arch || '—')}</dd></div><div><dt>System RAM</dt><dd>${bytes(host.memoryUsed)} / ${bytes(host.memoryTotal)}</dd></div><div><dt>Platform</dt><dd>${escape(({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' })[host.platform] ?? (host.platform || 'Not reported'))}</dd></div></dl><div class="accelerator-list">${(host.accelerators ?? []).map(device => `<div class="accelerator"><div><strong>${escape(device.name)}</strong><span>${escape([device.id, device.kind && device.kind !== 'unknown' ? device.kind.toUpperCase() : null].filter(Boolean).join(' · '))}</span></div>${device.vendor ? `<p><span>Vendor</span><strong>${escape(device.vendor)}</strong></p>` : ''}<p><span>Device memory</span><strong>${bytes(device.memoryUsed)} / ${bytes(device.memoryTotal)}</strong></p><p><span>Utilization</span><strong>${device.utilization == null ? '—' : `${device.utilization.toFixed(1)}%`}</strong></p></div>`).join('') || '<p class="empty-small">Accelerator readings not supplied.</p>'}</div></section></div><div class="section-title"><h2>${status === 'stale' ? 'Last reported models' : 'Loaded models'} <span class="badge-count">${host.residencyReported === false ? '—' : loaded.length}</span></h2><span class="quiet">${escape(host.name)}</span></div><div class="loaded-models">${loaded.map(model => { const inventory = state.data.models.find(item => item.name === model.name && item.provider === model.provider); return `<article class="loaded-model"><div>${inventory ? `<button class="model-name" data-inspect="model" data-key="${escape(inventory.id)}">${identityIcon(modelIdentity(model))}<strong>${escape(model.name)}</strong></button>` : `<strong>${modelLabel(model)}</strong>`}<p>${serviceLabel(model.runtime || model.provider || 'Runtime unspecified')}</p></div><div><strong>${bytes(model.memoryBytes)}</strong><p>${({ accelerator: 'Accelerator allocation', system: 'System RAM allocation', unified: 'Unified memory allocation' })[model.memoryKind] ?? 'Allocation type unspecified'}</p></div></article>`; }).join('') || `<p class="empty-small">${status === 'unknown' || host.residencyReported === false ? 'Model residency has not been reported.' : 'No loaded models in this host’s latest report.'}</p>`}</div><p class="table-foot">Loaded means resident; it does not imply an active request. Allocations are source-reported. Device and system memory can overlap on unified-memory hardware.</p>${runtimeCounters(host.id)}</section><p class="table-foot">Additional hosts come from your hardware export. Collection stays passive; the terminal does not discover machines or manage workloads.</p>`;
}
function runtimeCounters(hostId) {
  const runtimes = (state.data.runtimeStats ?? []).filter(runtime => (runtime.hostId ?? 'this-machine') === hostId);
  if (!runtimes.length) return '';
  return `<div class="section-title"><h2>Runtime counters</h2></div><div class="inventory-grid">${runtimes.map(runtime => `<article class="inventory-card"><h3>${serviceLabel(runtime.name, 18)}</h3>${detailList([['Running / waiting', `${compact(runtime.running)} / ${compact(runtime.waiting)}`], ['Input / output tokens', `${compact(runtime.inputTokens)} / ${compact(runtime.outputTokens)}`], ['Finished requests', compact(runtime.finished)]])}<p>Lifetime counters since the runtime reset. Separate from the activity window.</p></article>`).join('')}</div>`;
}
function sourcesPage() { return `${heading('Sources & coverage', 'Every source, its coverage, and where the picture is incomplete.', false)}<div class="source-list">${state.data.sources.map(source => `<button class="source-row" data-inspect="source" data-key="${escape(source.id)}"><span><h3>${serviceLabel(source.name, 18)}</h3><p>${escape(source.detail)}</p></span><span class="source-kind">${escape(source.kind)}</span>${stateBadge(source.state)}<span class="quiet">↗</span></button>`).join('')}</div><section class="panel instruction-panel"><h2>Bring your existing evidence.</h2><p>The terminal reads what your tools already record. Export request metadata to a project-local JSONL file, or declare your model and service inventory. It never sends a test prompt or changes a route.</p><button class="button" data-action="connect">Set up a source ${icon('arrow')}</button><button class="text-button" data-action="api" style="margin-left:18px">Read from an agent ↗</button></section>`; }
function main() {
  const stale = Date.now() - Date.parse(state.data.observedAt) > state.data.interval * 3000;
  const sample = state.data.mode === 'sample';
  return `${state.error ? `<div class="notice" role="status">${escape(state.error)}</div>` : stale ? '<div class="notice" role="status">Collection is delayed. Showing the last available snapshot.</div>' : ''}${sample ? `<div class="sample-disclosure"><span>Sample environment. Names, requests, and hardware are fictional.</span>${state.info.defaultMode !== 'sample' ? '<button data-action="live">View your environment →</button>' : ''}</div>` : ''}${({ overview: overviewPage, models: modelsPage, connections: connectionsPage, activity: activityPage, compute: computePage, sources: sourcesPage })[state.page]()}${footer()}`;
}
function render({ focusMain = false, focusTab = false } = {}) {
  closeSelect();
  const firstRender = !$('#terminal-panel');
  const active = document.activeElement;
  const pageButton = active?.getAttribute('role') === 'tab' ? active.dataset.page : null;
  const hoursButton = active?.dataset?.hours;
  const filterButton = active?.dataset?.filter;
  const scroll = window.scrollY;
  reconcile(shell(), state.data, state.error);
  if (firstRender) revealTab($(`#tab-${state.page}`));
  if (focusTab) { const tab = $(`#tab-${state.page}`); tab?.focus({ preventScroll: true }); revealTab(tab); window.scrollTo(0, 0); }
  else if (focusMain) { $('#main').focus({ preventScroll: true }); revealTab($(`#tab-${state.page}`)); window.scrollTo(0, 0); }
  else { if (pageButton) { document.querySelectorAll('.terminal-tabs [role="tab"]').forEach(tab => { tab.tabIndex = tab.dataset.page === pageButton ? 0 : -1; }); $(`#tab-${pageButton}`)?.focus({ preventScroll: true }); } if (hoursButton) $(`[data-hours="${hoursButton}"]`)?.focus({ preventScroll: true }); if (filterButton) $(`[data-filter="${filterButton}"]`)?.focus({ preventScroll: true }); window.scrollTo(0, scroll); }
}
function navigate(page, { focusTab = false } = {}) { if (!pages.includes(page)) return; state.page = page; state.filter = 'all'; state.search = ''; history.replaceState(null, '', `${location.pathname}${state.mode === 'sample' ? '?sample=1' : ''}#${page}`); render({ focusMain: !focusTab, focusTab }); }
function revealTab(tab) {
  if (!tab) return;
  const nav = tab.closest('.terminal-tabs'), left = tab.offsetLeft, right = left + tab.offsetWidth;
  const endInset = parseFloat(getComputedStyle(nav).paddingRight) || 0;
  if (left < nav.scrollLeft) nav.scrollLeft = left;
  else if (right > nav.scrollLeft + nav.clientWidth - endInset) nav.scrollLeft = right - nav.clientWidth + endInset;
}
window.addEventListener('resize', () => revealTab(document.activeElement?.matches('.terminal-tabs [role="tab"]') ? document.activeElement : $(`#tab-${state.page}`)));
function sourceName(id) { return state.data.sources.find(source => source.id === id)?.detail || id; }
function identityEvidence(items, kind) {
  const names = [...new Set(items.map(item => item[kind]).filter(Boolean))];
  const fields = [...new Set(items.map(item => item[kind] ? kind : `${kind}Id`))];
  return `<details class="identity-evidence"><summary>Where this name comes from</summary>${detailList([[`${kind === 'agent' ? 'Agent' : 'Task'} ID`, items[0]?.[`${kind}Id`] || 'Not supplied'], ['Display name', names.join(' · ') || 'Not supplied; displaying the ID'], ['Metadata fields', fields.join(', ')], ['Source', [...new Set(items.map(item => sourceName(item.sourceId)))].join(' · ')]])}<p>${state.data.mode === 'sample' ? 'Fictional example fields from the sample export. These are not files or agents discovered in your project.' : 'Copied from recorded metadata. The terminal does not infer a role or task description from code or prompts.'}</p></details>`;
}
function namingNote() { return `<p class="detail-note">${state.data.mode === 'sample' ? 'Sample names are fictional export fields, not discovered agents. ' : ''}Names come from recorded metadata; missing names use the supplied ID. Only explicit agent IDs establish these links.</p>`; }
function creatorFacts(item) { return [['Model creator', item.creatorConflict ? 'Conflicting reports' : item.modelCreator || 'Not reported'], ...(item.modelCreator || item.creatorConflict ? [['Creator source', (item.creatorSources ?? [item.sourceId]).filter(Boolean).map(sourceName).join(' · ') || 'Not supplied']] : [])]; }
function detailList(rows) { return `<dl class="detail-list">${rows.map(([label, value, type]) => `<div><dt>${escape(label)}</dt><dd>${type === 'models' ? `<span class="identity-list">${value.map(model => modelLabel(model, 15)).join('')}</span>` : type === 'services' ? `<span class="identity-list">${value.map(name => serviceLabel(name, 15)).join('')}</span>` : ['Provider', 'Provider / runtime', 'Served by', 'Model creator', 'Connection'].includes(label) ? serviceLabel(value, 15) : escape(value)}</dd></div>`).join('')}</dl>`; }
function openInspector(title, subtitle, body, context = '', identities = {}) {
  if (!inspecting) currentInspection = null;
  const dialog = $('#inspector');
  dialog.classList.toggle('environment-inspector', ['Agent environment', 'Deployment', 'Shared capacity', 'Reported path'].includes(context));
  const markup = `<div class="inspector-head"><button class="close-button" data-action="close" aria-label="Close details">×</button><h2 id="inspector-title">${identityLabel(title, identities.title, 24)}</h2><p>${identityLabel(subtitle, identities.subtitle, 15)}</p></div><div class="inspector-body">${body}</div>`;
  if (inspectorUpdating) { reconcileInspector(markup); return; }
  if (!dialog.open) returnFocus = document.activeElement;
  dialog.innerHTML = markup; dialog.showModal(); dialog.scrollTop = 0;
}
function refreshInspection() {
  if (!currentInspection || !$('#inspector').open) return;
  inspecting = true; inspectorUpdating = true;
  try { inspectInner(...currentInspection); } finally { inspecting = false; inspectorUpdating = false; }
}
function inspect(kind, key, pathKind) {
  currentInspection = [kind, key, pathKind]; inspectorTab = 'deployments'; inspecting = true;
  try { inspectInner(kind, key, pathKind); } finally { inspecting = false; }
}
function inspectInner(kind, key, pathKind) {
  if (inspectEnvironment(kind, key)) return;
  if (kind === 'agent-list' || kind === 'task-list') {
    const type = kind === 'agent-list' ? 'agent' : 'task', entities = observedEntities(type);
    openInspector(type === 'agent' ? 'Agents in view' : 'Tasks in view', `${integer(entities.length)} observed in the last ${state.hours}h`, `<div class="entity-head"><span>${type === 'agent' ? 'Agent' : 'Task'}</span><span>Models</span><span>Requests</span></div><div class="entity-list">${entities.map(entity => `<button class="entity-row" data-inspect="${type}" data-key="${escape(entity.id)}"><span><strong>${escape(entity.name)}</strong><small>${type === 'agent' ? `${entity.related.size} ${entity.related.size === 1 ? 'task' : 'tasks'} observed` : escape([...entity.related].join(', '))}</small></span><span>${entity.models.size}</span><span>${integer(entity.count)}</span></button>`).join('')}</div><p class="detail-note">Only source-reported IDs in the selected window are counted. Names use exported labels or fall back to the ID; the terminal does not discover agent roles from code. Request activity does not establish task completion.</p>`, 'Observed activity');
  } else if (kind === 'agent' || kind === 'task') {
    const items = records().filter(item => item[`${kind}Id`] === key); if (!items.length) { openInspector('No activity in this window', `${kind} · ${key}`, '<p class="detail-note">This identity no longer has retained activity in the selected window.</p>', 'Agent environment'); return; }
    const metrics = stats(items), name = items[0][kind] || key;
    openInspector(name, `Observed ${kind} · last ${state.hours}h`, `<button class="text-button" data-inspect="${kind}-list" data-key="all">← All ${kind === 'agent' ? 'agents' : 'tasks'}</button>${kind === 'agent' ? `<button class="text-button agent-map-link" data-focus-agent="${escape(key)}">Focus on map ↗</button>` : ''}<div class="agent-metrics">${[['Requests', integer(items.length)], ['Models', integer(new Set(items.map(item => `${item.provider}:${item.model}`)).size)], ['Median latency', duration(metrics.latency)], ['Recorded spend', money(metrics.cost)]].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join('')}</div>${identityEvidence(items, kind)}${dependencyDetails(items)}<p class="detail-caption">${kind === 'agent' ? 'Tasks observed' : 'Agents observed'}</p><p class="muted">${escape([...new Set(items.map(item => kind === 'agent' ? item.task || item.taskId : item.agent || item.agentId).filter(Boolean))].join(' · ') || 'Not supplied')}</p><p class="detail-note">Reported inference metadata only. Task lifecycle and agent orchestration remain outside the terminal.</p>`, kind === 'agent' ? 'Agent environment' : 'Observed activity');
  } else if (kind === 'model') {
    const model = state.data.models.find(item => item.id === key); if (!model) return;
    const items = records().filter(item => item.model === model.name && item.provider === model.provider), metrics = stats(items);
    openInspector(model.name, `Served by ${model.provider} · ${model.location}`, `${detailList([['Served by', model.provider], ...creatorFacts(model), ['State', stateLabel(model.state)], ['Observed paths', routeKinds(items).map(kind => ROUTES[kind].label).join(', ') || 'Not observed'], ['Observed requests', integer(items.length)], ['Window', `Last ${state.hours} ${state.hours === 1 ? 'hour' : 'hours'}`], ['Input / output tokens', `${compact(metrics.input)} / ${compact(metrics.output)}`], ['Median latency', duration(metrics.latency)], ['Recorded spend', money(metrics.cost)], ['Cost coverage', `${metrics.costCount} of ${items.length} requests`], ...(model.memoryBytes != null ? [['Reported VRAM allocation', bytes(model.memoryBytes)]] : []), ...(model.parameters ? [['Parameters', model.parameters]] : []), ...(model.quantization ? [['Quantization', model.quantization]] : [])])}<div class="detail-section-title"><h3>Deployments</h3></div>${deploymentList(items)}<p class="detail-caption">Used by</p><p class="muted">${escape([...new Set(items.map(item => item.workload))].join(', ') || 'No use observed in this window.')}</p><p class="detail-note">${model.state === 'loaded' ? 'Loaded means resident in memory, not necessarily generating. ' : ''}Usage reflects connected sources only. Missing cost and timing measurements are not treated as zero.</p>`, 'Model inventory', { title: modelIdentity(model), subtitle: serviceIdentity(model.provider)?.key !== modelIdentity(model)?.key ? serviceIdentity(model.provider) : null });
  } else if (kind === 'source') {
    const source = state.data.sources.find(item => item.id === key); if (!source) return;
    openInspector(source.name, source.kind, `${detailList([['Connection', stateLabel(source.state)], ['Location', source.detail], ['Last checked', source.updatedAt ? time(source.updatedAt) : 'No successful check'], ...(source.records != null ? [['Records retained', integer(source.records)]] : [])])}<p class="detail-note">${escape(source.note)}</p><div class="modal-actions"><button class="button" data-action="connect">Source setup →</button></div>`, 'Source coverage', { title: serviceIdentity(source.name) });
  } else if (kind === 'record') {
    const record = records().find(item => item.id === key); if (!record) return;
    openInspector(record.workload, record.model, `${detailList([['Scope', record.scope], ...(record.agentId ? [['Agent ID', record.agentId], ['Agent name', record.agent || 'Not supplied']] : []), ...(record.taskId ? [['Task ID', record.taskId], ['Task name', record.task || 'Not supplied']] : []), ['Served by', record.provider], ...creatorFacts(record), ['Connection', record.route], ['Path type', ROUTES[routeKind(record, state.data)].label], ['Status', stateLabel(record.status)], ['Recorded at', new Date(record.occurredAt).toLocaleString()], ['Duration', duration(record.durationMs)], ['Input / output tokens', `${compact(record.inputTokens)} / ${compact(record.outputTokens)}`], ['Cache read tokens', compact(record.cacheReadTokens)], ['Cost', record.currency === 'USD' ? money(record.cost) : 'Unsupported currency'], ['Cost basis', record.cost == null ? 'Not supplied' : record.costKind], ['Source', sourceName(record.sourceId)]])}<p class="detail-note">This is a metadata summary. Prompts, responses, and intermediate execution traces are not collected.</p>`, 'Recorded activity', { subtitle: modelIdentity(record) });
  } else {
    const items = records().filter(item => item[kind === 'route' ? 'route' : 'workload'] === key && (kind !== 'route' || !pathKind || routeKind(item, state.data) === pathKind)), metrics = stats(items);
    openInspector(key, kind === 'route' ? 'Observed connection' : 'Observed workload', `${detailList([['Requests', integer(items.length)], ['Path types', routeKinds(items).map(kind => ROUTES[kind].label).join(', ') || 'Not observed'], ['Models', [...new Map(items.map(item => [`${item.provider}:${item.model}`, item])).values()], 'models'], ['Providers', [...new Set(items.map(item => item.provider))], 'services'], ['Scope', [...new Set(items.map(item => item.scope))].join(', ')], ['Median latency', duration(metrics.latency)], ['Recorded spend', money(metrics.cost)]])}<p class="detail-note">Connections are taken from source metadata. They describe reported paths, not a network inspection or an enforced routing policy.</p>`, 'Environment map', { title: kind === 'route' ? serviceIdentity(key) : null });
  }
}
function inspectEnvironment(kind, key) {
  const env = environment();
  if (kind === 'deployment-list') {
    openInspector('Model deployments', `${env.deployments.length} declared or runtime-discovered instances`, `${deploymentList(records(), true)}<p class="detail-note">Each deployment has its own identity. Requests join only by an explicit deployment ID with a matching model and provider.</p>`, 'Deployment');
  } else if (kind === 'deployment') {
    const deployment = env.deployments.find(item => item.id === key); if (!deployment) { openInspector('Deployment unavailable', key, '<p class="detail-note">This deployment is absent from the latest inventory.</p>', 'Deployment'); return true; }
    const items = records().filter(item => deploymentFor(item, state.data)?.id === key);
    const agents = new Map(items.filter(item => item.agentId).map(item => [item.agentId, item.agent || item.agentId]));
    const pools = env.pools.filter(pool => deployment.poolIds.includes(pool.id));
    const host = computeHosts().find(item => item.id === deployment.hostId);
    openInspector(deployment.model, `${deployment.name} · ${deployment.location}`, `<button class="text-button" data-inspect="deployment-list" data-key="all">← All deployments</button>${detailList([['Deployment ID', deployment.id], ['Served by', deployment.provider], ...creatorFacts(deployment), ['Serving mode', ({ shared: 'Shared API', dedicated: 'Dedicated deployment', 'self-hosted': 'Self-hosted runtime' })[deployment.servingMode] || 'Not reported'], ['Inventory state', stateLabel(deployment.state)], ['Requests in window', integer(items.length)], ['Observed agents', integer(agents.size)], ['Identity source', sourceName(deployment.sourceId)], ['Host', host?.name || deployment.hostId || 'Not reported'], ['Hardware', host?.accelerators?.length ? host.accelerators.map(device => device.name).join(' · ') : 'Not reported']])}${host ? `<button class="text-button activity-link" data-host="${escape(host.id)}">Inspect ${escape(host.name)} →</button>` : ''}<div class="detail-section-title"><h3>Shared capacity</h3><span>${pools.length} linked pools</span></div>${pools.length ? pools.map(capacityRow).join('') : '<p class="detail-note">No resource pool is declared for this deployment.</p>'}<div class="detail-section-title"><h3>Agents recorded on this deployment</h3></div>${agentLinks(agents)}${namingNote()}<p class="detail-note">A declared or loaded deployment does not guarantee readiness. Pool readings cover all consumers and are separate from request counts.</p>`, 'Deployment', { title: modelIdentity(deployment) });
  } else if (kind === 'pool-list') {
    openInspector('Shared capacity', `${env.pools.length} declared or runtime-discovered pools`, `${env.pools.map(capacityRow).join('')}<p class="detail-note">Readings retain their source timestamps. No reading means capacity is unknown.</p>`, 'Shared capacity');
  } else if (kind === 'pool') {
    const pool = env.pools.find(item => item.id === key); if (!pool) { openInspector('Capacity unavailable', key, '<p class="detail-note">This pool is absent from the latest snapshot.</p>', 'Shared capacity'); return true; }
    const usage = env.usage.get(key), status = poolStatus(pool), readings = capacityReadings(pool);
    openInspector(pool.name, `${pool.kind === 'quota' ? 'Shared quota' : pool.kind === 'runtime' ? 'Inference runtime' : 'Shared connection'} · ${status === 'sampled' ? 'Sampled' : status === 'stale' ? 'Reading is stale' : 'No capacity reading'}`, `<button class="text-button" data-inspect="pool-list" data-key="all">← All shared pools</button><div class="pool-sample-note ${status}">${pool.observedAt ? `Sampled ${escape(new Date(pool.observedAt).toLocaleString())} · ${relativeTime(pool.observedAt)}` : 'The source has not supplied a usable reading.'}${status === 'stale' ? '<br>Older than three collection intervals. Current pressure is unknown.' : ''}</div><div class="pool-readings">${readings.map(row => `<div class="pool-reading"><div><span>${escape(row.label)}</span><strong>${readingValue(row)}</strong></div>${row.ratio != null ? `<div class="capacity-track ${status}" role="meter" aria-label="${escape(row.label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, Math.round(row.ratio * 100))}" aria-valuetext="${escape(readingValue(row))}"><i style="transform:scaleX(${Math.min(1, row.ratio)})"></i></div>` : ''}</div>`).join('')}</div>${detailList([['Name source', pool.id.startsWith('runtime:') ? sourceName(pool.sourceId) : '.openmerit/terminal.json · capacityPools'], ['Readings source', sourceName(pool.sourceId)], ['Quota window', pool.windowSeconds != null ? `${pool.windowSeconds} seconds` : 'Not supplied'], ['Reported reset', pool.resetAt ? new Date(pool.resetAt).toLocaleString() : 'Not supplied'], ['Observed requests using pool', integer(usage.items.length)], ['Linked deployments', integer(usage.deployments.length)]])}<div class="detail-section-title"><h3>Agents sharing this pool</h3><span>${usage.agents.size} observed · ${state.hours}h</span></div>${agentLinks(usage.agents)}<p class="detail-note">These are whole-pool readings, including consumers outside this project. Agents are linked by reported deployment IDs and declared connection dependencies. The terminal does not attribute pool usage to individual agents or predict remaining capacity.</p>`, 'Shared capacity', { title: poolIdentity(pool) });
  } else if (kind === 'entry') {
    const items = records().filter(item => JSON.stringify([reportedPath(item, state.data)[0]]) === key);
    const first = items.length ? reportedPath(items[0], state.data)[0] : null;
    const paths = new Map();
    for (const item of items) { const path = reportedPath(item, state.data), id = JSON.stringify(path); const value = paths.get(id) ?? { path, count: 0 }; value.count++; paths.set(id, value); }
    openInspector(first?.name ?? 'Connection no longer observed', `${items.length} requests across all observed agents · ${state.hours}h`, `<div class="detail-section-title"><h3>Reported paths</h3><span>${paths.size} sequences</span></div><div class="path-list">${[...paths].sort((a, b) => b[1].count - a[1].count).map(([id, { path, count }]) => `<button class="path-row" data-inspect="path" data-key="${escape(id)}">${path.map(hop => `<span class="path-hop" style="--route-color:${ROUTES[hop.kind].color}">${routeIcon(hop.kind)}${serviceLabel(hop.name, 14)}</span>`).join('<span class="path-arrow" aria-hidden="true">→</span>')}<span class="path-count">${integer(count)} requests</span></button>`).join('')}</div><p class="detail-note">Each sequence contains only reported hops. Missing connection metadata does not establish an execution path.</p>`, 'Reported path', { title: serviceIdentity(first?.name) });
  } else if (kind === 'path') {
    let path; try { path = JSON.parse(key); } catch { return true; }
    const items = records().filter(item => JSON.stringify(reportedPath(item, state.data)) === key);
    openInspector('Reported execution path', `${integer(items.length)} requests across the last ${state.hours}h`, `<ol class="path-steps">${path.map(hop => `<li style="--route-color:${ROUTES[hop.kind].color}">${routeIcon(hop.kind)}<span><strong>${serviceLabel(hop.name, 16)}</strong><small>${ROUTES[hop.kind].label}</small></span></li>`).join('')}</ol><div class="detail-section-title"><h3>Reached deployments</h3></div>${deploymentList(items)}<p class="detail-note">Only source-reported hops are shown. A one-hop record does not establish that no other intermediaries exist. Usage covers all agents reporting this path.</p>`, 'Reported path');
  } else if (kind === 'unidentified') {
    openInspector('Deployment unidentified', 'The model is known; its execution instance is not.', '<p class="detail-note">These requests do not provide a matching deployment identity. The map keeps this gap visible rather than assigning a deployment from a model name or connection.</p>', 'Deployment');
  } else return false;
  return true;
}
function agentLinks(agents) { return agents.size ? `<div class="agent-links">${[...agents].map(([id, name]) => `<button data-inspect="agent" data-key="${escape(id)}">${escape(name)}<span>↗</span></button>`).join('')}</div>` : '<p class="detail-note">No agent IDs were reported for this selection.</p>'; }
function closeDialog() { const dialog = $('dialog[open]'); if (dialog) dialog.close(); }
function connect() { closeDialog(); openInspector('Connect your environment.', 'Read existing evidence. Keep inference independent.', `<p class="detail-note" style="margin-top:0">Ollama is discovered at its standard local address. For requests, export one metadata record per line to <code>.openmerit/inference.jsonl</code>. Do not include prompts, responses, or secrets.</p><pre class="detail-code">${escape(JSON.stringify({ id: 'request-123', occurredAt: new Date().toISOString(), workload: 'your-service-id', scope: 'application', model: 'your-model', provider: 'your-provider', route: 'your-gateway', routeKind: 'gateway', location: 'cloud', status: 'completed', inputTokens: 120, outputTokens: 40, durationMs: 850, cost: 0.002, costKind: 'reported', currency: 'USD' }, null, 2))}</pre><p class="detail-note">Use a stable ID to update an ongoing request. Keep retries under separate IDs. Missing fields stay unknown. The activity feed takes precedence over OpenMerit audit summaries.</p><p class="detail-caption">Other local servers</p><p class="detail-note" style="margin-top:0">For LM Studio or vLLM, add a local runtime to <code>.openmerit/terminal.json</code>. Only model inventory and supported counters are read.</p><pre class="detail-code">${escape(JSON.stringify({ runtimes: [{ name: 'LM Studio', type: 'openai-compatible', url: 'http://127.0.0.1:1234' }, { name: 'vLLM', type: 'vllm', url: 'http://127.0.0.1:8000' }] }, null, 2))}</pre><p class="detail-caption">Optional inventory</p><p class="detail-note" style="margin-top:0">Create <code>.openmerit/terminal.json</code> and restart the terminal:</p><pre class="detail-code">${escape(JSON.stringify({ inventory: [{ name: 'Your gateway', kind: 'gateway', location: 'cloud' }, { name: 'Your model', kind: 'model', provider: 'Your provider', location: 'cloud' }] }, null, 2))}</pre>`, 'Source setup'); }
function workspace() { openInspector(state.info.hostedSample ? 'Sample environment' : 'Choose your view.', state.info.hostedSample ? 'A fictional workspace. No connection to your machine.' : 'Keep your environment and the example separate.', `<div class="workspace-options">${state.info.defaultMode !== 'sample' ? `<button class="workspace-option ${state.mode === 'live' ? 'selected' : ''}" data-action="live"><strong>Your environment</strong><span>Real inventory and evidence from this project.</span></button>` : ''}<button class="workspace-option ${state.mode === 'sample' ? 'selected' : ''}" data-action="sample"><strong>Sample environment</strong><span>40 agents, 140 tasks, and 21 models in a fictional enterprise workspace.</span></button></div><p class="detail-note">The sample makes no inference calls and never contributes to your project's totals.</p>`, 'Environment'); }
async function changeMode(mode) { if (state.info.hostedSample && mode !== 'sample') return; closeDialog(); state.mode = mode; state.error = ''; state.search = ''; state.filter = 'all'; mapAgent = ''; await refresh(true); history.replaceState(null, '', `${location.pathname}${mode === 'sample' ? '?sample=1' : ''}#${state.page}`); $('#announcement').textContent = mode === 'sample' ? 'Showing the fictional sample environment.' : 'Showing your project environment.'; }

let commandEntries = [];
function commandResults(query = '') {
  commandEntries = [...pages.map(page => ({ title: labels[page], type: 'Go to', action: () => navigate(page) })), ...state.data.models.map(model => ({ title: model.name, type: model.provider, identity: modelIdentity(model), action: () => inspect('model', model.id) })), ...computeHosts().map(host => ({ title: host.name, type: 'Host', action: () => { selectedHost = host.id; hostLocation = ''; navigate('compute'); } })), ...environment().deployments.map(deployment => ({ title: `${deployment.model} / ${deployment.name}`, type: 'Deployment', identity: modelIdentity(deployment), action: () => inspect('deployment', deployment.id) })), ...environment().pools.map(pool => ({ title: pool.name, type: 'Shared capacity', identity: poolIdentity(pool), action: () => inspect('pool', pool.id) })), ...state.data.sources.map(source => ({ title: source.name, type: 'Source', identity: serviceIdentity(source.name), action: () => inspect('source', source.id) })), ...observedEntities('agent').map(agent => ({ title: agent.name, type: 'Agent', action: () => inspect('agent', agent.id) })), ...observedEntities('task').map(task => ({ title: task.name, type: 'Task', action: () => inspect('task', task.id) }))].filter(item => `${item.title} ${item.type}`.toLowerCase().includes(query.toLowerCase())).slice(0, 12);
  $('#command-results').innerHTML = commandEntries.length ? commandEntries.map((entry, i) => `<button class="command-result ${i === 0 ? 'selected' : ''}" data-command="${i}">${identityLabel(entry.title, entry.identity, 18)}<small>${escape(entry.type)}</small></button>`).join('') : '<p class="empty-small" style="padding:16px">No matches in this environment.</p>';
}
function openCommand() { closeDialog(); returnFocus = document.activeElement; $('#command').innerHTML = `<div class="command-input-row">${icon('search')}<input id="command-input" type="search" placeholder="Find a model, agent, task, or source…" aria-label="Search your environment" autocomplete="off"><kbd>esc</kbd></div><div id="command-results"></div><div class="command-footer">↑ ↓ to move · enter to open</div>`; commandResults(); $('#command').showModal(); $('#command-input').focus(); }

document.addEventListener('click', event => {
  const element = event.target.closest('[data-page],[data-hours],[data-filter],[data-inspect],[data-action],[data-command],[data-focus-agent],[data-inspector-tab],[data-host],[data-activity-path]'); if (!element) return;
  if (element.dataset.host) { selectedHost = element.dataset.host; if (state.page !== 'compute') { hostLocation = ''; closeDialog(); navigate('compute'); } else render(); }
  else if (element.dataset.activityPath) { activityPath = element.dataset.activityPath; render(); }
  else if (element.dataset.inspectorTab) { inspectorTab = element.dataset.inspectorTab; refreshInspection(); }
  else if (element.dataset.focusAgent) { mapAgent = element.dataset.focusAgent; closeDialog(); navigate('connections'); }
  else if (element.dataset.page) navigate(element.dataset.page, { focusTab: element.getAttribute('role') === 'tab' });
  else if (element.dataset.hours) { state.hours = Number(element.dataset.hours); render(); }
  else if (element.dataset.filter) { state.filter = element.dataset.filter; render(); }
  else if (element.dataset.inspect) inspect(element.dataset.inspect, element.dataset.key, element.dataset.routeKind);
  else if (element.dataset.command != null) { const entry = commandEntries[Number(element.dataset.command)]; closeDialog(); entry?.action(); }
  else {
    const action = element.dataset.action;
    if (action === 'close') closeDialog();
    if (action === 'workspace') workspace();
    if (action === 'search') openCommand();
    if (action === 'connect') connect();
    if (action === 'live' || action === 'sample') void changeMode(action);
    if (action === 'api' && state.info.hostedSample) { closeDialog(); openInspector('Sample data for your agent.', 'The same fictional environment, as JSON.', `<pre class="detail-code">GET ${escape(location.origin)}/api/sample</pre><p class="detail-note">All names, requests, and hardware are fictional. This preview does not connect to your machine or run inference.</p>`, 'Agent access'); }
    if (action === 'api' && !state.info.hostedSample) { closeDialog(); openInspector('A view for your agent.', 'The same evidence, in a readable local snapshot.', `<pre class="detail-code">openmerit dash --json</pre><p class="detail-note">Or, while this terminal is running:</p><pre class="detail-code">GET ${escape(location.origin)}/api/snapshot</pre><p class="detail-note">Schema version 1. Includes models, inventory, sources, request metadata, and machine measurements. Read-only. No inference or model changes.</p>`, 'Agent access'); }
    if (action === 'about') openInspector('Inference Terminal', 'Your inference environment, in one place.', '<p class="detail-note" style="margin-top:0">A local, passive overview of models, providers, connections, activity, and compute. It reads existing evidence on a short interval. Your workloads never wait for it.</p><p class="detail-note">This is an unreleased source build. Collection currently covers OpenMerit application summaries, a metadata JSONL feed, declared inventory, local Ollama, compatible local model servers, vLLM counters, whole-machine CPU and memory, and exported hardware inventories.</p><p class="detail-note">No prompt storage. No model calls. No route changes. Your inference continues when the terminal closes.</p>', 'OpenMerit');
  }
});
document.addEventListener('change', event => { if (event.target.id === 'host-location') { hostLocation = event.target.value; render(); $('#host-location')?.focus({ preventScroll: true }); } if (event.target.id === 'map-agent') { mapAgent = event.target.value; render(); $('#map-agent')?.focus({ preventScroll: true }); } });
document.addEventListener('input', event => { if (event.target.id === 'model-search') { state.search = event.target.value; render(); $('#model-search').focus({ preventScroll: true }); } if (event.target.id === 'command-input') commandResults(event.target.value); });
document.addEventListener('pointerdown', () => document.body.classList.remove('keyboard'));
document.addEventListener('keydown', event => {
  document.body.classList.add('keyboard');
  if (event.target.matches('.terminal-tabs [role="tab"]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const tabs = [...document.querySelectorAll('.terminal-tabs [role="tab"]')], index = tabs.indexOf(event.target);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
    tabs.forEach((tab, i) => { tab.tabIndex = i === next ? 0 : -1; });
    tabs[next].focus({ preventScroll: true }); revealTab(tabs[next]); return;
  }
  if (event.key === 'Escape' && document.querySelector('dialog[open]')) { event.preventDefault(); closeDialog(); return; }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommand(); return; }
  if (event.target.matches('[data-bin]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const bins = [...document.querySelectorAll('[data-bin]')]; const i = Number(event.target.dataset.bin); const next = event.key === 'Home' ? 0 : event.key === 'End' ? bins.length - 1 : Math.max(0, Math.min(bins.length - 1, i + (event.key === 'ArrowLeft' ? -1 : 1))); bins.forEach((bin, index) => bin.setAttribute('tabindex', index === next ? '0' : '-1')); bins[next]?.focus({ preventScroll: true }); }
  if (event.target.matches('.map-node') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); inspect(event.target.dataset.inspect, event.target.dataset.key, event.target.dataset.routeKind); }
  if ($('#command').open && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) {
    event.preventDefault(); const buttons = [...document.querySelectorAll('.command-result')]; let index = buttons.findIndex(button => button.classList.contains('selected')); if (event.key === 'Enter') { buttons[index]?.click(); return; } index = Math.min(buttons.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1))); buttons.forEach((button, i) => button.classList.toggle('selected', i === index)); buttons[index]?.scrollIntoView({ block: 'nearest' });
  }
});
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', event => { if (event.target !== dialog) return; const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); });
  dialog.addEventListener('close', () => { if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); });
}
function highlightMap(node) { const kind = node.dataset.mapType, key = node.dataset.mapKey; document.querySelectorAll('.map-edge').forEach(edge => { const match = JSON.parse(edge.dataset[kind] ?? '[]').includes(key); edge.classList.toggle('focused', match); edge.classList.toggle('faded', !match); }); }
document.addEventListener('pointerover', event => { const node = event.target.closest('.map-node'); if (node) highlightMap(node); const hit = event.target.closest('[data-bin]'); if (hit) chartTooltip(hit); });
document.addEventListener('focusin', event => { if (event.target.matches('.map-node')) highlightMap(event.target); if (event.target.matches('[data-bin]')) chartTooltip(event.target); });
function clearChart() { document.querySelectorAll('.map-edge').forEach(edge => edge.classList.remove('focused', 'faded')); const tooltip = $('.chart-tooltip'); if (tooltip) tooltip.hidden = true; }
document.addEventListener('pointerout', event => { if (event.target.closest('.map-node,[data-bin]')) clearChart(); });
document.addEventListener('focusout', event => { if (event.target.matches('.map-node,[data-bin]')) clearChart(); });
function chartTooltip(hit) { const bin = buckets(records(), 60)[Number(hit.dataset.bin)], tooltip = $('.chart-tooltip'), parent = hit.closest('.activity-chart'); if (!bin || !tooltip || !parent) return; tooltip.textContent = `${time(bin.at)} · ${Object.entries(ROUTES).filter(([kind]) => bin.paths[kind] && (activityPath === 'all' || activityPath === kind)).map(([kind, route]) => `${bin.paths[kind]} ${route.short.toLowerCase()}`).join(' · ') || '0 requests'}`; tooltip.hidden = false; const bounds = hit.getBoundingClientRect(), area = parent.getBoundingClientRect(); tooltip.style.left = `${Math.min(area.width - tooltip.offsetWidth - 10, Math.max(10, bounds.left - area.left - tooltip.offsetWidth / 2))}px`; tooltip.style.top = '8px'; }
window.addEventListener('hashchange', () => { const page = location.hash.slice(1); if (pages.includes(page)) navigate(page); });

async function refresh(force = false) {
  if (state.fetching) { if (force) state.pendingRefresh = true; return; }
  state.fetching = true;
  const requestedMode = state.mode;
  try {
    const response = await fetch(requestedMode === 'sample' ? '/api/sample' : '/api/snapshot', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Snapshot unavailable');
    const snapshot = await response.json();
    if (requestedMode !== state.mode) return;
    state.data = snapshot; state.error = '';
    refreshInspection();
    if (force || (!document.querySelector('dialog[open]') && !selectIsOpen() && !document.activeElement?.matches('input'))) render();
  } catch {
    state.error = state.info.hostedSample ? 'The sample preview could not refresh. Reload the page to reconnect.' : 'The terminal is disconnected. Your inference is unaffected. Reopen the local command to reconnect.';
    refreshInspection();
    if (state.data && !document.querySelector('dialog[open]') && !selectIsOpen()) render();
    else if (!state.data) $('#app').innerHTML = `<div class="boot"><span class="wordmark">openmerit</span><p>${escape(state.error)}</p><p><a href="/">Try again →</a></p></div>`;
  } finally { state.fetching = false; if (state.pendingRefresh) { state.pendingRefresh = false; void refresh(true); } }
}
async function start() {
  try { const response = await fetch('/api/info'); state.info = await response.json(); if (state.info.defaultMode === 'sample') state.mode = 'sample'; } catch { /* The snapshot request provides the actionable error. */ }
  await refresh(true);
  state.timer = setInterval(() => { if (!document.hidden) void refresh(); }, Math.max(10, state.info.interval ?? 15) * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
}
void start();
