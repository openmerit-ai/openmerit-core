import { DurableObject } from 'cloudflare:workers';
import { Container, getContainer } from '@cloudflare/containers';
import { harnessModel, limits, taskPolicy, getTask } from './runtime/config.mjs';
import { inferenceRequest, decisionRequest, limitedText, readSessionCookie, sessionCookie, sessionReservationLimit, response } from './security.mjs';

const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
// Keep this name stable across releases so public allowances survive deployment.
const registry = env => env.DEMO_GATE.getByName('demo-admission-public-v1');

export class DemoGate extends DurableObject {
  async create(ip, task = 'support') {
    getTask(task);
    return this.ctx.storage.transaction(async storage => {
      const today = new Date().toISOString().slice(0, 10), now = Date.now();
      let day = await storage.get('day');
      if (day?.date !== today) day = { date: today, count: 0, networks: {}, salt: random() };
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(day.salt + ip))), b => b.toString(16).padStart(2, '0')).join('');
      const sessions = (await storage.get('sessions') ?? []).filter(s => s.expiresAt > now && !s.closed);
      if (day.count >= limits.dailySessions || (day.networks[hash] ?? 0) >= 3) throw new Error('Today’s demo allowance is used. Please try again tomorrow.');
      if (sessions.length >= limits.concurrentSessions) throw new Error('Both demo sandboxes are busy. Please try again in a few minutes.');
      const session = { id: random(), token: random(), task, createdAt: now, expiresAt: now + limits.lifetimeSeconds * 1000, requests: 0, reserved: 0 };
      sessions.push(session); day.count++; day.networks[hash] = (day.networks[hash] ?? 0) + 1;
      await storage.put({ day, sessions });
      return session;
    });
  }
  async get(id) { return (await this.ctx.storage.get('sessions') ?? []).find(s => s.id === id && !s.closed && s.expiresAt > Date.now()) ?? null; }
  async close(id) {
    await this.ctx.storage.transaction(async storage => {
      const sessions = await storage.get('sessions') ?? [];
      await storage.put('sessions', sessions.map(s => s.id === id ? { ...s, closed: true } : s));
    });
  }
  async reserve(id, token, cost) {
    return this.ctx.storage.transaction(async storage => {
      const sessions = await storage.get('sessions') ?? [];
      const s = sessions.find(s => s.id === id && s.token === token && !s.closed && s.expiresAt > Date.now());
      if (!s) return false;
      if (s.requests >= limits.maxRequests || s.reserved + cost > sessionReservationLimit) return false;
      s.requests++; s.reserved += cost;
      await storage.put('sessions', sessions); return true;
    });
  }
}

