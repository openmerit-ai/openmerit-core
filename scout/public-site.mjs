// Keep the rebuild boundary identical at the domain router, Scout Worker and
// local preview. Preserve the landing page and Scout, not the retired pages.
const sharedAssets = new Set([
  '/',
  '/favicon.svg',
  '/styles.css',
  // A shareable walkthrough of the Sahra Health playground; nothing else under /playground.
  '/playground/scout',
  '/playground/scout/',
]);

export function publicSiteResponse(request) {
  const path = new URL(request.url).pathname;
  if (path === '/scout' || path.startsWith('/scout/') || path === '/connect' || path.startsWith('/connect/') || path.startsWith('/assets/') || sharedAssets.has(path)) return null;
  return new Response('Not found.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}
