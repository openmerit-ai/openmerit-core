// The openmerit CLI as a client of an OpenMerit server: openmerit.ai, or a self-hosted one. It keeps
// which server it signed in to in ~/.openmerit/login.json (mode 0600) and calls the server's /mcp
// tools and /api with that sign-in, as a coding agent does.
//
// Which server, in order: OPENMERIT_SERVER with OPENMERIT_TOKEN (scripts and CI), then `openmerit
// login`, then a self-hosted server `openmerit server start` runs on this machine.
//
// Hosted sign-in is the MCP authorization flow: the CLI registers itself once as a public OAuth client
// of the server's authorization server (Clerk), then signs in with an authorization code and PKCE,
// redirected to a loopback port. When the browser runs on another machine, the user pastes the
// address it ends on. Access tokens refresh with the refresh token.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { openmeritHome } from "./state/paths.ts";

type Env = Record<string, string | undefined>;
export const HOSTED = "https://openmerit.ai";
const SCOPE = "openid profile email offline_access user:org:read";

interface OAuthLogin { issuer: string; tokenEndpoint: string; clientId: string; resource: string; accessToken: string; refreshToken: string | null; expiresAt: number | null }
export interface Login {
  server: string;
  mode: "hosted" | "self-hosted";
  /** Self-hosted: the file that holds the server's token. */
  tokenFile?: string;
  oauth?: OAuthLogin;
}
interface Saved { login: Login | null; /** The OAuth client this CLI registered with each authorization server, by issuer. */ clients: Record<string, string> }

/** Where the CLI talks to and how it signs in. */
export interface Connection { server: string; mode: "hosted" | "self-hosted"; token: () => string; refresh: (() => Promise<boolean>) | null }

const loginFile = (env: Env) => join(openmeritHome(env), "login.json");
function readSaved(env: Env): Saved {
  try { return { login: null, clients: {}, ...JSON.parse(readFileSync(loginFile(env), "utf8")) as Partial<Saved> }; } catch { return { login: null, clients: {} }; }
}
function writeSaved(env: Env, saved: Saved): void {
  const file = loginFile(env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

const serverDir = (env: Env) => env.OPENMERIT_DATA_DIR || join(openmeritHome(env), "server");
const trim = (url: string) => url.replace(/\/+$/, "");
async function getJson<T>(url: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  let response: Response;
  try { response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }); }
  catch { throw new Error(`${new URL(url).origin} could not be reached.`); }
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: text.slice(0, 200) }; }
  return { status: response.status, body: body as T };
}

/** The server the CLI uses now, or null when it has none. */
export function connection(env: Env = process.env): Connection | null {
  if (env.OPENMERIT_SERVER && env.OPENMERIT_TOKEN) {
    const token = env.OPENMERIT_TOKEN;
    return { server: trim(env.OPENMERIT_SERVER), mode: trim(env.OPENMERIT_SERVER) === HOSTED ? "hosted" : "self-hosted", token: () => token, refresh: null };
  }
  const saved = readSaved(env);
  const login = saved.login;
  if (login?.oauth) {
    const oauth = login.oauth;
    return { server: login.server, mode: login.mode, token: () => oauth.accessToken, refresh: () => refreshLogin(env, saved, login, oauth) };
  }
  if (login) {
    const file = login.tokenFile ?? join(serverDir(env), "token");
    return { server: login.server, mode: login.mode, token: () => readFileSync(file, "utf8").trim(), refresh: null };
  }
  // A self-hosted server this machine runs (openmerit server start).
  try {
    const info = JSON.parse(readFileSync(join(serverDir(env), "server.json"), "utf8")) as { url: string };
    const file = join(serverDir(env), "token");
    return { server: trim(info.url), mode: "self-hosted", token: () => readFileSync(file, "utf8").trim(), refresh: null };
  } catch { return null; }
}

