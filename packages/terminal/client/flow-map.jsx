import { rangeLabel } from '../src/history.mjs';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, Handle, Position } from '@xyflow/react';
import ELK from 'elkjs/lib/elk.bundled.js';
import '@xyflow/react/dist/base.css';
import './flow-map.css';
import { flowModel, browseEntities, spotlight, layoutFlow, flowEdgeId, FLOW_COLUMNS } from './flow-model.mjs';
import { ROUTES } from './routes.mjs';
import { routeIcon } from './route-icons.mjs';
import { modelIdentity, serviceIdentity } from './brands.mjs';

const roots = new Map();
const number = n => new Intl.NumberFormat('en').format(n);
const tabs = ['Workloads', 'Connections', 'Models'];
const memberIdentity = node => node.type === 'model' ? modelIdentity(node.example) : node.type === 'path' ? serviceIdentity(node.name) : null;
const icon = identity => identity && <img src={identity.src} width="18" height="18" alt="" />;
const routeMark = kind => <span className="flow-route-mark" style={{ color: ROUTES[kind].color }} dangerouslySetInnerHTML={{ __html: routeIcon(kind) }} />;

function Card({ data }) {
  const { node, front, caption, onActivate, onHover, onLeave, dimmed, active } = data;
  const stack = node.type === 'group', path = node.type === 'path', identity = memberIdentity(front);
  return <div className={`flow-card-wrap${dimmed ? ' is-dimmed' : ''}${active ? ' is-active' : ''}`}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    {stack && <><i className="flow-stack-back rear" /><i className="flow-stack-back" /></>}
    <button className={`flow-card nodrag${path ? ' is-connection' : ''}`} onClick={onActivate} onMouseEnter={onHover} onMouseLeave={onLeave} onFocus={onHover} onBlur={onLeave}
      aria-label={stack ? `Browse ${node.members.length} ${node.label} through ${node.names.join(', ')}` : `Spotlight ${node.name}`} title={`${front.name} — ${caption}`}>
      {path ? routeMark(node.kind) : icon(identity)}
      <span className="flow-card-copy"><strong>{front.name}</strong><small>{caption}</small></span>
      {path ? icon(identity) : stack ? <span className="flow-stack-count">+{node.members.length - 1}</span> : null}
    </button>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </div>;
}
function ColumnLabel({ data }) { return <span className="flow-column-label">{data.label}</span>; }
const nodeTypes = { card: Card, label: ColumnLabel };

