import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createCollector, loadConfig } from './collect.mjs';
import { sampleSnapshot } from './sample.mjs';

const assets = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/flow.js', ['flow.js', 'text/javascript']], ['/flow.css', ['flow.css', 'text/css']], ['/styles.css', ['styles.css', 'text/css']], ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]]);
for (const file of ['baseten.png', 'groq.ico', 'cerebras.png', 'qwen.png', 'meta.ico', 'nomic.png', 'baai.png', 'ollama.png', 'lm-studio.png', 'vllm.png', 'anthropic.png', 'google.png', 'deepseek.ico', 'cohere.png', 'openai.png', 'mistral.png', 'openrouter.png']) assets.set(`/brands/${file}`, [`brands/${file}`, file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.ico') ? 'image/x-icon' : 'image/png']);

export async function startTerminal({ root = process.cwd(), port = 4310, interval = 15, demo = false, collect: customCollect, config } = {}) {
  const collect = customCollect ?? (demo ? async () => sampleSnapshot() : createCollector(root, config ?? await loadConfig(root), interval));
  let snapshot = await collect();
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { snapshot = await collect(); } catch { /* Keep timestamp: the interface marks stale data. */ }
    finally { busy = false; }
  }, interval * 1000);
  timer.unref();
  const server = createServer(async (request, response) => {
    const address = server.address();
    const validHosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
    const host = request.headers.host;
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
    const send = (code, body, type = 'application/json') => { response.writeHead(code, { ...headers, 'Content-Type': `${type}; charset=utf-8` }); response.end(body); };
    if (!validHosts.includes(host) || (request.headers.origin && request.headers.origin !== `http://${host}`) || request.headers['sec-fetch-site'] === 'cross-site') return send(403, '{"error":"Local access only"}');
    if (request.method !== 'GET') return send(405, '{"error":"Read-only terminal"}');
    let path;
    try { path = new URL(request.url, `http://${host}`).pathname; }
    catch { return send(400, '{"error":"Invalid request URL"}'); }
    if (path === '/api/snapshot') return send(200, JSON.stringify(snapshot));
    if (path === '/api/sample') return send(200, JSON.stringify(sampleSnapshot()));
    if (path === '/api/info') return send(200, JSON.stringify({ version: 1, defaultMode: demo ? 'sample' : 'live', interval }));
    const asset = assets.get(path);
    if (!asset) return send(404, '{"error":"Not found"}');
    try { return send(200, await readFile(fileURLToPath(new URL(`../public/${asset[0]}`, import.meta.url))), asset[1]); }
    catch { return send(500, '{"error":"Terminal assets unavailable. Run npm run build."}'); }
  });
  server.on('close', () => clearInterval(timer));
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { clearInterval(timer); throw error; }
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { clearInterval(timer); server.close(resolve); server.closeIdleConnections(); }) };
}
