// Restored from codex/main-before-terminal-2026-10-12, with the same OTP contract.
import { betterAuth } from 'better-auth';
import { emailOTP } from 'better-auth/plugins/email-otp';

export interface MemoDatabase {
  prepare(sql: string): {
    bind(...values: unknown[]): ReturnType<MemoDatabase['prepare']>;
    first<T = Record<string, unknown>>(): Promise<T | null>;
    all<T = Record<string, unknown>>(): Promise<{ results: T[]; meta: { changes: number; last_row_id: number } }>;
    run(): Promise<unknown>;
  };
  batch<T = unknown>(statements: ReturnType<MemoDatabase['prepare']>[]): Promise<{ results: T[]; meta: { changes: number; last_row_id: number } }[]>;
  exec(sql: string): Promise<unknown>;
}

interface CodeEmail {
  from: string | { name: string; email: string };
  to: string[];
  subject: string;
  text: string;
}

export interface MemoEnv {
  MEMO_DB?: MemoDatabase;
  MEMO_AUTH_SECRET?: string;
  MEMO_AUTH_ORIGIN?: string;
  MEMO_ADMIN_EMAILS?: string;
  MEMO_EMAIL_PROVIDER?: string;
  MEMO_EMAIL_FROM?: string;
  MEMO_DAILY_EMAIL_LIMIT?: string;
  MEMO_EMAIL?: { send(message: CodeEmail): Promise<unknown> };
  RESEND_API_KEY?: string;
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export type ReadyMemoEnv = MemoEnv & { MEMO_DB: MemoDatabase; MEMO_AUTH_SECRET: string; MEMO_AUTH_ORIGIN: string };
export type SendCode = (email: string, otp: string) => Promise<void>;

export function createMemoAuth(env: ReadyMemoEnv, sendCode: SendCode) {
  return betterAuth({
    appName: 'OpenMerit', baseURL: env.MEMO_AUTH_ORIGIN, basePath: '/memo/auth',
    secret: env.MEMO_AUTH_SECRET, database: env.MEMO_DB,
    trustedOrigins: [env.MEMO_AUTH_ORIGIN], logger: { disabled: true },
    session: { expiresIn: 7 * 86400, disableSessionRefresh: true },
    advanced: {
      cookiePrefix: 'openmerit_memo', useSecureCookies: env.MEMO_AUTH_ORIGIN.startsWith('https://'),
      defaultCookieAttributes: { path: '/memo', httpOnly: true, sameSite: 'lax' },
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
    rateLimit: {
      enabled: true, storage: 'database', window: 60, max: 30,
      customRules: {
        '/email-otp/send-verification-otp': { window: 60, max: 3 },
        '/sign-in/email-otp': { window: 60, max: 10 },
      },
    },
    plugins: [emailOTP({
      otpLength: 6, expiresIn: 600, allowedAttempts: 5, storeOTP: 'hashed',
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type !== 'sign-in') throw new Error('Unsupported email type.');
        await sendCode(email, otp);
      },
    })],
  });
}

export async function consumeLimit(env: ReadyMemoEnv, key: string, windowSeconds: number, max: number, now = Date.now()) {
  const signingKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.MEMO_AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', signingKey, new TextEncoder().encode(key)));
  const hash = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
  const row = await env.MEMO_DB.prepare(`
    INSERT INTO memo_limits (key, count, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END,
      expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
    WHERE expires_at <= ? OR count < ? RETURNING count
  `).bind(hash, now + windowSeconds * 1000, now, now, now, max).first();
  return Boolean(row);
}

export async function sendMemoCode(env: MemoEnv, email: string, otp: string) {
  const message = {
    from: env.MEMO_EMAIL_FROM || '', to: [email], subject: 'Your code to read the OpenMerit memo',
    text: `Your OpenMerit verification code is ${otp}.\n\nEnter this code to read the memo. It expires in 10 minutes.\n\nIf you did not request this code, you can ignore this email.`,
  };
  if (env.MEMO_EMAIL_PROVIDER === 'cloudflare') {
    if (!env.MEMO_EMAIL?.send) throw new Error('Email delivery is not configured.');
    const named = /^([^<>]+)\s*<([^<>]+)>$/.exec(message.from);
    await env.MEMO_EMAIL.send({ ...message, from: named ? { name: named[1]!.trim(), email: named[2]! } : message.from });
    return;
  }
  if (env.MEMO_EMAIL_PROVIDER !== 'resend' || !env.RESEND_API_KEY) throw new Error('Email delivery is not configured.');
  const result = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(message), signal: AbortSignal.timeout(15000),
  });
  if (!result.ok) throw new Error('Email delivery failed.');
}
