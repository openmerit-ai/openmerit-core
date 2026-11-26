// Static pages that answer buyers' questions, one directory each under site/.
export const contentPages = ['/vs-routers/', '/find-a-cheaper-llm/', '/evals-from-your-code/', '/claude-code-and-codex/', '/run-locally/', '/contact-sales/'];
// Pages also served as Markdown, from an index.md the build writes beside each index.html.
export const markdownPages = ['/', ...contentPages];

// Keep the public boundary identical at the domain router and the web Worker:
// the landing page, the playground walkthrough, the content pages and the Clerk sign-in.
const sharedAssets = new Set([
  '/',
  '/favicon.svg',
  '/styles.css',
  // A shareable walkthrough of the Sahra Health playground; nothing else under /playground.
  '/playground/scout',
  '/playground/scout/',
  ...contentPages.flatMap(page => [page, page.slice(0, -1)]),
  // The contact-sales form's endpoint and its confirmation page.
  '/contact-sales/api',
  '/contact-sales/thanks/',
]);

export function publicSiteResponse(request: Request): Response | null {
  const path = new URL(request.url).pathname;
  if (path === '/scout' || path.startsWith('/scout/') || path.startsWith('/assets/') || sharedAssets.has(path)) return null;
  return new Response('Not found.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}
