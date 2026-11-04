export const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } });
// Reject retired agent endpoints before auth, redirects or asset/SPA fallback.
// Only the canonical /scout/mcp endpoint is served; aliases and OAuth discovery stay retired.
export const isRetiredAgentPath = path => /^\/scout\/(?:(?:alpha|v1|v2)\/)*api\/recommend(?:\/|$)/.test(path) || /^\/scout\/(?:(?:alpha|v1|v2)\/)+mcp(?:\/|$)/.test(path) || path.startsWith('/scout/mcp/') || /^\/scout\/(?:(?:alpha|v1|v2)\/)*\.well-known\/oauth-protected-resource(?:\/|$)/.test(path) || /^\/\.well-known\/oauth-protected-resource(?:\/|$)/.test(path);

export async function readJSON(request) {
  const fail = (message, status) => { const error = new Error(message); error.status = status; throw error; };
  if (Number(request.headers.get('content-length')) > 18_000) fail('Request is too large.', 413);
  const reader = request.body?.getReader(); let bytes = 0, text = ''; const decoder = new TextDecoder();
  if (!reader) fail('Provide a JSON body.', 400);
  while (true) {
    const { done, value } = await reader.read(); if (done) break; bytes += value.length;
    if (bytes > 18_000) { await reader.cancel(); fail('Request is too large.', 413); }
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}
