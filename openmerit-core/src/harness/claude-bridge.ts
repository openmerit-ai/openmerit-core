// Claude Code through pi-claude-bridge (https://pi.dev/packages/pi-claude-bridge): a pi extension that
// drives Claude Code with the Claude Agent SDK and the machine's Claude Code login. OpenMerit runs it
// outside a pi coding-agent session, so this module gives it the two extension calls it uses
// (registerProvider, on) and fires the session events the bridge relies on around each request:
// session_start names the request's working directory, before_agent_start records its system prompt
// (the bridge refuses a prompt it has not seen), and session_shutdown closes its Claude Code query.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openmeritHome } from "../state/paths.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

type ProviderConfigInput = Parameters<ModelRuntime["registerProvider"]>[1];
type Handler = (event: unknown, ctx: unknown) => unknown;
interface ExtensionShim { registerProvider(id: string, config: ProviderConfigInput): void; on(event: string, handler: Handler): void }
export interface ClaudeBridge { provider: ProviderConfigInput; handlers: Map<string, Handler[]> }

export const CLAUDE_BRIDGE_PROVIDER = "claude-bridge";
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";

/** The bridge version `openmerit connect claude-code` installs. */
export const BRIDGE_VERSION = "0.12.0";
type Env = Record<string, string | undefined>;

/**
 * Where the bridge is installed: ~/.openmerit/claude-bridge. It is not a dependency of the package, since the
 * Claude Agent SDK it depends on bundles its own Claude Code (over 300 MB per platform): only people who power
 * OpenMerit Harness with Claude Code install it, without that copy, and it runs their own `claude`.
 */
export const bridgeDir = (env: Env = process.env) => join(openmeritHome(env), "claude-bridge");
const bridgeEntry = (env: Env) => join(bridgeDir(env), "node_modules", "pi-claude-bridge", "src", "index.ts");
export const bridgeInstalled = (env: Env = process.env) => existsSync(bridgeEntry(env));

/**
 * Installs the bridge with npm, without optional dependencies (the SDK's bundled Claude Code) or peer
 * dependencies, then links its peers, Pi's model and agent packages, to the copies OpenMerit loads, so the
 * provider it registers runs on OpenMerit's own Pi.
 */
export function installClaudeBridge(env: Env = process.env): void {
  const dir = bridgeDir(env);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, "package.json"))) writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "openmerit-claude-bridge", private: true }, null, 2)}\n`);
  const npm = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund", "--omit=optional", "--legacy-peer-deps", "--save-exact", `pi-claude-bridge@${BRIDGE_VERSION}`], { cwd: dir, env: { ...process.env, ...env }, encoding: "utf8" });
  if (npm.error || npm.status !== 0) throw new Error(`Could not install the Claude Code bridge into ${dir}: ${npm.error?.message ?? npm.stderr.trim().split("\n").slice(-3).join(" ")}`);
  for (const peer of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]) {
    // The peers export only an ES module entry and not their package.json: walk up from that entry to the package.
    let target = dirname(fileURLToPath(import.meta.resolve(peer)));
    while (!existsSync(join(target, "package.json")) || (JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as { name?: string }).name !== peer) target = dirname(target);
    const link = join(dir, "node_modules", peer);
    rmSync(link, { recursive: true, force: true });
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link, "junction");
  }
}

/** Points the bridge at the user's own Claude Code, in its config in pi's agent directory, keeping the config's other settings. */
function useOwnClaude(env: Env): void {
  const agentDir = env.PI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join(openmeritHome(env), "agent");
  const file = join(agentDir, "claude-bridge.json");
  let config: { provider?: Record<string, unknown> } = {};
  try { config = JSON.parse(readFileSync(file, "utf8")) as typeof config; } catch { /* none yet */ }
  const binary = claudeBinary(env);
  if (!isAbsolute(binary)) throw new Error("Claude Code is not installed: OpenMerit Harness runs your own `claude`. Install it (https://claude.com/claude-code), log in, then run `openmerit connect claude-code` again; or set OPENMERIT_CLAUDE_BIN to its path.");
  if (config.provider?.pathToClaudeCodeExecutable === binary) return;
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...config, provider: { ...config.provider, pathToClaudeCodeExecutable: binary } }, null, 2)}\n`);
}

let loaded: Promise<ClaudeBridge> | undefined;

/** Loads the bridge once per process. Its config and log live in pi's agent directory (PI_CODING_AGENT_DIR). */
export function loadClaudeBridge(env: Env = process.env): Promise<ClaudeBridge> {
  return loaded ??= (async () => {
    const handlers = new Map<string, Handler[]>();
    let provider: ProviderConfigInput | undefined;
    const shim: ExtensionShim = {
      registerProvider: (id, config) => { if (id === CLAUDE_BRIDGE_PROVIDER) provider = config; },
      on: (event, handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    };
    if (!bridgeInstalled(env)) throw new Error("The Claude Code bridge is not installed. Run `openmerit connect claude-code`.");
    useOwnClaude(env);
    // The bridge ships TypeScript, which Node does not strip under node_modules; pi loads extensions with jiti too.
    const module = await createJiti(import.meta.url).import<{ default: (pi: ExtensionShim) => void }>(bridgeEntry(env));
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

/** The user's own Claude Code: OPENMERIT_CLAUDE_BIN, else `claude` on the PATH as an absolute path, else the bare name. */
export function claudeBinary(env: Env = process.env): string {
  if (env.OPENMERIT_CLAUDE_BIN) return env.OPENMERIT_CLAUDE_BIN;
  const found = spawnSync(process.platform === "win32" ? "where" : "/bin/sh", process.platform === "win32" ? ["claude"] : ["-c", "command -v claude"], { env: { ...process.env, ...env }, encoding: "utf8" });
  const path = found.status === 0 ? found.stdout.trim().split(/\r?\n/)[0] : "";
  return path && isAbsolute(path) ? path : "claude";
}
