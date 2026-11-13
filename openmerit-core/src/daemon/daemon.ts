// The OpenMerit daemon: one background process per OpenMerit home that runs the local Rivet engine and
// the actors (registry.ts). The CLI and the MCP server are its clients; the first one that needs it
// starts it, and it keeps running after they exit.
//
// - The engine listens on 127.0.0.1 only (port 6720 by default, peers on 6721, metrics on 6730), so it
//   does not collide with a Rivet dev server on 6420. No connection leaves the machine.
// - Its data lives in ~/.openmerit/rivet. ~/.openmerit/daemon.json (mode 0600) holds the pid, port,
//   version and a random token generated at each start; the engine refuses requests without it.
// - A client of another package version stops the daemon and starts its own, so an update takes
//   effect on the next command.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "rivetkit/client";
import type { Answers, Step } from "../scout/workflow.ts";
import { openmeritHome } from "../state/paths.ts";
import { packageVersion } from "../update.ts";
import type { Registry } from "./registry.ts";

export const DEFAULT_PORT = 6720;
const START_TIMEOUT_MS = 90_000;

export interface DaemonInfo { pid: number; port: number; token: string; version: string; startedAt: string }
type Env = Record<string, string | undefined>;

const paths = (env: Env) => {
  const home = openmeritHome(env);
  return { home, info: join(home, "daemon.json"), lock: join(home, "daemon.lock"), log: join(home, "daemon.log"), storage: join(home, "rivet") };
};
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };

export function readDaemonInfo(env: Env = process.env): DaemonInfo | null {
  try { return JSON.parse(readFileSync(paths(env).info, "utf8")) as DaemonInfo; } catch { return null; }
}

