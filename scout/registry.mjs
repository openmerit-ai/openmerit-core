import seed from './registry.json' with { type: 'json' };
import { digest } from './utils.mjs';
export const registry = seed;
export function validateRegistry(value) {
  const ids = new Set();
  if (!value || !Array.isArray(value.capabilities) || !value.capabilities.length) throw new Error('Missing capability registry.');
  for (const c of value.capabilities) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(c.id) || ids.has(c.id) || typeof c.label !== 'string' || !c.label || typeof c.task !== 'string' || !c.task || typeof c.benchmark !== 'string' || !c.benchmark) throw new Error('Invalid capability definition.');
    ids.add(c.id);
  }
  for (const c of value.capabilities) {
    const seen = new Set([c.id]); let parent = c.parent;
    while (parent) {
      if (!ids.has(parent) || seen.has(parent)) throw new Error('Invalid capability hierarchy.');
      seen.add(parent); parent = value.capabilities.find(x => x.id === parent).parent;
    }
  }
  return value;
}
export const registryHash = value => digest(value.capabilities.map(({ id, task, benchmark, parent }) => ({ id, task, benchmark, parent })));
export const labels = value => Object.fromEntries(value.capabilities.map(c => [c.id, { label: c.label, terms: [] }]));
