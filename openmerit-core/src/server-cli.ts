// `openmerit server`: starts, stops and reports the self-hosted OpenMerit server, the same server
// openmerit.ai runs (src/server), on this machine. It runs in the background with its state, token,
// log and pid in ~/.openmerit/server, and serves the web app, /api and /mcp on 127.0.0.1.
import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openmeritHome } from "./state/paths.ts";

type Env = Record<string, string | undefined>;
interface ServerInfo { pid: number; port: number; url: string; startedAt: string }

export const DEFAULT_PORT = 7330;
const dataDir = (env: Env) => env.OPENMERIT_DATA_DIR || join(openmeritHome(env), "server");
const infoFile = (env: Env) => join(dataDir(env), "server.json");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };

function readInfo(env: Env): ServerInfo | null {
  try { return JSON.parse(readFileSync(infoFile(env), "utf8")) as ServerInfo; } catch { return null; }
}
async function healthy(url: string): Promise<boolean> {
  try { return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}
/** The running server, or null; a record whose process ended is removed. */
async function running(env: Env): Promise<ServerInfo | null> {
  const info = readInfo(env);
  if (!info) return null;
  if (!alive(info.pid)) { rmSync(infoFile(env), { force: true }); return null; }
  return info;
}

/** A one-time sign-in link for the web app, which the server makes for a caller with its token. */
async function signInLink(env: Env, info: ServerInfo): Promise<string> {
  const token = readFileSync(join(dataDir(env), "token"), "utf8").trim();
  const response = await fetch(`${info.url}/api/session/link`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  const body = await response.json() as { url?: string; error?: string };
  if (!response.ok || !body.url) throw new Error(body.error ?? `the server answered ${response.status}`);
  return body.url;
}

/** The server's entry point beside this file: dist/server/server.js installed, src/server/server.ts from source. */
const entry = () => fileURLToPath(new URL(`./server/server.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url));

export async function serverCommand(args: string[], log: (line: string) => void, env: Env = process.env): Promise<void> {
  const [action = "status", ...rest] = args;
  const portAt = rest.indexOf("--port");
  const port = portAt >= 0 ? Number(rest[portAt + 1]) : Number(env.OPENMERIT_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_524) throw new Error("--port is a port number, such as 7330.");
  const dir = dataDir(env);

  if (action === "status") {
    const info = await running(env);
    if (info && await healthy(info.url)) return void process.stdout.write(`running: ${info.url} (pid ${info.pid}, since ${info.startedAt}), data in ${dir}\n`);
    return void process.stdout.write(info ? `starting or not answering: pid ${info.pid}; log in ${join(dir, "server.log")}\n` : "not running\n");
  }
  if (action === "stop") {
    const info = await running(env);
    if (!info) return void log("The OpenMerit server is not running.");
    process.kill(info.pid, "SIGTERM");
    for (let waited = 0; alive(info.pid) && waited < 20_000; waited += 200) await sleep(200);
    if (alive(info.pid)) process.kill(info.pid, "SIGKILL");
    rmSync(infoFile(env), { force: true });
    return void log("Stopped the OpenMerit server. Its runs and settings stay in its data directory.");
  }
  if (action === "link") {
    const info = await running(env);
    if (!info) throw new Error("The OpenMerit server is not running: start it with `openmerit server start`.");
    return void process.stdout.write(`${await signInLink(env, info)}\n`);
  }
  if (action !== "start") throw new Error(`Unknown server command "${action}". Use start, stop, status or link.`);

  const found = await running(env);
  if (found) {
    log(`The OpenMerit server already runs at ${found.url}.`);
    return void process.stdout.write(`Sign in to the web app (the link works once, for ten minutes):\n  ${await signInLink(env, found)}\n`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const url = `http://localhost:${port}`;
  const out = openSync(join(dir, "server.log"), "a");
  const child = spawn(process.execPath, [entry()], {
    detached: true, stdio: ["ignore", out, out],
    // The local engine listens on port + 1, port + 2 and port + 11, and the server's metrics on port + 3: one choice of port moves them all.
    env: { ...env, OPENMERIT_MODE: "self-hosted", OPENMERIT_DATA_DIR: dir, PORT: String(port), OPENMERIT_ENGINE_PORT: String(port + 1), RIVETKIT_METRICS_PORT: String(port + 3), OPENMERIT_PUBLIC_URL: url, OPENMERIT_APP_URL: url },
  });
  child.unref();
  const info: ServerInfo = { pid: child.pid!, port, url, startedAt: new Date().toISOString() };
  writeFileSync(infoFile(env), JSON.stringify(info), { mode: 0o600 });
  for (let waited = 0; !(await healthy(url)); waited += 500) {
    if (!alive(info.pid) || waited > 90_000) {
      rmSync(infoFile(env), { force: true });
      throw new Error(`The OpenMerit server did not start. Its log is ${join(dir, "server.log")}.`);
    }
    await sleep(500);
  }
  log(`OpenMerit server running at ${url} (pid ${info.pid}). Its token, for coding agents and scripts, is in ${join(dir, "token")}.`);
  process.stdout.write(`Sign in to the web app (the link works once, for ten minutes; \`openmerit server link\` makes another):\n  ${await signInLink(env, info)}\n`);
}
