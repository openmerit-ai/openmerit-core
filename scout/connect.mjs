import { json, readJSON } from './http.mjs';
import { handleEvaluations } from './evaluation-routes.ts';

// OpenMerit device login (RFC 8628 shape) and per-device keys. Only hashes of
// device codes and keys are stored; a key is minted once, when the CLI collects
// an approved login, so no plaintext credential is ever persisted server-side.
export const connectSchema = `CREATE TABLE IF NOT EXISTS openmerit_device_logins (device_hash TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, client TEXT NOT NULL, scope TEXT NOT NULL, device_name TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, polled_at INTEGER, status TEXT NOT NULL, user_id TEXT, key_id TEXT);
CREATE TABLE IF NOT EXISTS openmerit_device_keys (id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, client TEXT NOT NULL, device_name TEXT NOT NULL, permissions TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE INDEX IF NOT EXISTS openmerit_device_keys_user ON openmerit_device_keys(user_id, created_at);`;

export const scoutPermission = 'scout:recommend';
export const clients = { 'claude-code': 'Claude Code', pi: 'Pi' };
// Device codes last 30 minutes: approval often waits for a different person than the one running the installer.
const loginTTL = 1_800_000, pollInterval = 5, idleLifetime = 90 * 86400_000, touchEvery = 300_000;
const alphabet = 'BCDFGHJKLMNPQRSTVWXZ23456789';
const ready = new WeakSet();

// Workers run without nodejs_compat here, so avoid Buffer.
const random = bytes => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
const userCode = () => { const v = crypto.getRandomValues(new Uint8Array(8)); const s = [...v].map(b => alphabet[b % alphabet.length]).join(''); return `${s.slice(0, 4)}-${s.slice(4)}`; };
const normalizeCode = code => typeof code === 'string' ? code.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2') : '';
const oauthError = (error, status = 400, description) => json({ error, ...(description ? { error_description: description } : {}) }, status);

async function database(env) {
  const db = env.SCOUT_INDEX;
  if (!db) throw new Error('Device login storage is not configured.');
  if (!ready.has(db)) { await db.exec(connectSchema.replace(/\n/g, ' ')); ready.add(db); }
  return db;
}

