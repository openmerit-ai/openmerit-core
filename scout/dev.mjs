import { createServer } from 'node:http';
import { readFile, stat, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { Readable } from 'node:stream';
import { setDefaultResultOrder } from 'node:dns';
import { createIndex, selectSnapshot } from './rank.mjs';
import { handleAPI } from './http.mjs';
import { handleMCP } from './mcp.mjs';
import { refreshSnapshot } from './sources.mjs';
import { createRecommender } from './recommend.mjs';
import { registry } from './registry.mjs';
import { scoutAccess } from './auth.mjs';
import { createProductAnalytics } from './product-analytics.mjs';
import '../scripts/build-web-analytics.mjs';

const root = resolve(import.meta.dirname, '../site');
const recommendTask = createRecommender({ apiKey: process.env.OPENAI_API_KEY });
const analyticsEnv = { ...process.env, POSTHOG_ENVIRONMENT: 'development' };
setDefaultResultOrder('ipv4first');
const cache = resolve(import.meta.dirname, '../.openmerit/scout/snapshot.json');
let snapshot;
try { snapshot = JSON.parse(await readFile(cache, 'utf8')); } catch { snapshot = JSON.parse(await readFile(new URL('./snapshot.json', import.meta.url), 'utf8')); }
const seed = JSON.parse(await readFile(new URL('./snapshot.json', import.meta.url), 'utf8'));
snapshot = selectSnapshot(seed, snapshot);
const localIndex = snapshot => createIndex({...snapshot,registry:snapshot.registry??registry,servingEngine:'evidence',publication:{id:`local-${snapshot.checkedAt}`}});
let index = localIndex(snapshot), refreshing = false, refreshState = { refreshStatus: 'idle', scheduler: 'local-hourly' };
async function refresh() {
  if (refreshing) return; refreshing = true; refreshState.refreshStatus = 'refreshing';
  try {
    const next = await refreshSnapshot(fetch, index.snapshot, { apiKey: process.env.OPENAI_API_KEY }); const nextIndex = localIndex(next);
    await mkdir(resolve(cache, '..'), { recursive: true }); await writeFile(`${cache}.tmp`, JSON.stringify(next)); await rename(`${cache}.tmp`, cache);
    index = nextIndex; refreshState = { refreshStatus: next.sources.some(s => s.status === 'failed') ? 'degraded' : 'idle', scheduler: 'local-hourly', lastAttemptAt: new Date().toISOString() };
    console.log(`Scout index refreshed: ${nextIndex.models.length} models.`);
  } catch (error) { refreshState = { refreshStatus: 'failed', scheduler: 'local-hourly', lastAttemptAt: new Date().toISOString(), refreshError: 'Source refresh failed; serving the last successful index.' }; console.error(error.message); }
  finally { refreshing = false; }
}
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webp': 'image/webp', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    // This server binds only to loopback. The local Amp portal proxy supplies
    // the external scheme after stripping client-supplied forwarding headers.
    const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const url = new URL(req.url, `${protocol}://${req.headers.host ?? 'localhost'}`);
    if ((url.pathname.startsWith('/scout/api/') || url.pathname === '/scout/mcp')) {
      const request = new Request(url, { method: req.method, headers: req.headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}) });
      const analytics = createProductAnalytics(request, analyticsEnv), mcp = url.pathname === '/scout/mcp';
      let response = await scoutAccess(request, analyticsEnv, analytics.identify) ?? (url.pathname === '/scout/api/analytics'
        ? await analytics.handleEvent()
        : url.pathname === '/scout/api/analytics/preference' ? await analytics.handlePreference()
        : await (mcp ? handleMCP : handleAPI)(request, index, refreshState, (...args) => recommendTask(...args, mcp ? 'mcp' : 'api', analytics.observeSearch), analytics.observeMCP));
      analytics.complete(response);
      response = analytics.response(response);
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    if (url.pathname === '/scout/task-evidence.json') { const body = await readFile(new URL('./task-evidence.json', import.meta.url)); res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : body); return; }
    let file = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(root + sep) && file !== root) { res.writeHead(404); res.end(); return; }
    if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
    const body = await readFile(file); res.writeHead(200, { 'Content-Type': `${mime[extname(file)] ?? 'application/octet-stream'}`, 'Cache-Control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404); res.end('Not found'); }
});
const port = Number(process.env.SCOUT_PORT || 45833);
server.listen(port, '127.0.0.1', () => console.log(`Scout: http://127.0.0.1:${port}/scout/`));
const timer = setInterval(refresh, 3600_000);
if (Date.now() - Date.parse(snapshot.checkedAt) > 3600_000) void refresh();
function shutdown() { clearInterval(timer); server.close(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
