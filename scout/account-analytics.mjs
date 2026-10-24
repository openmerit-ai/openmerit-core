import { DurableObject } from 'cloudflare:workers';
import { verifyWebhook } from '@clerk/backend/webhooks';
import { accountAnalytics, accountId, accountSyncEnabled, sendProductBatch, deliveryDiagnostic } from './product-analytics.mjs';
import { json } from './http.mjs';

const week = 7 * 86400_000;
const lifecycle = {
  'user.created': 'scout_signed_up',
  'session.created': 'scout_signed_in',
  'session.ended': 'scout_signed_out',
  'session.removed': 'scout_session_removed',
  'session.revoked': 'scout_session_revoked',
};
const supported = new Set([...Object.keys(lifecycle), 'user.updated', 'user.deleted']);
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

async function eventId(value) {
  const hex = (await accountId(`event:${value}`)).slice(8, 40);
  // Stable UUID across retries, including a crash after delivery but before save.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function profile(user) {
  const email = user.email_addresses?.find(e => e.id === user.primary_email_address_id && e.verification?.status === 'verified');
  const name = [text(user.first_name, 100), text(user.last_name, 100)].filter(Boolean).join(' ');
  const providers = [...new Set((user.external_accounts ?? []).map(a => a.provider?.replace(/^oauth_/, '')).filter(p => ['google', 'github'].includes(p)))].sort();
  const values = { connected_providers: providers };
  if (name) values.name = name;
  if (text(email?.email_address, 320)) values.email = text(email.email_address, 320);
  if (Number.isSafeInteger(user.created_at) && user.created_at > 0) values.signup_at = new Date(user.created_at).toISOString();
  return { $set: values, $unset: ['name', 'email', 'signup_at'].filter(key => !Object.hasOwn(values, key)) };
}

