import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { buildMemo } from '../../scripts/build-memo.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const site = resolve(root, 'site');
export interface LocalEmail { email: string; otp: string }

export async function startMemoRuntime({ port = 0, origin = 'https://openmerit.ai', onEmail = (_message: LocalEmail): void | Promise<void> => {}, vars = {} }: {
  port?: number; origin?: string; onEmail?: (message: LocalEmail) => void | Promise<void>; vars?: Record<string, string>;
} = {}) {
  await buildMemo(root);
  // Canonical-origin tests run the production entry point and delivery adapter.
  // The loopback browser preview skips only the canonical-host wrapper.
  const entry = origin.startsWith('http://127.0.0.1:') ? './local-worker.ts' : '../site.ts';
  const bundle = await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'neutral', conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'], external: ['node:*', 'cloudflare:workers'], logLevel: 'silent' });
  const mailbox = new Map<string, string>();
  const capture = async (message: LocalEmail) => { mailbox.set(message.email, message.otp); await onEmail(message); };
  const mf = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1', port, modules: true, script: bundle.outputFiles[0]!.text,
    compatibilityDate: '2026-09-22', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['MEMO_DB'],
    bindings: { MEMO_AUTH_ORIGIN: origin, MEMO_AUTH_SECRET: 'local-simulator-only-secret-never-used-for-production-1234567890', MEMO_ADMIN_EMAILS: 'admin@example.test', MEMO_DAILY_EMAIL_LIMIT: '100', MEMO_EMAIL_PROVIDER: 'resend', MEMO_EMAIL_FROM: 'OpenMerit <memo@openmerit.ai>', RESEND_API_KEY: 'local-mailbox-only', ...vars },
    outboundService: async request => {
      if (request.url !== 'https://api.resend.com/emails') throw new Error('External network is disabled in the memo simulator.');
      const message = await request.json() as { to: string[]; text: string };
      const otp = message.text.match(/verification code is (\d{6})/)?.[1];
      if (!message.to[0] || !otp) throw new Error('Invalid local email.');
      await capture({ email: message.to[0], otp });
      return new Response('{"id":"local-only"}', { headers: { 'Content-Type': 'application/json' } });
    },
    serviceBindings: {
      TEST_MAILBOX: async request => {
        const message = await request.json() as LocalEmail;
        await capture(message);
        return new Response('ok');
      },
      ASSETS: async request => {
        let path: string;
        try { path = resolve(site, '.' + decodeURIComponent(new URL(request.url).pathname)); } catch { return new Response('Not found', { status: 404 }); }
        if (path !== site && !path.startsWith(site + sep)) return new Response('Not found', { status: 404 });
        const types: Record<string, string> = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp', '.html': 'text/html' };
        try {
          if (!extname(path)) path = resolve(path, 'index.html');
          return new Response(new Uint8Array(await readFile(path)), { headers: { 'Content-Type': types[extname(path)] || 'application/octet-stream' } });
        } catch { return new Response('Not found', { status: 404 }); }
      },
    },
  }));
  try {
    const db = await mf.getD1Database('MEMO_DB');
    for (const file of ['0001_better_auth.sql', '0002_memo_readers.sql']) {
      const sql = await readFile(new URL('./migrations/' + file, import.meta.url), 'utf8');
      await db.exec(sql.replace(/^--.*$/gm, '').replace(/\n/g, ' '));
    }
    return { mf, db, mailbox };
  } catch (error) { await mf.dispose(); throw error; }
}