export function requireConnection(env: Env = process.env): Connection {
  const found = connection(env);
  if (!found) throw new Error("No OpenMerit server: sign in to openmerit.ai with `openmerit login`, or start one on this machine with `openmerit server start`.");
  return found;
}

async function refreshLogin(env: Env, saved: Saved, login: Login, oauth: OAuthLogin): Promise<boolean> {
  if (!oauth.refreshToken) return false;
  const { status, body } = await getJson<TokenAnswer>(oauth.tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: oauth.refreshToken, client_id: oauth.clientId, resource: oauth.resource }) });
  if (status !== 200 || !body.access_token) return false;
  Object.assign(oauth, tokens(body, oauth.refreshToken));
  writeSaved(env, { ...saved, login: { ...login, oauth } });
  return true;
}

/** A request to the server with the CLI's sign-in; an expired hosted token is refreshed once. */
export async function call<T>(conn: Connection, path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const send = () => getJson<T>(`${conn.server}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${conn.token()}` } });
  let answer = await send();
  if (answer.status === 401 && conn.refresh && await conn.refresh()) answer = await send();
  if (answer.status === 401) {
    const error = (answer.body as { error?: string } | null)?.error;
    throw new Error(conn.mode === "hosted" ? `Your sign-in to ${conn.server} ended: run \`openmerit login\`.` : `${conn.server} refused the token${error ? `: ${error}` : ""}.`);
  }
  return answer;
}

