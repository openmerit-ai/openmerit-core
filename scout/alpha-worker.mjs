import scout from './worker.mjs';

const base = '/scout/alpha';

// Serve the current matcher without exposing a second refresh workflow. The
// catalogue bindings are used by the fetch path only; production owns writes.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return fetch(request);
    let response;
    if (url.pathname === base) {
      url.pathname += '/';
      response = Response.redirect(url, 308);
    } else {
      url.pathname = `/scout${url.pathname.slice(base.length)}`;
      response = await scout.fetch(new Request(url, request), env, ctx);
    }
    const headers = new Headers(response.headers), location = headers.get('location');
    if (location) {
      const target = new URL(location, url);
      if (target.origin === url.origin && (target.pathname === '/scout' || target.pathname.startsWith('/scout/')) && target.pathname !== base && !target.pathname.startsWith(`${base}/`)) {
        target.pathname = `${base}${target.pathname.slice('/scout'.length)}`;
        headers.set('location', target.href);
      }
    }
    headers.set('X-Robots-Tag', 'noindex, nofollow');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
