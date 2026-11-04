import morphdom from 'morphdom';
import { MorphController } from 'torph';
import { TextMorph } from 'torph/react';
import { createElement as h, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Liveline } from 'liveline';
import { hostState } from '../src/hardware.mjs';
import { contiguousSamples, nearestSample } from './samples.mjs';
import { useSystemTheme, chartColor } from './theme.js';

/* MOTION STORYBOARD
 * 0ms       A pointer selection commits immediately.
 * 0–260ms   Changed characters retain their place through Torph.
 * On sample Liveline interpolates the new reading, never the collection cadence.
 * Keyboard actions and reduced motion bypass transitions.
 */
const MOTION = { text: 260, ease: 'cubic-bezier(.23,1,.32,1)' };
const morphs = new Map();
const charts = new Map();
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
const instant = () => motionQuery.matches || document.body.classList.contains('keyboard');

function updateText(element, text) {
  let controller = morphs.get(element);
  if (!controller) { controller = new MorphController(); morphs.set(element, controller); }
  const options = { duration: MOTION.text, ease: MOTION.ease, scale: false, disabled: instant(), respectReducedMotion: true };
  if (controller.needsRecreate(options)) controller.attach(element, options);
  controller.update(text);
}

export function morphText(key, value, className = '') {
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<span data-morph="${escape(key)}" class="morph-text ${escape(className)}">${escape(value)}</span>`;
}

export function reconcile(markup, snapshot, error) {
  const app = document.getElementById('app');
  morphdom(app, `<div id="app">${markup}</div>`, {
    childrenOnly: true,
    getNodeKey: node => node.id || node.dataset?.uiKey || node.dataset?.morph,
    onBeforeElUpdated(from, to) {
      if (from.dataset.morph && from.dataset.morph === to.dataset.morph) {
        updateText(from, to.textContent);
        return false;
      }
      if (from.dataset.chart && from.dataset.chart === to.dataset.chart && from.dataset.hostId === to.dataset.hostId) return false;
      return !from.isEqualNode(to);
    },
  });
  for (const [element, controller] of morphs) if (!element.isConnected) { controller.destroy(); morphs.delete(element); }
  for (const [element, root] of charts) if (!element.isConnected) { root.unmount(); charts.delete(element); }
  app.querySelectorAll('[data-morph]').forEach(element => {
    if (!morphs.has(element)) updateText(element, element.textContent);
  });
  app.querySelectorAll('[data-chart]').forEach(element => {
    if (!charts.has(element)) charts.set(element, createRoot(element));
    // Reset history when the environment changes, never blend sample and local data.
    const machine = snapshot.hosts?.find(host => host.id === element.dataset.hostId) ?? snapshot.machine;
    charts.get(element).render(h(SampledChart, { key: `${snapshot.mode}:${machine.id ?? 'this-machine'}`, snapshot, machine, error, mini: element.dataset.chart === 'cpu-mini' }));
  });
}

const clock = seconds => new Date(seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const reading = (value, metric) => metric === 'cpuPercent' ? `${value.toFixed(1)}%` : `${(value / 1024 ** 3).toFixed(1)} GiB`;

function StaticSamples({ points, color }) {
  if (points.length < 2) return h('div', { className: 'chart-empty' }, points.length ? 'Waiting for another sample' : 'No measurements supplied');
  const start = points[0].time, end = points.at(-1).time;
  const max = Math.max(1, ...points.map(p => p.value));
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${((p.time - start) / (end - start) * 580 + 10).toFixed(2)},${(135 - p.value / max * 110).toFixed(2)}`).join(' ');
  return h('svg', { viewBox: '0 0 600 160', preserveAspectRatio: 'none', 'aria-hidden': true }, h('path', { d: path, stroke: color, strokeWidth: 1.5, fill: 'none', vectorEffect: 'non-scaling-stroke' }));
}

