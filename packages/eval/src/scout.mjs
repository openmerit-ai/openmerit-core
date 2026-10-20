import { digest, saveJSON, statePath } from './config.mjs';
import { join } from 'node:path';

export const selectionHash = config => digest({ scope: config.scope, connections: config.connections, tasks: config.tasks.map(t => ({ id: t.id, description: t.description })), scoutURL: config.scoutURL });
export async function makePlan(config, fetcher = fetch) {
  if (!['existing', 'all'].includes(config.scope)) throw new Error('Choose a scope with eval plan --scope existing or --scope all. Existing means the connections declared for this project.');
  const modelIds = [...new Set(config.connections.map(c => c.scoutId))];
  if (config.scope === 'existing' && !modelIds.length) throw new Error('Declare project connections in .openmerit/eval.json first. No credentials are sent to Scout.');
  const tasks = [];
  for (const task of config.tasks) {
    const response = await fetcher(config.scoutURL ?? 'https://openmerit.ai/scout/api/recommend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: task.description, ...(config.scope === 'existing' ? { modelIds } : {}) }), signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (!response.ok) throw new Error(`Scout returned HTTP ${response.status}; no evaluation was started.`);
    const body = await response.json();
    if (!Array.isArray(body.recommendations) || body.recommendations.length > 5) throw new Error('Invalid Scout response.');
    if (config.scope === 'existing' && (!Array.isArray(body.selection?.modelIds) || digest([...body.selection.modelIds].sort()) !== digest([...modelIds].sort()))) throw new Error('Scout did not acknowledge filtering before ranking. Update the Scout endpoint; no unscoped fallback is allowed.');
    const seen = new Set();
    const candidates = body.recommendations.map(m => {
      if (typeof m.id !== 'string' || seen.has(m.id) || config.scope === 'existing' && !modelIds.includes(m.id)) throw new Error('Invalid Scout model selection.');
      seen.add(m.id);
      return { scoutId: m.id, name: m.name, rank: m.rank, connections: config.connections.filter(c => c.scoutId === m.id).map(c => c.id) };
    });
    tasks.push({ id: task.id, candidates, ranking: body.ranking, warnings: body.warnings ?? [] });
  }
  return { version: 1, createdAt: new Date().toISOString(), scope: config.scope, selectionHash: selectionHash(config), tasks };
}
export async function savePlan(root, plan) { await saveJSON(join(root, statePath, 'plan.json'), plan); }
export function validatePlan(config, plan) {
  if (plan.selectionHash !== selectionHash(config)) throw new Error('Task descriptions, scope or connections changed. Run eval plan again.');
  if (!Array.isArray(plan.tasks) || plan.tasks.length !== config.tasks.length) throw new Error('Incomplete evaluation plan. Run eval plan again.');
  for (const task of config.tasks) {
    const entry = plan.tasks.find(t => t.id === task.id);
    if (!entry?.candidates?.length) throw new Error(`Scout has no supported candidates for ${task.id}. Broaden scope or revise the task description.`);
    for (const model of entry.candidates) {
      if (!model.connections.length || model.connections.some(id => !config.connections.some(c => c.id === id && c.scoutId === model.scoutId))) throw new Error(`Configure an authenticated agent connection for ${model.scoutId}, then plan again. All-model discovery does not grant endpoint access.`);
    }
  }
}
