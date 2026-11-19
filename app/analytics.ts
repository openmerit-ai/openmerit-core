// Product analytics for the signed-in pages: `$identify` once per page load and a
// `$pageview` for each view, with the Clerk user ID as distinct_id. Events go to
// the Worker's first-party /ingest/e/, which adds the PostHog project token. No
// cookies or storage; run IDs and query strings never leave the browser.
const endpoint = "/ingest/e/";

// /r/<run ID>/ becomes /r/:id/, so the path names the view and not the run.
export const normalisePath = (pathname: string): string => pathname.replace(/^\/r\/[^/]+/, "/r/:id");

function send(event: string, distinctId: string, properties: Record<string, unknown>): void {
  try {
    const body = JSON.stringify({ event, distinct_id: distinctId, timestamp: new Date().toISOString(), uuid: crypto.randomUUID(), properties: { interface: "app", ...properties } });
    if (navigator.sendBeacon?.(endpoint, new Blob([body], { type: "application/json" }))) return;
    void fetch(endpoint, { method: "POST", body, keepalive: true, headers: { "Content-Type": "application/json" } }).catch(() => {});
  } catch { /* analytics never breaks the page */ }
}

let identified: string | null = null;

export function trackPageview(userId: string | undefined): void {
  if (!userId?.startsWith("user_")) return;
  if (identified !== userId) { identified = userId; send("$identify", userId, {}); }
  const path = normalisePath(location.pathname);
  let referrer = "$direct";
  try { if (document.referrer) referrer = new URL(document.referrer).origin; } catch { /* unreadable */ }
  send("$pageview", userId, {
    $current_url: `${location.origin}${path}`, $pathname: path, $host: location.host, $referrer: referrer,
    $screen_width: screen.width, $screen_height: screen.height,
  });
}
