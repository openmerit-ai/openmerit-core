// The OpenMerit daemon: one background process per OpenMerit home that runs the local Rivet engine and
// the actors (registry.ts). The CLI and the MCP server are its clients; the first one that needs it
// starts it, and it keeps running after they exit.
//
// - The engine listens on 127.0.0.1 only (port 6720 by default, peers on 6721, metrics on 6730), so it
//   does not collide with a Rivet dev server on 6420. No connection leaves the machine.
// - Its data lives in ~/.openmerit/rivet. ~/.openmerit/daemon.json (mode 0600) holds the pid, port,
//   version and a random token generated at each start; the engine refuses requests without it. The
//   daemon refreshes the file's modification time every few seconds, so a client can tell a frozen
//   daemon from a working one: the engine's health check answers from the engine's own process.
// - Its output goes to ~/.openmerit/daemon.log, errors only, moved to daemon.log.1 when it grows too large.
// - A client of another package version stops the daemon and starts its own, so an update takes
//   effect on the next command.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "rivetkit/client";
import type { Answers, Step } from "../scout/workflow.ts";
import { openmeritHome } from "../state/paths.ts";
import { packageVersion } from "../update.ts";
import type { Registry } from "./registry.ts";

export const DEFAULT_PORT = 6720;
const START_TIMEOUT_MS = 90_000;
/** How often the daemon refreshes daemon.json's modification time, its heartbeat. */
const HEARTBEAT_MS = 5_000;
/**
 * A heartbeat older than this means the daemon is frozen: its event loop is blocked or the process is
 * stopped. Six heartbeats, and as long as a client waits for a call (CALL_TIMEOUT_MS): a daemon busy for
 * longer already counts as a lost connection, so a client's first or second reconnect replaces it.
 */
const STALE_MS = 30_000;
/** A daemon.log larger than this moves to daemon.log.1 when the next daemon starts. */
const LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Engine starts whose logs are kept. rivetkit writes a stdout and a stderr log at every start and deletes none. */
const ENGINE_LOG_STARTS = 5;

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

/** The engine's ports: its gateway on `port`, its peer API on port+1 and its metrics on port+10. */
const enginePorts = (port: number) => [port, port + 1, port + 10];

/** Those of `ports` that something already listens on at 127.0.0.1. */
async function portsInUse(ports: number[]): Promise<number[]> {
  const taken = await Promise.all(ports.map(port => new Promise<boolean>(resolve => {
    const server = createServer().once("error", () => resolve(true));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => server.close(() => resolve(false)));
  })));
  return ports.filter((_, index) => taken[index]);
}

async function portsError(port: number, taken: number[]): Promise<Error> {
  let free: number | undefined;
  for (let base = port + 100; free === undefined && base <= port + 1000 && base + 10 <= 65535; base += 100) if (!(await portsInUse(enginePorts(base))).length) free = base;
  const list = taken.length > 1 ? `${taken.slice(0, -1).join(", ")} and ${taken.at(-1)}` : String(taken[0]);
  return new Error(`${taken.length > 1 ? "Ports" : "Port"} ${list} on 127.0.0.1 ${taken.length > 1 ? "are" : "is"} already in use by another program, possibly another user's OpenMerit daemon. `
    + `The daemon's engine needs OPENMERIT_DAEMON_PORT (${port}), that port + 1 and that port + 10. Set OPENMERIT_DAEMON_PORT to another port${free ? `, such as ${free}` : ""}.`);
}

/** Where rivetkit records the engine it spawned, and where that engine's output goes. */
const engineFiles = (storage: string) => ({ stamp: join(storage, ".rivetkit", "var", "engine", "runtime.json"), logs: join(storage, ".rivetkit", "var", "logs", "rivet-engine") });

/** The pid of the engine an earlier daemon of this home started, while that engine still runs. */
function ownEngine(storage: string): number | null {
  try {
    const { pid } = JSON.parse(readFileSync(engineFiles(storage).stamp, "utf8")) as { pid: number };
    // The pid may belong to another process by now: only an engine started with this home's storage counts.
    const command = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    return command.includes("rivet-engine") && command.includes(storage) ? pid : null;
  } catch { return null; }
}

/** Whether `pid` is an OpenMerit daemon, and not another process that reused a crashed daemon's pid. */
function ownDaemon(pid: number): boolean {
  try { return /\bcli\.\w+ daemon$/.test(execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim()); } catch { return false; }
}

async function terminate(pid: number, graceMs: number): Promise<void> {
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  for (let waited = 0; alive(pid) && waited < graceMs; waited += 200) await sleep(200);
  if (!alive(pid)) return;
  process.kill(pid, "SIGKILL");
  for (let waited = 0; alive(pid) && waited < 2000; waited += 100) await sleep(100);
}

