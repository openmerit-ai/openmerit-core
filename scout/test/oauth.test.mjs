import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { scoutAccess } from '../auth.mjs';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = {
  CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from('oauth-test.clerk.accounts.dev$').toString('base64')}`,
  CLERK_SECRET_KEY: 'sk_test_fixture',
  CLERK_JWT_KEY: keys.publicKey.export({ type: 'spki', format: 'pem' }),
  SCOUT_OAUTH_ENABLED: 'true', SCOUT_OAUTH_CLIENT_IDS: 'scout-client',
};
function token(changes = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', typ: 'at+jwt', kid: 'fixture' })}.${encode({ iss: 'https://oauth-test.clerk.accounts.dev', sub: 'user_alice', client_id: 'scout-client', aud: 'https://example.test/scout/mcp', scope: 'scout:recommend', iat: now, nbf: now - 1, exp: now + 60, jti: 'oat_fixture', ...changes })}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
}
const request = (bearer, path = '/scout/mcp', extra = {}) => new Request(`https://example.test${path}`, { headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...extra } });

test('public discovery is gated, path-specific, cross-origin readable and actionable', async () => {
  const path = '/scout/.well-known/oauth-protected-resource';
  assert.equal((await scoutAccess(request(null, path), {})).status, 503);
  const metadata = await scoutAccess(request(null, path, { origin: 'https://client.test' }), env);
  assert.equal(metadata.status, 200);
  assert.equal((await metadata.json()).resource, 'https://example.test/scout/mcp');
  assert.match((await scoutAccess(request(), env)).headers.get('www-authenticate'), /resource_metadata="https:\/\/example.test\/scout\/\.well-known\/oauth-protected-resource"/);
});

test('real SDK verifies OAuth signature, audience, dedicated client and Scout permission', async () => {
  let identity;
  assert.equal(await scoutAccess(request(token()), env, id => { identity = id; }), null);
  assert.equal(identity, 'user_alice');
  for (const claims of [{ aud: 'https://other.test' }, { aud: undefined }, { client_id: 'unrelated' }, { exp: 1 }]) {
    const result = await scoutAccess(request(token(claims)), env);
    assert.equal(result.status, 401, JSON.stringify(claims));
  }
  assert.equal((await scoutAccess(request(token({ scope: 'openid profile email' })), env)).status, 403);
  assert.equal((await scoutAccess(request(token()), { ...env, SCOUT_OAUTH_ENABLED: 'false' })).status, 401);
  assert.equal((await scoutAccess(request(token(), '/scout/api/recommend'), env)).status, 401);
  assert.equal((await scoutAccess(request(token(), '/scout/mcp', { origin: 'https://other.test' }), env)).status, 403);
});
