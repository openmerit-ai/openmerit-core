// Claude Code through pi-claude-bridge (https://pi.dev/packages/pi-claude-bridge): a pi extension that
// drives Claude Code with the Claude Agent SDK and the machine's Claude Code login. OpenMerit runs it
// outside a pi coding-agent session, so this module gives it the two extension calls it uses
// (registerProvider, on) and fires the session events the bridge relies on around each request:
// session_start names the request's working directory, before_agent_start records its system prompt
// (the bridge refuses a prompt it has not seen), and session_shutdown closes its Claude Code query.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

type ProviderConfigInput = Parameters<ModelRuntime["registerProvider"]>[1];
type Handler = (event: unknown, ctx: unknown) => unknown;
interface ExtensionShim { registerProvider(id: string, config: ProviderConfigInput): void; on(event: string, handler: Handler): void }
export interface ClaudeBridge { provider: ProviderConfigInput; handlers: Map<string, Handler[]> }

export const CLAUDE_BRIDGE_PROVIDER = "claude-bridge";
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";

let loaded: Promise<ClaudeBridge> | undefined;

/** Loads the bridge once per process. Its config and log live in pi's agent directory (PI_CODING_AGENT_DIR). */
export function loadClaudeBridge(): Promise<ClaudeBridge> {
  return loaded ??= (async () => {
    const handlers = new Map<string, Handler[]>();
    let provider: ProviderConfigInput | undefined;
    const shim: ExtensionShim = {
      registerProvider: (id, config) => { if (id === CLAUDE_BRIDGE_PROVIDER) provider = config; },
      on: (event, handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    };
    // The bridge ships TypeScript, which Node does not strip under node_modules; pi loads extensions with jiti too.
    const module = await createJiti(import.meta.url).import<{ default: (pi: ExtensionShim) => void }>("pi-claude-bridge/src/index.ts");
    module.default(shim);
    if (!provider) throw new Error("pi-claude-bridge did not register its provider");
    return { provider, handlers };
  })().catch(error => { loaded = undefined; throw error; });
}

/** Runs `request` as one bridge session in `cwd`, so Claude Code starts there and accepts `systemPrompt`. */
export async function inBridgeSession<T>(bridge: ClaudeBridge, input: { sessionId: string; cwd: string; systemPrompt: string; tools: string[] }, request: () => Promise<T>): Promise<T> {
  const ctx = { cwd: input.cwd, ui: undefined, sessionManager: { getSessionId: () => input.sessionId }, modelRegistry: { getProvider: () => bridge.provider }, getSystemPrompt: () => input.systemPrompt };
  const fire = async (name: string, event: unknown) => { for (const handler of bridge.handlers.get(name) ?? []) await handler(event, ctx); };
  await fire("session_start", { type: "session_start", reason: "startup" });
  try {
    await fire("before_agent_start", { type: "before_agent_start", systemPrompt: input.systemPrompt, systemPromptOptions: { customPrompt: input.systemPrompt, contextFiles: [], skills: [], selectedTools: input.tools } });
    return await request();
  } finally { await fire("session_shutdown", { type: "session_shutdown" }); }
}

/** The Claude Code executable for login checks: the one the Claude Agent SDK bundles, which the bridge runs. */
export function claudeBinary(env: Record<string, string | undefined> = process.env): string {
  if (env.OPENMERIT_CLAUDE_BIN) return env.OPENMERIT_CLAUDE_BIN;
  try {
    const fromBridge = createRequire(createRequire(import.meta.url).resolve("pi-claude-bridge/package.json"));
    const fromSdk = createRequire(fromBridge.resolve("@anthropic-ai/claude-agent-sdk/package.json"));
    for (const variant of ["", "-musl"]) {
      try {
        const path = join(dirname(fromSdk.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${variant}/package.json`)), process.platform === "win32" ? "claude.exe" : "claude");
        if (existsSync(path)) return path;
      } catch { /* not installed for this libc */ }
    }
  } catch { /* fall back to PATH */ }
  return "claude";
}
