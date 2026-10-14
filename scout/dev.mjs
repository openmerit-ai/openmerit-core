import { createServer } from 'node:http';
import { readFile, stat, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { Readable } from 'node:stream';
import { setDefaultResultOrder } from 'node:dns';
import { createIndex } from './rank.mjs';
import { handleAPI } from './http.mjs';
import { handleMCP } from './mcp.mjs';
import { refreshSnapshot } from './sources.mjs';
import { createRecommender } from './recommend.mjs';

const root = resolve(import.meta.dirname, '../site');
const recommendTask = createRecommender({ apiKey: process.env.OPENAI_API_KEY });
setDefaultResultOrder('ipv4first');
const cache = resolve(import.meta.dirname, '../.openmerit/scout/snapshot.json');
let snapshot;
try { snapshot = JSON.parse(await readFile(cache, 'utf8')); } catch { snapshot = JSON.parse(await readFile(new URL('./snapshot.json', import.meta.url), 'utf8')); }
const seed = JSON.parse(await readFile(new URL('./snapshot.json', import.meta.url), 'utf8'));
if (Date.parse(seed.checkedAt) > Date.parse(snapshot.checkedAt)) snapshot = seed;
let index = createIndex(snapshot), refreshing = false, refreshState = { refreshStatus: 'idle', scheduler: 'local-hourly' };
async function refresh() {
  if (refreshing) return; refreshing = true; refreshState.refreshStatus = 'refreshing';
  try {
    const next = await refreshSnapshot(fetch, index.snapshot); const nextIndex = createIndex(next);
    await mkdir(resolve(cache, '..'), { recursive: true }); await writeFile(`${cache}.tmp`, JSON.stringify(next)); await rename(`${cache}.tmp`, cache);
    index = nextIndex; refreshState = { refreshStatus: next.sources.some(s => s.status === 'failed') ? 'degraded' : 'idle', scheduler: 'local-hourly', lastAttemptAt: new Date().toISOString() };
    console.log(`Scout index refreshed: ${nextIndex.models.length} models.`);
  } catch (error) { refreshState = { refreshStatus: 'failed', scheduler: 'local-hourly', lastAttemptAt: new Date().toISOString(), refreshError: 'Source refresh failed; serving the last successful index.' }; console.error(error.message); }
  finally { refreshing = false; }
}
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webp': 'image/webp', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if ((url.pathname.startsWith('/scout/api/') || url.pathname === '/scout/mcp')) {
      const request = new Request(url, { method: req.method, headers: req.headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}) });
      const response = await (url.pathname === '/scout/mcp' ? handleMCP : handleAPI)(request, index, refreshState, recommendTask);
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
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