/** Deletes the engine logs of all but the last ENGINE_LOG_STARTS starts. */
function pruneEngineLogs(storage: string): void {
  const { logs } = engineFiles(storage);
  let names: string[];
  try { names = readdirSync(logs); } catch { return; }
  const start = (name: string) => /^engine-(\d+)-/.exec(name)?.[1];
  const starts = [...new Set(names.map(start).filter(value => value !== undefined))].sort((a, b) => Number(a) - Number(b));
  const old = new Set(starts.slice(0, -ENGINE_LOG_STARTS));
  for (const name of names) if (old.has(start(name)!)) rmSync(join(logs, name), { force: true });
}

const stderrLogs = (logs: string) => { try { return readdirSync(logs).filter(name => name.endsWith("-stderr.log")); } catch { return []; } };

/**
 * Rejects once an engine spawned from now on exits with an error, which it writes to its own stderr log
 * as `Error: …`. rivetkit only notices after its 60 s health check. Stops watching when `signal` aborts.
 */
async function engineFailure(storage: string, port: number, signal: AbortSignal): Promise<never> {
  const { logs } = engineFiles(storage);
  const earlier = new Set(stderrLogs(logs));
  while (!signal.aborted) {
    await sleep(250);
    for (const name of stderrLogs(logs)) {
      if (earlier.has(name)) continue;
      const file = join(logs, name);
      const error = readFileSync(file, "utf8").split("\n").find(line => line.startsWith("Error: "));
      if (!error) continue;
      const taken = /Address (already )?in use/i.test(error) ? await portsInUse(enginePorts(port)) : [];
      throw taken.length ? await portsError(port, taken) : new Error(`The Rivet engine exited while starting: ${error.slice("Error: ".length)} (log: ${file})`);
    }
  }
  return new Promise<never>(() => {});
}

const heartbeatAge = (env: Env) => { try { return Date.now() - statSync(paths(env).info).mtimeMs; } catch { return Infinity; } };

/** Whether the daemon of `info` runs, has a recent heartbeat and its engine answers. `openmerit daemon status` uses it too. */
export async function healthy(info: DaemonInfo, env: Env = process.env): Promise<boolean> {
  if (!alive(info.pid)) return false;
  // A daemon on a machine that just woke from sleep refreshes its heartbeat within one interval; a frozen one does not.
  for (let waited = 0; heartbeatAge(env) > STALE_MS; waited += 250) {
    if (waited >= HEARTBEAT_MS + 2000) return false;
    await sleep(250);
  }
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
  // An engine that a crashed daemon of this home left running has the old token. rivetkit replaces it on
  // Linux but reuses it on macOS, where it then refuses the new token: stop it on every platform.
  const leftover = ownEngine(storage);
  if (leftover !== null) await terminate(leftover, 10_000);
  pruneEngineLogs(storage);
  // Any other holder of the ports fails the start: rivetkit would use another home's engine, or wait 60 s on a port it cannot bind.
  const taken = await portsInUse(enginePorts(port));
  if (taken.length) throw await portsError(port, taken);
  const { createRegistry } = await import("./registry.ts");
  const starting = new AbortController();
  try {
    await Promise.race([createRegistry({ port, token }).startAndWait(), engineFailure(storage, port, starting.signal)]);
  } catch (error) {
    // rivetkit keeps checking the failed engine's health in the background; do not wait for it to give up.
    setTimeout(() => process.exit(1), 100).unref();
    throw error;
  } finally { starting.abort(); }
  const record: DaemonInfo = { pid: process.pid, port, token, version: packageVersion(), startedAt: new Date().toISOString() };
  writeFileSync(info, JSON.stringify(record), { mode: 0o600 });
  process.on("exit", () => { if (readDaemonInfo(env)?.pid === process.pid) rmSync(info, { force: true }); });
  setInterval(() => {
    const now = new Date();
    try { if (readDaemonInfo(env)?.pid === process.pid) utimesSync(info, now, now); } catch { /* removed meanwhile */ }
  }, HEARTBEAT_MS).unref();
  process.stderr.write(`OpenMerit daemon ${record.version} on 127.0.0.1:${port} (pid ${process.pid}), data in ${storage}\n`);
}

/** Stops the daemon, if one runs. Its runs stop as interrupted and continue with `openmerit scout --resume`. */
export async function stopDaemon(env: Env = process.env): Promise<boolean> {
  const info = readDaemonInfo(env);
  if (!info || !alive(info.pid)) { rmSync(paths(env).info, { force: true }); return false; }
  await terminate(info.pid, 20_000);
  rmSync(paths(env).info, { force: true });
  return true;
}

/** The daemon could not start. Unlike a lost connection, trying again does not help until its cause is fixed. */
export class DaemonStartError extends Error {}

/**
 * What the daemon wrote to its log after byte `from`: its own error when it printed one, else the last
 * lines. rivetkit's warnings are left out, and its errors, JSON inside JSON, are unescaped and shortened.
 */
