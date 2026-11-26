// The web Worker (openmerit-scout-alpha): the landing page, the content pages
// and the contact-sales form. The retired playground walkthrough redirects home. /scout, Scout's
// retired sign-in page, redirects to /contact-sales/. The domain router sends
// /memo to the site Worker instead.
import { contentPages, markdownPages, publicSiteResponse } from './public-site.ts';
import { contactSubmit, type ContactEnv } from './contact.ts';

export interface WebEnv extends ContactEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

export default {
  async fetch(request: Request, env: WebEnv): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
    const unavailable = publicSiteResponse(request);
    if (unavailable) return unavailable;
    // Scout's sign-in page and its APIs are gone; old links go to the demo request form.
    if (path === '/scout' || path.startsWith('/scout/')) return Response.redirect(`${url.origin}/contact-sales/`, 308);
    if (path === '/playground/scout' || path === '/playground/scout/') return Response.redirect(`${url.origin}/`, 308);
    if (contentPages.includes(`${path}/`)) return Response.redirect(`${url.origin}${path}/${url.search}`, 308);
    if (path === '/contact-sales/api') return contactSubmit(request, env);
    if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'Not found.' }, 404);
    return markdownPages.includes(path) ? negotiatedPage(request, env, path) : env.ASSETS.fetch(request);
  },
};

// Like Cloudflare's Markdown for Agents: an agent that lists text/markdown in Accept
// gets the page's Markdown version; everyone else gets the HTML.
function wantsMarkdown(accept: string | null): boolean {
  return (accept ?? '').split(',').some(part => {
    const [type, ...params] = part.split(';').map(value => value.trim().toLowerCase());
    return type === 'text/markdown' && !params.some(param => /^q=0(\.0*)?$/.test(param));
  });
}

async function negotiatedPage(request: Request, env: WebEnv, path: string): Promise<Response> {
  const markdown = wantsMarkdown(request.headers.get('accept'));
  const source = await env.ASSETS.fetch(markdown ? new Request(new URL(`${path}index.md`, request.url), { method: request.method }) : request);
  const response = new Response(source.body, source);
  response.headers.append('Vary', 'Accept');
  if (markdown && source.ok) {
    response.headers.set('Content-Type', 'text/markdown; charset=utf-8');
    // The same policy as robots.txt: search and agents may use it, training may not.
    response.headers.set('Content-Signal', 'search=yes, ai-input=yes, ai-train=no');
  }
  return response;
}
