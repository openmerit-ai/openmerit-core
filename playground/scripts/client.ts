// Shared HTTP client for the scenario runner and the approver CLI.
// PLAYGROUND_URL defaults to `wrangler dev`; PLAYGROUND_TOKEN must match the Worker's secret.

export const baseUrl = (process.env.PLAYGROUND_URL ?? "http://localhost:8787").replace(/\/+$/, "");

export async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = process.env.PLAYGROUND_TOKEN;
  if (!token) throw new Error("Set PLAYGROUND_TOKEN (the same value as in .dev.vars or the Worker secret).");
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}
