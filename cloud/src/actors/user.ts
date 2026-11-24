// The user actor, one per Clerk user across their organizations: the member's own Claude and ChatGPT
// subscriptions, a sign-in waiting to finish, and which of them writes their tasks' cases. Tokens are
// encrypted with OPENMERIT_KEY_ENCRYPTION_KEY, with `user:<id>` as associated data, and leave the
// actor only for a job's memory (`writer`); no list or export returns them.
import { actor } from "rivetkit";
import { db } from "rivetkit/db";
import { decryptKey, encryptKey } from "../keys.ts";
import { services } from "../services.ts";
import {
  chatgptDeviceCode, chatgptPoll, CLAUDE_SIGN_IN_TTL_MS, claudeExchange, claudeSignIn, PROVIDER_NAMES, refreshSubscription, SUBSCRIPTION_PROVIDERS,
  type CaseWriter, type DeviceCode, type SubscriptionCredential, type SubscriptionProvider,
} from "../subscriptions.ts";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS subscriptions (provider TEXT PRIMARY KEY, sealed TEXT NOT NULL, connected_at INTEGER NOT NULL, refreshed_at INTEGER, last_error TEXT)`,
  `CREATE TABLE IF NOT EXISTS sign_ins (provider TEXT PRIMARY KEY, sealed TEXT NOT NULL, started_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), writer TEXT NOT NULL DEFAULT 'openmerit')`,
];

/** Renew an access token this long before it expires, so a job's calls do not outlive it. */
const RENEW_BEFORE_MS = 10 * 60_000;

/** What the account settings page shows: never a token. */
export interface SubscriptionView { provider: SubscriptionProvider; name: string; connected: boolean; connectedAt: string | null; problem: string | null; signIn: { startedAt: string; userCode: string | null; verificationUri: string | null; url: string | null } | null }
export interface SubscriptionsView { writer: CaseWriter; subscriptions: SubscriptionView[] }

type Database = { execute: (query: string, ...args: unknown[]) => Promise<Record<string, unknown>[]> };
type Pending = { kind: "claude"; verifier: string; url: string } | ({ kind: "chatgpt" } & DeviceCode);

const iso = (ms: unknown) => (typeof ms === "number" ? new Date(ms).toISOString() : null);
const sealKey = () => {
  const key = services().config.keyEncryptionKey;
  if (!key) throw new Error("Subscriptions are not available yet: the app has no key-encryption key.");
  return key;
};
const seal = (userId: string, value: unknown) => encryptKey(sealKey(), `user:${userId}`, JSON.stringify(value));
const unseal = <T>(userId: string, sealed: unknown): T => JSON.parse(decryptKey(sealKey(), `user:${userId}`, String(sealed))) as T;

async function view(database: Database, userId: string): Promise<SubscriptionsView> {
  const [settings] = await database.execute(`SELECT writer FROM settings WHERE id = 1`);
  const rows = new Map((await database.execute(`SELECT * FROM subscriptions`)).map(row => [String(row.provider), row]));
  const pending = new Map((await database.execute(`SELECT * FROM sign_ins`)).map(row => [String(row.provider), row]));
  return {
    writer: (settings?.writer as CaseWriter | undefined) ?? "openmerit",
    subscriptions: SUBSCRIPTION_PROVIDERS.map(provider => {
      const row = rows.get(provider), started = pending.get(provider);
      let signIn: SubscriptionView["signIn"] = null;
      if (started) {
        try {
          const value = unseal<Pending>(userId, started.sealed);
          signIn = { startedAt: iso(started.started_at)!, userCode: value.kind === "chatgpt" ? value.userCode : null, verificationUri: value.kind === "chatgpt" ? value.verificationUri : null, url: value.kind === "claude" ? value.url : null };
        } catch { signIn = null; }
      }
      return { provider, name: PROVIDER_NAMES[provider], connected: !!row, connectedAt: iso(row?.connected_at), problem: (row?.last_error as string | null) ?? null, signIn };
    }),
  };
}

async function save(database: Database, userId: string, provider: SubscriptionProvider, credential: SubscriptionCredential): Promise<void> {
  const now = Date.now();
  await database.execute(`INSERT INTO subscriptions (provider, sealed, connected_at, refreshed_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (provider) DO UPDATE SET sealed = excluded.sealed, connected_at = excluded.connected_at, refreshed_at = excluded.refreshed_at, last_error = NULL`, provider, seal(userId, credential), now, now);
  await database.execute(`DELETE FROM sign_ins WHERE provider = ?`, provider);
}

/** Renewals in flight, so two jobs that start together renew a token once. */
const renewing = new Map<string, Promise<SubscriptionCredential>>();

export const user = actor({
  db: db({ onMigrate: async database => { for (const statement of SCHEMA) await database.execute(statement); } }),
  actions: {
    subscriptions: async (c): Promise<SubscriptionsView> => view(c.db, c.key[0]!),

    /** Starts a Claude sign-in: the page the member opens. The code it shows finishes it. */
    startClaude: async (c): Promise<SubscriptionsView> => {
      const started = claudeSignIn(services().config.subscriptions.claude);
      await c.db.execute(`INSERT INTO sign_ins (provider, sealed, started_at) VALUES ('claude', ?, ?) ON CONFLICT (provider) DO UPDATE SET sealed = excluded.sealed, started_at = excluded.started_at`,
        seal(c.key[0]!, { kind: "claude", verifier: started.verifier, url: started.url } satisfies Pending), Date.now());
      return view(c.db, c.key[0]!);
    },

    finishClaude: async (c, code: string): Promise<{ ok: true; view: SubscriptionsView } | { ok: false; error: string }> => {
      const [row] = await c.db.execute(`SELECT sealed, started_at FROM sign_ins WHERE provider = 'claude'`);
      if (!row || Number(row.started_at) < Date.now() - CLAUDE_SIGN_IN_TTL_MS) return { ok: false, error: "This sign-in expired. Start again." };
      const pending = unseal<Pending>(c.key[0]!, row.sealed);
      if (pending.kind !== "claude") return { ok: false, error: "Start the Claude sign-in again." };
      try {
        const { config, fetch } = services();
        await save(c.db, c.key[0]!, "claude", await claudeExchange(config.subscriptions.claude, fetch, pending.verifier, code));
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "The sign-in failed." }; }
      return { ok: true, view: await view(c.db, c.key[0]!) };
    },

    /** Starts a ChatGPT sign-in: the code the member enters at OpenAI. `pollChatgpt` finishes it. */
    startChatgpt: async (c): Promise<{ ok: true; view: SubscriptionsView } | { ok: false; error: string }> => {
      const { config, fetch } = services();
      let device: DeviceCode;
      try { device = await chatgptDeviceCode(config.subscriptions.chatgpt, fetch); } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "OpenAI did not start the sign-in." }; }
      await c.db.execute(`INSERT INTO sign_ins (provider, sealed, started_at) VALUES ('chatgpt', ?, ?) ON CONFLICT (provider) DO UPDATE SET sealed = excluded.sealed, started_at = excluded.started_at`,
        seal(c.key[0]!, { kind: "chatgpt", ...device } satisfies Pending), Date.now());
      return { ok: true, view: await view(c.db, c.key[0]!) };
    },

    /** Asks OpenAI once whether the member entered the code. */
    pollChatgpt: async (c): Promise<{ status: "pending" | "connected"; view: SubscriptionsView } | { status: "failed"; error: string; view: SubscriptionsView }> => {
      const [row] = await c.db.execute(`SELECT sealed FROM sign_ins WHERE provider = 'chatgpt'`);
      if (!row) return { status: "failed", error: "No ChatGPT sign-in is waiting. Start one.", view: await view(c.db, c.key[0]!) };
      const pending = unseal<Pending>(c.key[0]!, row.sealed);
      if (pending.kind !== "chatgpt") return { status: "failed", error: "Start the ChatGPT sign-in again.", view: await view(c.db, c.key[0]!) };
      const { config, fetch } = services();
      let polled;
      try { polled = await chatgptPoll(config.subscriptions.chatgpt, fetch, pending); } catch (error) { polled = { status: "failed" as const, error: error instanceof Error ? error.message : "The sign-in failed." }; }
      if (polled.status === "pending") return { status: "pending", view: await view(c.db, c.key[0]!) };
      if (polled.status === "failed") {
        await c.db.execute(`DELETE FROM sign_ins WHERE provider = 'chatgpt'`);
        return { status: "failed", error: polled.error, view: await view(c.db, c.key[0]!) };
      }
      await save(c.db, c.key[0]!, "chatgpt", polled.credential);
      return { status: "connected", view: await view(c.db, c.key[0]!) };
    },

    /** Forgets a subscription's tokens, or a sign-in that has not finished. Its cases go back to OpenMerit's key. */
    disconnect: async (c, provider: SubscriptionProvider): Promise<SubscriptionsView> => {
      await c.db.execute(`DELETE FROM subscriptions WHERE provider = ?`, provider);
      await c.db.execute(`DELETE FROM sign_ins WHERE provider = ?`, provider);
      await c.db.execute(`UPDATE settings SET writer = 'openmerit' WHERE id = 1 AND writer = ?`, provider);
      return view(c.db, c.key[0]!);
    },

    setWriter: async (c, writer: CaseWriter): Promise<{ ok: true; view: SubscriptionsView } | { ok: false; error: string }> => {
      if (writer !== "openmerit") {
        const [row] = await c.db.execute(`SELECT provider FROM subscriptions WHERE provider = ?`, writer);
        if (!row) return { ok: false, error: `Connect your ${PROVIDER_NAMES[writer]} subscription first.` };
      }
      await c.db.execute(`INSERT INTO settings (id, writer) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET writer = excluded.writer`, writer);
      return { ok: true, view: await view(c.db, c.key[0]!) };
    },

    /**
     * The subscription that writes this member's cases, with tokens good for at least RENEW_BEFORE_MS,
     * for a job's memory only; null when OpenMerit's key writes them. A renewal that fails records
     * why, for the settings page, and throws, so the job says so.
     */
    writer: async (c): Promise<{ provider: SubscriptionProvider; credential: SubscriptionCredential } | null> => {
      const [settings] = await c.db.execute(`SELECT writer FROM settings WHERE id = 1`);
      const provider = settings?.writer as CaseWriter | undefined;
      if (!provider || provider === "openmerit") return null;
      const [row] = await c.db.execute(`SELECT sealed FROM subscriptions WHERE provider = ?`, provider);
      if (!row) return null;
      const userId = c.key[0]!;
      const credential = unseal<SubscriptionCredential>(userId, row.sealed);
      if (credential.expires - Date.now() > RENEW_BEFORE_MS) return { provider, credential };
      const key = `${userId}\0${provider}`;
      let renewal = renewing.get(key);
      if (!renewal) {
        const { config, fetch } = services();
        renewal = refreshSubscription(provider, config.subscriptions, fetch, credential).finally(() => renewing.delete(key));
        renewing.set(key, renewal);
      }
      try {
        const renewed = await renewal;
        await c.db.execute(`UPDATE subscriptions SET sealed = ?, refreshed_at = ?, last_error = NULL WHERE provider = ?`, seal(userId, renewed), Date.now(), provider);
        return { provider, credential: renewed };
      } catch (error) {
        const reason = `${PROVIDER_NAMES[provider]} did not renew the sign-in: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}. Sign in again.`;
        await c.db.execute(`UPDATE subscriptions SET last_error = ? WHERE provider = ?`, reason, provider);
        throw new Error(reason);
      }
    },
  },
});