async function healthy(info: DaemonInfo): Promise<boolean> {
  if (!alive(info.pid)) return false;
  try { return (await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}

/** Runs the daemon in this process until it receives SIGINT or SIGTERM. `openmerit daemon` calls it. */
export async function serveDaemon(env: Env = process.env): Promise<void> {
  const { home, info, storage } = paths(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const port = Number(env.OPENMERIT_DAEMON_PORT ?? DEFAULT_PORT);
  const token = `om_${randomBytes(24).toString("hex")}`;
  // Read by the engine process rivetkit spawns: its storage, and the admin token that replaces Rivet's local default.
  process.env.RIVETKIT_STORAGE_PATH = storage;
  process.env.RIVET__AUTH__ADMIN_TOKEN = token;
  const { createRegistry } = await import("./registry.ts");
  await createRegistry({ port, token }).startAndWait();
  const record: DaemonInfo = { pid: process.pid, port, token, version: packageVersion(), startedAt: new Date().toISOString() };
  writeFileSync(info, JSON.stringify(record), { mode: 0o600 });
  process.on("exit", () => { if (readDaemonInfo(env)?.pid === process.pid) rmSync(info, { force: true }); });
  process.stderr.write(`OpenMerit daemon ${record.version} on 127.0.0.1:${port} (pid ${process.pid}), data in ${storage}\n`);
}

/** Stops the daemon, if one runs. Its runs stop as interrupted and continue with `openmerit scout --resume`. */
export async function stopDaemon(env: Env = process.env): Promise<boolean> {
  const info = readDaemonInfo(env);
  if (!info || !alive(info.pid)) { rmSync(paths(env).info, { force: true }); return false; }
  process.kill(info.pid, "SIGTERM");
  for (let waited = 0; alive(info.pid) && waited < 20_000; waited += 200) await sleep(200);
  if (alive(info.pid)) process.kill(info.pid, "SIGKILL");
  rmSync(paths(env).info, { force: true });
  return true;
}

/** The running daemon of this package version, started in the background when there is none. */
export async function ensureDaemon(env: Env = process.env): Promise<DaemonInfo> {
  const current = readDaemonInfo(env);
  if (current && current.version === packageVersion() && await healthy(current)) return current;
  const { home, lock, log } = paths(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // One starter at a time: the CLI and an MCP server may both find no daemon.
  let owner = false;
  try { closeSync(openSync(lock, "wx")); owner = true; }
  catch { if (Date.now() - statSync(lock).mtimeMs > START_TIMEOUT_MS) { rmSync(lock, { force: true }); return ensureDaemon(env); } }
  try {
    if (owner) {
      const stale = readDaemonInfo(env);
      if (stale && stale.version !== packageVersion()) await stopDaemon(env);
      else if (stale) rmSync(paths(env).info, { force: true });
      const cli = fileURLToPath(new URL(`../cli${extname(fileURLToPath(import.meta.url))}`, import.meta.url));
      const out = openSync(log, "a");
      const child = spawn(process.execPath, [cli, "daemon"], { detached: true, stdio: ["ignore", out, out], env: { ...env, OPENMERIT_NO_UPDATE_CHECK: "1" } });
      child.unref();
      closeSync(out);
    }
    for (let waited = 0; waited < START_TIMEOUT_MS; waited += 250) {
      const info = readDaemonInfo(env);
      if (info && info.version === packageVersion() && await healthy(info)) return info;
      await sleep(250);
    }
    const tail = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").slice(-5).join("\n") : "";
    throw new Error(`The OpenMerit daemon did not start within ${START_TIMEOUT_MS / 1000} s.${tail ? ` Its log (${log}) ends with:\n${tail}` : ""}`);
  } finally { if (owner) rmSync(lock, { force: true }); }
}

export function daemonClient(info: DaemonInfo) {
  return createClient<Registry>({ endpoint: `http://127.0.0.1:${info.port}`, token: info.token });
}

/** A daemon call that takes longer than this counts as a lost connection. A daemon that just started can take a while to wake a run. */
const CALL_TIMEOUT_MS = 30_000;
/** Reconnect attempts after a lost connection, before the client gives up. */
export const RECONNECTS = 3;

/** `call`, or a rejection once it has taken CALL_TIMEOUT_MS. */
function within<T>(call: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer in ${CALL_TIMEOUT_MS / 1000} s`)), CALL_TIMEOUT_MS);
    call.then(value => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.replace(/^HTTP request error: Request failed: /, "").slice(0, 160);

/**
 * Advances a Scout run in the daemon: attaches this client's directory and environment, sends the
 * answers, and waits for the step's outcome while relaying its progress lines. Aborting `signal` stops
 * the step, which saves the run as interrupted. When the daemon stops answering, the client reconnects
 * (starting a new daemon if needed) up to RECONNECTS times, then gives up with the resume command.
 */
export async function advanceInDaemon(input: { runId: string; cwd: string; env: Env; answers: Answers; log: (line: string) => void; signal?: AbortSignal }): Promise<Step> {
  // process.env is not a plain object, and the client cannot serialize it: send a copy with only the set variables.
  const env = Object.fromEntries(Object.entries(input.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const connect = async () => {
    const handle = daemonClient(await ensureDaemon(input.env)).scoutRun.getOrCreate([input.runId]);
    const { since } = await within(handle.attach({ cwd: input.cwd, env }));
    return { handle, since };
  };
  const reconnect = async (error: unknown) => {
    input.log(`Connection to the OpenMerit daemon lost${/no answer in/.test(reason(error)) ? ` (no answer in ${CALL_TIMEOUT_MS / 1000} s)` : ""}. Reconnecting…`);
    for (let attempt = 1; attempt <= RECONNECTS; attempt++) {
      await sleep(1000 * attempt);
      try { const next = await connect(); input.log("Reconnected."); return next; }
      catch (retry) { input.log(`  Reconnect ${attempt}/${RECONNECTS} failed: ${reason(retry)}`); }
    }
    throw new Error(`Could not reconnect to the OpenMerit daemon. Resume later with: openmerit scout --resume ${input.runId}`);
  };
  // Attaching is safe to repeat, so a first attach that gets no answer reconnects too; the send below is not repeated.
  let { handle, since: cursor } = await connect().catch(reconnect);
  // The request waits in the run's queue and its outcome in the run's state, so both survive a daemon restart.
  const requestId = randomUUID();
  await within(handle.send("advance", { requestId, answers: input.answers }));
  let stopping = false;
  for (;;) {
    let polled;
    try {
      if (input.signal?.aborted && !stopping) { stopping = true; await within(handle.stop()); }
      polled = await within(handle.poll({ requestId, since: cursor }));
    } catch (error) {
      ({ handle, since: cursor } = await reconnect(error));
      continue;
    }
    for (const line of polled.lines) input.log(line);
    cursor = polled.next;
    if (polled.outcome) {
      if ("error" in polled.outcome) throw new Error(polled.outcome.error);
      return polled.outcome.step;
    }
    await sleep(250);
  }
}
