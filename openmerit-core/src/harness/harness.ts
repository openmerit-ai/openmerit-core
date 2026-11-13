// OpenMerit Harness: Scout's reasoning steps run on Pi's model runtime. Pi is powered by one of:
// - Claude Code through pi-claude-bridge, with the machine's Claude Code login;
// - Codex models through pi's ChatGPT sign-in (`openai-codex`, the login pi's own `/login` uses),
//   whose tokens pi keeps in ~/.openmerit/agent/auth.json;
// - a Pi API provider (anthropic, openai, openrouter, ...) with a configured key.
// Every connection reads the repository only through pi's read-only tools (read, grep, find, ls),
// which refuse paths outside it. The harness never reads coding-agent credential files, and never
// switches provider silently.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { validateToolCall, type Api, type AssistantMessage, type Message, type Model, type ToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { createReadOnlyTools, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolveCredential, type HarnessSettings } from "../state/config.ts";
import { openmeritHome } from "../state/paths.ts";
import { CLAUDE_BRIDGE_PROVIDER, claudeBinary, DEFAULT_CLAUDE_MODEL, inBridgeSession, loadClaudeBridge, type ClaudeBridge } from "./claude-bridge.ts";

type Tool = ReturnType<typeof createReadOnlyTools>[number];
type Env = Record<string, string | undefined>;

/** Pi's provider for ChatGPT Plus/Pro sign-ins, which serves Codex models. */
export const CODEX_PROVIDER = "openai-codex";
export const DEFAULT_CODEX_MODEL = "gpt-6.1-sol";

export interface HarnessUsage { calls: number; costUsd: number; unknownCost: number; inputTokens: number; outputTokens: number }

export interface JsonRequest {
  system: string;
  prompt: string;
  /** JSON Schema of the reply; the reply is parsed and must be an object. */
  schema: Record<string, unknown>;
  /** Let the harness read (never write) files under `cwd` with pi's read-only tools. */
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

/** Pi's model runtime on OpenMerit's agent directory, ~/.openmerit/agent: auth.json (the ChatGPT sign-in), models.json and the bridge's config. */
export function harnessRuntime(env: Env = process.env): Promise<ModelRuntime> {
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(openmeritHome(env), "agent");
  // The bridge and pi's tools read these from the process environment.
  process.env.PI_CODING_AGENT_DIR ??= agentDir;
  process.env.PI_SKIP_VERSION_CHECK ??= "1";
  return ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
}

/** True when `path` (a tool argument, relative to `root` or absolute) is inside `root` after resolving symlinks. */
function insideRoot(root: string, path: unknown): boolean {
  if (path !== undefined && typeof path !== "string") return false;
  const raw = (path ?? ".").replace(/^@/, "");
  if (raw.startsWith("~")) return false;
  const real = (target: string) => (existsSync(target) ? realpathSync(target) : target);
  const base = real(root), target = real(resolve(root, raw || "."));
  return target === base || target.startsWith(base + sep);
}

/** Pi's read-only tools in `root`, refusing paths outside it. */
function repositoryTools(root: string): Tool[] {
  return createReadOnlyTools(root).map(tool => ({
    ...tool,
    execute: (id, params, signal, onUpdate) => {
      if (!insideRoot(root, (params as { path?: unknown }).path)) return Promise.reject(new Error(`OpenMerit Harness reads only files inside ${root}.`));
      return tool.execute(id, params, signal, onUpdate);
    },
  }));
}

async function runTool(tools: Tool[], call: ToolCall, signal?: AbortSignal): Promise<ToolResultMessage> {
  const result = (content: ToolResultMessage["content"], isError: boolean): ToolResultMessage => ({ role: "toolResult", toolCallId: call.id, toolName: call.name, content, isError, timestamp: Date.now() });
  try {
    const tool = tools.find(item => item.name === call.name);
    if (!tool) throw new Error(`Unknown tool ${call.name}`);
    const output = await tool.execute(call.id, validateToolCall(tools, call) as never, signal);
    return result(output.content, false);
  } catch (error) { return result([{ type: "text", text: error instanceof Error ? error.message : String(error) }], true); }
}

/** Tool rounds one harness request may take before it is stopped. */
const MAX_TOOL_ROUNDS = 40;

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
  "claude-code": "Claude Code on this machine, which sends prompts and the files OpenMerit Harness reads to Anthropic (or the API your Claude Code is configured for)",
  codex: "OpenAI, through your ChatGPT sign-in (Codex models), which receives prompts and the files OpenMerit Harness reads",
  api: "the configured API provider",
};