function startLog(log: string, from: number): string {
  const lines = (existsSync(log) ? readFileSync(log).subarray(from).toString("utf8").split("\n") : [])
    .filter(line => line.trim() && !/^level=(warn|info|debug|trace)\b/.test(line))
    .map(line => line.startsWith("level=") ? line.replace(/\\+"/g, "\"").slice(0, 400) : line);
  const error = lines.findLastIndex(line => line.startsWith("openmerit: "));
  if (error < 0) return lines.slice(-5).join("\n").trim();
  const own = lines.slice(error);
  const end = own.findIndex(line => line.startsWith("level="));
  return own.slice(0, end < 0 ? undefined : end).join("\n").slice("openmerit: ".length).trim();
}

/** The running daemon of this package version, started in the background when there is none. Throws DaemonStartError when it does not start. */
export async function ensureDaemon(env: Env = process.env): Promise<DaemonInfo> {
  const current = readDaemonInfo(env);
  if (current && current.version === packageVersion() && await healthy(current, env)) return current;
  const { home, lock, log } = paths(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // One starter at a time: the CLI and an MCP server may both find no daemon.
  let owner = false;
  try { closeSync(openSync(lock, "wx")); owner = true; }
  catch { if (Date.now() - statSync(lock).mtimeMs > START_TIMEOUT_MS) { rmSync(lock, { force: true }); return ensureDaemon(env); } }
  if (owner && existsSync(log) && statSync(log).size > LOG_MAX_BYTES) renameSync(log, `${log}.1`);
  const from = existsSync(log) ? statSync(log).size : 0;
  const failed = (what: string) => {
    const said = startLog(log, from);
    return new DaemonStartError(`The OpenMerit daemon ${what}.${said ? `\n${said}` : ""}\nIts log: ${log}`);
  };
  try {
    let exited: string | null = null;
    if (owner) {
      const stale = readDaemonInfo(env);
      if (stale && stale.version !== packageVersion()) await stopDaemon(env);
      else if (stale) {
        // Its heartbeat stopped or its engine does not answer. SIGKILL also ends a stopped process, which never handles SIGTERM.
        if (ownDaemon(stale.pid)) await terminate(stale.pid, 0);
        rmSync(paths(env).info, { force: true });
      }
      const cli = fileURLToPath(new URL(`../cli${extname(fileURLToPath(import.meta.url))}`, import.meta.url));
      const out = openSync(log, "a");
      // rivetkit logs warnings by default, such as one for every unnamed SQLite transaction; the log keeps its errors.
      const childEnv = { ...env, OPENMERIT_NO_UPDATE_CHECK: "1", RIVET_LOG_LEVEL: env.RIVET_LOG_LEVEL ?? "error" };
      const child = spawn(process.execPath, [cli, "daemon"], { detached: true, stdio: ["ignore", out, out], env: childEnv });
      child.once("exit", (code, signal) => { exited = signal ?? `code ${code}`; });
      child.unref();
      closeSync(out);
    }
    for (let waited = 0; waited < START_TIMEOUT_MS; waited += 250) {
      // Checked before the health check: a starter that finished before a failed check gave up.
      const starterDone = !owner && !existsSync(lock);
      const info = readDaemonInfo(env);
      if (info && info.version === packageVersion() && await healthy(info, env)) return info;
      if (exited !== null) throw failed(`could not start (it exited with ${exited})`);
      if (starterDone) throw failed("that another OpenMerit process was starting did not start");
      await sleep(250);
    }
    throw failed(`did not start within ${START_TIMEOUT_MS / 1000} s`);
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
 * (starting a new daemon if needed) up to RECONNECTS times, then gives up with the resume command. A
 * daemon that cannot start is not a lost connection: that error ends the call at once, with the resume command.
 */
export async function advanceInDaemon(input: { runId: string; cwd: string; env: Env; answers: Answers; log: (line: string) => void; signal?: AbortSignal }): Promise<Step> {
  // process.env is not a plain object, and the client cannot serialize it: send a copy with only the set variables.
  const env = Object.fromEntries(Object.entries(input.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const connect = async () => {
    const handle = daemonClient(await ensureDaemon(input.env)).scoutRun.getOrCreate([input.runId]);
    const { since } = await within(handle.attach({ cwd: input.cwd, env }));
    return { handle, since };
  };
  const notStarted = (error: unknown) => error instanceof DaemonStartError ? new Error(`${error.message}\nThen continue with: openmerit scout --resume ${input.runId}`) : null;
  const reconnect = async (error: unknown) => {
    const start = notStarted(error);
    if (start) throw start;
    input.log(`Connection to the OpenMerit daemon lost${/no answer in/.test(reason(error)) ? ` (no answer in ${CALL_TIMEOUT_MS / 1000} s)` : ""}. Reconnecting…`);
    for (let attempt = 1; attempt <= RECONNECTS; attempt++) {
      await sleep(1000 * attempt);
      try { const next = await connect(); input.log("Reconnected."); return next; }
      catch (retry) {
        const failed = notStarted(retry);
        if (failed) throw failed;
        input.log(`  Reconnect ${attempt}/${RECONNECTS} failed: ${reason(retry)}`);
      }
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