function SampledChart({ snapshot, machine, error, mini }) {
  const theme = useSystemTheme();
  const [metric, setMetric] = useState('cpuPercent');
  const [hover, setHover] = useState(null);
  const [reduced, setReduced] = useState(motionQuery.matches);
  const [visible, setVisible] = useState(false);
  const container = useRef(null);
  useEffect(() => {
    const update = () => setReduced(motionQuery.matches);
    motionQuery.addEventListener('change', update);
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(container.current);
    return () => { motionQuery.removeEventListener('change', update); observer.disconnect(); };
  }, []);
  const samples = contiguousSamples((machine.history ?? []), metric, snapshot.interval);
  const latest = samples.at(-1);
  const color = chartColor(metric === 'cpuPercent' ? 'chart' : 'blue');
  const points = metric === 'cpuPercent' ? samples : samples.map(p => ({ ...p, value: p.value / 1024 ** 3 }));
  const stale = Boolean(error) || hostState({ ...machine, observedAt: machine.observedAt ?? (machine.id ? null : snapshot.observedAt) }, snapshot.interval) !== 'sampled';
  const canDraw = points.length >= 2 && !reduced && visible;
  const windowSecs = mini ? 300 : Math.max(300, (latest?.time ?? 0) - (samples[0]?.time ?? 0) + snapshot.interval * 2);
  const selected = hover == null ? latest : nearestSample(samples, hover);
  const format = v => metric === 'cpuPercent' ? `${v.toFixed(0)}%` : `${v.toFixed(1)} GiB`;
  const keydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key) || !samples.length) return;
    event.preventDefault();
    const index = samples.indexOf(selected);
    const next = event.key === 'Home' ? 0 : ['End', 'Escape'].includes(event.key) ? samples.length - 1 : Math.min(samples.length - 1, Math.max(0, index + (event.key === 'ArrowLeft' ? -1 : 1)));
    setHover(samples[next].time);
  };
  return h('div', { ref: container, className: mini ? 'sampled-chart mini-chart' : 'sampled-chart' },
    !mini && h('div', { className: 'sample-chart-header' },
      h('div', { className: 'chart-metric-tabs', role: 'group', 'aria-label': 'Machine reading' },
        ...[['cpuPercent', 'CPU'], ['memoryUsed', 'System RAM']].map(([key, label]) => h('button', { key, type: 'button', 'aria-pressed': metric === key, onClick: () => { setMetric(key); setHover(null); } }, label))),
      h('span', { className: 'sample-reading' }, h(TextMorph, { duration: MOTION.text, ease: MOTION.ease, scale: false, disabled: instant() }, latest ? reading(latest.value, metric) : '—'))),
    h('div', { className: 'liveline-canvas', 'aria-hidden': true }, canDraw
      ? h(Liveline, { data: points, value: points.at(-1).value, window: windowSecs, theme, color, grid: !mini, badge: false, momentum: false, pulse: false, fill: false, scrub: !mini, paused: stale, lineWidth: 1.5, padding: mini ? { top: 5, right: 4, bottom: 5, left: 4 } : { top: 16, right: 68, bottom: 28, left: 10 }, formatValue: format, formatTime: clock, onHover: point => setHover(point?.time ?? null) })
      : h(StaticSamples, { points, color })),
    !mini && h('div', { className: 'sample-readout', tabIndex: 0, role: 'group', 'aria-label': 'Exact samples. Use left and right arrows to inspect readings.', onKeyDown: keydown },
      h('span', { className: 'sample-crosshair', 'aria-hidden': true }, '+'),
      h('span', null, hover == null ? 'Latest sample' : 'Nearest sample'),
      h('strong', null, selected ? `${clock(selected.time)} · ${reading(selected.value, metric)}` : 'Awaiting a reading'),
      h('span', { className: 'sample-cadence' }, stale ? 'Reading not current' : `Every ${snapshot.interval}s`)),
    !mini && h('p', { className: 'chart-method' }, reduced ? 'Sampled readings. Use the arrow keys on the readout to inspect each measurement.' : 'Curve interpolated between samples; the latest value is held until the next poll.'),
    mini && h('span', { className: 'sr-only' }, latest ? `Latest CPU sample: ${reading(latest.value, metric)}. Collected every ${snapshot.interval} seconds.` : 'Awaiting CPU samples'),
  );
}

export function reconcileInspector(markup) {
  const dialog = document.getElementById('inspector');
  morphdom(dialog, `<dialog>${markup}</dialog>`, {
    childrenOnly: true,
    getNodeKey: node => node.id || (node.dataset?.inspect ? `${node.dataset.inspect}:${node.dataset.key}` : node.dataset?.inspectorTab ? `tab:${node.dataset.inspectorTab}` : undefined),
    onBeforeElUpdated: (from, to) => !from.isEqualNode(to),
  });
}
