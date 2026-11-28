// The catalogue actor, one for the app: models, ECI and prices. It starts from openmerit-core's
// bundled snapshot and refreshes daily when the app has a refresh source. When a refresh adds a model
// or makes one cheaper, it tells every watched task which models changed, and each task starts a watch
// job only when one of them could beat what it has now (task.ts `watchTick`).
import { actor } from "rivetkit";
import type { Catalogue } from "../engine.ts";
import { catalogueChanges } from "../../job/pool.ts";
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

    /** Fetches a fresh catalogue and, when it added a model or made one cheaper, tells the watched tasks which. */
    refresh: async (c): Promise<{ version: string; changed: boolean; models: string[] }> => {
      const previous = c.state.catalogue ?? services().bundledCatalogue();
      const source = services().refreshCatalogue;
      if (!source) return { version: previous.version, changed: false, models: [] };
      const next = await source();
      c.state.catalogue = next;
      c.state.refreshedAt = new Date().toISOString();
      await c.saveState({ immediate: true });
      if (next.version === previous.version) return { version: previous.version, changed: false, models: [] };
      // The version is the day the catalogue was built, so it changes every day; only new and cheaper models matter.
      const models = catalogueChanges(previous, next);
      if (!models.length) return { version: next.version, changed: true, models };
      const client = c.client<Registry>();
      // After this action returns: a task's watch job reads the catalogue, which waits while this action runs.
      // One task's failure must not stop the others from hearing about the new catalogue.
      c.waitUntil(Promise.all(c.state.subscribers.map(subscriber => client.task.getOrCreate([subscriber.accountId, subscriber.taskId]).watchTick({ models })
        .catch((error: unknown) => { c.log.warn({ msg: "watch tick failed", task: subscriber.taskId, error: String(error) }); }))).then(() => undefined));
      return { version: next.version, changed: true, models };
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