export interface ToolAnswer { text: string; data: Record<string, unknown>; isError: boolean }
let rpcId = 0;
/** Calls one of the server's MCP tools, as a coding agent does. */
export async function callTool(conn: Connection, name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const { status, body } = await call<{ result?: { content?: { text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }; error?: { message: string } | string }>(conn, "/mcp", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  if (body?.error || !body?.result) throw new Error(typeof body?.error === "object" ? body.error.message : body?.error ?? `${conn.server} answered ${status}.`);
  return { text: body.result.content?.map(part => part.text ?? "").join("\n") ?? "", data: body.result.structuredContent ?? {}, isError: body.result.isError === true };
}

interface TokenAnswer { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }
const tokens = (body: TokenAnswer, keep: string | null) => ({ accessToken: body.access_token!, refreshToken: body.refresh_token ?? keep, expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : null });
const base64url = (bytes: Buffer) => bytes.toString("base64url");

export interface LoginOptions {
  server?: string;
  /** Self-hosted: the server's token file, when it is not this machine's ~/.openmerit/server/token. */
  tokenFile?: string;
  /** Opens the sign-in page; the default starts the system's browser. Tests replace it. */
  open?: (url: string) => void;
  /** Lines the user types, such as the address the browser ended on. Default: stdin when it is a terminal. */
  input?: NodeJS.ReadableStream | null;
  log: (line: string) => void;
}

/** `openmerit login`: signs the CLI in to a server and saves it as the one the CLI uses. */
export async function login(options: LoginOptions, env: Env = process.env): Promise<Login> {
  const server = trim(options.server ?? HOSTED);
  const metadata = await getJson<{ resource?: string; authorization_servers?: string[] }>(`${server}/.well-known/oauth-protected-resource`);
  if (metadata.status !== 200 || !metadata.body) throw new Error(`${server} is not an OpenMerit server: it has no /.well-known/oauth-protected-resource.`);
  const saved = readSaved(env);
  const issuer = metadata.body.authorization_servers?.[0];
  let next: Login;
  if (!issuer) {
    // A self-hosted server signs in with its token, which is on the machine it runs on.
    const tokenFile = options.tokenFile ?? join(serverDir(env), "token");
    if (!existsSync(tokenFile)) throw new Error(`${server} is self-hosted, and its token is not in ${tokenFile}. Pass --token-file with the server's token file.`);
    next = { server, mode: "self-hosted", tokenFile };
  } else {
    next = { server, mode: "hosted", oauth: await authorize(server, issuer, metadata.body.resource ?? `${server}/mcp`, saved, options, env) };
  }
  // The sign-in must work before it replaces the last one.
  const me = await call<{ error?: string }>({ server, mode: next.mode, token: () => next.oauth?.accessToken ?? readFileSync(next.tokenFile!, "utf8").trim(), refresh: null }, "/api/me");
  if (me.status !== 200) throw new Error(`${server} refused the sign-in: ${me.body?.error ?? me.status}.`);
  writeSaved(env, { ...readSaved(env), login: next });
  return next;
}

export function logout(env: Env = process.env): Login | null {
  const saved = readSaved(env);
  if (!saved.login) return null;
  writeSaved(env, { ...saved, login: null });
  return saved.login;
}

async function authorize(server: string, issuer: string, resource: string, saved: Saved, options: LoginOptions, env: Env): Promise<OAuthLogin> {
  const meta = await getJson<{ authorization_endpoint?: string; token_endpoint?: string; registration_endpoint?: string }>(`${trim(issuer)}/.well-known/oauth-authorization-server`);
  const { authorization_endpoint: authorizeAt, token_endpoint: tokenAt, registration_endpoint: registerAt } = meta.body ?? {};
  if (!authorizeAt || !tokenAt) throw new Error(`${issuer} did not describe its OAuth endpoints.`);
  let clientId = saved.clients[issuer];
  if (!clientId) {
    if (!registerAt) throw new Error(`${issuer} does not let the CLI register itself.`);
    // Loopback redirects match any port (RFC 8252), so one registration serves every login.
    const registered = await getJson<{ client_id?: string; error_description?: string }>(registerAt, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "OpenMerit CLI", redirect_uris: ["http://127.0.0.1/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: SCOPE }) });
    if (!registered.body?.client_id) throw new Error(`${issuer} refused to register the CLI: ${registered.body?.error_description ?? registered.status}.`);
    clientId = registered.body.client_id;
    writeSaved(env, { ...readSaved(env), clients: { ...readSaved(env).clients, [issuer]: clientId } });
  }

  const verifier = base64url(randomBytes(32)), state = base64url(randomBytes(16));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  let finish: (address: string) => void = () => {};
  const arrived = new Promise<string>(resolve => { finish = resolve; });
  const listener = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Signed in to OpenMerit. You can close this tab and go back to the terminal.\n");
    finish(url.href);
  });
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const redirectUri = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/callback`;
  const url = `${authorizeAt}?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: SCOPE, state, code_challenge: challenge, code_challenge_method: "S256", resource })}`;
  options.log(`Sign in to ${server} in your browser:\n  ${url}`);
  options.log("If your browser runs on another machine, it ends on a page that does not load: paste that page's address here.");
  (options.open ?? openBrowser)(url);
  const input = options.input === undefined ? (process.stdin.isTTY ? process.stdin : null) : options.input;
  const lines = input ? createInterface({ input }) : null;
  lines?.on("line", line => { if (line.trim().includes("code=")) finish(line.trim()); });
  const timeout = setTimeout(() => finish(""), 10 * 60_000);
  let address: string;
  try { address = await arrived; } finally { clearTimeout(timeout); lines?.close(); listener.close(); }
  if (!address) throw new Error("The sign-in timed out after ten minutes. Run `openmerit login` again.");

  const back = new URL(address, redirectUri).searchParams;
  if (back.get("error")) throw new Error(`The sign-in was refused: ${back.get("error_description") ?? back.get("error")}.`);
  if (back.get("state") !== state || !back.get("code")) throw new Error("That address is not from this sign-in. Run `openmerit login` again.");
  const { body } = await getJson<TokenAnswer>(tokenAt, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: back.get("code")!, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource }) });
  if (!body?.access_token) throw new Error(`The sign-in failed: ${body?.error_description ?? body?.error ?? "no access token"}.`);
  return { issuer, tokenEndpoint: tokenAt, clientId, resource, ...tokens(body, null) };
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try { spawn(command, [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref(); } catch { /* the printed address still works */ }
}
