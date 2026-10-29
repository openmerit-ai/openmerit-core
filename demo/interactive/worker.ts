import { getContainer } from '@cloudflare/containers';
import { limitedText, response } from '../security.mjs';
import { MODELS, ROUTES, STEPS, DEFAULTS, LIMITS, DECISION_MODELS, casesFor, BUILD, constraints } from './scenario.ts';
import { prepareCall, callProvider } from './provider.ts';
import type { PreparedCall } from './provider.ts';
import { discoverCatalog } from './catalog.ts';
import type { DemoSession } from '../admission.ts';

interface Sandbox { configure(config: DemoSession & { origin: string }): Promise<void>; fetch(request: Request): Promise<Response>; expire(): Promise<void> }
interface Gate { get(id: string): Promise<DemoSession | null>; create(ip: string, task: string): Promise<DemoSession>; reserve(id: string, token: string, cost: number): Promise<boolean>; close(id: string): Promise<void> }
export interface InteractiveEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DEMO_INTERACTIVE_ENABLED?: string; DEMO_OPENAI_API_KEY?: string; DEMO_OPENROUTER_API_KEY?: string;
  DEMO_GATE: { getByName(name: string): Gate };
  DEMO_CONTAINER: Parameters<typeof getContainer>[0];
}
let catalogCache: { expires: number; promise: ReturnType<typeof discoverCatalog> } | undefined;
async function providerCatalog(env: InteractiveEnv) {
  if (!catalogCache || catalogCache.expires < Date.now()) catalogCache = { expires: Date.now() + 300000, promise: discoverCatalog({ openaiKey: env.DEMO_OPENAI_API_KEY, openrouterKey: env.DEMO_OPENROUTER_API_KEY }) };
  return catalogCache.promise;
}
const registry = (env: InteractiveEnv) => env.DEMO_GATE.getByName('interactive-admission-v1');
const cookie = (id: string, age = LIMITS.lifetimeSeconds) => `openmerit_interactive=${id}; Path=/demo; Max-Age=${age}; HttpOnly; Secure; SameSite=Strict`;
const readCookie = (request: Request) => request.headers.get('Cookie')?.match(/(?:^|;\s*)openmerit_interactive=([a-f0-9]{64})(?:;|$)/)?.[1] ?? null;
const assets = new Set(['/demo', '/demo/', '/demo/index.html', '/demo/interactive.js', '/demo/interactive.css']);
export async function handleInteractiveRequest(request: Request, env: InteractiveEnv): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname;
  if (assets.has(path)) {
    if (!['GET', 'HEAD'].includes(request.method)) return response({ error: 'Method not allowed.' }, 405);
    return env.ASSETS.fetch(request);
  }
  const internal = path.match(/^\/demo\/internal\/([a-f0-9]{64})\/(infer|catalog)$/);
  const allowed: Record<string, string[]> = { '/demo/api/config': ['GET'], '/demo/api/session': ['GET', 'POST', 'DELETE'], '/demo/api/preview': ['POST'], '/demo/api/compare': ['POST'], '/demo/api/approve': ['POST'], '/demo/api/try': ['POST'], '/demo/api/evidence': ['GET'] };
  if (!internal && !allowed[path]?.includes(request.method)) return null;
  if (url.searchParams.has('task')) return null;
  const enabled = env.DEMO_INTERACTIVE_ENABLED === 'true' && !!env.DEMO_OPENAI_API_KEY && !!env.DEMO_OPENROUTER_API_KEY;
  if (path === '/demo/api/config') return response({ enabled, models: MODELS, routes: ROUTES, steps: STEPS, defaults: DEFAULTS, limits: LIMITS, decisionModels: DECISION_MODELS, cases: casesFor(DEFAULTS), build: BUILD });
  if (!enabled) return response({ error: 'Live inference is currently unavailable. Please try again later.' }, 503);
  try {
    if (internal) {
      if (request.method !== (internal[2] === 'catalog' ? 'GET' : 'POST')) return response({ error: 'Not found.' }, 404);
      const token = request.headers.get('Authorization')?.replace(/^Bearer /, ''), gate = registry(env);
      const session = await gate.get(internal[1]!);
      if (!session || session.task !== 'constraints' || session.token !== token) return response({ error: 'Session expired.' }, 403);
      if (internal[2] === 'catalog') return response(await providerCatalog(env));
      const call = JSON.parse(await limitedText(request, 12000)) as PreparedCall;
      const models = { ...MODELS };
      if (!Object.hasOwn(models, call.modelKey)) for (const model of (await providerCatalog(env)).models) models[model.key] = model;
      const { reservation } = prepareCall(call, models);
      if (!await gate.reserve(session.id, token!, reservation)) return response({ error: 'Session inference allowance reached.' }, 429);
      const result = await callProvider(call, { models, openaiKey: env.DEMO_OPENAI_API_KEY, openrouterKey: env.DEMO_OPENROUTER_API_KEY });
      if (result.cost > reservation) return response({ error: 'Inference charge exceeded its reservation.' }, 502);
      return response(result);
    }
    if (['POST', 'DELETE'].includes(request.method) && request.headers.get('Origin') !== url.origin) return response({ error: 'Origin is not allowed.' }, 403);
    const gate = registry(env), id = readCookie(request);
    let session = id ? await gate.get(id) : null;
    if (path === '/demo/api/session' && request.method === 'POST') {
      if (session) return await (getContainer(env.DEMO_CONTAINER, session.id) as Sandbox).fetch(new Request('http://container/demo/api/session'));
      const input = JSON.parse(await limitedText(request, 1000)) as { confirmed?: boolean };
      if (input.confirmed !== true) return response({ error: 'Start the experiment to authorize its bounded calls.' }, 400);
      session = await gate.create(request.headers.get('CF-Connecting-IP') ?? 'unknown', 'constraints');
      const sandbox = getContainer(env.DEMO_CONTAINER, session.id) as Sandbox;
      try {
        await sandbox.configure({ ...session, origin: url.origin });
        const result = await sandbox.fetch(new Request('http://container/demo/api/session', { method: 'POST' }));
        if (!result.ok) throw new Error('Container could not start.');
        const snapshot = await result.json() as { build?: string };
        if (snapshot?.build !== BUILD) throw new Error('Container update is still rolling out.');
        return response(snapshot, 201, { 'Set-Cookie': cookie(session.id) });
      } catch {
        await gate.close(session.id); await sandbox.expire().catch(() => {});
        return response({ error: 'The demo container could not start. Please try again.' }, 503);
      }
    }
    if ((!session || session.task !== 'constraints') && path === '/demo/api/session' && request.method === 'GET') return response(null);
    if (!session || session.task !== 'constraints') return response({ error: 'Start a new demo session.' }, 410);
    const sandbox = getContainer(env.DEMO_CONTAINER, session.id) as Sandbox;
    if (request.method === 'DELETE') { await gate.close(session.id); await sandbox.expire(); return response({ stopped: true }, 200, { 'Set-Cookie': cookie('', 0) }); }
    const payload = request.method === 'POST' ? await limitedText(request, 2000) : undefined;
    if (path === '/demo/api/compare') constraints((JSON.parse(payload!) as { constraints: Record<string, unknown> }).constraints);
    return await sandbox.fetch(new Request('http://container' + path, { method: request.method, headers: { 'Content-Type': 'application/json' }, ...(payload ? { body: payload } : {}) }));
  } catch (error) {
    const message = (error as Error).message;
    const known = /allowance|busy|threshold|requirement|Response time|yes\/no/.test(message);
    return response({ error: known ? message : 'The request could not complete. Check the trace or try again shortly.' }, /allowance|busy/.test(message) ? 429 : 400);
  }
}
