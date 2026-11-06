import { json, readJSON } from './http.mjs';
import type { Measurement, MeasurementInput } from './agent/recommendation.ts';

export interface EvaluationStore {
  status(): Promise<unknown>;
  configure(config: unknown): Promise<unknown>;
  sync(): Promise<unknown>;
  disconnect(): Promise<unknown>;
  clear(): Promise<unknown>;
  measurements(): Promise<Measurement[]>;
  report(results: MeasurementInput[]): Promise<Measurement[]>;
}
export interface EvaluationNamespace { getByName(user: string): EvaluationStore }

// Only authored messages may reach clients; never upstream bodies or secrets.
export function evaluationError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : '';
  return /^(?:Langfuse |A Viewer key |A Langfuse request |Connect Langfuse |Connection cancelled|Sync cancelled|More than 100 experiments|Evaluation storage is full)/.test(message) ? message : null;
}

// Invoked only after the caller's browser session or device key is authenticated.
export async function handleEvaluations(request: Request, namespace: EvaluationNamespace | undefined, user: string): Promise<Response> {
  if (!namespace) return json({ error: 'Evaluation connections are unavailable.' }, 503);
  const path = new URL(request.url).pathname;
  const store = namespace.getByName(user);
  try {
    if (path === '/connect/api/langfuse') {
      if (request.method === 'GET') return json(await store.status());
      if (request.method === 'DELETE') return json(await store.disconnect());
      if (request.method === 'POST') {
        if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'Use application/json.' }, 415);
        let config: unknown;
        try { config = await readJSON(request); } catch { return json({ error: 'Invalid Langfuse settings. Use a JSON object.' }, 400); }
        return json(await store.configure(config));
      }
    }
    if (path === '/connect/api/langfuse/sync' && request.method === 'POST') return json(await store.sync());
    if (path === '/connect/api/evaluations' && request.method === 'DELETE') return json(await store.clear());
    return json({ error: 'Not found.' }, 404);
  } catch (error) {
    return json({ error: evaluationError(error) ?? 'Evaluation connection failed. Please check your settings and try again.' }, 400);
  }
}
