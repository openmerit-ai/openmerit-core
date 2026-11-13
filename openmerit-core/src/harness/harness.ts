// OpenMerit Harness: Scout's reasoning steps run on Pi's model runtime. Pi is powered by one of:
// - Claude Code (`claude -p`) or Codex (`codex exec`), registered as Pi providers that drive the
//   user's installed, logged-in CLI through its supported non-interactive mode, read-only;
// - a Pi API provider (anthropic, openai, openrouter, ...) with a configured key.
// The harness never reads coding-agent credential files, and never switches provider silently.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, type Api, type AssistantMessage, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolveCredential, type HarnessSettings } from "../state/config.ts";
import { openmeritHome } from "../state/paths.ts";

export interface HarnessUsage { calls: number; costUsd: number; unknownCost: number; inputTokens: number; outputTokens: number }

export interface JsonRequest {
  system: string;
  prompt: string;
  /** JSON Schema of the reply; the reply is parsed and must be an object. */
  schema: Record<string, unknown>;
  /** Let a coding-agent harness read (never write) files under `cwd` with its own read-only tools. */
  cwd?: string;
  signal?: AbortSignal;
}

export interface Harness {
  readonly kind: HarnessSettings["kind"];
  /** Who receives code and context sent to the harness, for disclosure. */
  readonly destination: string;
  readonly usage: HarnessUsage;
  json<T>(request: JsonRequest): Promise<T>;
}

/** The text of every message after the system prompt, in order. */
const promptText = (context: TranscriptContext) => context.messages.map(message => {
  if (message.role === "system") return "";
  const content = (message as { content: unknown }).content;
  return typeof content === "string" ? content : Array.isArray(content) ? content.map(part => (part as { text?: string }).text ?? "").join("") : "";
}).filter(Boolean).join("\n\n");

interface CliResult { text: string; costUsd: number | null; input: number; output: number }

function run(command: string, args: string[], input: string, cwd: string, signal?: AbortSignal, env: Record<string, string | undefined> = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], ...(signal ? { signal } : {}) });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; if (stderr.length > 200_000) stderr = stderr.slice(-100_000); });
    child.on("error", error => reject((error as NodeJS.ErrnoException).code === "ENOENT" ? new Error(`${command} is not installed or not on PATH`) : error));
    child.on("close", code => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

const tail = (text: string) => text.trim().split("\n").slice(-4).join(" ").slice(0, 400);

/** Claude Code print mode: no session file, no MCP servers (OpenMerit's own included), read-only tools. */
async function claudeCode(system: string, prompt: string, schema: object, options: { model?: string; cwd: string; readFiles: boolean; signal?: AbortSignal }): Promise<CliResult> {
  const args = ["-p", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config", "--permission-mode", "dontAsk",
    "--system-prompt", system, "--json-schema", JSON.stringify(schema), "--tools", options.readFiles ? "Read,Grep,Glob" : "", ...(options.model ? ["--model", options.model] : [])];
  const { code, stdout, stderr } = await run(process.env.OPENMERIT_CLAUDE_BIN ?? "claude", args, prompt, options.cwd, options.signal);
  let body: { is_error?: boolean; result?: string; structured_output?: unknown; total_cost_usd?: number; usage?: { input_tokens?: number; output_tokens?: number } };
  try { body = JSON.parse(stdout) as typeof body; } catch { throw new Error(`Claude Code exited ${code}: ${tail(stderr || stdout) || "no output"}`); }
  if (body.is_error || code !== 0) throw new Error(`Claude Code: ${tail(body.result ?? stderr) || `exit ${code}`}`);
  const text = body.structured_output !== undefined ? JSON.stringify(body.structured_output) : body.result ?? "";
  return { text, costUsd: typeof body.total_cost_usd === "number" ? body.total_cost_usd : null, input: body.usage?.input_tokens ?? 0, output: body.usage?.output_tokens ?? 0 };
}

/** Codex exec: ephemeral, read-only sandbox, no MCP servers, schema-constrained final message. */
async function codex(system: string, prompt: string, schema: object, options: { model?: string; cwd: string; signal?: AbortSignal }): Promise<CliResult> {
  const dir = mkdtempSync(join(tmpdir(), "openmerit-codex-"));
  try {
    const schemaPath = join(dir, "schema.json");
    writeFileSync(schemaPath, JSON.stringify(schema));
    const args = ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "-c", "mcp_servers={}", "-C", options.cwd,
      "--output-schema", schemaPath, ...(options.model ? ["-m", options.model] : []), "-"];
    const { code, stdout, stderr } = await run(process.env.OPENMERIT_CODEX_BIN ?? "codex", args, `${system}\n\n${prompt}`, options.cwd, options.signal);
    let text = "", input = 0, output = 0, error = "";
    for (const line of stdout.split("\n")) {
      if (!line.trim().startsWith("{")) continue;
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string }; usage?: { input_tokens?: number; output_tokens?: number }; message?: string; error?: { message?: string } };
      if (event.type === "item.completed" && event.item?.type === "agent_message") text = event.item.text ?? "";
      if (event.type === "turn.completed") { input += event.usage?.input_tokens ?? 0; output += event.usage?.output_tokens ?? 0; }
      if (event.type === "error" || event.type === "turn.failed") error = event.message ?? event.error?.message ?? "turn failed";
    }
    if (error || code !== 0 || !text) throw new Error(`Codex: ${error || tail(stderr) || `exit ${code}`}`);
    return { text, costUsd: null, input, output };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/** Registers `claude-code` or `codex` as a Pi provider whose one model runs the CLI. */
