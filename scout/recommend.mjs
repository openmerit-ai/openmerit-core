import { classifyPrompt, validatePrompt } from './decisions.mjs';
import { recommend } from './rank.mjs';

// Shared by HTTP and MCP; bounded admission without accounts, queues or history.
export function createRecommender({ apiKey, fetcher = fetch, now = Date.now, timeoutMs = 4000 } = {}) {
  let inFlight = 0, windowStart = now(), requests = 0;
  return async (index, prompt) => {
    prompt = validatePrompt(prompt);
    if (now() - windowStart >= 60_000) { windowStart = now(); requests = 0; }
    if (inFlight >= 8 || requests >= 120) {
      const error = new Error('Scout is busy. Please try again shortly.'); error.status = 429; throw error;
    }
    requests++; inFlight++;
    try {
      let interpreted;
      try { interpreted = await classifyPrompt(prompt, { apiKey, fetcher, timeoutMs }); }
      catch { const error = new Error('Scout could not interpret this task right now. Please try again.'); error.status = 503; throw error; }
      const result = recommend(index, prompt, now(), interpreted.task);
      return { ...result, interpretationMs: interpreted.elapsedMs };
    } finally { inFlight--; }
  };
}
