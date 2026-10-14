import { DurableObject } from 'cloudflare:workers';
import snapshot from './snapshot.json';
import { createIndex } from './rank.mjs';
import { handleAPI } from './http.mjs';
import { handleMCP } from './mcp.mjs';
import { refreshSnapshot } from './sources.mjs';

// One durable snapshot. No user prompts, accounts, history, queues, or inference calls.
export class ScoutIndex extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS scout_snapshot (id INTEGER PRIMARY KEY, data TEXT NOT NULL, state TEXT NOT NULL)');
    const stored = ctx.storage.sql.exec('SELECT data, state FROM scout_snapshot WHERE id = 1').toArray()[0];
    const saved = stored ? JSON.parse(stored.data) : snapshot;
    this.index = createIndex(Date.parse(snapshot.checkedAt) > Date.parse(saved.checkedAt) ? snapshot : saved);
    this.state = stored ? JSON.parse(stored.state) : { refreshStatus: 'seed', scheduler: 'cloudflare-hourly' };
  }
  async refresh() {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        const next = await refreshSnapshot(fetch, this.index.snapshot); const index = createIndex(next);
        const state = { refreshStatus: next.sources.some(s => s.status === 'failed') ? 'degraded' : 'idle', scheduler: 'cloudflare-hourly', lastAttemptAt: new Date().toISOString() };
        this.ctx.storage.sql.exec('INSERT OR REPLACE INTO scout_snapshot (id, data, state) VALUES (1, ?, ?)', JSON.stringify(next), JSON.stringify(state));
        this.index = index; this.state = state;
      } catch {
        this.state = { refreshStatus: 'failed', scheduler: 'cloudflare-hourly', lastAttemptAt: new Date().toISOString(), refreshError: 'Source refresh failed; serving the last successful index.' };
        this.ctx.storage.sql.exec('INSERT OR REPLACE INTO scout_snapshot (id, data, state) VALUES (1, ?, ?)', JSON.stringify(this.index.snapshot), JSON.stringify(this.state));
      } finally { this.pending = null; }
    })();
    return this.pending;
  }
  fetch(request) {
    if (this.state.refreshStatus === 'seed') this.ctx.waitUntil(this.refresh());
    return (new URL(request.url).pathname === '/scout/mcp' ? handleMCP : handleAPI)(request, this.index, this.state); }
}

export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    if ((path.startsWith('/scout/api/') || path === '/scout/mcp')) return env.SCOUT_INDEX.getByName('scout-v1').fetch(request);
    if (path === '/' || path === '/memo/' || path === '/memo') return Response.redirect(`https://openmerit.ai${path}`, 302);
    return env.ASSETS.fetch(request);
  },
  scheduled(_event, env, ctx) { ctx.waitUntil(env.SCOUT_INDEX.getByName('scout-v1').refresh()); },
};
