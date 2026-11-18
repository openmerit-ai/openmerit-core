// The catalogue actor, one for the app: models, ECI and prices. It starts from openmerit-core's
// bundled snapshot and refreshes daily when the app has a refresh source. When the version
// changes, it tells every watched task, which decides whether to start a watch job.
import { actor } from "rivetkit";
import type { Catalogue } from "../engine.ts";
import { services } from "../services.ts";
import type { Registry } from "../registry.ts";

const REFRESH = "refresh";
const DAY_MS = 24 * 60 * 60 * 1000;

interface CatalogueState { catalogue: Catalogue | null; refreshedAt: string | null; subscribers: { accountId: string; taskId: string }[] }

export const catalogue = actor({
  state: { catalogue: null, refreshedAt: null, subscribers: [] } as CatalogueState,
  onCreate: async c => { await c.cron.every({ name: REFRESH, interval: DAY_MS, action: "refresh", maxHistory: 30 }); },
  actions: {
    get: (c): Catalogue => c.state.catalogue ?? services().bundledCatalogue(),
    version: (c): string => (c.state.catalogue ?? services().bundledCatalogue()).version,

    /** Fetches a fresh catalogue and, when its version changed, tells the watched tasks. */
    refresh: async (c): Promise<{ version: string; changed: boolean }> => {
      const before = (c.state.catalogue ?? services().bundledCatalogue()).version;
      const source = services().refreshCatalogue;
      if (!source) return { version: before, changed: false };
      const next = await source();
      c.state.catalogue = next;
      c.state.refreshedAt = new Date().toISOString();
      await c.saveState({ immediate: true });
      if (next.version === before) return { version: before, changed: false };
      const client = c.client<Registry>();
      // After this action returns: a task's watch job reads the catalogue, which waits while this action runs.
      // One task's failure must not stop the others from hearing about the new catalogue.
      c.waitUntil(Promise.all(c.state.subscribers.map(subscriber => client.task.getOrCreate([subscriber.accountId, subscriber.taskId]).watchTick()
        .catch((error: unknown) => { c.log.warn({ msg: "watch tick failed", task: subscriber.taskId, error: String(error) }); }))).then(() => undefined));
      return { version: next.version, changed: true };
    },

    subscribe: async (c, input: { accountId: string; taskId: string }): Promise<void> => {
      if (!c.state.subscribers.some(item => item.accountId === input.accountId && item.taskId === input.taskId)) c.state.subscribers.push(input);
      await c.saveState({ immediate: true });
    },
    unsubscribe: async (c, input: { accountId: string; taskId?: string }): Promise<void> => {
      c.state.subscribers = c.state.subscribers.filter(item => item.accountId !== input.accountId || (input.taskId !== undefined && item.taskId !== input.taskId));
      await c.saveState({ immediate: true });
    },
  },
});
