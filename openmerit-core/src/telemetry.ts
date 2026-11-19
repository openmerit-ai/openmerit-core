// Anonymous usage telemetry: one `cli_command_run` event per CLI command and per local MCP tool call,
// sent to PostHog. Metadata only: the command or tool name, the surface, success, duration and the
// OpenMerit, Node.js and OS versions, with a random install ID. Never arguments, paths, repository
// names, model IDs, errors or output. Off with DO_NOT_TRACK=1 or OPENMERIT_TELEMETRY=0, and always in
// CI. Sending never throws, never writes to stdout and gives up after TIMEOUT_MS.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { arch, platform } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { openmeritHome } from "./state/paths.ts";
import { packageVersion } from "./update.ts";

type Env = Record<string, string | undefined>;

/** OpenMerit's production PostHog project. A public project token: it can only send events. */
const PRODUCTION_TOKEN = "phc_uGqGVy96bhXQsq59dsx4Wt5N7zSG2zYs3xBT2jqY4KKB";
const DEFAULT_HOST = "https://us.i.posthog.com";
const TIMEOUT_MS = 1000;

export const TELEMETRY_NOTICE = "OpenMerit sends anonymous usage data: the command name, whether it succeeded, how long it took, and the OpenMerit, Node.js and OS versions, with a random install ID. Never arguments, code, paths, model names or errors. Turn it off with OPENMERIT_TELEMETRY=0 or DO_NOT_TRACK=1. Details: https://www.npmjs.com/package/openmerit#telemetry";

export function telemetryEnabled(env: Env): boolean {
  if (env.CI) return false;
  const dnt = env.DO_NOT_TRACK?.trim().toLowerCase();
  if (dnt && dnt !== "0" && dnt !== "false") return false;
  return !["0", "false", "off"].includes(env.OPENMERIT_TELEMETRY?.trim().toLowerCase() ?? "");
}

/**
 * The PostHog project token. Only an installed package (this file under node_modules) uses the
 * production project; running from source sends only when OPENMERIT_POSTHOG_TOKEN names a project.
 */
export function telemetryToken(env: Env, file: string = fileURLToPath(import.meta.url)): string | null {
  if (env.OPENMERIT_POSTHOG_TOKEN) return env.OPENMERIT_POSTHOG_TOKEN;
  return file.split(sep).includes("node_modules") ? PRODUCTION_TOKEN : null;
}

/** The random install ID in OPENMERIT_HOME, created with the one-time notice. Null when it cannot be saved. */
function installId(env: Env, log: (line: string) => void): string | null {
  const home = openmeritHome(env);
  const file = join(home, "telemetry.json");
  const read = () => {
    try { const saved = JSON.parse(readFileSync(file, "utf8")) as { installId?: unknown }; return typeof saved.installId === "string" && saved.installId ? saved.installId : null; } catch { return null; }
  };
  const saved = read();
  if (saved) return saved;
  const id = randomUUID();
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(file, `${JSON.stringify({ installId: id, noticeShownAt: new Date().toISOString() }, null, 2)}\n`, { flag: "wx" });
  } catch { return read(); }
  log(TELEMETRY_NOTICE);
  return id;
}

export interface CommandRun { command: string; surface: "cli" | "mcp"; ok: boolean; durationMs: number }

/** Sends one `cli_command_run` event. Resolves within about TIMEOUT_MS and never rejects. */
export async function sendCommandRun(run: CommandRun, env: Env = process.env, log: (line: string) => void = line => process.stderr.write(`${line}\n`)): Promise<void> {
  try {
    if (!telemetryEnabled(env)) return;
    const token = telemetryToken(env);
    if (!token) return;
    const distinctId = installId(env, log);
    if (!distinctId) return;
    const host = (env.OPENMERIT_POSTHOG_HOST || DEFAULT_HOST).replace(/\/+$/, "");
    const body = JSON.stringify({
      api_key: token, event: "cli_command_run", distinct_id: distinctId, timestamp: new Date().toISOString(), uuid: randomUUID(),
      properties: {
        command: run.command, surface: run.surface, ok: run.ok, duration_ms: Math.round(run.durationMs), version: packageVersion(),
        os: platform(), arch: arch(), node_version: process.versions.node, interface: "cli", $process_person_profile: false,
      },
    });
    await post(new URL(`${host}/i/v0/e/`), body);
  } catch { /* telemetry never affects the command */ }
}

/**
 * POSTs and resolves on the reply, an error or after TIMEOUT_MS, whichever comes first. Not fetch: an
 * aborted fetch keeps connecting to an unreachable host for about 10 s, which would hold the CLI open.
 * Here the timer destroys the request and the socket never keeps the process alive.
 */
function post(url: URL, body: string): Promise<void> {
  return new Promise(resolve => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, response => {
      response.resume();
      response.on("end", done);
      response.on("error", done);
    });
    const timer = setTimeout(done, TIMEOUT_MS);
    function done() { clearTimeout(timer); request.destroy(); resolve(); }
    request.on("socket", socket => socket.unref());
    request.on("error", done);
    request.end(body);
  });
}