// Returns the user ID for a valid, unrevoked, unexpired key with the permission.
export async function deviceKeyUser(env, token, permission = scoutPermission, now = Date.now()) {
  if (!/^om_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const db = await database(env);
  const key = await db.prepare('SELECT id,user_id,permissions,last_used_at,expires_at,revoked_at FROM openmerit_device_keys WHERE key_hash=?').bind(await sha256(token)).first();
  if (!key || key.revoked_at || key.expires_at <= now || !JSON.parse(key.permissions).includes(permission)) return null;
  // Idle expiry moves forward with use; writes are throttled to keep MCP cheap.
  if (now - key.last_used_at >= touchEvery) await db.prepare('UPDATE openmerit_device_keys SET last_used_at=?,expires_at=? WHERE id=?').bind(now, now + idleLifetime, key.id).run();
  return { userId: key.user_id, keyId: key.id };
}

// /connect/api/* routes. `session` verifies a Clerk browser session and returns a
// user ID or null; it is injected so tests and the local server share one path.
export async function handleConnect(request, env, options = {}) {
  const { analytics } = options, started = performance.now();
  const response = await connect(request, env, options);
  if (analytics) {
    let body;
    try { body = await response.clone().json(); } catch { body = {}; }
    const path = new URL(request.url).pathname.slice('/connect/api/'.length);
    const stage = ['device', 'token', 'login', 'keys'].includes(path) ? path : path.startsWith('keys/') ? 'revoke' : 'request';
    const status = body.access_token ? 'collected' : body.revoked ? 'revoked' : body.status ?? ({
      authorization_pending: 'pending', slow_down: 'slow_down', expired_token: 'expired', access_denied: 'denied', invalid_grant: 'invalid',
    }[body.error]);
    analytics.connectStep({ stage, status, http_status: response.status, duration_ms: Math.round(performance.now() - started),
      outcome: ['pending', 'slow_down'].includes(status) ? 'pending' : status === 'denied' ? 'denied' : response.ok ? 'ok' : 'error' });
    if (response.status >= 400 && !['pending', 'slow_down', 'denied'].includes(status)) analytics.exception(null, 'connect_error');
  }
  return response;
}

async function connect(request, env, { session, now = Date.now(), analytics } = {}) {
  const url = new URL(request.url), path = url.pathname.slice('/connect/api/'.length), method = request.method;
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json({ error: 'Origin not allowed.' }, 403);
  const limit = async key => !env.SCOUT_RATE || (await env.SCOUT_RATE.limit({ key })).success;
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const body = async () => { const value = await readJSON(request); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Provide a JSON object.'), { status: 400 }); return value; };
  const bearer = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
  try {
    if (path === 'device' && method === 'POST') {
      if (!await limit(`connect:start:${ip}`)) return json({ error: 'Too many requests. Please try again shortly.' }, 429, { 'Retry-After': '60' });
      const input = await body();
      const deviceName = typeof input.device_name === 'string' ? input.device_name.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 64) : '';
      if (!clients[input.client] || !['user', 'project'].includes(input.scope) || !deviceName) return json({ error: 'Provide client, scope (user or project) and device_name.' }, 400);
      const db = await database(env), deviceCode = random(32), code = userCode();
      await db.prepare('DELETE FROM openmerit_device_logins WHERE expires_at<?').bind(now - 86400_000).run();
      await db.prepare("INSERT INTO openmerit_device_logins(device_hash,user_code,client,scope,device_name,created_at,expires_at,status) VALUES(?,?,?,?,?,?,?,'pending')")
        .bind(await sha256(deviceCode), code, input.client, input.scope, deviceName, now, now + loginTTL).run();
      const verification = `${url.origin}/connect`;
      return json({ device_code: deviceCode, user_code: code, verification_uri: verification, verification_uri_complete: `${verification}?code=${code}`, expires_in: loginTTL / 1000, interval: pollInterval });
    }
    if (path === 'token' && method === 'POST') {
      const { device_code: deviceCode } = await body();
      if (typeof deviceCode !== 'string' || deviceCode.length > 100) return oauthError('invalid_request');
      const db = await database(env), hash = await sha256(deviceCode);
      const login = await db.prepare('SELECT * FROM openmerit_device_logins WHERE device_hash=?').bind(hash).first();
      if (!login || login.status === 'collected') return oauthError('invalid_grant');
      if (login.user_id) analytics?.identify(login.user_id);
      if (login.expires_at <= now) return oauthError('expired_token');
      if (login.status === 'denied') return oauthError('access_denied');
      if (login.status === 'pending') {
        const tooFast = login.polled_at && now - login.polled_at < (pollInterval - 1) * 1000;
        await db.prepare('UPDATE openmerit_device_logins SET polled_at=? WHERE device_hash=?').bind(now, hash).run();
        return oauthError(tooFast ? 'slow_down' : 'authorization_pending');
      }
      // Claim the approval atomically so concurrent polls cannot mint two keys.
      const keyId = `dk_${random(12)}`;
      const claimed = await db.prepare("UPDATE openmerit_device_logins SET status='collected',key_id=? WHERE device_hash=? AND status='approved' RETURNING user_id,client,device_name").bind(keyId, hash).first();
      if (!claimed) return oauthError('invalid_grant');
      const key = `om_${random(32)}`;
      await db.prepare('INSERT INTO openmerit_device_keys(id,key_hash,user_id,client,device_name,permissions,created_at,last_used_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .bind(keyId, await sha256(key), claimed.user_id, claimed.client, claimed.device_name, JSON.stringify([scoutPermission]), now, now, now + idleLifetime).run();
      return json({ access_token: key, token_type: 'Bearer', key_id: keyId, scope: scoutPermission, expires_in: idleLifetime / 1000 });
    }
    if (path === 'keys/self' && method === 'DELETE') {
      const owner = bearer && await deviceKeyUser(env, bearer, scoutPermission, now);
      if (!owner) return json({ error: 'Unknown or inactive device key.' }, 401);
      analytics?.identify(owner.userId);
      await (await database(env)).prepare('UPDATE openmerit_device_keys SET revoked_at=? WHERE id=?').bind(now, owner.keyId).run();
      return json({ revoked: owner.keyId });
    }

    // Everything below acts for a signed-in person in the browser.
    const userId = await session(request);
    if (!userId) return json({ error: 'Sign in to continue.', code: 'sign_in_required' }, 401, { 'WWW-Authenticate': 'Bearer realm="OpenMerit"' });
    analytics?.identify(userId);
    if (!await limit(`connect:user:${userId}`)) return json({ error: 'Too many requests. Please try again shortly.' }, 429, { 'Retry-After': '60' });
    if (['langfuse', 'langfuse/sync', 'evaluations'].includes(path)) return handleEvaluations(request, env.SCOUT_EVALUATIONS, userId);
    const db = await database(env);
    if (path === 'login' && method === 'GET') {
      const login = await db.prepare('SELECT client,scope,device_name,expires_at,status,user_id FROM openmerit_device_logins WHERE user_code=?').bind(normalizeCode(url.searchParams.get('code'))).first();
      if (!login || login.user_id && login.user_id !== userId) return json({ error: 'This code is not recognized. Check it against your coding agent.' }, 404);
      const status = login.status === 'pending' && login.expires_at <= now ? 'expired' : login.status;
      return json({ client: login.client, clientName: clients[login.client], scope: login.scope, deviceName: login.device_name, status, permissions: [scoutPermission], expiresAt: new Date(login.expires_at).toISOString() });
    }
    if (path === 'login' && method === 'POST') {
      const { code, decision } = await body();
      if (!['approve', 'deny'].includes(decision)) return json({ error: 'Choose approve or deny.' }, 400);
      const updated = await db.prepare("UPDATE openmerit_device_logins SET status=?,user_id=? WHERE user_code=? AND status='pending' AND expires_at>? RETURNING status")
        .bind(decision === 'approve' ? 'approved' : 'denied', userId, normalizeCode(code), now).first();
      if (!updated) return json({ error: 'This code has expired or was already used. Run the install command again for a new code.' }, 409);
      return json({ status: updated.status });
    }
    if (path === 'keys' && method === 'GET') {
      const { results } = await db.prepare('SELECT id,client,device_name,created_at,last_used_at,expires_at FROM openmerit_device_keys WHERE user_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 100').bind(userId, now).all();
      return json({ keys: results.map(k => ({ id: k.id, client: k.client, clientName: clients[k.client] ?? k.client, deviceName: k.device_name, createdAt: new Date(k.created_at).toISOString(), lastUsedAt: new Date(k.last_used_at).toISOString(), expiresAt: new Date(k.expires_at).toISOString() })) });
    }
    const revoke = path.match(/^keys\/(dk_[A-Za-z0-9_-]{16})$/);
    if (revoke && method === 'DELETE') {
      const revoked = await db.prepare('UPDATE openmerit_device_keys SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL RETURNING id').bind(now, revoke[1], userId).first();
      return revoked ? json({ revoked: revoked.id }) : json({ error: 'Device not found.' }, 404);
    }
    return json({ error: 'Not found.' }, 404);
  } catch (error) {
    if (error.status) return json({ error: error instanceof SyntaxError ? 'Invalid JSON.' : error.message }, error.status);
    if (error instanceof SyntaxError) return json({ error: 'Invalid JSON.' }, 400);
    return json({ error: 'Device sign-in is temporarily unavailable. Please try again later.' }, 503);
  }
}
