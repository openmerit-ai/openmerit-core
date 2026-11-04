// Restored memo routes. No public route can inject the delivery adapter.
import { createMemoAuth, consumeLimit, sendMemoCode } from './auth.ts';
import type { MemoEnv, ReadyMemoEnv, SendCode } from './auth.ts';
import { loginPage, messagePage, readersPage, readerCsv } from './views.mjs';
import { memoHtml, memoMarkdown, memoSharingMetadata } from './generated/content.ts';

const securityHeaders = {
  'Cache-Control': 'private, no-store, max-age=0', 'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
function reply(body: BodyInit | null, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers: { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8', ...headers } });
}
const jsonError = (message: string, status: number) => reply(JSON.stringify({ message }), status, { 'Content-Type': 'application/json' });
const isUnder = (path: string, root: string) => path === root || path.startsWith(root + '/');
const isMemoRequest = (path: string) => isUnder(path, '/memo');
const adminEmails = (env: MemoEnv) => new Set((env.MEMO_ADMIN_EMAILS ?? '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean));

async function parseBody(request: Request): Promise<unknown> {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') throw new Error('Invalid request.');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Invalid request.');
  let size = 0, text = '';
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2048) { await reader.cancel(); throw new Error('Invalid request.'); }
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}

export async function handleMemoRequest(request: Request, env: MemoEnv, { sendCode = (email, otp) => sendMemoCode(env, email, otp) }: { sendCode?: SendCode } = {}): Promise<Response | null> {
  const url = new URL(request.url);
  let path: string;
  try { path = decodeURIComponent(url.pathname).replace(/\/{2,}/g, '/'); } catch { return jsonError('Invalid address.', 400); }
  if (!isMemoRequest(path)) return null;
  const origin = env.MEMO_AUTH_ORIGIN || 'https://openmerit.ai';
  if (url.origin !== origin) {
    if (!['GET', 'HEAD'].includes(request.method)) return jsonError('Invalid origin.', 403);
    return reply(null, 302, { Location: origin + path });
  }
  const authPath = isUnder(path, '/memo/auth'), adminPath = isUnder(path, '/memo/readers');
  if (authPath && (request.method !== 'POST' || request.headers.get('Origin') !== origin)) return jsonError('Invalid request origin or method.', 403);
  if (!authPath && !['GET', 'HEAD'].includes(request.method)) return reply(null, 405, { Allow: 'GET, HEAD' });
  if (isUnder(path, '/memo/v2')) return reply(request.method === 'HEAD' ? null : messagePage('This memo has been removed', 'The current memo is available at the link below.'), 410);
  const moved: Record<string, string> = {
    '/memo/v3': '/memo/', '/memo/v3/': '/memo/', '/memo/v3/index.html': '/memo/', '/memo/v3/source.md': '/memo/source.md',
  };
  if (moved[path]) return reply(null, 308, { Location: moved[path] + url.search });
  if (['/memo', '/memo/index.html'].includes(path)) return reply(null, 302, { Location: '/memo/' + url.search });
  if (!authPath && !adminPath && !['/memo/', '/memo/source.md'].includes(path)) return reply(null, 404);
  if (!env.MEMO_DB || !env.MEMO_AUTH_SECRET || env.MEMO_AUTH_SECRET.length < 32) {
    return authPath ? jsonError('Email access is not ready yet. Please try again later.', 503) : reply(messagePage('Email access is being set up', 'Please check back shortly to read the memo.'), 503);
  }
  const ready: ReadyMemoEnv = { ...env, MEMO_DB: env.MEMO_DB, MEMO_AUTH_SECRET: env.MEMO_AUTH_SECRET, MEMO_AUTH_ORIGIN: origin };
  try {
    const auth = createMemoAuth(ready, sendCode);
    if (authPath) {
      const allowed = ['/memo/auth/email-otp/send-verification-otp', '/memo/auth/sign-in/email-otp', '/memo/auth/sign-out'];
      if (!allowed.includes(path)) return jsonError('Not found.', 404);
      let parsed: unknown;
      try { parsed = await parseBody(request); } catch { return jsonError('Please check your email and code.', 400); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return jsonError('Invalid request.', 400);
      let body = parsed as Record<string, unknown>;
      if (path !== '/memo/auth/sign-out') {
        if (typeof body.email !== 'string' || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) return jsonError('Enter a valid email address.', 400);
        body.email = body.email.trim().toLowerCase();
      }
      if (path.endsWith('/send-verification-otp')) {
        if (body.type !== 'sign-in' || Object.keys(body).some(k => !['email', 'type'].includes(k))) return jsonError('Invalid request.', 400);
        if (!await consumeLimit(ready, 'email:' + String(body.email), 60, 1)) return jsonError('Please wait a minute before requesting another code.', 429);
        const ip = request.headers.get('cf-connecting-ip') || 'local';
        if (!await consumeLimit(ready, 'send-ip:' + ip, 3600, 10)) return jsonError('Too many code requests. Please try again later.', 429);
        const dailyLimit = Number(env.MEMO_DAILY_EMAIL_LIMIT || 100);
        if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 3000) return jsonError('Email access is temporarily unavailable.', 503);
        if (!await consumeLimit(ready, 'daily:' + new Date().toISOString().slice(0, 10), 86400, dailyLimit)) return jsonError('Today’s email allowance has been reached. Please try again tomorrow.', 429);
      } else if (path.endsWith('/email-otp')) {
        if (typeof body.otp !== 'string' || !/^\d{6}$/.test(body.otp) || Object.keys(body).some(k => !['email', 'otp'].includes(k))) return jsonError('Enter the six-digit code from your email.', 400);
      } else body = {};
      const response = await auth.handler(new Request(origin + path, { method: 'POST', headers: request.headers, body: JSON.stringify(body) }));
      if (!response.ok) return jsonError(response.status === 429 ? 'Too many attempts. Please wait a minute and try again.' : response.status >= 500 ? 'We couldn’t send the code. Please try again later.' : 'That code is invalid or has expired. Please request a new code.', response.status);
      const headers = new Headers(securityHeaders);
      headers.set('Content-Type', 'application/json');
      for (const cookie of response.headers.getSetCookie()) headers.append('Set-Cookie', cookie);
      return new Response('{"ok":true}', { headers });
    }
    const session = await auth.api.getSession({ headers: request.headers, query: { disableRefresh: true } });
    if (!session?.user?.emailVerified) return reply(request.method === 'HEAD' ? null : loginPage({ admin: adminPath, sharingMetadata: memoSharingMetadata }));
    if (adminPath) {
      if (!adminEmails(env).has(session.user.email.toLowerCase())) return reply(messagePage('This page is private', 'Your email can read the memo, but it does not have access to the reader list.'), 403);
      if (!['/memo/readers', '/memo/readers/', '/memo/readers/export.csv'].includes(path)) return reply(null, 404);
      const { results } = await ready.MEMO_DB.prepare('SELECT email, first_opened_at, last_opened_at, visits FROM memo_readers ORDER BY last_opened_at DESC').all();
      if (path.endsWith('/export.csv')) return reply(request.method === 'HEAD' ? null : readerCsv(results), 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="openmerit-memo-readers.csv"' });
      return reply(request.method === 'HEAD' ? null : readersPage(results));
    }
    if (path === '/memo/source.md') return reply(request.method === 'HEAD' ? null : memoMarkdown, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    if (request.method === 'GET' && !/prefetch/i.test(request.headers.get('Sec-Purpose') || request.headers.get('Purpose') || '')) {
      const now = Date.now();
      await ready.MEMO_DB.prepare(`INSERT INTO memo_readers (email, first_opened_at, last_opened_at, visits) VALUES (?, ?, ?, 1)
        ON CONFLICT(email) DO UPDATE SET last_opened_at = excluded.last_opened_at, visits = visits + 1`).bind(session.user.email.toLowerCase(), now, now).run();
    }
    return reply(request.method === 'HEAD' ? null : memoHtml);
  } catch {
    return authPath ? jsonError('Email access is temporarily unavailable. Please try again later.', 503) : reply(messagePage('Temporarily unavailable', 'We couldn’t open the memo. Please try again shortly.'), 503);
  }
}
