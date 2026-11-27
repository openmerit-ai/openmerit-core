// `openmerit mcp`: a stdio MCP server for Claude Code, Codex and other clients that forwards each
// message to the /mcp of the OpenMerit server the CLI uses (openmerit.ai after `openmerit login`, or
// a self-hosted one; see client.ts), signed in as the CLI. The agent gets the same tools,
// confirmations and results as over HTTP. Stdout carries protocol messages only.
//
// The server is looked up for each message, so signing in or starting a server takes effect without
// restarting the client. Until there is one, initialize and tools/list are answered here and each tool
// call says how to get a server.
import { createInterface } from "node:readline";
import { call, connection } from "./client.ts";
import { TOOLS } from "./server/tools.ts";
import { sendCommandRun } from "./telemetry.ts";
import { checkForUpdate, packageVersion, updateNotice } from "./update.ts";

type Json = Record<string, unknown>;
type Env = Record<string, string | undefined>;
// Tools answer without waiting for a run; a bundle upload is the slowest request.
const TIMEOUT_MS = 5 * 60_000;
const NO_SERVER = "No OpenMerit server: ask the user to run `openmerit login` to use openmerit.ai, or `openmerit server start` to run one on this machine.";

export async function serveMcp(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout, env: Env = process.env) {
  const send = (message: Json) => output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const updateCheck = checkForUpdate(env);
  const telemetry = new Set<Promise<void>>();
  // The session ID the server returned on initialize; it names the client on held confirmations.
  let session: string | null = null;

  /** The replies when the server cannot give them: initialize and tools/list still work, everything else says why. */
  const answerHere = (message: Json, problem: string): Json[] => {
    const id = message.id;
    if (id === undefined) return [];
    const method = message.method;
    if (method === "initialize") {
      const params = (message.params ?? {}) as Json;
      return [{ id, result: { protocolVersion: params.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "openmerit", version: packageVersion() }, instructions: `OpenMerit finds the cheapest model that does a task as well as the current one. ${problem}` } }];
    }
    if (method === "ping") return [{ id, result: {} }];
    if (method === "tools/list") return [{ id, result: { tools: TOOLS } }];
    if (method === "tools/call") return [{ id, result: { content: [{ type: "text", text: problem }], isError: true } }];
    return [{ id, error: { code: -32000, message: problem } }];
  };

  /** Sends one message to the server and returns its replies. */
  const forward = async (message: Json): Promise<Json[]> => {
    const conn = connection(env);
    if (!conn) return answerHere(message, NO_SERVER);
    let status: number, body: unknown, headers: Headers;
    try {
      ({ status, body, headers } = await call<unknown>(conn, "/mcp", {
        method: "POST", body: JSON.stringify(message), signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
      }));
    } catch (error) { return answerHere(message, error instanceof Error ? error.message : String(error)); }
    session = headers.get("mcp-session-id") ?? session;
    if (status === 202) return [];
    if (status !== 200 || !body || typeof body !== "object") {
      const error = (body as { error?: unknown } | null)?.error;
      return answerHere(message, `${conn.server} answered ${status}${typeof error === "string" ? `: ${error}` : ""}.`);
    }
    return [body].flat() as Json[];
  };

  const handle = async (message: Json) => {
    const started = Date.now();
    const replies = await forward(message).catch(error => answerHere(message, error instanceof Error ? error.message : String(error)));
    for (const reply of replies) send(reply);
    if (message.method === "notifications/initialized") {
      const notice = updateNotice(await updateCheck);
      if (notice) send({ method: "notifications/message", params: { level: "warning", logger: "openmerit", data: notice } });
    }
    if (message.method !== "tools/call") return;
    // One telemetry event per tool call, with the tool's name only; the reply never waits for it.
    const name = (message.params as { name?: string } | undefined)?.name;
    const ok = replies.length > 0 && replies.every(reply => !reply.error && !(reply.result as { isError?: boolean } | undefined)?.isError);
    const sending = sendCommandRun({ command: TOOLS.some(tool => tool.name === name) ? name! : "unknown", surface: "mcp", ok, durationMs: Date.now() - started }, env);
    telemetry.add(sending);
    void sending.finally(() => telemetry.delete(sending));
  };

  const lines = createInterface({ input });
  const pending = new Set<Promise<void>>();
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: Json;
    try { message = JSON.parse(line) as Json; } catch { send({ id: null, error: { code: -32700, message: "Parse error" } }); continue; }
    const work = handle(message).finally(() => pending.delete(work));
    pending.add(work);
  }
  await Promise.all(pending);
  await Promise.all(telemetry);
}
