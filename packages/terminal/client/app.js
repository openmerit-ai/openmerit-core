import { requestCount, requestWeight } from './request-count.mjs';
import { ACTIVITY_RANGES, rangeLabel, rangeDescription, historyExtent, activityWindow, windowRecords, intervalLabel, activityTime } from '../src/history.mjs';
import { reconcile, reconcileInspector, morphText } from './interface.js';
import { ROUTES, routeKind, routeBreakdown, requestCountKnown, activityEvidence } from './routes.mjs';
import { routeIcon } from './route-icons.mjs';
import { selectControl, selectIsOpen, closeSelect } from './select.js';
import { hostState } from '../src/hardware.mjs';
import { serviceIdentity, modelIdentity, identityIcon, identitySvg } from './brands.mjs';
import { serviceInventory, SERVICE_TYPES } from './services.mjs';
import { reportedPath, deploymentFor, poolsFor, capacityState, capacityReadings, poolUsage } from './environment.mjs';

import { buildEnvironmentMap } from './map.mjs';
import { createAnalytics, browserErrorProperties } from './analytics.mjs';

const analytics = createAnalytics({ enabled: () => state.info.telemetry === true, mode: () => state.mode });
const interaction = (action, kind = 'other') => analytics('terminal_interaction', { action, kind: ['model','agent','task','service','source','host','deployment','pool','record','path'].includes(kind) ? kind : 'other' });
window.addEventListener('error', event => analytics('terminal_error', { code: 'uncaught_error', ...browserErrorProperties(event.error) }));
window.addEventListener('unhandledrejection', event => analytics('terminal_error', { code: 'uncaught_error', ...browserErrorProperties(event.reason) }));

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const compact = value => value == null ? '—' : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const integer = value => new Intl.NumberFormat('en').format(value);
const quantity = (count, noun) => `${integer(count)} ${noun}${count === 1 ? '' : 's'}`;
const money = value => value == null ? '—' : new Intl.NumberFormat('en', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < .01 ? 4 : 2 }).format(value);
const bytes = value => value == null ? '—' : `${(value / 1024 ** 3).toFixed(1)} GiB`;
const duration = value => value == null ? '—' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
const median = values => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
const sumKnown = values => { const known = values.filter(value => typeof value === 'number'); return known.length ? known.reduce((a, b) => a + b, 0) : null; };
const time = value => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const relativeTime = value => { const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000)); return seconds < 60 ? 'just now' : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : seconds < 2592000 ? `${Math.floor(seconds / 86400)}d ago` : new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }); };
const iconPaths = { overview: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="13" y="3" width="6" height="6" rx="1"/><rect x="3" y="13" width="6" height="6" rx="1"/><rect x="13" y="13" width="6" height="6" rx="1"/>', models: '<path d="m11 2 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M2 15l9 5 9-5"/>', connections: '<rect x="2" y="8" width="5" height="6" rx="1.5"/><rect x="15" y="2" width="5" height="6" rx="1.5"/><rect x="15" y="14" width="5" height="6" rx="1.5"/><path d="M7 11h3c2 0 2-6 5-6m-5 6c2 0 2 6 5 6"/>', activity: '<path d="M2 12h4l3-7 4 13 3-6h4"/>', compute: '<rect x="5" y="5" width="12" height="12" rx="2"/><path d="M8 2v3m6-3v3M8 17v3m6-3v3M2 8h3m-3 6h3m12-6h3m-3 6h3"/><rect x="8" y="8" width="6" height="6" rx="1"/>', sources: '<circle cx="11" cy="11" r="3"/><path d="M11 2v3m0 12v3M2 11h3m12 0h3M4.6 4.6l2.1 2.1m8.6 8.6 2.1 2.1M4.6 17.4l2.1-2.1m8.6-8.6 2.1-2.1"/>', search: '<circle cx="9.5" cy="9.5" r="6"/><path d="m14 14 5 5"/>', arrow: '<path d="M4 11h14m-5-5 5 5-5 5"/>', refresh: '<path d="M18 7a8 8 0 1 0 1 8M18 2v5h-5"/>' };
const icon = name => `<svg viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] ?? iconPaths.overview}</svg>`;
const logo = '<svg viewBox="0 0 28 30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M3 27V13a11 11 0 0 1 22 0v14M8 27V13a6 6 0 0 1 12 0v14M14 16v11"/></svg>';
const pages = ['overview', 'models', 'services', 'activity', 'compute', 'sources'];
const labels = { overview: 'Overview', models: 'Models', services: 'Services', activity: 'Activity', compute: 'Local compute', sources: 'Sources' };
const state = { data: null, page: location.hash === '#connections' ? 'services' : pages.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview', hours: 0, filter: 'all', search: '', mode: new URLSearchParams(location.search).has('sample') ? 'sample' : 'live', info: {}, error: '', fetching: false, timer: null };
const countRequests = items => requestCount(items, state.data);
let returnFocus = null;
let mapAgent = '';
let mapExpandAll = false;
const mapGroupExpansion = new Map();
let serviceView = location.hash === '#connections' ? 'map' : 'inventory';
let serviceFilter = 'all';
let serviceSearch = '';
let referenceKind = 'all', referenceSearch = '', referencePage = 0;
let serviceCache = null;
function services() {
  if (serviceCache?.data !== state.data || serviceCache.hours !== state.hours) serviceCache = { data: state.data, hours: state.hours, items: serviceInventory(state.data, records()) };
  return serviceCache.items;
}
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

let historyWindowCache = null;
function windowBounds() {
  if (historyWindowCache?.data !== state.data || historyWindowCache.hours !== state.hours) historyWindowCache = { data: state.data, hours: state.hours, ...activityWindow(state.data.records, state.hours, state.data.observedAt), items: windowRecords(state.data.records, state.hours, state.data.observedAt) };
  return historyWindowCache;
}
function records() { return windowBounds().items; }
function chartTime(value, detail = false) { const { start, end } = windowBounds(); return activityTime(value, end - start, detail); }
function chartInterval() { const { start, end } = windowBounds(); return intervalLabel((end - start) / 60); }
function historyCaption() {
  const history = state.data.history ?? historyExtent(state.data.records, state.data.observedAt);
  const dates = history.first ? `${new Date(history.first).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })} – ${new Date(history.last).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}` : 'No recorded requests';
  return `<div class="history-coverage"><span>Available history <span class="history-dates">${dates}</span></span><button class="text-button ${history.coverage === 'partial' ? 'history-partial' : ''}" data-page="sources">${history.coverage === 'partial' ? 'Partial history · review sources' : 'Recorded sources only ↗'}</button></div>`;
}
function observedEntities(type) {
  const entities = new Map();
  for (const item of records()) {
    const id = item[`${type}Id`]; if (!id) continue;
    const entity = entities.get(id) ?? { id, name: item[type] || id, count: 0, models: new Set(), related: new Set() };
    entity.count += requestWeight(item, state.data); entity.models.add(`${item.provider}:${item.model}`);
    const related = type === 'agent' ? item.taskId : item.agent || item.agentId || item.workload;
    if (related) entity.related.add(related);
    entities.set(id, entity);
  }
  return [...entities.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
function scopeSummary() {
  const agents = observedEntities('agent'), tasks = observedEntities('task');
  if (!agents.length && !tasks.length) return state.data.repository?.references.length ? `<button class="text-button" data-page="sources">${integer(state.data.repository.references.length)} code & configuration references ↗</button>` : 'Models, connections, and compute. Together, in one place.';
  const connections = new Set(records().map(item => item.route).filter(route => route && route !== 'Unattributed route')).size;
  return `<span class="scope-summary" aria-label="Activity in the selected window">${agents.length ? `<button class="text-button scope-link" data-inspect="agent-list" data-key="all">${integer(agents.length)} ${agents.length === 1 ? 'agent' : 'agents'}</button>` : ''}${tasks.length ? `<button class="text-button scope-link" data-inspect="task-list" data-key="all">${integer(tasks.length)} ${tasks.length === 1 ? 'task' : 'tasks'}</button>` : ''}<span>${integer(connections)} connections</span></span>`;
}
function stats(items = records()) {
  const costs = items.filter(item => item.currency === 'USD');
  return { count: countRequests(items), input: sumKnown(items.map(item => item.inputTokens)), output: sumKnown(items.map(item => item.outputTokens)), tokens: sumKnown(items.flatMap(item => [item.inputTokens, item.outputTokens])), cost: sumKnown(costs.map(item => item.cost)), costCount: countRequests(costs.filter(item => item.cost != null)), estimated: costs.some(item => item.cost != null && item.costKind === 'estimated'), unknownCostKind: costs.some(item => item.cost != null && !['reported', 'estimated'].includes(item.costKind)), latency: median(items.filter(item => item.status !== 'running').map(item => item.durationMs).filter(value => value != null)), failures: countRequests(items.filter(item => item.status === 'failed')) };
}
function buckets(items = records(), count = 48) {
  const { start, end } = windowBounds(), step = (end - start) / count;
  const result = Array.from({ length: count }, (_, i) => ({ at: start + i * step, cloud: 0, local: 0, unknown: 0, paths: Object.fromEntries(Object.keys(ROUTES).map(kind => [kind, 0])) }));
  for (const item of items) { const index = Math.min(count - 1, Math.max(0, Math.floor((Date.parse(item.occurredAt) - start) / step))); result[index][item.location === 'private' ? 'local' : item.location] += requestWeight(item, state.data); result[index].paths[routeKind(item, state.data)] += requestWeight(item, state.data); }
  return result;
}
function spark(values, { color = 'var(--chart)', width = 90, height = 28, fill = false, className = '' } = {}) {
  const measured = values.filter(value => value != null);
  if (!measured.length) return `<svg class="${className}" viewBox="0 0 ${width} ${height}" aria-hidden="true"><path d="M0 ${height - 4}h${width}" stroke="var(--line-strong)" stroke-dasharray="2 4"/></svg>`;
  const max = Math.max(1, ...measured);
  // A gap remains a gap. No line is interpolated across an unknown sample.
  let drawing = '', active = false;
  values.forEach((value, index) => { if (value == null) { active = false; return; } const x = index * width / Math.max(1, values.length - 1), y = height - 3 - value / max * (height - 6); drawing += `${active ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)} `; active = true; });
  return `<svg class="${className}" viewBox="0 0 ${width} ${height}" aria-hidden="true">${fill && !values.includes(null) ? `<path d="${drawing}L${width},${height} L0,${height}Z" fill="${color}" opacity=".07"/>` : ''}<path d="${drawing}" fill="none" stroke="${color}" stroke-width="1.25" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
function stateLabel(value) { return ({ detected: 'Detected', needs_access: 'Needs access', connected: 'Connected', partial: 'Partial', not_found: 'Not connected', unavailable: 'Unavailable', disabled: 'Disabled', configured: 'Configured', declared: 'Declared', available: 'Available', observed: 'Observed', loaded: 'Loaded', installed: 'Installed', unknown: 'Unknown', completed: 'Completed', running: 'Reported running', failed: 'Failed' })[value] ?? value; }
function stateBadge(value) { return `<span class="state ${escape(value)}"><i class="status-dot ${['connected', 'loaded'].includes(value) ? '' : ['partial', 'unavailable', 'failed', 'needs_access'].includes(value) ? 'warning' : 'dim'}"></i>${escape(stateLabel(value))}</span>`; }

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
  const known = requestCountKnown(state.data);
  return `<section class="path-summary" aria-label="Requests by path"><div class="path-summary-title"><h2>Request paths</h2><p>${rangeDescription(state.hours)} · recorded only</p></div><div class="path-summary-items">${Object.entries(ROUTES).filter(([kind]) => kind !== 'unknown' || counts.unknown).map(([kind, route]) => `<div class="path-summary-item" style="--route-color:${route.color}"><div>${routeBadge(kind, true)}${morphText(`path-total-${kind}`, known ? integer(counts[kind]) : '—', 'path-total')}</div><span class="path-share-track" aria-hidden="true"><i style="width:${items.length ? counts[kind] / countRequests(items) * 100 : 0}%"></i></span></div>`).join('')}</div></section>`;
}

function shell() {
  const data = state.data;
  const interrupted = Boolean(state.error) || Date.now() - Date.parse(data.observedAt) > data.interval * 3000;
  const connected = data.sources.filter(source => ['connected', 'partial'].includes(source.state)).length;
  const sourceStatus = data.loading ? (data.loadError ? 'Collection delayed' : 'Reading sources') : interrupted ? 'Collection interrupted' : `${connected} of ${data.sources.length} sources`;
  const warning = !data.loading && (interrupted || connected < data.sources.length);
  const tabs = pages.map(page => `<button id="tab-${page}" role="tab" aria-selected="${state.page === page}" aria-controls="terminal-panel" tabindex="${state.page === page ? '0' : '-1'}" data-ui-key="nav-${page}" data-page="${page}">${labels[page]}</button>`).join('');
  return `<div class="shell"><header class="terminal-header"><div class="terminal-header-inner">
    <div class="terminal-masthead"><div class="terminal-identity"><button class="brand" data-action="about" aria-label="About OpenMerit">${logo}<span class="wordmark">openmerit</span></button><span class="terminal-product">Inference Terminal</span></div>
      <div class="header-actions"><button class="environment-switch" data-action="workspace" aria-label="Choose environment" title="${escape(data.project.name)} · ${data.mode === 'sample' ? 'Sample environment' : 'Current project'}"><span class="environment-name">${escape(data.project.name)}</span>${data.mode === 'sample' ? '<span class="environment-mode">Sample</span>' : ''}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="m5 7 3 3 3-3"/></svg></button><button class="header-search" data-action="search" aria-label="Find in your environment" title="Find anything · Command K">${icon('search')}<span>Search</span><kbd>⌘ K</kbd></button></div>
    </div><div class="terminal-navigation"><nav class="terminal-tabs" role="tablist" aria-label="Terminal views">${tabs}</nav><button class="source-status ${warning ? 'attention' : ''}" data-page="sources" aria-label="${sourceStatus}. View source coverage" title="${sourceStatus} · ${data.mode === 'sample' ? 'Fictional sample' : `Every ${data.interval}s`}"><i class="status-dot ${warning ? 'warning' : ''}"></i>${morphText('coverage-count', sourceStatus)}${data.mode === 'live' && !interrupted ? `<span class="source-interval">${data.interval}s</span>` : ''}</button></div>
    </div></header><main id="main" class="main" tabindex="-1"><div id="terminal-panel" role="tabpanel" aria-labelledby="tab-${state.page}">${main()}</div></main></div>`;
}

function heading(title, description, controls = true) { return `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div>${controls ? `<div class="heading-controls"><span class="collection-time"><i class="status-dot"></i>${morphText('freshness', state.error ? 'Disconnected' : `Updated ${relativeTime(state.data.observedAt)}`)}</span><div class="segmented" role="group" aria-label="Activity window">${ACTIVITY_RANGES.map(hour => `<button data-hours="${hour}" aria-pressed="${state.hours === hour}">${rangeLabel(hour)}</button>`).join('')}</div></div>` : ''}</div>${controls ? historyCaption() : ''}`; }
function summary() {
  const data = stats();
  const active = new Set(records().map(item => `${item.provider}:${item.model}`)).size;
  const local = state.data.models.filter(model => ['local', 'private'].includes(model.location)).length;
  const countKnown = requestCountKnown(state.data);
  const series = buckets().map(item => countKnown ? item.cloud + item.local + item.unknown : null);
  const values = [
    ['Models in view', state.data.models.length.toString().padStart(2, '0'), `${local} self-hosted · ${state.data.models.length - local} cloud / other`, null],
    ['Requests observed', countKnown ? integer(data.count) : '—', countKnown ? `${active} models used · ${rangeLabel(state.hours)}` : 'Connect an activity source', series],
    ['Recorded tokens', compact(data.tokens), data.tokens == null ? 'No token measurements yet' : `${compact(data.input)} input · ${compact(data.output)} output`, null],
    ['Recorded spend', money(data.cost), data.cost == null ? 'Cost coverage not available' : `${data.unknownCostKind ? 'USD · cost basis incomplete' : data.estimated ? 'Includes estimates' : 'Reported USD'} · ${compact(data.costCount)} / ${compact(data.count)} requests priced`, null],
  ];
  return `<section class="summary-grid" aria-label="Environment summary">${values.map(([label, value, note, chart]) => `<div class="summary"><div class="summary-label">${label}</div><div class="summary-value">${morphText(`summary-${label.toLowerCase().replaceAll(' ', '-')}`, value)}</div>${chart ? spark(chart, { className: 'summary-spark' }) : ''}<div class="summary-bottom">${note}</div></div>`).join('')}</section>`;
}

function environmentMap(expanded = false) {
  const all = records(), agents = observedEntities('agent');
  if (mapAgent && !agents.some(agent => agent.id === mapAgent)) mapAgent = '';
  const candidates = mapAgent ? all.filter(item => item.agentId === mapAgent) : all;
  const graph = buildEnvironmentMap(candidates, state.data, { expandAll: mapExpandAll, expansion: mapGroupExpansion });
  const allExpanded = graph.groups.length > 0 && graph.groups.every(group => group.expanded);
  const height = Math.max(300, Math.max(...graph.columns.map(column => column.length)) * 58 + 42);
  const positions = new Map();
  const columns = [{ x: 14, width: 196 }, { x: 310, width: 222 }, { x: 642, width: 244 }];
  graph.columns.forEach((nodes, col) => nodes.forEach((node, index) => positions.set(node.id, { ...columns[col], inset: node.groupId ? 8 : 0, y: 56 + (nodes.length === 1 ? (height - 94) / 2 : index * (height - 94) / (nodes.length - 1)) })));
  const shorten = (value, max) => escape(String(value).length > max ? `${String(value).slice(0, max - 1)}…` : value);
  const renderNode = node => {
    const position = positions.get(node.id), isGroup = node.type === 'group', isPath = node.type === 'path';
    const x = position.x + (node.groupId ? 8 : 0), width = position.width - (node.groupId ? 8 : 0);
    let name = node.name, caption, attrs, identity = null;
    const stacked = isGroup && !node.expanded;
    if (isGroup) {
      caption = `${node.members.length} ${node.label} · ${integer(node.count)} requests`;
      attrs = `data-map-group="${escape(node.id)}" aria-expanded="${node.expanded}" aria-label="${node.expanded ? 'Collapse' : 'Expand'} ${escape(node.name)} through ${escape(node.names.join(', '))}"`;
      if (stacked) {
        name = node.members[0].name;
        if (node.side === 'model') identity = modelIdentity(node.members[0].example);
      }
    } else if (isPath) {
      caption = `${ROUTES[node.kind].short} · ${integer(node.count)} requests`;
      attrs = `data-inspect="entry" data-key="${escape(node.key)}" aria-label="Inspect connections through ${escape(name)}"`;
      identity = serviceIdentity(name);
    } else if (node.type === 'model') {
      const deployments = [...node.deployments.values()];
      caption = deployments.length === 1 ? `${node.provider} · ${deployments[0].name}` : `${node.provider}${deployments.length > 1 ? ` · ${deployments.length} deployments` : ''}`;
      attrs = `data-inspect="map-model" data-key="${escape(node.key)}" aria-label="Inspect ${escape(name)} served by ${escape(node.provider)}"`;
      identity = modelIdentity(node.example);
    } else {
      caption = `${integer(node.count)} requests · ${rangeLabel(state.hours)}`;
      attrs = `data-inspect="${node.type}" data-key="${escape(node.inspectKey)}" aria-label="Inspect ${escape(name)}"`;
    }
    const textX = isPath || identity ? 38 : 12, inset = isGroup ? 47 : isPath && identity ? 37 : 12;
    const max = Math.floor((width - textX - inset) / 5.7);
    const backCards = stacked ? `<rect class="map-stack-back" x="8" y="8" width="${width - 16}" height="46" rx="7"/><rect class="map-stack-back" x="4" y="4" width="${width - 8}" height="46" rx="7"/>` : '';
    return `<g class="map-node${isPath ? ' route-node' : ''}${isGroup ? ' map-group' : ''}${node.groupId ? ' map-member' : ''}" data-ui-key="${escape(node.id)}" data-map-node-id="${escape(node.id)}" data-map-node-type="${node.type}" role="button" tabindex="0" ${attrs} ${isPath ? `style="--route-color:${ROUTES[node.kind].color}"` : ''} transform="translate(${x} ${position.y - 23})"><title>${escape(stacked ? `${name} and ${node.members.length - 1} more` : name)} — ${escape(caption)}</title>${backCards}<rect width="${width}" height="46" rx="7"/>${isPath ? `<g class="route-node-icon" transform="translate(10 13)">${routeIcon(node.kind)}</g>` : ''}${identitySvg(identity, isPath ? width - 28 : 12, 14)}<text x="${textX}" y="19">${shorten(name, max)}</text><text class="sub" x="${textX}" y="34">${shorten(caption, Math.floor((width - textX - 12) / 4.8))}</text>${stacked ? `<text class="map-stack-count" x="${width - 12}" y="19" text-anchor="end">+${node.members.length - 1}</text>` : isGroup ? `<path class="map-disclosure" d="${node.expanded ? `M${width - 24} 21l4 4 4-4` : `M${width - 22} 19l4 4-4 4`}"/>` : ''}</g>`;
  };
  const edges = graph.edges.map(edge => {
    const from = positions.get(edge.from), to = positions.get(edge.to);
    const x = from.x + from.width, end = to.x + to.inset;
    const middle = (x + end) / 2;
    return `<path class="map-edge route-thread" style="--route-color:${ROUTES[edge.kind].color}" data-nodes="${escape(JSON.stringify([...edge.related]))}" data-map-segment="${edge.segment}" data-request-count="${edge.count}" d="M${x} ${from.y}C${middle} ${from.y} ${middle} ${to.y} ${end} ${to.y}"><title>${integer(edge.count)} requests</title></path>`;
  }).join('');
  const body = candidates.length ? `<div class="map-scroll complete-map-scroll" data-ui-key="environment-map-scroll" tabindex="0" role="region" aria-label="Complete environment map. Scroll to explore expanded groups."><svg class="environment-map deployment-map complete-map" style="--map-height:${height}px" viewBox="0 0 900 ${height}" aria-label="All ${quantity(graph.workloadCount, 'workload')}, ${quantity(graph.connectionCount, 'entry connection')}, and ${quantity(graph.modelCount, 'model')} in this scope"><g class="map-column-labels" aria-hidden="true"><text x="14" y="17">AGENTS / WORKLOADS</text><text x="310" y="17">ENTRY CONNECTION</text><text x="642" y="17">MODELS</text></g>${edges}${graph.columns.map(nodes => nodes.map(renderNode).join('')).join('')}</svg></div>` : '<div class="map-empty"><h3>Your environment will take shape here.</h3><p>Connect existing activity metadata to see workloads, connections, and models.</p><button class="text-button" data-page="sources">Connect a source →</button></div>';
  return `<section class="panel environment-panel"><div class="panel-head"><div><h2>Environment map</h2><p>${quantity(graph.workloadCount, 'workload')} · ${quantity(graph.connectionCount, 'connection')} · ${quantity(graph.modelCount, 'model')}</p></div>${!expanded ? '<button class="panel-action" data-service-view="map" aria-label="Explore environment">↗</button>' : ''}</div><div class="environment-toolbar"><label for="map-agent">Focus${selectControl({ id: 'map-agent', label: 'Focus environment on an agent', value: mapAgent, options: [{ value: '', label: 'All agents & workloads' }, ...agents.map(agent => ({ value: agent.id, label: agent.name }))] })}</label><div class="map-controls">${graph.groups.length ? `<button class="text-button" data-map-expand="${allExpanded ? 'collapse' : 'expand'}">${allExpanded ? 'Collapse all' : 'Expand all'}</button>` : ''}<button class="text-button" data-inspect="deployment-list" data-key="all">Deployments ↗</button></div></div>${body}<div class="map-foot">${routeLegend()}<span>${requestCountKnown(state.data) ? `All ${quantity(graph.requestCount, 'request')} represented · ${rangeLabel(state.hours)}` : 'Request coverage unavailable'}</span></div>${candidates.length ? `<div class="map-coverage">${graph.groups.length ? 'Select a stack to reveal its agents or models.' : 'Select a workload, connection, or model to inspect its recorded details.'}</div>` : ''}</section>`;
}
function toggleMapGroup(element) {
  const key = element.dataset.mapGroup, top = element.getBoundingClientRect().top;
  mapGroupExpansion.set(key, !(mapGroupExpansion.get(key) ?? mapExpandAll));
  render();
  const target = [...document.querySelectorAll('[data-map-group]')].find(node => node.dataset.mapGroup === key);
  if (target) {
    const viewport = target.closest('.map-scroll');
    viewport.scrollTop += target.getBoundingClientRect().top - top;
    target.focus({ preventScroll: true });
  }
}
function poolStatus(pool) { return capacityState(pool, state.data.interval, Date.now()); }
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
  return deployments.length ? `<div class="deployment-list">${deployments.map(deployment => { const count = countRequests(items.filter(item => deploymentFor(item, state.data)?.id === deployment.id)); return `<button class="deployment-row" data-inspect="deployment" data-key="${escape(deployment.id)}"><span><strong>${modelLabel(deployment)}</strong><small>${escape(deployment.name)} · ${escape(deployment.location)}</small></span><span>${integer(count)}<small>requests ↗</small></span></button>`; }).join('')}</div>` : '<p class="detail-note">No identified deployments in this selection. Supply a deployment ID that matches the declared model and provider.</p>';
}
function dependencyDetails(items) {
  const pools = environment().pools.filter(pool => environment().usage.get(pool.id).items.some(item => items.includes(item)));
  const identified = countRequests(items.filter(item => deploymentFor(item, state.data)));
  const paths = [...new Map(items.map(item => { const path = reportedPath(item, state.data); return [JSON.stringify(path), path]; })).entries()];
  pools.sort((a, b) => (poolStatus(b) === 'sampled' ? poolSummary(b)?.ratio ?? -1 : -2) - (poolStatus(a) === 'sampled' ? poolSummary(a)?.ratio ?? -1 : -2));
  const tabs = `<div class="inspector-tabs" role="group" aria-label="Explore agent environment">${[['deployments', 'Deployments'], ['paths', 'Paths'], ['capacity', 'Capacity']].map(([id, name]) => `<button data-inspector-tab="${id}" aria-pressed="${inspectorTab === id}">${name}</button>`).join('')}</div>`;
  if (inspectorTab === 'paths') return `${tabs}<div class="detail-section-title"><h3>Execution paths</h3><span>${paths.length} reported</span></div><div class="path-list">${paths.map(([key, path]) => `<button class="path-row" data-inspect="path" data-key="${escape(key)}">${path.map(hop => `<span class="path-hop" style="--route-color:${ROUTES[hop.kind].color}">${routeIcon(hop.kind)}${serviceLabel(hop.name, 14)}</span>`).join('<span class="path-arrow" aria-hidden="true">→</span>')}</button>`).join('')}</div>`;
  if (inspectorTab === 'capacity') return `${tabs}<div class="detail-section-title"><h3>Shared limits & pressure</h3><span>${pools.length} pools</span></div>${pools.length ? pools.map(capacityRow).join('') : '<p class="detail-note">No shared pools are linked by the available metadata.</p>'}<p class="detail-note">Pool readings include all consumers. Shared use does not establish which agent caused pressure.</p>`;
  return `${tabs}<div class="detail-section-title"><h3>Model deployments</h3><span>${integer(identified)} / ${integer(countRequests(items))} requests identified</span></div>${deploymentList(items)}`;
}
function modelTable(overview = false) {
  let models = state.data.models.filter(model => (state.filter === 'all' || model.location === state.filter || state.filter === 'local' && model.location === 'private') && `${model.name} ${model.provider} ${model.modelCreator ?? ""}`.toLowerCase().includes(state.search.toLowerCase()));
  if (overview) models = state.data.models.slice(0, 12);
  if (!models.length) return `<div class="empty-small">${state.search || state.filter !== 'all' ? 'No models match this view. Try another filter.' : 'No models identified for this project. Connect its request logs or declare a model or runtime endpoint to bring them into view.'}</div>`;
  return `<div class="table-wrap"><table class="data-table model-table"><thead><tr><th scope="col">Model / service</th><th class="state-column" scope="col">State</th><th scope="col">Requests</th><th class="trend-column" scope="col">Activity</th><th class="latency-column" scope="col">Median latency</th><th scope="col">Spend</th></tr></thead><tbody>${models.map(model => {
    const items = records().filter(item => item.model === model.name && item.provider === model.provider), metrics = stats(items);
    const hasSource = requestCountKnown(state.data);
    return `<tr><td><button class="model-name" data-inspect="model" data-key="${escape(model.id)}">${identityIcon(modelIdentity(model))}<span><strong>${escape(model.name)}</strong><small>${model.state === 'declared' ? `Declared · ${model.provider === 'Unattributed' ? 'service not established' : escape(model.provider)}` : `Served by ${hostingLabel(model)} · ${escape(model.location)}`}</small></span></button><div class="model-routes">${routeBadges(items)}</div></td><td class="state-column">${stateBadge(model.state)}</td><td>${morphText(`model-requests-${model.id}`, items.length ? integer(countRequests(items)) : hasSource ? '0' : '—')}</td><td class="trend-column">${spark(buckets(items, 18).map(bin => bin.cloud + bin.local + bin.unknown), { className: 'table-spark', color: routeKinds(items).length === 1 ? ROUTES[routeKinds(items)[0]].color : 'var(--chart)' })}</td><td class="latency-column">${morphText(`model-latency-${model.id}`, duration(metrics.latency))}</td><td>${morphText(`model-cost-${model.id}`, money(metrics.cost))}${metrics.estimated ? '<span title="Includes estimated cost">*</span>' : ''}</td></tr>`;
  }).join('')}</tbody></table></div><p class="table-foot">${overview ? `Showing ${models.length} of ${state.data.models.length} models. Configured, loaded, or observed.` : 'Usage is limited to connected sources and the selected window. A dash means the measurement is unavailable.'}</p>`;
}
function recentActivity() {
  const items = [...records()].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)).slice(0, 10);
  return `<section><div class="section-title"><h2>Recent activity</h2><span class="quiet" style="font-size:10px">${state.data.mode === 'sample' ? 'Sample' : 'Observed'}</span></div>${items.length ? `<ul class="activity-list">${items.map(item => `<li class="activity-item"><span class="activity-mark route-mark" style="--route-color:${ROUTES[routeKind(item, state.data)].color}" aria-hidden="true"></span><div class="activity-item-content"><strong>${escape(item.workload)}</strong><p>${modelLabel(item, 13)}${item.status === 'failed' ? ' · failed' : item.status === 'running' ? ' · running' : ''}</p><div class="recent-route">${routeBadge(routeKind(item, state.data))}<span>${serviceLabel(item.route, 12)}</span></div></div><time datetime="${item.occurredAt}">${relativeTime(item.occurredAt)}</time></li>`).join('')}</ul><button class="text-button activity-link" data-page="activity">View activity <span>→</span></button>` : `<p class="empty-small">${requestCountKnown(state.data) ? 'No requests recorded in this window.' : 'Request activity is unknown. Connect a request source to see it here.'}</p>`}</section>`;
}
function footer() { const sources = state.data.sources.filter(source => ['connected', 'partial'].includes(source.state)); return `<footer class="footer"><div class="source-strip"><button class="text-button" data-page="sources"><i class="status-dot"></i>${sources.length} ${sources.length === 1 ? 'source' : 'sources'} connected</button><span>${state.data.mode === 'sample' ? 'Fictional environment · no real inference' : 'Local view · passive collection'}</span></div><span class="footer-end">OPENMERIT / INFERENCE TERMINAL</span></footer>`; }
function activityChart() {
  const items = records();
  if (!requestCountKnown(state.data)) return '<div class="map-empty"><h3>Request activity is unknown.</h3><p>No readable request source is connected. Configuration and task summaries do not establish request volume.</p><button class="text-button" data-page="sources">View sources →</button></div>';
  if (!items.length) return '<div class="map-empty"><h3>No activity in this window.</h3><p>Choose a longer window or connect an activity source.</p></div>';
  const bins = buckets(items, 60), counts = routeBreakdown(items, state.data);
  const values = bins.map(bin => activityPath === 'all' ? Object.values(bin.paths).reduce((a, b) => a + b, 0) : bin.paths[activityPath]);
  const max = Math.max(1, ...values), color = activityPath === 'all' ? 'var(--chart)' : ROUTES[activityPath].color;
  const bars = bins.map((bin, i) => {
    let accumulated = 0;
    const segments = Object.entries(ROUTES).filter(([kind]) => activityPath === 'all' || activityPath === kind).map(([kind, route]) => {
      const value = bin.paths[kind];
      accumulated += value;
      return value ? `<rect class="volume-bar" data-path="${kind}" x="${i * 16 + 3}" y="${124 - accumulated / max * 116}" width="10" height="${value / max * 116}" fill="${route.color}"/>` : '';
    }).join('');
    const detail = Object.entries(ROUTES).filter(([kind]) => bin.paths[kind] && (activityPath === 'all' || activityPath === kind)).map(([kind, route]) => `${bin.paths[kind]} ${route.label}`).join(', ');
    return `<g>${segments}<rect class="chart-hit" x="${i * 16}" y="0" width="16" height="128" data-bin="${i}" tabindex="${i === 0 ? '0' : '-1'}" role="img" aria-label="${chartTime(bin.at, true)}: ${values[i]} requests${detail ? `. ${detail}` : ''}. Use left and right arrows to inspect."/></g>`;
  }).join('');
  const choices = [['all', { label: 'All paths', color: 'var(--chart)' }], ...Object.entries(ROUTES)];
  return `<div class="volume-chart activity-chart" style="--chart-color:${color}"><div class="volume-scale" aria-hidden="true"><span>${integer(max)}</span><span>${integer(Math.round(max / 2))}</span><span>0</span></div><div class="volume-plot"><svg viewBox="0 0 960 128" preserveAspectRatio="none" aria-label="${escape(activityPath === 'all' ? 'All paths' : ROUTES[activityPath].label)} requests per ${chartInterval()} interval">${[8, 66, 124].map(y => `<line class="chart-grid" x1="0" x2="960" y1="${y}" y2="${y}" vector-effect="non-scaling-stroke"/>`).join('')}${bars}</svg><div class="volume-times" aria-hidden="true">${[0, 15, 30, 45, 59].map(i => `<span>${chartTime(i === 59 ? windowBounds().end : bins[i].at)}</span>`).join('')}</div></div><div class="chart-tooltip" hidden></div></div><div class="volume-paths" role="group" aria-label="Chart path">${choices.map(([kind, route]) => `<button data-activity-path="${kind}" aria-pressed="${activityPath === kind}" style="--route-color:${route.color}"><span>${kind === 'all' ? '<span class="all-paths-mark" aria-hidden="true">≋</span>' : routeIcon(kind)}${route.label}</span><strong>${integer(kind === 'all' ? countRequests(items) : counts[kind])}</strong></button>`).join('')}</div><p class="chart-caption">${chartInterval()} intervals · select a path to isolate its volume</p>`;
}

function overviewPage() { return `${heading('Your inference environment.', scopeSummary())}${summary()}${pathSummary()}<div class="overview-top">${environmentMap()}${capacityPanel()}</div><div class="lower-grid"><section><div class="section-title"><h2>Model inventory <span class="badge-count">${state.data.models.length}</span></h2><button class="text-button" data-page="models">All models <span>→</span></button></div>${modelTable(true)}</section>${recentActivity()}</div>`; }
function modelsPage() { return `${heading('Model inventory', 'Declarations, runtime inventory, and recorded model use.')}${pathSummary()}<div class="filter-bar"><div class="filter-tabs" role="group" aria-label="Filter models by location">${['all', 'local', 'cloud'].map(filter => `<button data-filter="${filter}" aria-pressed="${state.filter === filter}">${({ all: 'All models', local: 'Self-hosted', cloud: 'Cloud' })[filter]}</button>`).join('')}</div><input class="filter-input" id="model-search" type="search" aria-label="Search models" placeholder="Find a model…" value="${escape(state.search)}"></div><div id="model-results">${modelTable()}</div>`; }
function serviceTypes(service) { return service.types.map(type => { const role = SERVICE_TYPES[type], route = ROUTES[role.path]; return `<span class="route-badge" style="--route-color:${route.color}">${routeIcon(role.path)}${role.label}</span>`; }).join(''); }
function serviceEvidenceLabel(service) {
  const kinds = [];
  if (service.reported) kinds.push('Activity');
  if (service.evidence.some(item => item.sourceId === 'repository')) kinds.push('Code & config');
  if (service.evidence.some(item => item.sourceId === 'environment')) kinds.push('Environment');
  if (service.evidence.some(item => item.sourceId === 'inventory' || item.sourceId?.startsWith('project:'))) kinds.push('Configuration');
  if (!kinds.length && service.evidence.length) kinds.push('Inventory source');
  return kinds.join(' · ') || 'Not reported';
}
function servicesPage() {
  const all = services(), active = all.filter(service => service.records.length);
  const controls = `<div class="service-view-bar"><div class="segmented" role="group" aria-label="Services view">${[['inventory', 'Inventory'], ['map', 'Environment map']].map(([value, label]) => `<button data-ui-key="services-view-${value}" data-service-view="${value}" aria-pressed="${serviceView === value}">${label}</button>`).join('')}</div><span class="quiet">${integer(all.length)} services · ${integer(active.length)} with activity</span></div>`;
  const header = heading('Services', 'Services declared by this project or identified in its recorded data.');
  if (serviceView === 'map') return `${header}${controls}${environmentMap(true)}<div class="environment-detail-grid"><section><div class="section-title"><h2>Model deployments</h2><span class="quiet">Declared deployments and endpoint catalogs</span></div>${deploymentList(mapAgent ? records().filter(item => item.agentId === mapAgent) : records(), !mapAgent)}</section>${capacityPanel(true)}</div>`;
  const matching = all.filter(service => (serviceFilter === 'all' || service.types.includes(serviceFilter)) && [service.name, ...service.aliases, ...service.endpoints, ...service.models.map(model => model.name)].join(' ').toLowerCase().includes(serviceSearch.toLowerCase()));
  const filters = `<div class="service-filter-bar"><div class="filter-tabs" role="group" aria-label="Filter services by type">${[['all', 'All services'], ...Object.entries(SERVICE_TYPES).map(([type, role]) => [type, role.plural])].map(([type, label]) => `<button data-ui-key="service-filter-${type}" data-service-filter="${type}" aria-pressed="${serviceFilter === type}">${label}<span>${type === 'all' ? all.length : all.filter(service => service.types.includes(type)).length}</span></button>`).join('')}</div><input class="filter-input" id="service-search" type="search" aria-label="Search services" placeholder="Find a service or model…" value="${escape(serviceSearch)}"></div>`;
  const table = matching.length ? `<div class="table-wrap"><table class="data-table service-table"><thead><tr><th scope="col">Service</th><th scope="col">Type</th><th scope="col">Models</th><th scope="col">Requests</th><th scope="col">Last activity</th><th scope="col">Capacity</th><th scope="col">Evidence</th></tr></thead><tbody>${matching.map(service => {
    const pools = service.pools, recent = pools.filter(pool => poolStatus(pool) === 'sampled'), reading = recent.map(poolSummary).find(Boolean);
    const endpoint = service.endpoints.join(' · '), location = service.locations.map(value => ({ local: 'Local', private: 'Private', cloud: 'Cloud' })[value] || value).join(' / ');
    return `<tr data-ui-key="service-row-${escape(service.id)}"><td><button class="model-name" data-inspect="service" data-key="${escape(service.id)}">${identityIcon(serviceIdentity(service.name), 19)}<span><strong>${escape(service.name)}</strong><small>${escape([location, endpoint].filter(Boolean).join(' · ') || 'Location not reported')}</small></span></button></td><td><div class="service-types">${serviceTypes(service)}</div></td><td>${integer(service.models.length)}</td><td>${service.records.length ? morphText(`service-requests-${service.id}`, integer(countRequests(service.records))) : '—'}</td><td>${service.lastAt ? `<time datetime="${escape(service.lastAt)}" title="${escape(new Date(service.lastAt).toLocaleString())}">${relativeTime(service.lastAt)}</time>` : 'Not recorded'}</td><td class="service-capacity">${reading ? `<span>${readingValue(reading)}</span><small>${escape(reading.label)}</small>` : `<span>${pools.length ? 'No recent reading' : 'Not reported'}</span>`}</td><td class="service-evidence"><span>${escape(serviceEvidenceLabel(service))}</span><small>${service.records.length ? 'Recorded in this window' : service.reported ? 'Outside this window' : service.configured ? 'Configured only' : service.declared ? 'Declared only' : 'Inventory only'}</small></td></tr>`;
  }).join('')}</tbody></table></div>` : `<div class="empty-small"><strong>${all.length ? 'No services match this view.' : 'No services identified yet.'}</strong><p>${all.length ? 'Try another type or search term.' : 'Services appear from configuration, runtime inventory, and recorded activity.'}</p>${all.length ? '<button class="text-button" data-service-reset>Clear filters →</button>' : '<button class="text-button" data-page="sources">View sources →</button>'}</div>`;
  return `${header}${controls}${filters}${table}<p class="table-foot">Requests cover the selected window. A request can touch several services; row counts are not additive. Models include inventory and recorded paths. Configuration does not establish connectivity.</p>`;
}
function inspectService(key) {
  const service = services().find(item => item.id === key);
  if (!service) { openInspector('Service no longer in view', 'No matching identity in the latest snapshot.', '<p class="detail-note">Its configuration or recorded metadata may have changed.</p>', 'Service'); return; }
  const metrics = stats(service.records);
  const models = service.models.map(model => state.data.models.find(item => item.provider === model.provider && item.name === model.name) ?? model);
  const facts = [['Evidence', serviceEvidenceLabel(service)], ['Activity', service.records.length ? `${rangeDescription(state.hours)}` : service.reported ? 'Recorded outside this window' : 'No requests recorded'], ['Last recorded activity', service.lastAt ? new Date(service.lastAt).toLocaleString() : 'Not reported'], ['Location', service.locations.join(' · ') || 'Not reported'], ['Endpoint identity', service.endpoints.join(' · ') || 'Not reported'], ['Reported names', service.aliases.join(' · ')], ['Type basis', service.typeEvidence.join(' · ')]];
  const modelList = models.length ? `<div class="service-model-list">${models.map(model => `<button class="service-model-row" data-inspect="model" data-key="${escape(model.id)}" ${state.data.models.some(item => item.id === model.id) ? '' : 'disabled'}><span>${modelLabel(model, 16)}<small>${model.state === 'declared' ? 'Declared service' : 'Served by'} ${hostingLabel(model)}</small></span><span aria-hidden="true">↗</span></button>`).join('')}</div>` : '<p class="detail-note">No model inventory or recorded model use is available for this service.</p>';
  const deployments = service.deployments.length ? `<div class="deployment-list">${service.deployments.map(deployment => `<button class="deployment-row" data-inspect="deployment" data-key="${escape(deployment.id)}"><span><strong>${modelLabel(deployment)}</strong><small>${escape(deployment.name)} · ${escape(deployment.location)}</small></span><span aria-hidden="true">↗</span></button>`).join('')}</div>` : '<p class="detail-note">No matching deployments are identified.</p>';
  const paths = service.paths.length ? `<div class="path-list">${service.paths.sort((a, b) => b.count - a.count).slice(0, 12).map(({ path, count }) => `<button class="path-row" data-inspect="path" data-key="${escape(JSON.stringify(path))}">${path.map(hop => `<span class="path-hop" style="--route-color:${ROUTES[hop.kind].color}">${routeIcon(hop.kind)}${serviceLabel(hop.name, 14)}</span>`).join('<span class="path-arrow" aria-hidden="true">→</span>')}<span class="path-count">${integer(count)} requests</span></button>`).join('')}</div>${service.paths.length > 12 ? `<p class="detail-note">Showing the 12 most used of ${service.paths.length} reported paths.</p>` : ''}` : '<p class="detail-note">No execution paths are reported in this window.</p>';
  const evidence = `<details class="identity-evidence" open><summary>Where this identity comes from</summary><div class="service-evidence-list">${service.evidence.map(item => `<div><strong>${escape(item.field)}</strong><span>${escape(item.detail)}</span>${item.referenceId ? `<button class="text-button" data-inspect="reference" data-key="${escape(item.referenceId)}">${escape(item.file)}:${item.line} ↗</button>` : ''}${state.data.sources.some(source => source.id === item.sourceId) ? `<button class="text-button" data-inspect="source" data-key="${escape(item.sourceId)}">${escape(state.data.sources.find(source => source.id === item.sourceId)?.name || item.sourceId)} ↗</button>` : `<small>${escape(sourceName(item.sourceId))}</small>`}</div>`).join('')}</div></details>`;
  openInspector(service.name, service.types.map(type => SERVICE_TYPES[type].label).join(' · '), `<div class="agent-metrics">${[['Requests', service.records.length ? integer(countRequests(service.records)) : '—'], ['Models', integer(service.models.length)], ['Median latency', duration(metrics.latency)], ['Request spend', money(metrics.cost)]].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join('')}</div>${detailList(facts)}<p class="detail-note">Usage describes recorded requests touching this service. Spend and latency are whole-request measurements, not this service’s bill or added latency. ${service.records.length ? `USD cost is supplied for ${integer(metrics.costCount)} of ${integer(countRequests(service.records))} requests${metrics.estimated ? ' and includes estimates' : ''}${metrics.unknownCostKind ? '; some cost bases were not reported' : ''}.` : 'No usage measurements are available in this window.'}</p><div class="detail-section-title"><h3>Models</h3><span>${models.length}</span></div>${modelList}<div class="detail-section-title"><h3>Linked deployments</h3><span>${service.deployments.length}</span></div>${deployments}<div class="detail-section-title"><h3>Reported paths</h3><span>${service.paths.length}</span></div>${paths}<div class="detail-section-title"><h3>Shared limits & capacity</h3><span>${service.pools.length} ${service.pools.length === 1 ? 'pool' : 'pools'}</span></div>${service.pools.length ? service.pools.map(capacityRow).join('') : '<p class="detail-note">No capacity pools are explicitly linked to this service.</p>'}${evidence}<p class="detail-note">${state.data.mode === 'sample' ? 'All identities and configuration evidence here are fictional. ' : ''}Configuration, inventory, and recorded usage do not establish current reachability or available capacity. Endpoint identities exclude credentials, resource paths, and queries. Code declarations may retain a structural API path.</p>`, 'Service', { title: serviceIdentity(service.name) });
}
function activityPage() {
  const evidence = activityEvidence(state.data, records());
  const failureLabel = evidence.failures == null ? evidence.unknownStatuses ? `${evidence.reportedFailures} reported failed · ${evidence.unknownStatuses} ${evidence.unknownStatuses === 1 ? 'status' : 'statuses'} unknown` : 'Failures unknown' : `${evidence.failures} failed`;
  const items = [...records()].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  return `${heading('Inference activity', 'Usage across your applications, agents, and evaluations.')}<section class="panel activity-panel"><div class="panel-head"><div><h2>Request volume</h2><p>${evidence.known ? `${integer(countRequests(items))} recorded requests in this window` : 'Request count unavailable'}</p></div><span class="panel-meta">${failureLabel}</span></div>${activityChart()}</section><div class="section-title"><h2>Recorded activity</h2><span class="quiet" style="font-size:10px">${!evidence.known ? 'No request coverage' : items.length > 100 ? 'Most recent 100 requests' : `${items.length} requests`}</span></div>${items.length ? `<div class="table-wrap"><table class="data-table activity-table"><thead><tr><th>Workload / task</th><th>Request path</th><th>Scope</th><th>Time</th><th>Duration</th><th>Tokens in / out</th><th>Spend</th><th>Status</th></tr></thead><tbody>${items.slice(0, 100).map(item => `<tr><td><button class="model-name" data-inspect="record" data-key="${escape(item.id)}"><span><strong>${escape(item.task || item.taskId || item.workload)}</strong><small>${item.task || item.taskId ? `${escape(item.agent || item.agentId || item.workload)} · ` : ''}${modelLabel(item, 14)}</small></span></button></td><td class="activity-route">${routeBadge(routeKind(item, state.data))}<small>${serviceLabel(item.route, 12)}</small></td><td>${escape(item.scope)}</td><td>${chartTime(item.occurredAt, true)}</td><td>${duration(item.durationMs)}</td><td>${compact(item.inputTokens)} / ${compact(item.outputTokens)}</td><td>${item.currency === 'USD' ? money(item.cost) : '—'}${item.cost != null && item.currency === 'USD' ? item.costKind === 'estimated' ? '*' : item.costKind !== 'reported' ? '<span title="Cost basis not reported">?</span>' : '' : ''}</td><td>${stateBadge(item.status)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty-small">Activity appears when a connected source records it.</p>'}<p class="table-foot">Metadata only. No prompts or responses. An asterisk marks estimated cost; a question mark means its basis was not reported. Amounts without an explicit USD currency are excluded from dollar totals.</p>`;
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
  if (!host) return `${heading('Local compute', 'No local compute is linked to this project.', false)}<p class="detail-note">Host links must be supplied by this project. A localhost endpoint may be a proxy or tunnel; it does not identify the machine serving its models. Hardware exports and explicit runtime host IDs establish those links.</p><button class="text-button" data-page="sources">View sources →</button>`;
  selectedHost = host.id;
  const fresh = hosts.filter(host => hardwareStatus(host) === 'sampled');
  const groups = new Map();
  for (const entry of visible) { const group = [entry.site || (reportedSites.length ? 'Site not supplied' : ''), entry.rack].filter(Boolean).join(' / '); if (!groups.has(group)) groups.set(group, []); groups.get(group).push(entry); }
  const loaded = host.loadedModels ?? [], status = hardwareStatus(host);
  const rows = [...groups].map(([group, entries]) => `<tbody aria-label="${escape(group)}">${group ? `<tr class="host-group"><th colspan="7" scope="rowgroup">${escape(group)}<span>${entries.length} ${entries.length === 1 ? 'host' : 'hosts'}</span></th></tr>` : ''}${entries.map(entry => `<tr class="host-row ${entry.id === host.id ? 'selected' : ''}"><td><button class="host-name" data-host="${escape(entry.id)}" aria-pressed="${entry.id === host.id}">${escape(entry.name)}${entry.id === 'this-machine' ? '<small>This machine</small>' : ''}</button></td><td>${escape(entry.chip || 'Not reported')}</td><td>${entry.cpuPercent == null ? '—' : `${entry.cpuPercent.toFixed(1)}%`}</td><td>${bytes(entry.memoryUsed)}<span class="quiet"> / ${bytes(entry.memoryTotal)}</span></td><td>${entry.accelerators?.length ? [...new Set(entry.accelerators.map(item => item.name))].map(name => `${entry.accelerators.filter(item => item.name === name).length} × ${escape(name)}`).join(' · ') : 'Not reported'}</td><td>${entry.observedAt && entry.residencyReported !== false ? entry.loadedModels?.length ?? 0 : '—'}</td><td>${hardwareBadge(entry)}</td></tr>`).join('')}</tbody>`).join('');
  return `${heading('Local compute', 'This machine and self-hosted servers from your exports.', false)}<div class="fleet-summary"><div><strong>${hosts.length}</strong><span>${hosts.length === 1 ? 'host' : 'hosts'} in view</span></div><div><strong>${hosts.reduce((total, item) => total + (item.accelerators?.length ?? 0), 0)}</strong><span>accelerators listed</span></div><div><strong>${fresh.length} <span>/ ${hosts.length}</span></strong><span>hosts with recent readings</span></div><p>Passively sampled · every ${state.data.interval}s<br>${reportedSites.length} reported sites · ${new Set(hosts.filter(item => item.rack).map(item => `${item.site}/${item.rack}`)).size} racks</p></div><div class="section-title host-inventory-heading"><div><h2>Host inventory</h2><p>Select a host to inspect its resources.</p></div>${locations.length ? selectControl({ id: 'host-location', label: 'Filter hosts by reported site', value: hostLocation, options: [{ value: '', label: 'All reported sites' }, ...locations.map(site => ({ value: site, label: site }))] }) : ''}</div><div class="table-wrap"><table class="data-table host-table"><thead><tr><th scope="col">Host</th><th scope="col">Processor</th><th scope="col">CPU</th><th scope="col">System RAM</th><th scope="col">Accelerators</th><th scope="col">Loaded</th><th scope="col">Reading</th></tr></thead>${rows}</table></div><section class="host-detail" aria-label="Selected host"><div class="section-title"><div><h2>${escape(host.name)}</h2><p>${escape([host.site, host.rack].filter(Boolean).join(' / '))}${host.site || host.rack ? ' · ' : ''}${host.observedAt ? `Last sample ${relativeTime(host.observedAt)}` : 'No measurement received'}</p></div>${hardwareBadge(host)}</div><div class="host-detail-grid"><section class="panel host-history"><div class="panel-head"><h2>Resource history</h2><span class="panel-meta">${status === 'stale' ? 'Last reported readings' : 'Whole host'}</span></div><div class="history-chart"><div data-chart="machine-history" data-host-id="${escape(host.id)}" data-ui-key="history-${escape(host.id)}"></div><p>CPU and system RAM. Host usage is not attributed to inference.</p></div></section><section class="panel host-hardware"><div class="panel-head"><h2>Hardware</h2></div><dl class="host-facts"><div><dt>Name source</dt><dd>${host.id === 'this-machine' ? (state.data.mode === 'sample' ? 'Sample · hostname' : 'Operating system · hostname') : `${escape(sourceName(host.sourceId))} · ${escape(host.nameField || 'name / id')}`}</dd></div><div><dt>Site / rack</dt><dd>${escape([host.site, host.rack].filter(Boolean).join(' / ') || 'Not supplied')}</dd></div><div><dt>Processor</dt><dd>${escape(host.chip || 'Not reported')}</dd></div><div><dt>Cores / architecture</dt><dd>${host.cores ?? '—'} / ${escape(host.arch || '—')}</dd></div><div><dt>System RAM</dt><dd>${bytes(host.memoryUsed)} / ${bytes(host.memoryTotal)}</dd></div><div><dt>Platform</dt><dd>${escape(({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' })[host.platform] ?? (host.platform || 'Not reported'))}</dd></div></dl><div class="accelerator-list">${(host.accelerators ?? []).map(device => `<div class="accelerator"><div><strong>${escape(device.name)}</strong><span>${escape([device.id, device.kind && device.kind !== 'unknown' ? device.kind.toUpperCase() : null].filter(Boolean).join(' · '))}</span></div>${device.vendor ? `<p><span>Vendor</span><strong>${escape(device.vendor)}</strong></p>` : ''}<p><span>Device memory</span><strong>${bytes(device.memoryUsed)} / ${bytes(device.memoryTotal)}</strong></p><p><span>Utilization</span><strong>${device.utilization == null ? '—' : `${device.utilization.toFixed(1)}%`}</strong></p></div>`).join('') || '<p class="empty-small">Accelerator readings not supplied.</p>'}</div></section></div><div class="section-title"><h2>${status === 'stale' ? 'Last reported models' : 'Loaded models'} <span class="badge-count">${host.residencyReported === false ? '—' : loaded.length}</span></h2><span class="quiet">${escape(host.name)}</span></div><div class="loaded-models">${loaded.map(model => { const inventory = state.data.models.find(item => item.name === model.name && item.provider === model.provider); return `<article class="loaded-model"><div>${inventory ? `<button class="model-name" data-inspect="model" data-key="${escape(inventory.id)}">${identityIcon(modelIdentity(model))}<strong>${escape(model.name)}</strong></button>` : `<strong>${modelLabel(model)}</strong>`}<p>${serviceLabel(model.runtime || model.provider || 'Runtime unspecified')}</p></div><div><strong>${bytes(model.memoryBytes)}</strong><p>${({ accelerator: 'Accelerator allocation', system: 'System RAM allocation', unified: 'Unified memory allocation' })[model.memoryKind] ?? 'Allocation type unspecified'}</p></div></article>`; }).join('') || `<p class="empty-small">${status === 'unknown' || host.residencyReported === false ? 'Model residency has not been reported.' : 'No loaded models in this host’s latest report.'}</p>`}</div><p class="table-foot">Loaded means resident; it does not imply an active request. Allocations are source-reported. Device and system memory can overlap on unified-memory hardware.</p>${runtimeCounters(host.id)}</section><p class="table-foot">Additional hosts come from your hardware export. Collection stays passive; the terminal does not discover machines or manage workloads.</p>`;
}
function runtimeCounters(hostId) {
  const runtimes = (state.data.runtimeStats ?? []).filter(runtime => runtime.hostId === hostId);
  if (!runtimes.length) return '';
  return `<div class="section-title"><h2>Runtime counters</h2></div><div class="inventory-grid">${runtimes.map(runtime => `<article class="inventory-card"><h3>${serviceLabel(runtime.name, 18)}</h3>${detailList([['Running / waiting', `${compact(runtime.running)} / ${compact(runtime.waiting)}`], ['Input / output tokens', `${compact(runtime.inputTokens)} / ${compact(runtime.outputTokens)}`], ['Finished requests', compact(runtime.finished)]])}<p>Lifetime counters since the runtime reset. Separate from the activity window.</p></article>`).join('')}</div>`;
}
const referenceContexts = { application: 'Declaration', candidate: 'Candidate', benchmark: 'Benchmark', example: 'Example', test: 'Test', fallback: 'Fallback', alias: 'Model alias', unlinked: 'Unlinked reference' };
const indexIssueLabels = { 'non-inference-endpoint': 'Hub URL does not identify an inference service', 'syntax-error': 'Could not parse this file', 'unresolved-expression': 'Computed or ambiguous value', 'unresolved-environment': 'Environment value not found in project files', 'ambiguous-environment': 'Multiple environment declarations disagree', 'unresolved-alias': 'YAML alias was not expanded', 'placeholder-endpoint': 'Placeholder endpoint excluded', 'unsupported-endpoint': 'Endpoint could not be safely indexed', 'unsupported-value': 'Value is not a supported identifier', 'model-pattern': 'Model pattern, not a concrete model', 'changed-during-read': 'File changed while being read; retried next pass', 'scan-limit': 'Scan reached its configured bounds', 'oversized-file': 'File exceeds the read limit', 'unreadable-file': 'File could not be read', 'unreadable-directory': 'Directory could not be read', 'binary-file': 'Binary content skipped', 'syntax-budget': 'Syntax complexity limit reached' };
function referenceEvidence(ids = [], title = 'Declaration evidence') {
  const refs = (state.data.repository?.references ?? []).filter(ref => ids.includes(ref.id));
  return refs.length ? `<div class="detail-section-title"><h3>${escape(title)}</h3></div><div class="service-model-list">${refs.map(ref => `<button class="service-model-row" data-inspect="reference" data-key="${escape(ref.id)}"><span>${escape(ref.file)}:${ref.line}<small>${escape(ref.field)} · ${escape(referenceContexts[ref.context] || ref.context)}</small></span><span aria-hidden="true">↗</span></button>`).join('')}</div><p class="detail-note">A declaration is not a request or proof that this model is available.</p>` : '';
}
function indexProgress() {
  const index=state.data.repository,p=index?.progress;
  if(!p||p.phase==='complete')return '';
  const failed=p.phase==='failed';
  const label=failed?'Repository indexing interrupted':p.phase==='discovering'?'Finding project files':p.phase==='resolving'?'Linking declarations':p.phase==='queued'?'Preparing repository index':'Indexing code & configuration';
  const detail=failed?'Showing the last available declarations. Retrying in 60s.':p.total!=null?`${integer(p.processed)} of ${integer(p.total)} files checked${p.reused?` · ${integer(p.reused)} unchanged`:''}`:`${integer(p.discovered)} supported files found`;
  return `<section class="index-progress${failed?' interrupted':''}" aria-label="Repository indexing"><div class="index-progress-copy"><strong role="status">${label}</strong><span>${detail}</span></div>${!failed?`<progress aria-label="Files checked" ${p.total!=null&&p.total>0?`max="${p.total}" value="${p.processed}"`:''}></progress>`:''}<button class="text-button" data-page="sources">Coverage →</button><small>${index.checkedAt?'Available declarations remain usable while the index updates.':'Results appear as files are read. Request collection runs separately.'}</small></section>`;
}
function indexCoverageDetails(showLink = true) {
  const index = state.data.repository; if (!index) return '';
  const summary = index.summary;
  return `${detailList([['Files indexed', integer(summary.filesIndexed ?? summary.filesRead)], ['Files read this pass', integer(summary.filesRead)], ...(index.progress ? [['Index state', ({complete:'Up to date',queued:'Preparing',discovering:'Finding files',indexing:'Reading files',resolving:'Linking declarations',failed:'Interrupted'})[index.progress.phase] || index.progress.phase], ['Files checked', `${integer(index.progress.processed)} / ${index.progress.total==null?'discovering':integer(index.progress.total)}`], ['Parsed this pass', integer(index.progress.parsed)], ['Reused this pass', integer(index.progress.reused)], ['Elapsed', `${(index.progress.elapsedMs / 1000).toFixed(1)}s`]] : []), ['Metadata references', integer(summary.declarations)], ['Read this pass', `${(summary.bytesRead / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB`], ...Object.entries(summary.skipped).map(([key, value]) => [`Skipped · ${key}`, integer(value)])])}${showLink ? `<button class="text-button" data-inspect="index-issues" data-key="all">${integer(summary.unresolved)} coverage notes ↗</button>` : ''}<p class="detail-note">For a report containing only coverage counts, run <code>openmerit dash --diagnostics</code>. It contains no source paths, endpoint names, model names, or credentials.</p>`;
}
function inspectIndexIssues() {
  const index = state.data.repository; if (!index) return;
  openInspector('Index coverage', 'What the static reader could not establish.', `${indexCoverageDetails(false)}<div class="service-evidence-list">${index.issues.map(issue => `<div><strong>${escape(indexIssueLabels[issue.code] || issue.code)}</strong><span>${escape(issue.file || 'Repository')}${issue.file ? `:${issue.line}` : ''}</span>${issue.field ? `<small>${escape(issue.field)}</small>` : ''}</div>`).join('')}</div>${index.summary.unresolved > index.issues.length ? `<p class="detail-note">Showing ${index.issues.length} of ${index.summary.unresolved} notes.</p>` : ''}<p class="detail-note">Static reading cannot resolve imported values, arbitrary expressions, dynamic routes, or runtime environment overrides. Missing declarations do not mean the application uses no inference.</p>`);
}
function inspectReference(key) {
  const index = state.data.repository, ref = index?.references.find(item => item.id === key); if (!ref) return;
  const related = index.references.filter(item => ref.endpointIds?.includes(item.id) || item.endpointIds?.includes(ref.id) || ref.kind === 'task' && item.kind === 'model' && item.file === ref.file && item.task === ref.value);
  openInspector(ref.value, `${ref.kind === 'task' ? 'Call site / task declaration' : ref.kind === 'model' ? 'Model declaration' : 'Endpoint declaration'} · ${referenceContexts[ref.context] || ref.context}`, `${detailList([['Source', `${ref.file}:${ref.line}`], ['Field', ref.field], ['Basis', ref.basis], ...(ref.via ? [['Referenced declaration', `${ref.via.file}:${ref.via.line}`]] : []), ...(ref.task ? [['Enclosing function', ref.task]] : []), ...(ref.endpoint ? [['Service identity', ref.endpoint.service], ['Role', SERVICE_TYPES[ref.endpoint.serviceType]?.label || 'Unclassified'], ['Path detail', ref.endpoint.pathRedacted ? 'Resource path omitted' : 'Structural API path only']] : []), ...(ref.localLibrary ? [['Declaration', 'Local model library; residency unknown']] : [])])}${related.length ? ` ${referenceEvidence(related.map(item => item.id), 'Linked declarations')}` : ''}<p class="detail-note">Found by reading syntax, without executing this project. This is not evidence of a completed task, a running agent, a reachable endpoint, or a loaded model. Runtime overrides and unreported routing remain unknown.</p>`);
}
function repositoryPanel() {
  const index = state.data.repository; if (!index) return '';
  const all = index.references, items = all.filter(ref => (referenceKind === 'all' || ref.kind === referenceKind) && [ref.value, ref.file, ref.field, ref.context].join(' ').toLowerCase().includes(referenceSearch.toLowerCase()));
  const pages = Math.max(1, Math.ceil(items.length / 25)); referencePage = Math.max(0, Math.min(referencePage, pages - 1));
  const shown = items.slice(referencePage * 25, referencePage * 25 + 25);
  return `<section class="repository-index"><div class="section-title"><div><h2>Code & configuration</h2><p class="quiet">${integer(index.summary.filesIndexed ?? index.summary.filesRead)} files indexed · ${integer(all.length)} references · no code executed</p></div><button class="text-button" data-inspect="index-issues" data-key="all">${integer(index.summary.unresolved)} coverage notes ↗</button></div><div class="service-filter-bar"><div class="filter-tabs" role="group" aria-label="Filter code references">${[['all', 'All references'], ['endpoint', 'Endpoints'], ['model', 'Models'], ['task', 'Call sites & tasks']].map(([key, label]) => `<button data-ui-key="reference-kind-${key}" data-reference-kind="${key}" aria-pressed="${referenceKind === key}">${label}<span>${key === 'all' ? all.length : all.filter(ref => ref.kind === key).length}</span></button>`).join('')}</div><input class="filter-input" type="search" id="reference-search" aria-label="Search code references" placeholder="Find a declaration or file…" value="${escape(referenceSearch)}"></div>${shown.length ? `<div class="table-wrap"><table class="data-table reference-table"><thead><tr><th>Declaration</th><th>Context</th><th>Evidence</th></tr></thead><tbody>${shown.map(ref => `<tr data-ui-key="reference-${escape(ref.id)}"><td><button class="model-name" data-inspect="reference" data-key="${escape(ref.id)}"><span><strong>${escape(ref.value)}</strong><small>${ref.kind === 'task' ? 'Call site / task' : ref.kind === 'model' ? 'Model' : 'Endpoint'}</small></span></button></td><td>${escape(referenceContexts[ref.context] || ref.context)}</td><td><button class="text-button reference-file" data-inspect="reference" data-key="${escape(ref.id)}">${escape(ref.file)}:${ref.line} ↗</button></td></tr>`).join('')}</tbody></table></div>` : `<p class="empty-small">${all.length ? 'No declarations match this view.' : index.progress&&index.progress.phase!=='complete'?'The repository index is still incomplete. Declarations will appear here as they are read.':'No supported inference declarations found. Review coverage for skipped or unresolved files.'}</p>`}<div class="reference-pagination"><span class="quiet">${items.length ? `${referencePage * 25 + 1}–${referencePage * 25 + shown.length} of ${items.length}` : '0 references'}</span>${pages > 1 ? `<button class="text-button" data-reference-page="${referencePage - 1}" ${referencePage === 0 ? 'disabled' : ''}>← Previous</button><button class="text-button" data-reference-page="${referencePage + 1}" ${referencePage === pages - 1 ? 'disabled' : ''}>Next →</button>` : ''}</div><p class="table-foot">Declarations are separate from recorded usage. Examples, benchmarks, candidates, fallbacks, aliases and unlinked references are retained here; they do not add to application model or service inventory.</p></section>`;
}

function sourcesPage() {
  const discovery = state.data.discovery, pending = state.data.sources.filter(source => source.state === 'needs_access').length;
  const coverage = discovery ? `<div class="discovery-summary"><div><strong>${discovery.enabled ? 'Automatic discovery' : 'Automatic discovery off'}</strong><span>${discovery.enabled ? 'Code & configuration · saved request logs · linked runtimes' : 'Automatic discovery is disabled for this run.'}</span></div><span>${pending ? `${pending} source${pending === 1 ? ' needs' : 's need'} access` : discovery.enabled ? `Checks every ${discovery.intervalSeconds}s` : 'Read-only collection'}</span></div>` : '';
  return `${heading('Sources & coverage', 'What your environment exposes, and what the terminal can read.', false)}${coverage}${repositoryPanel()}<div class="source-list">${state.data.sources.map(source => `<button class="source-row" data-inspect="source" data-key="${escape(source.id)}"><span><h3>${serviceLabel(source.name, 18)}</h3><p>${escape(source.detail)}</p>${source.coverage ? `<span class="source-coverage">${source.coverage.map(escape).join(' · ')}</span>` : ''}${source.limits?.length ? `<span class="source-coverage">${source.limits.map(item => `${integer(item.omitted)} ${escape(item.collection)} omitted · limit ${integer(item.limit)}`).join('; ')}</span>` : ''}</span><span class="source-kind">${escape(source.kind)}</span>${stateBadge(source.state)}<span class="quiet">↗</span></button>`).join('')}</div><section class="panel instruction-panel"><h2>${state.data.mode === 'sample' ? 'Discovery starts on your machine.' : 'Your existing data, connected.'}</h2><p>Running <code>openmerit dash</code> indexes supported code/configuration and saved request logs. Static declarations remain separate from usage. Usage belongs to this application; coding-harness usage is excluded. Sources show which records contribute to totals and which could not be reconciled.</p><button class="button" data-action="connect">Source details ${icon('arrow')}</button><button class="text-button" data-action="api" style="margin-left:18px">Read from an agent ↗</button></section>`;
}

function main() {
  if(state.data.loading)return `${state.error?`<div class="notice">${escape(state.error)}</div>`:''}<section class="terminal-loading" role="status"><h1>${state.data.loadError?'Waiting for project sources':'Opening your inference terminal.'}</h1><p>${state.data.loadError?'The first collection did not finish. Retrying automatically; your application is unaffected.':'Reading saved activity and configuration. Your application can keep running.'}</p><progress aria-label="Reading project sources"></progress><span>Data appears as it becomes available.</span></section>`;
  const stale = Date.now() - Date.parse(state.data.observedAt) > state.data.interval * 3000;
  const sample = state.data.mode === 'sample';
  const audit = state.data.discovery?.reconciliation;
  const limited = state.data.sources.filter(source => source.limits?.length);
  const inventoryNotice = limited.length ? `<div class="notice" role="status">Inventory is incomplete. ${limited.length} ${limited.length === 1 ? 'source reached a collection limit' : 'sources reached collection limits'}. <button class="text-button" data-page="sources">Review omitted entries →</button></div>` : '';
  const coverageNotice = !sample && (audit?.excluded || audit?.conflicts) ? `<div class="notice" role="status">${audit.excluded ? `${integer(audit.excluded)} records are excluded from totals because source overlap is unresolved. ` : ''}${audit.conflicts ? `${integer(audit.conflicts)} requests have conflicting source records. ` : ''}<button class="text-button" data-page="sources">Review sources →</button></div>` : '';
  const content = ({ overview: overviewPage, models: modelsPage, services: servicesPage, activity: activityPage, compute: computePage, sources: sourcesPage })[state.page]();
  return `${state.error ? `<div class="notice" role="status">${escape(state.error)}</div>` : stale ? '<div class="notice" role="status">Collection is delayed. Showing the last available snapshot.</div>' : ''}${sample ? `<div class="sample-disclosure"><span>Sample environment. Names, requests, and hardware are fictional.</span>${state.info.defaultMode !== 'sample' ? '<button data-action="live">View your environment →</button>' : ''}</div>` : ''}${coverageNotice}${inventoryNotice}${indexProgress()}${content}${footer()}`;
}
function render({ focusMain = false, focusTab = false } = {}) {
  try { return renderInner({focusMain,focusTab}); }
  catch (error) { analytics('terminal_error',{code:'render_error',...browserErrorProperties(error)}); throw error; }
}
function renderInner({ focusMain = false, focusTab = false } = {}) {
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
function terminalQuery(mode) { const params = new URLSearchParams(); if (mode === 'sample') params.set('sample', '1'); return params.size ? `?${params}` : ''; }
function navigate(page, { focusTab = false } = {}) { if (page === 'connections') { page = 'services'; serviceView = 'map'; } if (!pages.includes(page)) return; state.page = page; analytics('terminal_page_viewed', {page}); if (page === 'services' && serviceView === 'map') analytics('terminal_page_viewed', {page:'connections'}); state.filter = 'all'; state.search = ''; history.replaceState(null, '', `${location.pathname}${terminalQuery(state.mode)}#${page}`); render({ focusMain: !focusTab, focusTab }); }
function revealTab(tab) {
  if (!tab) return;
  const nav = tab.closest('.terminal-tabs'), left = tab.offsetLeft, right = left + tab.offsetWidth;
  const endInset = parseFloat(getComputedStyle(nav).paddingRight) || 0;
  if (left < nav.scrollLeft) nav.scrollLeft = left;
  else if (right > nav.scrollLeft + nav.clientWidth - endInset) nav.scrollLeft = right - nav.clientWidth + endInset;
}
window.addEventListener('resize', () => revealTab(document.activeElement?.matches('.terminal-tabs [role="tab"]') ? document.activeElement : $(`#tab-${state.page}`)));
function taskSummaryList() {
  const summaries = [...(state.data.taskSummaries ?? [])].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  if (!summaries.length) return '';
  return `<details class="identity-evidence"><summary>${integer(summaries.length)} retained task ${summaries.length === 1 ? 'summary' : 'summaries'}</summary><p class="detail-note">Task-level evidence only. These values are excluded from request totals, charts, tokens, and spend.</p>${summaries.slice(0, 100).map(item => `<div class="detail-section-title"><h3>${escape(item.workload)}</h3><span>${escape(new Date(item.occurredAt).toLocaleString())}</span></div>${detailList([['Model reported by task', item.model], ['Input / output tokens', `${compact(item.inputTokens)} / ${compact(item.outputTokens)}`], ['Cost basis', ['reported', 'estimated'].includes(item.costKind) ? item.costKind : 'Not supplied'], ['Task cost', item.currency === 'USD' ? money(item.cost) : item.cost == null ? 'Not supplied' : `${compact(item.cost)} · currency unknown or unsupported`]])}`).join('')}${summaries.length > 100 ? '<p class="detail-note">Showing the latest 100 summaries. The JSON snapshot contains all retained summaries.</p>' : ''}</details>`;
}
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
  dialog.classList.toggle('environment-inspector', ['Agent environment', 'Deployment', 'Shared capacity', 'Reported path', 'Service'].includes(context));
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
  interaction('inspect', kind === 'map-model' ? 'model' : kind === 'entry' ? 'path' : kind);
  currentInspection = [kind, key, pathKind]; inspectorTab = 'deployments'; inspecting = true;
  try { inspectInner(kind, key, pathKind); } finally { inspecting = false; }
}
function inspectInner(kind, key, pathKind) {
  if (kind === 'map-model') {
    const model = state.data.models.find(item => JSON.stringify([item.provider, item.name]) === key);
    if (model) inspectInner('model', model.id);
    else openInspector('Model no longer in view', 'Activity changed since the map was drawn.', '<p class="detail-note">Choose a model from the current inventory.</p>');
    return;
  }
  if (kind === 'service') { inspectService(key); return; }
  if (kind === 'reference') { inspectReference(key); return; }
  if (kind === 'index-issues') { inspectIndexIssues(); return; }
  if (inspectEnvironment(kind, key)) return;
  if (kind === 'agent-list' || kind === 'task-list') {
    const type = kind === 'agent-list' ? 'agent' : 'task', entities = observedEntities(type);
    openInspector(type === 'agent' ? 'Agents in view' : 'Tasks in view', `${integer(entities.length)} recorded · ${rangeLabel(state.hours)}`, `<div class="entity-head"><span>${type === 'agent' ? 'Agent' : 'Task'}</span><span>Models</span><span>Requests</span></div><div class="entity-list">${entities.map(entity => `<button class="entity-row" data-inspect="${type}" data-key="${escape(entity.id)}"><span><strong>${escape(entity.name)}</strong><small>${type === 'agent' ? `${entity.related.size} ${entity.related.size === 1 ? 'task' : 'tasks'} observed` : escape([...entity.related].join(', '))}</small></span><span>${entity.models.size}</span><span>${integer(entity.count)}</span></button>`).join('')}</div><p class="detail-note">Only source-reported IDs in the selected window are counted. Names use exported labels or fall back to the ID; the terminal does not discover agent roles from code. Request activity does not establish task completion.</p>`, 'Observed activity');
  } else if (kind === 'agent' || kind === 'task') {
    const items = records().filter(item => item[`${kind}Id`] === key); if (!items.length) { openInspector('No activity in this window', `${kind} · ${key}`, '<p class="detail-note">This identity no longer has retained activity in the selected window.</p>', 'Agent environment'); return; }
    const metrics = stats(items), name = items[0][kind] || key;
    openInspector(name, `Recorded ${kind} · ${rangeLabel(state.hours)}`, `<button class="text-button" data-inspect="${kind}-list" data-key="all">← All ${kind === 'agent' ? 'agents' : 'tasks'}</button>${kind === 'agent' ? `<button class="text-button agent-map-link" data-focus-agent="${escape(key)}">Focus on map ↗</button>` : ''}<div class="agent-metrics">${[['Requests', integer(countRequests(items))], ['Models', integer(new Set(items.map(item => `${item.provider}:${item.model}`)).size)], ['Median latency', duration(metrics.latency)], ['Recorded spend', money(metrics.cost)]].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join('')}</div>${identityEvidence(items, kind)}${dependencyDetails(items)}<p class="detail-caption">${kind === 'agent' ? 'Tasks observed' : 'Agents observed'}</p><p class="muted">${escape([...new Set(items.map(item => kind === 'agent' ? item.task || item.taskId : item.agent || item.agentId).filter(Boolean))].join(' · ') || 'Not supplied')}</p><p class="detail-note">Reported inference metadata only. Task lifecycle and agent orchestration remain outside the terminal.</p>`, kind === 'agent' ? 'Agent environment' : 'Observed activity');
  } else if (kind === 'model') {
    const model = state.data.models.find(item => item.id === key); if (!model) return;
    const items = records().filter(item => item.model === model.name && item.provider === model.provider), metrics = stats(items);
    const countKnown = requestCountKnown(state.data);
    openInspector(model.name, model.state === 'declared' ? 'Declared in code or configuration' : `Served by ${model.provider} · ${model.location}`, `${referenceEvidence(model.declarationIds)}${detailList([[model.state === 'declared' ? 'Declared service' : 'Served by', model.provider], ...creatorFacts(model), ['State', stateLabel(model.state)], ['Observed paths', routeKinds(items).map(kind => ROUTES[kind].label).join(', ') || (countKnown ? 'Not observed' : 'Unavailable')], ['Observed requests', countKnown ? integer(countRequests(items)) : 'Unavailable'], ['Window', rangeDescription(state.hours)], ['Input / output tokens', `${compact(metrics.input)} / ${compact(metrics.output)}`], ['Median latency', duration(metrics.latency)], ['Recorded spend', money(metrics.cost)], ['Cost coverage', countKnown ? `${metrics.costCount} of ${countRequests(items)} requests` : 'Unavailable'], ...(model.memoryBytes != null ? [['Reported VRAM allocation', bytes(model.memoryBytes)]] : []), ...(model.parameters ? [['Parameters', model.parameters]] : []), ...(model.quantization ? [['Quantization', model.quantization]] : [])])}<div class="detail-section-title"><h3>Deployments</h3></div>${deploymentList(items)}<p class="detail-caption">Used by</p><p class="muted">${escape([...new Set(items.map(item => item.workload))].join(', ') || (countKnown ? 'No use observed in this window.' : 'Request activity is unavailable.'))}</p><p class="detail-note">${model.state === 'loaded' ? 'Loaded means resident in memory, not necessarily generating. ' : ''}Usage reflects connected sources only. Missing cost and timing measurements are not treated as zero.</p>`, 'Model inventory', { title: modelIdentity(model), subtitle: serviceIdentity(model.provider)?.key !== modelIdentity(model)?.key ? serviceIdentity(model.provider) : null });
  } else if (kind === 'source') {
    const source = state.data.sources.find(item => item.id === key); if (!source) return;
    openInspector(source.name, source.kind, `${detailList([['Connection', stateLabel(source.state)], ['Location', source.detail], ...(source.coverage ? [['Provides', source.coverage.join(' · ')]] : []), ...(source.access ? [['Access', source.access]] : []), ['Last checked', source.updatedAt ? time(source.updatedAt) : 'No successful check'], ...(source.records != null ? [['Records retained', integer(source.records)]] : []), ...(source.summaries != null ? [['Task summaries retained', integer(source.summaries)]] : []), ...(source.activity ? [['Included in totals', integer(source.activity.included)], ['Matching records reconciled', integer(source.activity.duplicates)], ['Unresolved overlap', integer(source.activity.excluded)]] : [])])}<p class="detail-note">${escape(source.note)}</p>${source.id === 'openmerit' ? taskSummaryList() : source.id === 'repository' ? indexCoverageDetails() : ''}<div class="modal-actions"><button class="button" data-action="connect">Source setup →</button></div>`, 'Source coverage', { title: serviceIdentity(source.name) });
  } else if (kind === 'record') {
    const record = records().find(item => item.id === key); if (!record) return;
    openInspector(record.workload, record.model, `${detailList([['Scope', record.scope], ...(record.agentId ? [['Agent ID', record.agentId], ['Agent name', record.agent || 'Not supplied']] : []), ...(record.taskId ? [['Task ID', record.taskId], ['Task name', record.task || 'Not supplied']] : []), ['Served by', record.provider], ...creatorFacts(record), ['Connection', record.route], ['Path type', ROUTES[routeKind(record, state.data)].label], ['Status', stateLabel(record.status)], ['Recorded at', new Date(record.occurredAt).toLocaleString()], ['Duration', duration(record.durationMs)], ['Input / output tokens', `${compact(record.inputTokens)} / ${compact(record.outputTokens)}`], ['Cache read tokens', compact(record.cacheReadTokens)], ['Cost', record.cost == null ? 'Not supplied' : record.currency === 'USD' ? money(record.cost) : `${compact(record.cost)} · currency unknown or unsupported`], ['Cost basis', record.cost == null || record.costKind === 'unknown' ? 'Not supplied' : record.costKind], ['Sources', (record.sourceIds ?? [record.sourceId]).map(sourceName).join(' · ')], ...(record.requestId ? [['Request ID', record.requestId]] : []), ...(record.evidenceFormat ? [['Record format', record.evidenceFormat]] : []), ...(record.conflictingFields?.length ? [['Conflicting fields', record.conflictingFields.join(', ')]] : [])])}<p class="detail-note">This is a metadata summary. Source files may contain prompts and responses. Only the displayed metadata is retained; conversation content is discarded.</p>`, 'Recorded activity', { subtitle: modelIdentity(record) });
  } else {
    const items = records().filter(item => item[kind === 'route' ? 'route' : 'workload'] === key && (kind !== 'route' || !pathKind || routeKind(item, state.data) === pathKind)), metrics = stats(items);
    openInspector(key, kind === 'route' ? 'Observed connection' : 'Observed workload', `${detailList([['Requests', integer(countRequests(items))], ['Path types', routeKinds(items).map(kind => ROUTES[kind].label).join(', ') || 'Not observed'], ['Models', [...new Map(items.map(item => [`${item.provider}:${item.model}`, item])).values()], 'models'], ['Providers', [...new Set(items.map(item => item.provider))], 'services'], ['Scope', [...new Set(items.map(item => item.scope))].join(', ')], ['Median latency', duration(metrics.latency)], ['Recorded spend', money(metrics.cost)]])}<p class="detail-note">Connections are taken from source metadata. They describe reported paths, not a network inspection or an enforced routing policy.</p>`, 'Environment map', { title: kind === 'route' ? serviceIdentity(key) : null });
  }
}
function inspectEnvironment(kind, key) {
  const env = environment();
  if (kind === 'deployment-list') {
    openInspector('Model deployments', `${env.deployments.length} declared or catalog entries`, `${deploymentList(records(), true)}<p class="detail-note">Catalog entries identify a model at an endpoint; physical placement requires explicit host metadata. Requests join only by an explicit deployment ID with a matching model and provider.</p>`, 'Deployment');
  } else if (kind === 'deployment') {
    const deployment = env.deployments.find(item => item.id === key); if (!deployment) { openInspector('Deployment unavailable', key, '<p class="detail-note">This deployment is absent from the latest inventory.</p>', 'Deployment'); return true; }
    const items = records().filter(item => deploymentFor(item, state.data)?.id === key);
    const agents = new Map(items.filter(item => item.agentId).map(item => [item.agentId, item.agent || item.agentId]));
    const pools = env.pools.filter(pool => deployment.poolIds.includes(pool.id));
    const host = computeHosts().find(item => item.id === deployment.hostId);
    openInspector(deployment.model, `${deployment.name} · ${deployment.location}`, `<button class="text-button" data-inspect="deployment-list" data-key="all">← All deployments</button>${detailList([['Deployment ID', deployment.id], ['Served by', deployment.provider], ...creatorFacts(deployment), ['Serving mode', ({ shared: 'Shared API', dedicated: 'Dedicated deployment', 'self-hosted': 'Self-hosted runtime' })[deployment.servingMode] || 'Not reported'], ['Inventory state', stateLabel(deployment.state)], ['Requests in window', integer(countRequests(items))], ['Observed agents', integer(agents.size)], ['Identity source', sourceName(deployment.sourceId)], ['Host', host?.name || deployment.hostId || 'Not reported'], ['Hardware', host?.accelerators?.length ? host.accelerators.map(device => device.name).join(' · ') : 'Not reported']])}${host ? `<button class="text-button activity-link" data-host="${escape(host.id)}">Inspect ${escape(host.name)} →</button>` : ''}<div class="detail-section-title"><h3>Shared capacity</h3><span>${pools.length} linked pools</span></div>${pools.length ? pools.map(capacityRow).join('') : '<p class="detail-note">No resource pool is declared for this deployment.</p>'}<div class="detail-section-title"><h3>Agents recorded on this deployment</h3></div>${agentLinks(agents)}${namingNote()}<p class="detail-note">A declared or loaded deployment does not guarantee readiness. Pool readings cover all consumers and are separate from request counts.</p>`, 'Deployment', { title: modelIdentity(deployment) });
  } else if (kind === 'pool-list') {
    openInspector('Shared capacity', `${env.pools.length} declared or runtime-discovered pools`, `${env.pools.map(capacityRow).join('')}<p class="detail-note">Readings retain their source timestamps. No reading means capacity is unknown.</p>`, 'Shared capacity');
  } else if (kind === 'pool') {
    const pool = env.pools.find(item => item.id === key); if (!pool) { openInspector('Capacity unavailable', key, '<p class="detail-note">This pool is absent from the latest snapshot.</p>', 'Shared capacity'); return true; }
    const usage = env.usage.get(key), status = poolStatus(pool), readings = capacityReadings(pool);
    openInspector(pool.name, `${pool.kind === 'quota' ? 'Shared quota' : pool.kind === 'runtime' ? 'Inference runtime' : 'Shared connection'} · ${status === 'sampled' ? 'Sampled' : status === 'stale' ? 'Reading is stale' : 'No capacity reading'}`, `<button class="text-button" data-inspect="pool-list" data-key="all">← All shared pools</button><div class="pool-sample-note ${status}">${pool.observedAt ? `Sampled ${escape(new Date(pool.observedAt).toLocaleString())} · ${relativeTime(pool.observedAt)}` : 'The source has not supplied a usable reading.'}${status === 'stale' ? '<br>Older than three collection intervals. Current pressure is unknown.' : ''}</div><div class="pool-readings">${readings.map(row => `<div class="pool-reading"><div><span>${escape(row.label)}</span><strong>${readingValue(row)}</strong></div>${row.ratio != null ? `<div class="capacity-track ${status}" role="meter" aria-label="${escape(row.label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, Math.round(row.ratio * 100))}" aria-valuetext="${escape(readingValue(row))}"><i style="transform:scaleX(${Math.min(1, row.ratio)})"></i></div>` : ''}</div>`).join('')}</div>${detailList([['Name source', pool.id.startsWith('runtime:') ? sourceName(pool.sourceId) : '.openmerit/terminal.json · capacityPools'], ['Readings source', sourceName(pool.sourceId)], ['Quota window', pool.windowSeconds != null ? `${pool.windowSeconds} seconds` : 'Not supplied'], ['Reported reset', pool.resetAt ? new Date(pool.resetAt).toLocaleString() : 'Not supplied'], ['Observed requests using pool', integer(countRequests(usage.items))], ['Linked deployments', integer(usage.deployments.length)]])}<div class="detail-section-title"><h3>Agents sharing this pool</h3><span>${usage.agents.size} observed · ${rangeLabel(state.hours)}</span></div>${agentLinks(usage.agents)}<p class="detail-note">These are whole-pool readings, including consumers outside this project. Agents are linked by reported deployment IDs and declared connection dependencies. The terminal does not attribute pool usage to individual agents or predict remaining capacity.</p>`, 'Shared capacity', { title: poolIdentity(pool) });
  } else if (kind === 'entry') {
    const items = records().filter(item => JSON.stringify([reportedPath(item, state.data)[0]]) === key);
    const first = items.length ? reportedPath(items[0], state.data)[0] : null;
    const paths = new Map();
    for (const item of items) { const path = reportedPath(item, state.data), id = JSON.stringify(path); const value = paths.get(id) ?? { path, count: 0 }; value.count += requestWeight(item, state.data); paths.set(id, value); }
    openInspector(first?.name ?? 'Connection no longer observed', `${integer(countRequests(items))} requests across all observed agents · ${rangeLabel(state.hours)}`, `<div class="detail-section-title"><h3>Reported paths</h3><span>${paths.size} sequences</span></div><div class="path-list">${[...paths].sort((a, b) => b[1].count - a[1].count).map(([id, { path, count }]) => `<button class="path-row" data-inspect="path" data-key="${escape(id)}">${path.map(hop => `<span class="path-hop" style="--route-color:${ROUTES[hop.kind].color}">${routeIcon(hop.kind)}${serviceLabel(hop.name, 14)}</span>`).join('<span class="path-arrow" aria-hidden="true">→</span>')}<span class="path-count">${integer(count)} requests</span></button>`).join('')}</div><p class="detail-note">Each sequence contains only reported hops. Missing connection metadata does not establish an execution path.</p>`, 'Reported path', { title: serviceIdentity(first?.name) });
  } else if (kind === 'path') {
    let path; try { path = JSON.parse(key); } catch { return true; }
    const items = records().filter(item => JSON.stringify(reportedPath(item, state.data)) === key);
    openInspector('Reported execution path', `${integer(countRequests(items))} requests · ${rangeDescription(state.hours)}`, `<ol class="path-steps">${path.map(hop => `<li style="--route-color:${ROUTES[hop.kind].color}">${routeIcon(hop.kind)}<span><strong>${serviceLabel(hop.name, 16)}</strong><small>${ROUTES[hop.kind].label}</small></span></li>`).join('')}</ol><div class="detail-section-title"><h3>Reached deployments</h3></div>${deploymentList(items)}<p class="detail-note">Only source-reported hops are shown. A one-hop record does not establish that no other intermediaries exist. Usage covers all agents reporting this path.</p>`, 'Reported path');
  } else if (kind === 'unidentified') {
    openInspector('Deployment unidentified', 'The model is known; its execution instance is not.', '<p class="detail-note">These requests do not provide a matching deployment identity. A model name or connection alone does not identify an execution instance.</p>', 'Deployment');
  } else return false;
  return true;
}
function agentLinks(agents) { return agents.size ? `<div class="agent-links">${[...agents].map(([id, name]) => `<button data-inspect="agent" data-key="${escape(id)}">${escape(name)}<span>↗</span></button>`).join('')}</div>` : '<p class="detail-note">No agent IDs were reported for this selection.</p>'; }
function closeDialog() { const dialog = $('dialog[open]'); if (dialog) dialog.close(); }
function connect() { closeDialog(); openInspector('Connect your environment.', 'Read existing evidence. Keep inference independent.', `<p class="detail-note" style="margin-top:0">Supported JSONL request logs in <code>logs/</code>, <code>runs/</code>, and <code>results/</code>, project declarations, and project-linked local runtime APIs are discovered automatically. Coding-harness histories are not read. Only connect request logs belonging to this application. If an application does not save a supported log, it can export one metadata record per line to <code>.openmerit/inference.jsonl</code>. Do not include prompts, responses, or secrets.</p><pre class="detail-code">${escape(JSON.stringify({ id: 'request-123', occurredAt: new Date().toISOString(), workload: 'your-service-id', scope: 'application', model: 'your-model', provider: 'your-provider', route: 'your-gateway', routeKind: 'gateway', location: 'cloud', status: 'completed', inputTokens: 120, outputTokens: 40, durationMs: 850, cost: 0.002, costKind: 'reported', currency: 'USD' }, null, 2))}</pre><p class="detail-note">Use a stable ID to update an ongoing request. Keep retries under separate IDs. Missing fields stay unknown. Shared recorded IDs reconcile copied requests. Unresolved overlaps stay separate from totals. Task summaries remain separate from all request metrics.</p><p class="detail-caption">Other local servers</p><p class="detail-note" style="margin-top:0">For Ollama, declare its URL in the <code>ollama</code> field. For LM Studio or vLLM, add a local runtime to <code>.openmerit/terminal.json</code>. Only model inventory and supported counters are read.</p><pre class="detail-code">${escape(JSON.stringify({ ollama: 'http://127.0.0.1:11434', runtimes: [{ name: 'LM Studio', type: 'openai-compatible', url: 'http://127.0.0.1:1234' }, { name: 'vLLM', type: 'vllm', url: 'http://127.0.0.1:8000' }] }, null, 2))}</pre><p class="detail-caption">Optional inventory</p><p class="detail-note" style="margin-top:0">Create <code>.openmerit/terminal.json</code> and restart the terminal:</p><pre class="detail-code">${escape(JSON.stringify({ inventory: [{ name: 'Your gateway', kind: 'gateway', location: 'cloud' }, { name: 'Your model', kind: 'model', provider: 'Your provider', location: 'cloud' }] }, null, 2))}</pre>`, 'Source setup'); }
function workspace() { openInspector('Choose your view.', 'Keep your environment and the example separate.', `<div class="workspace-options">${state.info.defaultMode !== 'sample' ? `<button class="workspace-option ${state.mode === 'live' ? 'selected' : ''}" data-action="live"><strong>Your environment</strong><span>Real inventory and evidence from this project.</span></button>` : ''}<button class="workspace-option ${state.mode === 'sample' ? 'selected' : ''}" data-action="sample"><strong>Sample environment</strong><span>40 agents, 140 tasks, and 21 models in a fictional enterprise workspace.</span></button></div><p class="detail-note">The sample makes no inference calls and never contributes to your project's totals.</p>`, 'Environment'); }
async function changeMode(mode) { closeDialog(); state.mode = mode; state.error = ''; state.search = ''; state.filter = 'all'; mapAgent = ''; mapExpandAll = false; mapGroupExpansion.clear(); serviceSearch = ''; serviceFilter = 'all'; serviceView = 'inventory'; await refresh(true); history.replaceState(null, '', `${location.pathname}${terminalQuery(mode)}#${state.page}`); $('#announcement').textContent = mode === 'sample' ? 'Showing the fictional sample environment.' : 'Showing your project environment.'; }

let commandEntries = [];
function commandResults(query = '') {
  commandEntries = [...pages.map(page => ({ title: labels[page], type: 'Go to', action: () => navigate(page) })), ...services().map(service => ({ title: service.name, type: 'Service', identity: serviceIdentity(service.name), action: () => inspect('service', service.id) })), ...state.data.models.map(model => ({ title: model.name, type: model.provider, identity: modelIdentity(model), action: () => inspect('model', model.id) })), ...computeHosts().map(host => ({ title: host.name, type: 'Host', action: () => { selectedHost = host.id; hostLocation = ''; navigate('compute'); } })), ...environment().deployments.map(deployment => ({ title: `${deployment.model} / ${deployment.name}`, type: 'Deployment', identity: modelIdentity(deployment), action: () => inspect('deployment', deployment.id) })), ...environment().pools.map(pool => ({ title: pool.name, type: 'Shared capacity', identity: poolIdentity(pool), action: () => inspect('pool', pool.id) })), ...state.data.sources.map(source => ({ title: source.name, type: 'Source', identity: serviceIdentity(source.name), action: () => inspect('source', source.id) })), ...observedEntities('agent').map(agent => ({ title: agent.name, type: 'Agent', action: () => inspect('agent', agent.id) })), ...observedEntities('task').map(task => ({ title: task.name, type: 'Task', action: () => inspect('task', task.id) }))].filter(item => `${item.title} ${item.type}`.toLowerCase().includes(query.toLowerCase())).slice(0, 12);
  $('#command-results').innerHTML = commandEntries.length ? commandEntries.map((entry, i) => `<button class="command-result ${i === 0 ? 'selected' : ''}" data-command="${i}">${identityLabel(entry.title, entry.identity, 18)}<small>${escape(entry.type)}</small></button>`).join('') : '<p class="empty-small" style="padding:16px">No matches in this environment.</p>';
}
function openCommand() { closeDialog(); returnFocus = document.activeElement; $('#command').innerHTML = `<div class="command-input-row">${icon('search')}<input id="command-input" type="search" placeholder="Find a service, model, agent, or source…" aria-label="Search your environment" autocomplete="off"><kbd>esc</kbd></div><div id="command-results"></div><div class="command-footer">↑ ↓ to move · enter to open</div>`; commandResults(); $('#command').showModal(); $('#command-input').focus(); }

document.addEventListener('click', event => {
  const element = event.target.closest('[data-map-version],[data-map-group],[data-map-expand],[data-page],[data-hours],[data-filter],[data-inspect],[data-action],[data-command],[data-focus-agent],[data-inspector-tab],[data-host],[data-activity-path],[data-service-view],[data-service-filter],[data-service-reset],[data-reference-kind],[data-reference-page]'); if (!element) return;
  if (element.hasAttribute('data-map-group') || element.dataset.mapExpand) interaction('map_expand');
  if (['hours','filter','serviceFilter','referenceKind','activityPath'].some(key => element.dataset[key] != null) || element.hasAttribute('data-service-reset')) interaction('filter');
  if (element.dataset.host) interaction('inspect','host');
  if (element.dataset.serviceView === 'map') analytics('terminal_page_viewed',{page:'connections'});
  if (element.dataset.action === 'live' || element.dataset.action === 'sample') analytics('terminal_interaction',{action:'mode',kind:'other',mode:state.mode});
  if (element.dataset.action === 'search' || element.dataset.command != null) interaction('command');
  if (element.hasAttribute('data-map-group')) { toggleMapGroup(element); }
  else if (element.dataset.mapExpand) { mapExpandAll = element.dataset.mapExpand === 'expand'; mapGroupExpansion.clear(); render(); $('[data-map-expand]')?.focus({ preventScroll: true }); }
  else if (element.hasAttribute('data-service-reset')) { serviceFilter = 'all'; serviceSearch = ''; render(); $('#service-search')?.focus({ preventScroll: true }); }
  else if (element.dataset.serviceView) { serviceView = element.dataset.serviceView; if (state.page !== 'services') navigate('services'); else render(); }
  else if (element.dataset.referenceKind) { referenceKind = element.dataset.referenceKind; referencePage = 0; render(); }
  else if (element.hasAttribute('data-reference-page')) { referencePage = Number(element.dataset.referencePage); render(); }
  else if (element.dataset.serviceFilter) { serviceFilter = element.dataset.serviceFilter; render(); }
  else if (element.dataset.host) { selectedHost = element.dataset.host; if (state.page !== 'compute') { hostLocation = ''; closeDialog(); navigate('compute'); } else render(); }
  else if (element.dataset.activityPath) { activityPath = element.dataset.activityPath; render(); }
  else if (element.dataset.inspectorTab) { inspectorTab = element.dataset.inspectorTab; refreshInspection(); }
  else if (element.dataset.focusAgent) { mapAgent = element.dataset.focusAgent; closeDialog(); navigate('connections'); }
  else if (element.dataset.page) navigate(element.dataset.page, { focusTab: element.getAttribute('role') === 'tab' });
  else if (element.dataset.hours) { if (ACTIVITY_RANGES.includes(Number(element.dataset.hours))) { state.hours = Number(element.dataset.hours); render(); } }
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
    if (action === 'api') { closeDialog(); openInspector('A view for your agent.', 'The same evidence, in a readable local snapshot.', `<pre class="detail-code">openmerit dash --json</pre><p class="detail-note">Or, while this terminal is running:</p><pre class="detail-code">GET ${escape(location.origin)}/api/snapshot</pre><p class="detail-note">Schema version 1. Includes models, inventory, sources, request metadata, and machine measurements. Read-only. No inference or model changes.</p>`, 'Agent access'); }
    if (action === 'about') openInspector('Inference Terminal', 'Your inference environment, in one place.', `<p class="detail-note" style="margin-top:0">A local, passive view of your application’s models, services, recorded activity, and linked compute. Your workloads never wait for it.</p><p class="detail-note">The terminal indexes supported code and configuration, reads existing application request logs and exports, and checks explicitly authorized local runtime endpoints. Declarations identify inventory; they do not establish past usage. Whole-machine readings are shared context.</p><p class="detail-note">No prompt or response storage. No inference calls or route changes. The terminal is separate from Pi’s evaluation and model-change workflow.</p>`, 'OpenMerit');
  }
});
document.addEventListener('change', event => { if (event.target.id === 'host-location') { hostLocation = event.target.value; render(); $('#host-location')?.focus({ preventScroll: true }); } if (event.target.id === 'map-agent') { mapAgent = event.target.value; render(); $('#map-agent')?.focus({ preventScroll: true }); } });
document.addEventListener('input', event => { if (event.target.id === 'reference-search') { referenceSearch = event.target.value; referencePage = 0; render(); $('#reference-search').focus({ preventScroll: true }); } if (event.target.id === 'service-search') { serviceSearch = event.target.value; render(); $('#service-search').focus({ preventScroll: true }); } if (event.target.id === 'model-search') { state.search = event.target.value; render(); $('#model-search').focus({ preventScroll: true }); } if (event.target.id === 'command-input') commandResults(event.target.value); });
document.addEventListener('pointerdown', () => document.body.classList.remove('keyboard'));
document.addEventListener('change', event => { if (['host-location','map-agent'].includes(event.target.id)) interaction('filter'); });
let lastSearchAction = 0;
document.addEventListener('input', event => { if (['reference-search','service-search','model-search','command-input'].includes(event.target.id) && Date.now() - lastSearchAction > 1000) { lastSearchAction = Date.now(); interaction('search'); } });
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
  if (event.target.matches('.map-node') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.target.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
  if ($('#command').open && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) {
    event.preventDefault(); const buttons = [...document.querySelectorAll('.command-result')]; let index = buttons.findIndex(button => button.classList.contains('selected')); if (event.key === 'Enter') { buttons[index]?.click(); return; } index = Math.min(buttons.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1))); buttons.forEach((button, i) => button.classList.toggle('selected', i === index)); buttons[index]?.scrollIntoView({ block: 'nearest' });
  }
});
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', event => { if (event.target !== dialog) return; const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); });
  dialog.addEventListener('close', () => { if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); });
}
function highlightMap(node) { const key = node.dataset.mapNodeId; document.querySelectorAll('.map-edge').forEach(edge => { const match = JSON.parse(edge.dataset.nodes ?? '[]').includes(key); edge.classList.toggle('focused', match); edge.classList.toggle('faded', !match); }); }
document.addEventListener('pointerover', event => { const node = event.target.closest('.map-node'); if (node) highlightMap(node); const hit = event.target.closest('[data-bin]'); if (hit) chartTooltip(hit); });
document.addEventListener('focusin', event => { if (event.target.matches('.map-node')) highlightMap(event.target); if (event.target.matches('[data-bin]')) chartTooltip(event.target); });
function clearChart() { document.querySelectorAll('.map-edge').forEach(edge => edge.classList.remove('focused', 'faded')); const tooltip = $('.chart-tooltip'); if (tooltip) tooltip.hidden = true; }
document.addEventListener('pointerout', event => { if (event.target.closest('.map-node,[data-bin]')) clearChart(); });
document.addEventListener('focusout', event => { if (event.target.matches('.map-node,[data-bin]')) clearChart(); });
function chartTooltip(hit) { const bin = buckets(records(), 60)[Number(hit.dataset.bin)], tooltip = $('.chart-tooltip'), parent = hit.closest('.activity-chart'); if (!bin || !tooltip || !parent) return; tooltip.textContent = `${chartTime(bin.at, true)} · ${Object.entries(ROUTES).filter(([kind]) => bin.paths[kind] && (activityPath === 'all' || activityPath === kind)).map(([kind, route]) => `${bin.paths[kind]} ${route.short.toLowerCase()}`).join(' · ') || '0 requests'}`; tooltip.hidden = false; const bounds = hit.getBoundingClientRect(), area = parent.getBoundingClientRect(); tooltip.style.left = `${Math.min(area.width - tooltip.offsetWidth - 10, Math.max(10, bounds.left - area.left - tooltip.offsetWidth / 2))}px`; tooltip.style.top = '8px'; }
window.addEventListener('hashchange', () => { const page = location.hash.slice(1); if (pages.includes(page) || page === 'connections') navigate(page); });

async function refresh(force = false) {
  if (state.fetching) { if (force) state.pendingRefresh = true; return; }
  state.fetching = true;
  const requestedMode = state.mode;
  try {
    const previousIndex=state.data?.mode==='live'?state.data.repository:null;
    const snapshotUrl=previousIndex?.revision!=null?`/api/snapshot?repositoryRevision=${previousIndex.revision}`:'/api/snapshot';
    const response = await fetch(requestedMode === 'sample' ? '/api/sample' : snapshotUrl, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Snapshot unavailable');
    const snapshot = await response.json();
    if (requestedMode !== state.mode) return;
    if(snapshot.repository&&!snapshot.repository.references&&previousIndex?.revision===snapshot.repository.revision)snapshot.repository.references=previousIndex.references;
    state.data = snapshot; state.error = '';
    analytics('terminal_snapshot', {model_count:snapshot.models?.length??0,record_count:snapshot.records?.length??0,source_count:snapshot.sources?.length??0,host_count:snapshot.hosts?.length??0,deployment_count:snapshot.deployments?.length??0,agent_count:new Set((snapshot.records??[]).map(record=>record.agentId).filter(Boolean)).size});
    refreshInspection();
    if (force || (!document.querySelector('dialog[open]') && !selectIsOpen() && !document.activeElement?.matches('input'))) render();
  } catch (error) {
    analytics('terminal_error', {code:'snapshot_error',...browserErrorProperties(error)});
    state.error = 'The terminal is disconnected. Your inference is unaffected. Reopen the local command to reconnect.';
    refreshInspection();
    if (state.data && !document.querySelector('dialog[open]') && !selectIsOpen()) render();
    else if (!state.data) $('#app').innerHTML = `<div class="boot"><span class="wordmark">openmerit</span><p>${escape(state.error)}</p><p><a href="/">Try again →</a></p></div>`;
  } finally { state.fetching = false; if (state.pendingRefresh) { state.pendingRefresh = false; void refresh(true); } else scheduleRefresh(); }
}
function scheduleRefresh() {
  clearTimeout(state.timer);
  const p=state.data?.repository?.progress;
  const indexing=state.mode==='live'&&(state.data?.loading||p&& !['complete','failed'].includes(p.phase));
  state.timer=setTimeout(()=>{if(!document.hidden)void refresh();else scheduleRefresh();},indexing?1000:Math.max(10,state.info.interval??15)*1000);
}
async function start() {
  try { const response = await fetch('/api/info'); state.info = await response.json(); if (state.info.defaultMode === 'sample') state.mode = 'sample'; } catch { /* The snapshot request provides the actionable error. */ }
  analytics('terminal_visited'); analytics('terminal_page_viewed',{page:state.page});
  await refresh(true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
}
void start();