export class DemoContainer extends Container {
  defaultPort = 45832;
  sleepAfter = '11m';
  async configure(config) {
    if (await this.ctx.storage.get('config')) throw new Error('Session already configured.');
    await this.ctx.storage.put('config', config);
    await this.schedule(new Date(config.expiresAt), 'expire');
  }
  async expire() {
    await this.ctx.storage.put('expired', true);
    await this.destroy();
  }
  async fetch(request) {
    const config = await this.ctx.storage.get('config');
    if (!config || await this.ctx.storage.get('expired') || Date.now() >= config.expiresAt) return response({ error: 'This sandbox session has ended.' }, 410);
    await this.startAndWaitForPorts({ ports: 45832, startOptions: { envVars: {
      DEMO_PROXY_TOKEN: config.token,
      DEMO_INFERENCE_URL: `${config.origin}/demo/internal/${config.id}/chat/completions`,
      DEMO_DECISIONS_URL: `${config.origin}/demo/internal/${config.id}/decisions`,
      DEMO_TASK: config.task ?? 'support',
      DEMO_BUILD: this.env.DEMO_BUILD ?? 'development',
    } }, cancellationOptions: { instanceGetTimeoutMS: 30000, portReadyTimeoutMS: 30000 } });
    return this.containerFetch(request);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname;
    if (!path.startsWith('/demo/api/') && !path.startsWith('/demo/internal/')) return env.ASSETS.fetch(request);
    try {
      const internal = path.match(/^\/demo\/internal\/([a-f0-9]{64})\/(chat\/completions|decisions)$/);
      if (internal) {
        if (request.method !== 'POST' || !env.OPENROUTER_API_KEY) return response({ error: 'Unavailable.' }, 503);
        const token = request.headers.get('Authorization')?.replace(/^Bearer /, '');
        const session = await registry(env).get(internal[1]);
        if (!session || token !== session.token) return response({ error: 'Session expired.' }, 403);
        const decisions = internal[2] === 'decisions';
        const raw = await limitedText(request, decisions ? 6000 : limits.maxInputBytes);
        const prepare = decisions ? decisionRequest : inferenceRequest;
        const { body, reservation } = prepare(JSON.parse(raw), new TextEncoder().encode(raw).length, session.task ?? 'support');
        if (!await registry(env).reserve(internal[1], token, reservation)) return response({ error: 'Session inference allowance reached.' }, 429);
        const upstream = await fetch(decisions ? 'https://openrouter.ai/api/alpha/decisions' : 'https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST', headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://openmerit.site/demo', 'X-Title': 'OpenMerit supervised demo' },
          body: JSON.stringify(body), signal: AbortSignal.timeout(90000),
        });
        return new Response(upstream.body, { status: upstream.status, headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json', 'Cache-Control': 'no-store' } });
      }
      if (path.startsWith('/demo/internal/')) return response({ error: 'Not found.' }, 404);
      if (path === '/demo/api/config' && request.method === 'GET') {
        const task = getTask(url.searchParams.get('task') ?? 'support');
        return response({ enabled: env.DEMO_ENABLED === 'true' && !!env.OPENROUTER_API_KEY,
          task:task.id, models:task.models, harnessModel, sampleCount: task.sampleCount ?? 24, verificationCount: task.verificationCount ?? 6, policy:taskPolicy(task.id), limits:{...limits,maxOutputTokens:task.maxOutputTokens ?? limits.maxOutputTokens}, build: env.DEMO_BUILD });
      }
      if (env.DEMO_ENABLED !== 'true' || !env.OPENROUTER_API_KEY) return response({ error: 'The live demo is not available yet.' }, 503);
      if (['POST', 'DELETE'].includes(request.method) && request.headers.get('Origin') !== url.origin) return response({ error: 'Origin is not allowed.' }, 403);
      let id = readSessionCookie(request), session = id ? await registry(env).get(id) : null;
      if (path === '/demo/api/session' && request.method === 'POST') {
        const input = JSON.parse(await limitedText(request, 1000));
        if (input.confirmed !== true) return response({ error: 'Confirm the demo policy first.' }, 400);
        const task = getTask(input.task ?? 'support');
        if (session) return response({ error: 'You already have a running session. Resume it or end it first.' }, 409);
        session = await registry(env).create(request.headers.get('CF-Connecting-IP') ?? 'unknown', task.id); id = session.id;
        const sandbox = getContainer(env.DEMO_CONTAINER, id);
        try {
          await sandbox.configure({ ...session, origin: url.origin });
          const result = await sandbox.fetch(new Request('http://container/demo/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({confirmed:true,task:task.id}) }));
          if (!result.ok) throw new Error('The sandbox could not start its workflow.');
          return new Response(result.body, { status: 201, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie(id) } });
        } catch (error) {
          await registry(env).close(id); await sandbox.expire().catch(() => {});
          return response({ error: 'The sandbox could not start. Please try again later.' }, 503);
        }
      }
      if (!session) return response({ error: 'Start a new demo session.' }, 410);
      const allowed = { '/demo/api/session': ['GET', 'DELETE'], '/demo/api/approve': ['POST'], '/demo/api/try': ['POST'], '/demo/api/evidence': ['GET'] };
      if (!allowed[path]?.includes(request.method)) return response({ error: 'Not found.' }, 404);
      const sandbox = getContainer(env.DEMO_CONTAINER, id);
      if (request.method === 'DELETE') {
        await registry(env).close(id); await sandbox.expire();
        return response({ stopped: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
      }
      const payload = request.method === 'POST' ? await limitedText(request, 6000) : undefined;
      return await sandbox.fetch(new Request('http://container' + path, { method: request.method, headers: { 'Content-Type': 'application/json' }, ...(payload ? { body: payload } : {}) }));
    } catch {
      return response({ error: 'The request could not be completed. The demo may be busy or its allowance used.' }, 400);
    }
  },
};