function MapPreview({ records, snapshot, hours, onInspect }) {
  const model = useMemo(() => flowModel(records, snapshot), [records, snapshot]);
  const [layout, setLayout] = useState(null), [error, setError] = useState('');
  const [open, setOpen] = useState(false), [column, setColumn] = useState(0), [groupId, setGroupId] = useState(''), [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(''), [hover, setHover] = useState('');
  const [stageWidth, setStageWidth] = useState(900), stageRef = useRef(null);
  const gap = (stageWidth - 28 - 196 - 222 - 244) / 2;
  const columnX = [14, 210 + gap, stageWidth - 258];
  const elk = useMemo(() => new ELK(), []), listRef = useRef(null), searchRef = useRef(null), scrollRef = useRef(null), browseButton = useRef(null);
  // An updated reading only changes labels. Layout runs when relationships change.
  useEffect(() => {
    let cancelled = false;
    layoutFlow(model.graph, elk).then(value => { if (!cancelled) { setLayout(value); setError(''); } }).catch(() => { if (!cancelled) setError('The preview could not arrange this environment. Use Original map to continue.'); });
    return () => { cancelled = true; };
  }, [model.signature, elk]);
  // The bundled ELK engine uses an in-process worker shim with no terminate
  // method. The layout effect above already cancels updates after unmount.
  useEffect(() => {
    if (selectedId && !model.owners.has(selectedId)) setSelectedId('');
    if (groupId && !model.graph.groups.some(group => group.id === groupId)) setGroupId('');
  }, [model, selectedId, groupId]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const resize = new ResizeObserver(([entry]) => setStageWidth(entry.contentRect.width)); resize.observe(stage);
    return () => resize.disconnect();
  }, [Boolean(layout), Boolean(records.length)]);
  const selected = model.entities.flat().find(node => node.id === selectedId);
  const highlighted = useMemo(() => spotlight(model, selectedId), [model, selectedId]);
  const browsing = browseEntities(model, column, groupId, search);
  const paths = new Map(model.graph.columns[1].map(node => [node.key, node.name]));
  const openBrowser = (col = 0, group = '') => {
    setColumn(col); setGroupId(group); setSearch(''); setOpen(true);
    requestAnimationFrame(() => { if (listRef.current) listRef.current.scrollTop = 0; searchRef.current?.focus({ preventScroll: true }); });
  };
  const reveal = id => {
    const point = layout?.positions.get(model.owners.get(id));
    if (point && scrollRef.current) scrollRef.current.scrollTo({ top: Math.max(0, point.y - 90), behavior: 'instant' });
  };
  const select = entity => { setSelectedId(entity.id); reveal(entity.id); };
  const closeBrowser = () => { setOpen(false); browseButton.current?.focus({ preventScroll: true }); };
  const nodes = layout ? model.graph.columns.flatMap((nodes, col) => nodes.map(node => {
    const stack = node.type === 'group';
    const front = stack ? node.members.find(member => member.id === selectedId) ?? node.members.find(member => highlighted.members.has(member.id)) ?? node.members[0] : node;
    const caption = stack ? `${node.members.length} ${node.label} · ${number(node.count)} requests` : node.type === 'path' ? `${ROUTES[node.kind].short} · ${number(node.count)} requests` : node.type === 'model' ? node.provider : `${number(node.count)} requests · ${rangeLabel(hours)}`;
    const isRelated = selected ? highlighted.nodes.has(node.id) : !hover || node.id === hover || model.graph.edges.some(edge => edge.related.has(hover) && (edge.from === node.id || edge.to === node.id));
    return { id: node.id, type: 'card', position: { x: columnX[col], y: layout.positions.get(node.id)?.y ?? 34 }, width: FLOW_COLUMNS[col].width, height: 46,
      draggable: false, selectable: false, data: { node, front, caption, dimmed: !isRelated, active: selected && highlighted.nodes.has(node.id),
        onActivate: () => { if (stack) openBrowser(col, node.id); else { select(node); openBrowser(col); } },
        onHover: () => setHover(node.id), onLeave: () => setHover('') } };
  })) : [];
  const labels = FLOW_COLUMNS.map((col, i) => ({ id: `column-${i}`, type: 'label', position: { x: columnX[i], y: 0 }, data: { label: ['AGENTS / WORKLOADS', 'ENTRY CONNECTION', 'MODELS'][i] }, selectable: false, draggable: false }));
  const edges = model.graph.edges.map(edge => {
    const lit = selected ? highlighted.edges.has(flowEdgeId(edge.from, edge.to)) : !hover || edge.related.has(hover);
    return { id: flowEdgeId(edge.from, edge.to), source: edge.from, target: edge.to, type: 'default', focusable: false, selectable: false,
      style: { stroke: ROUTES[edge.kind].color, strokeWidth: selected && lit ? 1.8 : 1.4, opacity: lit ? .7 : .1 },
      data: { count: edge.count, segment: edge.segment } };
  });
  const relatedNames = entity => entity.type === 'path' ? ROUTES[entity.kind].label : [...entity.connections].map(key => paths.get(key)).join(' · ');
  return <div className="flow-preview" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); if (selectedId) setSelectedId(''); else if (open) closeBrowser(); } }}>
    <div className="flow-explore-bar">
      <span className="flow-spotlight" aria-live="polite">{selected ? <><span>Spotlight</span><strong title={selected.name}>{selected.name}</strong><button onClick={() => setSelectedId('')} aria-label="Clear spotlight">×</button></> : 'All recorded relationships'}</span>
      <button ref={browseButton} className="text-button" onClick={() => open ? closeBrowser() : openBrowser()} aria-expanded={open} aria-controls="flow-browser">{open ? 'Close browser' : 'Browse all'} <span aria-hidden="true">{open ? '×' : '↗'}</span></button>
    </div>
    {error ? <p className="flow-empty" role="alert">{error}</p> : !records.length ? <p className="flow-empty">No recorded activity in this window.</p> : !layout ? <p className="flow-empty" role="status">Arranging the environment…</p> :
      <div className="flow-canvas-scroll" ref={scrollRef} tabIndex="0" role="region" aria-label="Environment map. Scroll to explore all connections.">
        <div className="flow-stage" ref={stageRef} style={{ height: layout.height }}>
          <ReactFlow nodes={[...labels, ...nodes]} edges={edges} nodeTypes={nodeTypes} defaultViewport={{ x: 0, y: 0, zoom: 1 }}
            nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} elementsSelectable={false}
            panOnDrag={false} panOnScroll={false} zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false} preventScrolling={false}
            minZoom={1} maxZoom={1} deleteKeyCode={null} selectionKeyCode={null} proOptions={{ hideAttribution: true }} colorMode="system" />
        </div>
      </div>}
    {open && <section id="flow-browser" className="flow-browser" aria-label="Browse the environment">
      <div className="flow-browser-heading"><h3>Browse environment</h3><button className="text-button" onClick={closeBrowser} aria-label="Close environment browser">×</button></div><div className="flow-browser-tools"><div role="tablist" aria-label="Browse entities" className="flow-browser-tabs">{tabs.map((label, i) => <button key={label} id={`flow-tab-${i}`} role="tab" aria-controls="flow-member-list" aria-selected={column === i} tabIndex={column === i ? 0 : -1}
        onClick={() => { setColumn(i); setGroupId(''); setSearch(''); if (listRef.current) listRef.current.scrollTop = 0; }}
        onKeyDown={event => { if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (i + (event.key === 'ArrowRight' ? 1 : 2)) % 3; setColumn(next); setGroupId(''); setSearch(''); document.getElementById(`flow-tab-${next}`)?.focus(); } }}>
        {label}<span>{model.entities[i].length}</span></button>)}</div><input ref={searchRef} type="search" value={search} onChange={event => { setSearch(event.target.value); if (listRef.current) listRef.current.scrollTop = 0; }} placeholder={`Find ${tabs[column].toLowerCase()}…`} aria-label={`Search ${tabs[column].toLowerCase()}`} /></div>
      <div className="flow-browser-scope"><span>{browsing.group ? <>{browsing.group.names.join(' · ')}<button className="text-button" onClick={() => setGroupId('')}>Show all {tabs[column].toLowerCase()}</button></> : 'Select a row to spotlight its recorded paths.'}</span><span role="status">{browsing.rows.length} of {browsing.total} {tabs[column].toLowerCase()}</span></div>
      <div className="flow-member-list" ref={listRef} id="flow-member-list" role="tabpanel" aria-labelledby={`flow-tab-${column}`}>
        <table><thead><tr><th>Name</th><th>{column === 1 ? 'Path type' : 'Connections'}</th><th>Requests</th><th><span className="sr-only">Details</span></th></tr></thead><tbody>
          {browsing.rows.map(entity => <tr key={entity.id} className={selectedId === entity.id ? 'selected' : ''}><td><button className="flow-member-name" onClick={() => select(entity)} aria-pressed={selectedId === entity.id}>{icon(memberIdentity(entity))}<span>{entity.name}{entity.provider ? <small>{entity.provider}</small> : <small className="flow-row-connection">{relatedNames(entity)}</small>}</span></button></td><td>{relatedNames(entity)}</td><td>{number(entity.count)}</td><td><button className="text-button" aria-label={`Inspect ${entity.name}`} onClick={() => onInspect(entity)}><span className="flow-details-word">Details </span>↗</button></td></tr>)}
        </tbody></table>{!browsing.rows.length && <p className="flow-empty">No matches. Try another name or connection.</p>}
      </div>
    </section>}
    <div className="flow-map-footer"><div className="route-legend">{Object.entries(ROUTES).filter(([kind]) => model.graph.columns[1].some(path => path.kind === kind)).map(([kind, route]) => <span key={kind} style={{ color: route.color }}>{routeMark(kind)}{route.label}</span>)}</div><span>All {number(model.graph.requestCount)} requests represented · {rangeLabel(hours)}</span></div>
    <p className="flow-map-note">Select a stack to browse every member.{layout?.height > 340 ? ' Scroll the map to explore all connections.' : ''}</p>
  </div>;
}
class PreviewBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p className="flow-empty" role="alert">The map preview is unavailable. Use Original map to continue.</p> : this.props.children; }
}
export function renderFlowMap(element, props) {
  for (const [host, root] of roots) if (host !== element || !host.isConnected) { root.unmount(); roots.delete(host); }
  if (!element) return;
  if (!roots.has(element)) roots.set(element, createRoot(element));
  roots.get(element).render(<PreviewBoundary key={props.snapshot.mode}><MapPreview {...props} /></PreviewBoundary>);
}