function registerAgentProvider(runtime: ModelRuntime, kind: "claude-code" | "codex", settings: HarnessSettings, request: { current: JsonRequest | null }) {
  const api = `openmerit-${kind}` as Api;
  runtime.registerProvider(kind, {
    name: kind === "claude-code" ? "Claude Code" : "Codex", baseUrl: "local-cli", apiKey: "local-cli", api,
    models: [{ id: settings.model ?? "default", name: `${kind} ${settings.model ?? "default model"}`, api, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 32_000 }],
    streamSimple: (model: Model<Api>, context: TranscriptContext, options) => {
      const stream = createAssistantMessageEventStream();
      const message = (patch: Partial<AssistantMessage>): AssistantMessage => ({ role: "assistant", content: [], api, provider: kind, model: model.id, usage: emptyUsage(), stopReason: "stop", timestamp: Date.now(), ...patch });
      const current = request.current;
      const system = getCurrentSystemPrompt(context.messages);
      const prompt = promptText(context);
      const cwd = current?.cwd ?? process.cwd();
      const base = { cwd, ...(settings.model ? { model: settings.model } : {}), ...(options?.signal ? { signal: options.signal } : {}) };
      const call = kind === "claude-code" ? claudeCode(system, prompt, current?.schema ?? { type: "object" }, { ...base, readFiles: !!current?.cwd }) : codex(system, prompt, current?.schema ?? { type: "object" }, base);
      call.then(result => {
        const usage = emptyUsage();
        usage.input = result.input; usage.output = result.output; usage.totalTokens = result.input + result.output; usage.cost.total = result.costUsd ?? Number.NaN;
        const done = message({ content: [{ type: "text", text: result.text }], usage });
        stream.push({ type: "done", reason: "stop", message: done });
        stream.end(done);
      }, (error: unknown) => {
        const failed = message({ stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error) });
        stream.push({ type: "error", reason: "error", error: failed });
        stream.end(failed);
      });
      return stream;
    },
  });
  return runtime.getModel(kind, settings.model ?? "default")!;
}

/** The first JSON object in a reply, with code fences removed. */
export function parseJsonObject(reply: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(reply)?.[1] ?? reply;
  const start = fenced.indexOf("{");
  for (let end = fenced.length; start >= 0 && end > start; end--) {
    try { const value: unknown = JSON.parse(fenced.slice(start, end)); if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>; } catch { /* shorten */ }
  }
  throw new Error(`The harness did not reply with a JSON object: ${reply.slice(0, 200)}`);
}

const DESTINATIONS: Record<HarnessSettings["kind"], string> = {
  "claude-code": "Claude Code on this machine, which sends prompts and the files it reads to Anthropic (or the API your Claude Code is configured for)",
  codex: "Codex on this machine, which sends prompts and the files it reads to OpenAI (or the provider your Codex is configured for)",
  api: "the configured API provider",
};