/** Builds the harness from saved settings. Fails clearly, without falling back, when it cannot. */
export async function createHarness(settings: HarnessSettings, env: Env = process.env): Promise<Harness> {
  const runtime = await harnessRuntime(env);
  let model: Model<Api> | undefined;
  let apiKey: string | undefined;
  let bridge: ClaudeBridge | undefined;
  if (settings.kind === "api") {
    if (!settings.api) throw new Error("The API harness has no provider and model. Run `openmerit connect api`.");
    model = runtime.getModel(settings.api.provider, settings.api.model);
    if (!model) throw new Error(`Pi does not know ${settings.api.provider}/${settings.api.model}. Run \`openmerit connect api\` to pick another model.`);
    apiKey = resolveCredential(settings.api.apiKey, env) ?? undefined;
    if (!apiKey) throw new Error(`The harness API key (${JSON.stringify(settings.api.apiKey)}) is not set. Run \`openmerit connect api\`.`);
  } else if (settings.kind === "claude-code") {
    bridge = await loadClaudeBridge();
    runtime.registerProvider(CLAUDE_BRIDGE_PROVIDER, bridge.provider);
    model = runtime.getModel(CLAUDE_BRIDGE_PROVIDER, settings.model ?? DEFAULT_CLAUDE_MODEL);
    if (!model) throw new Error(`Claude Code has no model ${settings.model}. Run \`openmerit connect claude-code --model <id>\` with one of: ${runtime.getModels(CLAUDE_BRIDGE_PROVIDER).map(item => item.id).join(", ")}.`);
  } else {
    model = runtime.getModel(CODEX_PROVIDER, settings.model ?? DEFAULT_CODEX_MODEL);
    if (!model) throw new Error(`Codex has no model ${settings.model}. Run \`openmerit connect codex --model <id>\` with one of: ${runtime.getModels(CODEX_PROVIDER).map(item => item.id).join(", ")}.`);
    if (!runtime.hasConfiguredAuth(CODEX_PROVIDER)) throw new Error("OpenMerit is not signed in to ChatGPT. Run `openmerit connect codex`.");
  }
  const chosen = model;

  const usage: HarnessUsage = { calls: 0, costUsd: 0, unknownCost: 0, inputTokens: 0, outputTokens: 0 };
  const destination = settings.kind === "api" ? `${DESTINATIONS.api} (${settings.api!.provider}, model ${settings.api!.model})` : DESTINATIONS[settings.kind];
  const complete = async (system: string, messages: Message[], tools: Tool[], input: JsonRequest, sessionId: string) => {
    const reply = await runtime.complete(chosen, { systemPrompt: system, messages, ...(tools.length ? { tools } : {}) },
      { ...(input.signal ? { signal: input.signal } : {}), ...(apiKey ? { apiKey } : {}), sessionId, maxTokens: 16_000 });
    usage.calls++;
    usage.inputTokens += reply.usage.input; usage.outputTokens += reply.usage.output;
    if (Number.isFinite(reply.usage.cost.total)) usage.costUsd += reply.usage.cost.total; else usage.unknownCost++;
    if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? reply.stopReason);
    return reply;
  };
  const replyText = (reply: AssistantMessage) => reply.content.filter(part => part.type === "text").map(part => part.text).join("");
  return {
    kind: settings.kind, destination, usage,
    async json<T>(input: JsonRequest): Promise<T> {
      const system = `${input.system}\n\nReply with one JSON object that matches this JSON Schema, and nothing else:\n${JSON.stringify(input.schema)}`;
      const messages: Message[] = [{ role: "user", content: input.prompt, timestamp: Date.now() }];
      const tools = input.cwd ? repositoryTools(input.cwd) : [];
      const sessionId = `openmerit-${randomUUID()}`;
      const ask = async (): Promise<T> => {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const reply = await complete(system, messages, tools, input, sessionId);
          const calls = reply.content.filter((part): part is ToolCall => part.type === "toolCall");
          if (reply.stopReason !== "toolUse" || !calls.length) return parseJsonObject(replyText(reply)) as T;
          messages.push(reply);
          for (const call of calls) messages.push(await runTool(tools, call, input.signal));
        }
        throw new Error(`OpenMerit Harness stopped after ${MAX_TOOL_ROUNDS} rounds of file reads without an answer.`);
      };
      try {
        // Claude Code: one bridge session per request, so its query starts in the repository and closes afterwards.
        return bridge ? await inBridgeSession(bridge, { sessionId, cwd: input.cwd ?? tmpdir(), systemPrompt: system, tools: tools.map(tool => tool.name) }, ask) : await ask();
      } finally {
        // A refreshed ChatGPT token replaces the old one; save it before the process can exit.
        await runtime.settleCredentialWrites();
      }
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

/** Runs the Claude Code executable the bridge uses, such as `auth status` or `auth login`. */
export function runClaude(args: string[], options: { env?: Env; interactive?: boolean; signal?: AbortSignal } = {}): Promise<{ code: number; stdout: string }> {
  return new Promise((done, reject) => {
    const child = spawn(claudeBinary(options.env), args, { env: options.env ?? process.env, stdio: options.interactive ? "inherit" : ["ignore", "pipe", "ignore"], ...(options.signal ? { signal: options.signal } : {}) });
    let stdout = "";
    child.stdout?.on("data", chunk => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", code => done({ code: code ?? 1, stdout }));
  });
}

/** Whether Claude Code reports a login (its own status command), and whether OpenMerit has a ChatGPT sign-in. */
export async function detectAgents(env: Env = process.env): Promise<{ kind: "claude-code" | "codex"; loggedIn: boolean; detail: string }[]> {
  let claudeLogin = false;
  try { claudeLogin = (JSON.parse((await runClaude(["auth", "status"], { env, signal: AbortSignal.timeout(20_000) })).stdout) as { loggedIn?: boolean }).loggedIn === true; } catch { /* no status */ }
  // Claude Code also runs with ANTHROPIC_API_KEY or a third-party provider; its status only covers logins.
  if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN || env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX) claudeLogin = true;
  const codexLogin = (await harnessRuntime(env)).hasConfiguredAuth(CODEX_PROVIDER);
  return [
    { kind: "claude-code", loggedIn: claudeLogin, detail: claudeLogin ? "logged in" : "not logged in" },
    { kind: "codex", loggedIn: codexLogin, detail: codexLogin ? "signed in to ChatGPT" : "not signed in to ChatGPT" },
  ];
}
