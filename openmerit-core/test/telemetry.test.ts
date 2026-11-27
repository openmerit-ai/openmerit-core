// Telemetry: one `cli_command_run` event per CLI command and per local MCP tool call, with metadata
// only. A local HTTP server stands in for PostHog; no request leaves the machine.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { telemetryToken } from "../src/telemetry.ts";
import { packageVersion } from "../src/update.ts";

const cli = new URL("../src/cli.ts", import.meta.url).pathname;
type Event = { api_key: string; event: string; distinct_id: string; timestamp: string; uuid: string; properties: Record<string, unknown> };

async function fakePostHog() {
  const events: Event[] = [];
  const paths: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => { paths.push(`${req.method} ${req.url}`); events.push(JSON.parse(body) as Event); res.writeHead(200, { "content-type": "application/json" }); res.end("{\"status\":1}"); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { events, paths, host: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

/** The test's environment without any opt-out or token it inherited, with telemetry sent to `host`. */
function telemetryEnv(home: string, host: string, extra: Record<string, string> = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["CI", "DO_NOT_TRACK", "OPENMERIT_TELEMETRY"].includes(key) && !key.startsWith("OPENMERIT_POSTHOG_")));
  return { ...inherited, OPENMERIT_HOME: home, OPENMERIT_NO_UPDATE_CHECK: "1", OPENMERIT_POSTHOG_TOKEN: "phc_test", OPENMERIT_POSTHOG_HOST: host, ...extra };
}

test("the production token applies only to an installed package, never when running from source", () => {
  assert.equal(telemetryToken({}, "/usr/lib/node_modules/openmerit/dist/telemetry.js"), "phc_uGqGVy96bhXQsq59dsx4Wt5N7zSG2zYs3xBT2jqY4KKB");
  assert.equal(telemetryToken({}), null, "this checkout is not under node_modules");
  assert.equal(telemetryToken({ POSTHOG_PROJECT_TOKEN: "phc_app" }), null, "an application's own PostHog token is not read");
  assert.equal(telemetryToken({ OPENMERIT_POSTHOG_TOKEN: "phc_internal" }), "phc_internal");
});

test("a CLI command sends one event with metadata only, and the opt-outs send nothing", async () => {
  const posthog = await fakePostHog();
  const home = mkdtempSync(join(tmpdir(), "openmerit-telemetry-"));
  const repo = mkdtempSync(join(tmpdir(), "openmerit-telemetry-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const history = (extra: Record<string, string> = {}) => new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
    const child = spawn(process.execPath, [cli, "history", "--json"], { cwd: repo, env: telemetryEnv(home, posthog.host, extra), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
  try {
    const first = await history();
    assert.equal(first.code, 0);
    assert.equal(first.stdout, "[]\n", "stdout is the command's output only");
    assert.match(first.stderr, /anonymous usage data[\s\S]*OPENMERIT_TELEMETRY=0 or DO_NOT_TRACK=1/, "the first run that sends says so");
    assert.ok(existsSync(join(home, "telemetry.json")));
    assert.deepEqual(posthog.paths, ["POST /i/v0/e/"]);
    const [event] = posthog.events;
    assert.equal(posthog.events.length, 1);
    assert.deepEqual(Object.keys(event!).sort(), ["api_key", "distinct_id", "event", "properties", "timestamp", "uuid"]);
    assert.equal(event!.api_key, "phc_test");
    assert.equal(event!.event, "cli_command_run");
    assert.deepEqual(Object.keys(event!.properties).sort(), ["$process_person_profile", "arch", "command", "duration_ms", "interface", "node_version", "ok", "os", "surface", "version"]);
    assert.deepEqual({ ...event!.properties, duration_ms: 0 }, { command: "history", surface: "cli", ok: true, duration_ms: 0, version: packageVersion(), os: process.platform, arch: process.arch, node_version: process.versions.node, interface: "cli", $process_person_profile: false });
    assert.equal(typeof event!.properties.duration_ms, "number");

    const second = await history();
    assert.equal(second.stdout, first.stdout);
    assert.doesNotMatch(second.stderr, /anonymous usage data/, "the notice is shown once");
    assert.equal(posthog.events.length, 2);
    assert.equal(posthog.events[1]!.distinct_id, event!.distinct_id, "the install ID is kept");

    for (const optOut of [{ DO_NOT_TRACK: "1" }, { OPENMERIT_TELEMETRY: "0" }, { OPENMERIT_TELEMETRY: "false" }, { OPENMERIT_TELEMETRY: "off" }, { CI: "true" }]) {
      const quiet = await history(optOut);
      assert.equal(quiet.code, 0);
      assert.equal(quiet.stdout, first.stdout);
    }
    assert.equal(posthog.events.length, 2, "no opt-out sent an event");
  } finally { posthog.close(); }
});

test("an MCP tool call through openmerit mcp sends one event with surface mcp, and the proxy itself none", async () => {
  const posthog = await fakePostHog();
  const home = mkdtempSync(join(tmpdir(), "openmerit-telemetry-"));
  const repo = mkdtempSync(join(tmpdir(), "openmerit-telemetry-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  try {
    const child = spawn(process.execPath, [cli, "mcp"], { cwd: repo, env: telemetryEnv(home, posthog.host), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    send({ id: 2, method: "tools/list" });
    // No server: the call fails, and the event says so.
    send({ id: 3, method: "tools/call", params: { name: "openmerit_tasks", arguments: {} } });
    child.stdin.end();
    await new Promise(resolve => child.on("close", resolve));
    assert.ok(stdout.trim().split("\n").every(line => (JSON.parse(line) as { jsonrpc?: string }).jsonrpc === "2.0"), "stdout carries protocol messages only");
    assert.equal(posthog.events.length, 1, JSON.stringify(posthog.events));
    const { properties } = posthog.events[0]!;
    assert.equal(properties.command, "openmerit_tasks");
    assert.equal(properties.surface, "mcp");
    assert.equal(properties.ok, false);
    assert.equal(properties.interface, "cli");
  } finally { posthog.close(); }
});