// One account's privacy state, deliveries and deletion are serialized. Storage
// contains pseudonyms, receipts and bounded lifecycle metadata, never profiles,
// raw Clerk IDs, tokens, webhook bodies, IPs or prompts.
export class ScoutAccounts extends DurableObject {
  async preference(userId, enabled, observedAt) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.ctx.storage.get('state') ?? {};
      if (state.deleted) { if (!state.deletionRequested && accountSyncEnabled(this.env)) await this.erase(userId, state); return; }
      if (observedAt < (state.preferenceAt ?? 0) || observedAt === state.preferenceAt && state.enabled === false) return;
      const changed = state.enabled !== enabled;
      state.enabled = enabled; state.preferenceAt = observedAt;
      if (!enabled) state.pending = [];
      await this.ctx.storage.put('state', state);
      if (enabled && accountSyncEnabled(this.env)) {
        if (changed || !state.syncedAt || Date.now() - state.syncedAt > 3600_000) await this.syncProfile(userId, state);
        if (!state.deleted) await this.flush(state);
        await this.ctx.storage.put('state', state);
      }
    });
  }

  async capture(batch) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.ctx.storage.get('state') ?? {};
      if (!state.deleted && state.enabled !== false) await sendProductBatch(this.env, batch);
      else deliveryDiagnostic('account_suppressed', 0, batch.length);
    });
  }

  async webhook(event, deliveryId) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.ctx.storage.get('state') ?? {};
      const userId = event.type.startsWith('user.') ? event.data.id : event.data.user_id;
      if (event.type === 'user.deleted') {
        await this.erase(userId, state);
        return;
      }
      if (state.deleted) { if (!state.deletionRequested) await this.erase(userId, state); return; }
      const receipt = await eventId(deliveryId);
      const now = Date.now();
      state.receipts = (state.receipts ?? []).filter(r => r.at > now - week);
      if (state.receipts.some(r => r.id === receipt)) return;
      if (state.enabled === true && event.type.startsWith('user.')) {
        // A delayed user.updated payload can be stale. Fetch canonical state
        // rather than attempting to reconstruct Clerk's object ordering.
        await this.syncProfile(userId, state);
        if (state.deleted) return;
      }
      const name = lifecycle[event.type];
      if (name && state.enabled !== false && event.timestamp > now - week) {
        const entry = await this.entry(userId, name, receipt, event.timestamp, { auth_provider: 'unknown' });
        state.pending = [...(state.pending ?? []), entry];
        // Unknown preference: retain only a bounded, seven-day delivery buffer
        // so signup preceding the OAuth callback is not silently lost.
        state.pending = state.pending.filter(e => Date.parse(e.timestamp) > now - week).slice(-128);
      }
      if (state.enabled === true) await this.flush(state);
      state.receipts.push({ id: receipt, at: now });
      state.receipts = state.receipts.slice(-256);
      if (state.pending?.length) await this.ctx.storage.setAlarm(Math.min(...state.pending.map(e => Date.parse(e.timestamp))) + week);
      await this.ctx.storage.put('state', state);
    });
  }

  async alarm() {
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.ctx.storage.get('state');
      if (!state) return;
      if (state.deleted) { await this.reconcileDeletion(state); return; }
      const now = Date.now();
      state.pending = (state.pending ?? []).filter(e => Date.parse(e.timestamp) > now - week);
      state.receipts = (state.receipts ?? []).filter(r => r.at > now - week);
      await this.ctx.storage.put('state', state);
      if (state.pending.length) await this.ctx.storage.setAlarm(Math.min(...state.pending.map(e => Date.parse(e.timestamp))) + week);
    });
  }

  async entry(userId, event, uuid, time, properties) {
    return { event, uuid, timestamp: new Date(time).toISOString(), properties: {
      distinct_id: await accountId(userId), $process_person_profile: true, $geoip_disable: true, $ip: null,
      product: 'scout', environment: this.env.POSTHOG_ENVIRONMENT, client: 'server', transport: 'clerk', ...properties,
    } };
  }

  async syncProfile(userId, state) {
    // The installed Clerk SDK does not expose abort/redirect controls for this
    // endpoint. Use its documented API directly, with a fixed host and deadline.
    const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${this.env.CLERK_SECRET_KEY}` },
      signal: AbortSignal.timeout(3000), redirect: 'manual',
    });
    if (response.status === 404) { await response.body?.cancel(); await this.erase(userId, state); return; }
    if (!response.ok) { await response.body?.cancel(); throw new Error('Profile unavailable.'); }
    const user = await response.json();
    if (user.id !== userId || user.object !== 'user') throw new Error('Invalid profile.');
    const properties = profile(user), fingerprint = await accountId(JSON.stringify(properties));
    if (fingerprint !== state.profileFingerprint) {
      await sendProductBatch(this.env, [await this.entry(userId, '$set', crypto.randomUUID(), Date.now(), properties)]);
      state.profileFingerprint = fingerprint;
    }
    state.syncedAt = Date.now();
  }

  async flush(state) {
    const pending = (state.pending ?? []).filter(e => Date.parse(e.timestamp) > Date.now() - week);
    await sendProductBatch(this.env, pending);
    state.pending = [];
  }

  async erase(userId, state) {
    // Persist the tombstone before any external call. Old sessions, duplicate
    // webhooks and delayed updates must never recreate a deleted account.
    if (state.deleted && state.deletionRequested) return;
    const distinctId = await accountId(userId);
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, { deleted: true, distinctId, deletionRequested: false });
    await this.ctx.storage.put('state', state);
    await this.reconcileDeletion(state);
  }

  async reconcileDeletion(state) {
    // PostHog resolves persons at deletion time, not at capture acceptance.
    // Keep reconciling: queued ingestion may recreate even a deleted person.
    // Schedule first so a failed alarm still has a later reconciliation.
    await this.ctx.storage.setAlarm(Date.now() + 86400_000);
    // Disabling new capture must not disable erasure of previously sent data.
    if (!['https://eu.i.posthog.com', 'https://us.i.posthog.com'].includes(this.env.POSTHOG_HOST) ||
        !this.env.POSTHOG_PERSONAL_API_KEY || !/^\d+$/.test(this.env.POSTHOG_PROJECT_ID ?? '')) throw new Error('Account erasure unavailable.');
    const host = this.env.POSTHOG_HOST === 'https://eu.i.posthog.com' ? 'https://eu.posthog.com' : 'https://us.posthog.com';
    const response = await fetch(`${host}/api/projects/${this.env.POSTHOG_PROJECT_ID}/persons/bulk_delete/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.env.POSTHOG_PERSONAL_API_KEY}` },
      body: JSON.stringify({ distinct_ids: [state.distinctId], delete_events: true, delete_recordings: true }),
      signal: AbortSignal.timeout(3000), redirect: 'manual',
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Account erasure unavailable.'); }
    const result = await response.json();
    if (result.deletion_errors?.length || !Number.isInteger(result.persons_found) || result.persons_found < 0 || result.persons_found > 0 && result.events_queued_for_deletion !== true) throw new Error('Account erasure not accepted.');
    state.deletionRequested = true;
    await this.ctx.storage.put('state', state);
  }
}

export async function handleClerkWebhook(request, env) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, { Allow: 'POST' });
  if (!env.SCOUT_ACCOUNTS || !env.CLERK_WEBHOOK_SIGNING_SECRET) return json({ error: 'Account sync is not configured.' }, 503);
  let event;
  try {
    // Bound raw bytes, including chunked requests; verification must see the
    // original text, not JSON parsed and serialized into a different signature.
    const reader = request.body?.getReader(), decoder = new TextDecoder();
    let bytes = 0, body = '';
    if (!reader) return json({ error: 'Invalid webhook.' }, 400);
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length;
      if (bytes > 262144) { await reader.cancel(); return json({ error: 'Webhook too large.' }, 413); }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    event = await verifyWebhook(new Request(request.url, { method: 'POST', headers: request.headers, body }), { signingSecret: env.CLERK_WEBHOOK_SIGNING_SECRET });
  } catch { return json({ error: 'Invalid webhook signature.' }, 400); }
  if (!supported.has(event.type)) return json({ received: true });
  if (event.type !== 'user.deleted' && !accountSyncEnabled(env)) return json({ error: 'Account sync is not configured.' }, 503);
  const userId = event.type.startsWith('user.') ? event.data?.id : event.data?.user_id;
  if (typeof userId !== 'string' || !/^user_[A-Za-z0-9]+$/.test(userId) || !Number.isSafeInteger(event.timestamp) || event.timestamp <= 0 || event.timestamp > Date.now() + 300_000) return json({ error: 'Invalid webhook payload.' }, 400);
  try {
    await (await accountAnalytics(env, userId)).webhook(event, request.headers.get('svix-id'));
    return json({ received: true });
  } catch {
    // Acknowledge only durable buffering/suppression or successful delivery.
    // Svix owns retry/replay; do not expose provider bodies or personal data.
    return json({ error: 'Account sync temporarily unavailable.' }, 503);
  }
}