/** Builds the harness from saved settings. Fails clearly, without falling back, when it cannot. */
export async function createHarness(settings: HarnessSettings, env: Record<string, string | undefined> = process.env): Promise<Harness> {
  env.PI_CODING_AGENT_DIR ??= join(openmeritHome(env), "agent");
  env.PI_SKIP_VERSION_CHECK ??= "1";
  const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
  const request: { current: JsonRequest | null } = { current: null };
  let model: Model<Api>;
  let apiKey: string | undefined;
  if (settings.kind === "api") {
    if (!settings.api) throw new Error("The API harness has no provider and model. Run `openmerit setup`.");
    const found = runtime.getModel(settings.api.provider, settings.api.model);
    if (!found) throw new Error(`Pi does not know ${settings.api.provider}/${settings.api.model}. Run \`openmerit setup\` to pick another model.`);
    model = found;
    apiKey = resolveCredential(settings.api.apiKey, env) ?? undefined;
    if (!apiKey) throw new Error(`The harness API key (${JSON.stringify(settings.api.apiKey)}) is not set. Run \`openmerit setup\`.`);
  } else model = registerAgentProvider(runtime, settings.kind, settings, request);

  const usage: HarnessUsage = { calls: 0, costUsd: 0, unknownCost: 0, inputTokens: 0, outputTokens: 0 };
  const destination = settings.kind === "api" ? `${DESTINATIONS.api} (${settings.api!.provider}, model ${settings.api!.model})` : DESTINATIONS[settings.kind];
  return {
    kind: settings.kind, destination, usage,
    async json<T>(input: JsonRequest): Promise<T> {
      request.current = input;
      const system = `${input.system}\n\nReply with one JSON object that matches this JSON Schema, and nothing else:\n${JSON.stringify(input.schema)}`;
      try {
        const reply = await runtime.complete(model, { systemPrompt: system, messages: [{ role: "user", content: input.prompt, timestamp: Date.now() }] },
          { ...(input.signal ? { signal: input.signal } : {}), ...(apiKey ? { apiKey } : {}), maxTokens: 16_000 });
        usage.calls++;
        usage.inputTokens += reply.usage.input; usage.outputTokens += reply.usage.output;
        if (Number.isFinite(reply.usage.cost.total)) usage.costUsd += reply.usage.cost.total; else usage.unknownCost++;
        if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? reply.stopReason);
        const text = reply.content.filter(part => part.type === "text").map(part => part.text).join("");
        return parseJsonObject(text) as T;
      } finally { request.current = null; }
    },
  };
}

/** One round trip that proves the configured connection powers the harness. */
export async function verifyHarness(harness: Harness, cwd: string): Promise<{ ok: true; detail: string } | { ok: false; detail: string }> {
  try {
    const reply = await harness.json<{ status?: string; harness?: string }>({
      system: "You are OpenMerit Harness checking its connection.", cwd,
      prompt: "Reply with status \"OPENMERIT_READY\" and, in harness, the name of the model you are.",
      schema: { type: "object", properties: { status: { type: "string" }, harness: { type: "string" } }, required: ["status", "harness"], additionalProperties: false },
    });
    if (reply.status !== "OPENMERIT_READY") return { ok: false, detail: `Unexpected reply ${JSON.stringify(reply).slice(0, 200)}` };
    return { ok: true, detail: `answered as ${String(reply.harness).slice(0, 80)}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Which coding agents are installed, and whether they report a login. Uses only their own status commands. */
export async function detectAgents(): Promise<{ kind: "claude-code" | "codex"; installed: boolean; loggedIn: boolean | null; detail: string }[]> {
  const probe = async (command: string, args: string[]) => {
    try { return await run(command, args, "", process.cwd(), AbortSignal.timeout(20_000)); } catch (error) { return { code: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }; }
  };
  const claude = await probe(process.env.OPENMERIT_CLAUDE_BIN ?? "claude", ["auth", "status"]);
  const codexStatus = await probe(process.env.OPENMERIT_CODEX_BIN ?? "codex", ["login", "status"]);
  let claudeLogin: boolean | null = null;
  try { claudeLogin = (JSON.parse(claude.stdout) as { loggedIn?: boolean }).loggedIn ?? null; } catch { /* older versions print text */ }
  // Claude Code also runs with ANTHROPIC_API_KEY or a third-party provider; its status only covers logins.
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX) claudeLogin = true;
  return [
    { kind: "claude-code", installed: claude.code !== -1, loggedIn: claude.code === -1 ? null : claudeLogin, detail: claude.code === -1 ? "not installed" : claudeLogin ? "logged in" : "installed, not logged in" },
    { kind: "codex", installed: codexStatus.code !== -1, loggedIn: codexStatus.code === -1 ? null : codexStatus.code === 0, detail: codexStatus.code === -1 ? "not installed" : codexStatus.code === 0 ? "logged in" : "installed, not logged in" },
  ];
}
