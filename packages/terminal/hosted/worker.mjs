import { sampleSnapshot } from '../src/sample.mjs';

// This entry point deliberately imports no collector, CLI, filesystem, or provider client.
const headers = {
  'Cache-Control': 'no-cache, no-transform',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
// Link-preview crawlers may read the card while general crawling stays excluded.
const robots = `User-agent: Twitterbot
User-agent: facebookexternalhit
User-agent: LinkedInBot
User-agent: Slackbot
User-agent: Discordbot
User-agent: TelegramBot
User-agent: WhatsApp
Disallow: /api/
Allow: /

User-agent: *
Disallow: /
`;
let sampleBody;
let sampleTime;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export default {
  async fetch(request, env) {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Read-only preview', { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } });
    const path = new URL(request.url).pathname;
    let response;
    if (path === '/api/info') response = json({ version: 1, defaultMode: 'sample', hostedSample: true, interval: 15 });
    else if (path === '/api/sample') {
      const now = Math.floor(Date.now() / 15000) * 15000;
      if (!sampleBody || sampleTime !== now) { sampleBody = JSON.stringify(sampleSnapshot(now)); sampleTime = now; }
      response = new Response(sampleBody, { headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    } else if (path.startsWith('/api/')) response = json({ error: 'This preview contains fictional sample data only.' }, 404);
    else if (path === '/robots.txt') response = new Response(robots, { headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
    else {
      const asset = await env.ASSETS.fetch(request);
      response = new Response(asset.body, asset);
      for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
      // Keep HTML untouched by zone-level injection, but allow scripts/styles to compress.
      const contentType = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
      if (['text/javascript', 'application/javascript', 'text/css'].includes(contentType)) response.headers.set('Cache-Control', 'no-cache');
    }
    return request.method === 'HEAD' ? new Response(null, response) : response;
  },
};
