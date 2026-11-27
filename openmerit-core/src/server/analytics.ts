// Product analytics: one PostHog event per fact, posted with plain fetch. Fire-and-forget: it never
// throws and gives up after 2 s. Without a token (POSTHOG_PROJECT_TOKEN) it sends nothing.
// Events carry only enums, counts, durations and IDs: never prompts, bundles, keys or error text.
import { randomUUID } from "node:crypto";
import type { PostHogConfig } from "./config.ts";

/** Sends one event. The promise always resolves, so a caller may hold an actor awake on it but never awaits it in a request path. */
export function capture(config: PostHogConfig | null, event: string, distinctId: string, properties: Record<string, unknown>): Promise<void> {
  if (!config) return Promise.resolve();
  return fetch(`${config.host}/i/v0/e/`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(2000),
    body: JSON.stringify({ api_key: config.token, event, distinct_id: distinctId, timestamp: new Date().toISOString(), uuid: randomUUID(), properties }),
  }).then(response => { void response.body?.cancel(); }, () => undefined);
}
