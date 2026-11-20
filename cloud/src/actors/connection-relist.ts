// A connected app's listings, one actor per account and connection kind. Every listing goes through
// it, so only one runs at a time: Refresh, a read of a stale listing and the schedule each start one
// only when none is running, and none of them waits for it. Its Rivet cron lists the connection's
// tasks again every 15 minutes (`OPENMERIT_RELIST_MS`), so a task added or deleted in Viktor or
// Langfuse shows up without anyone pressing Refresh. Listing never starts an evaluation. A scheduled
// Viktor listing waits while one of the connection's jobs is running, since listing also deletes
// leftover copies. After three failed scheduled listings in a row the schedule lists at most hourly
// (`OPENMERIT_RELIST_BACKOFF_MS`); each failure is kept on the connection, as for Refresh. The
// schedule stops, and the actor is destroyed, when the connection is removed.
import { actor } from "rivetkit";
import { refreshLangfuse } from "../langfuse.ts";
import { services } from "../services.ts";
import type { AppClient, Registry } from "../registry.ts";
import { refreshViktor, VIKTOR } from "../viktor.ts";

const RELIST = "relist";
export const FAILURES_BEFORE_BACKOFF = 3;

interface RelistState { accountId: string; kind: string; failures: number; lastAt: number | null; last: string | null }

/** What one scheduled run did: started a listing, or why it skipped. */
export type RelistTick = { listed: true } | { listed: false; reason: string };

/** The listing each actor this process hosts is running, by account and kind. */
const running = new Map<string, Promise<string | null>>();

/** Starts a listing unless one is running. Resolves to the error kept on the connection, or null. */
function startListing(state: RelistState, client: AppClient, keep: (promise: Promise<unknown>) => void): { started: boolean; done: Promise<string | null> } {
  const key = `${state.accountId}:${state.kind}`;
  const current = running.get(key);
  if (current) return { started: false, done: current };
  const done = (state.kind === VIKTOR ? refreshViktor(client, state.accountId) : refreshLangfuse(client, state.accountId))
    .catch((error: unknown) => String(error)).finally(() => running.delete(key));
  running.set(key, done);
  keep(done);
  return { started: true, done };
}

export const connectionRelist = actor({
  createState: (_c, input: { accountId: string; kind: string }): RelistState => ({ ...input, failures: 0, lastAt: null, last: null }),
  actions: {
    /** Starts the schedule; calling it again changes nothing unless the interval changed. */
    arm: async (c): Promise<void> => {
      const interval = Math.max(5_000, services().config.relist.intervalMs);
      const current = await c.cron.get(RELIST);
      if (current && "intervalMs" in current && current.intervalMs === interval) return;
      await c.cron.every({ name: RELIST, interval, action: "tick", maxHistory: 20 });
    },
    info: async (c): Promise<RelistState & { armed: boolean; listing: boolean }> => ({ ...c.state, armed: !!(await c.cron.get(RELIST)), listing: running.has(`${c.state.accountId}:${c.state.kind}`) }),

    /** Refresh and a read of a stale listing: starts a listing unless one is running, and returns at once. */
    relist: (c): { started: boolean } => ({ started: startListing(c.state, c.client<Registry>(), promise => c.waitUntil(promise.then(() => undefined))).started }),
    /** Whether a listing is running. */
    listing: (c): boolean => running.has(`${c.state.accountId}:${c.state.kind}`),

    tick: async (c): Promise<RelistTick> => {
      const client = c.client<Registry>();
      const account = client.account.getOrCreate([c.state.accountId]);
      const connection = await account.connection(c.state.kind);
      if (!connection) {
        await c.cron.delete(RELIST).catch(() => false);
        c.destroy();
        return { listed: false, reason: "not connected" };
      }
      if (c.state.kind === VIKTOR) {
        const jobs = await account.connectionJobs({ kind: VIKTOR, since: 0 });
        if (jobs.some(job => job.status === "queued" || job.status === "running")) return { listed: false, reason: "a job is running" };
      }
      const now = Date.now();
      if (c.state.failures >= FAILURES_BEFORE_BACKOFF && c.state.lastAt !== null && now - c.state.lastAt < services().config.relist.backoffMs) return { listed: false, reason: "backing off after failures" };
      const { started, done } = startListing(c.state, client, () => undefined);
      if (!started) return { listed: false, reason: "a listing is running" };
      c.waitUntil(done.then(async error => {
        c.state.failures = error ? c.state.failures + 1 : 0;
        c.state.lastAt = now;
        c.state.last = error;
        await c.saveState({ immediate: true });
      }));
      return { listed: true };
    },

    /** For removing the connection: stops the schedule. */
    disarm: async (c): Promise<void> => {
      await c.cron.delete(RELIST).catch(() => false);
      c.destroy();
    },
  },
});
