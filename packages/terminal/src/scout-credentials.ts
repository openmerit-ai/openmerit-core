import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type ScoutClient = 'claude-code' | 'pi';
export type ScoutScope = 'user' | 'project';
export interface DeviceCredentials {
  version: 1;
  server: string;
  key: string;
  keyId?: string;
  headers?: Record<string, string>;
}

// Retain the existing Claude user key in place. Other installations own their
// own key and approval, so removing one cannot revoke another's connection.
export function credentialsPath(client: ScoutClient | 'connector', scope: ScoutScope, root: string): string {
  const base = resolve(process.env.OPENMERIT_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'openmerit'));
  if (client === 'claude-code' && scope === 'user') return join(base, 'credentials.json');
  const installation = scope === 'project' ? createHash('sha256').update(resolve(root)).digest('hex').slice(0, 24) : 'user';
  return join(base, client, installation, 'credentials.json');
}

export function pendingPath(client: ScoutClient | 'connector', scope: ScoutScope, root: string): string {
  return join(dirname(credentialsPath(client, scope, root)), 'login.json');
}

export function readCredentials(path: string): DeviceCredentials | null {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw new Error('Scout credentials could not be read. Run the targeted install command again.'); }
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
    || !('server' in value) || typeof value.server !== 'string'
    || !('key' in value) || typeof value.key !== 'string' || !/^om_[A-Za-z0-9_-]{43}$/.test(value.key)) return null;
  const url = new URL(value.server);
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) return null;
  const result: DeviceCredentials = { version: 1, server: value.server.replace(/\/+$/, ''), key: value.key };
  if ('keyId' in value && typeof value.keyId === 'string') result.keyId = value.keyId;
  if ('headers' in value && value.headers && typeof value.headers === 'object') {
    result.headers = Object.fromEntries(Object.entries(value.headers).filter(([key, v]) => /^X-Scout-[A-Za-z-]+$/.test(key) && typeof v === 'string'));
  }
  return result;
}
