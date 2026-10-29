// Preserve the deployed retirement boundary, including encoded old links.
export function demoOfflineResponse(request: Request): Response | null {
  let path: string;
  try { path = decodeURIComponent(new URL(request.url).pathname); }
  catch { return null; }
  if (!/^\/demo(?:\/|$|\.html$)/.test(path)) return null;
  return new Response(request.method === 'HEAD' ? null : 'Not found.\n', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' },
  });
}
