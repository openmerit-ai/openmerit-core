import test from 'node:test';
import assert from 'node:assert/strict';
import web, { type WebEnv } from '../web.ts';

const assets: WebEnv['ASSETS'] = { fetch: async request => {
  const path = new URL(request.url).pathname;
  const pages: Record<string, string> = { '/': 'Landing page', '/vs-routers/': 'Comparison', '/vs-routers/index.md': '# Comparison' };
  return new Response(pages[path] ?? 'Not found', { status: pages[path] ? 200 : 404 });
} };

const webEnv: WebEnv = { ASSETS: assets };

test('the landing page stays at root, the retired walkthrough and /scout redirect', async () => {
  const home = await web.fetch(new Request('https://example.test/?ref=home'), webEnv);
  assert.equal(home.status, 200); assert.equal(await home.text(), 'Landing page');
  for (const path of ['/scout', '/scout/', '/scout/?q=a', '/scout/api/auth', '/scout/api/session']) {
    const scout = await web.fetch(new Request(`https://example.test${path}`), webEnv);
    assert.equal(scout.status, 308, path); assert.equal(scout.headers.get('location'), 'https://example.test/contact-sales/', path);
  }
  for (const path of ['/playground/scout', '/playground/scout/']) {
    const playground = await web.fetch(new Request(`https://example.test${path}`), webEnv);
    assert.equal(playground.status, 308, path); assert.equal(playground.headers.get('location'), 'https://example.test/', path);
  }
  for (const page of ['vs-routers', 'run-locally']) {
    const response = await web.fetch(new Request(`https://example.test/${page}?ref=x`), webEnv);
    assert.equal(response.status, 308); assert.equal(response.headers.get('location'), `https://example.test/${page}/?ref=x`);
  }
  assert.equal(await (await web.fetch(new Request('https://example.test/vs-routers/'), webEnv)).text(), 'Comparison');
});

test('pages answer agents that ask for text/markdown with their Markdown version, and browsers with HTML', async () => {
  const page = (accept?: string, path = '/vs-routers/') => web.fetch(new Request(`https://example.test${path}`, accept ? { headers: { accept } } : {}), webEnv);
  for (const accept of ['text/markdown', 'text/markdown, text/html, */*', 'text/html;q=0.9, text/markdown;q=0.5']) {
    const response = await page(accept);
    assert.equal(await response.text(), '# Comparison', accept);
    assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8');
    assert.equal(response.headers.get('content-signal'), 'search=yes, ai-input=yes, ai-train=no');
    assert.match(response.headers.get('vary') ?? '', /Accept/);
  }
  for (const accept of [undefined, 'text/html,application/xhtml+xml,*/*;q=0.8', 'text/markdown;q=0', 'text/x-markdown']) {
    const response = await page(accept);
    assert.equal(await response.text(), 'Comparison', String(accept));
    assert.equal(response.headers.get('content-signal'), null);
    assert.match(response.headers.get('vary') ?? '', /Accept/);
  }
});

test('retired pages and APIs return 404 without reading assets or secrets', async () => {
  const unavailable = new Proxy({}, { get() { assert.fail('Retired pages must not read bindings or assets'); } }) as WebEnv;
  for (const path of ['/connect', '/connect/', '/connect/api/device', '/scouting', '/playground', '/playground/other', '/index.html', '/docs/', '/memo/', '/demo/api/session']) {
    for (const method of ['GET', 'HEAD', 'POST']) assert.equal((await web.fetch(new Request(`https://example.test${path}`, { method }), unavailable)).status, 404, `${method} ${path}`);
  }
});

test('the contact-sales form emails a valid request to OpenMerit with Reply-To set to the sender', async () => {
  const sent: unknown[] = [];
  let allowed = true, failSend = false;
  const env: WebEnv = {
    ASSETS: assets, CONTACT_TO: 'team@openmerit.ai', CONTACT_FROM: 'memo@openmerit.ai',
    CONTACT_EMAIL: { send: async message => { if (failSend) throw new Error('down'); sent.push(message); } },
    CONTACT_RATE: { limit: async () => ({ success: allowed }) },
  };
  const submit = (fields: Record<string, string>, method = 'POST') => web.fetch(new Request('https://example.test/contact-sales/api', {
    method, ...(method === 'POST' ? { body: new URLSearchParams(fields) } : {}),
  }), env);
  const valid = { name: 'Ada\r\nBcc: x@evil.test', email: 'ada@acme.test', company: 'Acme', size: '11–50', spend: '$50K–$100K', use: 'Support replies', heard: '' };

  const ok = await submit(valid);
  assert.equal(ok.status, 303); assert.equal(ok.headers.get('location'), 'https://example.test/contact-sales/thanks/');
  assert.equal(sent.length, 1);
  const message = sent[0] as { to: string[]; from: { email: string }; replyTo: { name: string; email: string }; subject: string; text: string };
  assert.deepEqual(message.to, ['team@openmerit.ai']); assert.equal(message.from.email, 'memo@openmerit.ai');
  assert.deepEqual(message.replyTo, { name: 'Ada Bcc: x@evil.test', email: 'ada@acme.test' });
  assert.equal(message.subject, 'OpenMerit Cloud enquiry: Acme');
  assert.match(message.text, /Company size: 11–50/); assert.match(message.text, /Monthly LLM spend: \$50K–\$100K/); assert.match(message.text, /Support replies/); assert.match(message.text, /\(not given\)/);

  // A bot filling the hidden field sees success, but nothing is sent.
  assert.equal((await submit({ ...valid, website: 'http://spam.test' })).status, 303);
  for (const broken of [{ ...valid, size: '5' }, { ...valid, spend: '' }, { ...valid, spend: '$25–$50' }, { ...valid, email: 'not-an-email' }, { ...valid, company: ' ' }, { ...valid, use: 'x'.repeat(4001) }]) {
    assert.equal((await submit(broken)).status, 400);
  }
  allowed = false; assert.equal((await submit(valid)).status, 429); allowed = true;
  failSend = true; const failed = await submit(valid); failSend = false;
  assert.equal(failed.status, 502); assert.match(await failed.text(), /mailto:team@openmerit\.ai/);
  assert.equal((await submit({}, 'GET')).status, 404);
  assert.equal(sent.length, 1);
});
