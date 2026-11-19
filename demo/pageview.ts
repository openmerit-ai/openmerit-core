// The website's `$pageview`, sent server-side by the domain router: cookieless and
// anonymous. The daily visitor ID is a hash that changes every UTC day.
export interface PageviewEnv {
  POSTHOG_PROJECT_TOKEN?: string;
  POSTHOG_HOST?: string;
}

interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

const pageHosts = new Set(['openmerit.ai', 'www.openmerit.ai']);
const skippedPrefixes = ['/mcp', '/.well-known', '/api', '/assets'];
const bots = /bot|crawl|spider|preview|headless/i;
const salt = 'openmerit-website-pageview-v1';

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function origin(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

async function send(request: Request, env: PageviewEnv, token: string): Promise<void> {
  const url = new URL(request.url);
  const userAgent = request.headers.get('user-agent') ?? '';
  const ip = request.headers.get('cf-connecting-ip') ?? '';
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const properties: Record<string, string | boolean> = {
    interface: 'website',
    $process_person_profile: false,
    $current_url: url.origin + url.pathname,
    $pathname: url.pathname,
    $host: url.host,
    $raw_user_agent: userAgent,
  };
  if (ip) properties.$ip = ip;
  const referrer = origin(request.headers.get('referer'));
  if (referrer) properties.$referrer = referrer;
  for (const name of ['utm_source', 'utm_medium', 'utm_campaign']) {
    const value = url.searchParams.get(name);
    if (value) properties[name] = value;
  }
  await fetch(new URL('/i/v0/e/', env.POSTHOG_HOST || 'https://us.i.posthog.com'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: token,
      event: '$pageview',
      distinct_id: await sha256(salt + ip + userAgent + day),
      timestamp: now.toISOString(),
      uuid: crypto.randomUUID(),
      properties,
    }),
    signal: AbortSignal.timeout(2000),
  });
}

// Queues one capture for a successful HTML page GET; never throws or touches the response.
export function capturePageview(request: Request, response: Response, env: PageviewEnv, ctx: WaitUntil | undefined): void {
  try {
    const token = env.POSTHOG_PROJECT_TOKEN;
    if (!token || !ctx || request.method !== 'GET') return;
    if (response.status < 200 || response.status > 299) return;
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/html') return;
    const url = new URL(request.url);
    if (!pageHosts.has(url.hostname)) return;
    if (skippedPrefixes.some(prefix => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) return;
    if (bots.test(request.headers.get('user-agent') ?? '')) return;
    ctx.waitUntil(send(request, env, token).catch(() => undefined));
  } catch {
    // Analytics must never affect the page.
  }
}
