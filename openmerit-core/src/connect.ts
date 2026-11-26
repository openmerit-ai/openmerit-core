// `openmerit connect [claude-code|codex|api]`: how OpenMerit Harness is powered. Signs in where needed,
// proves the connection with one round trip, and saves it to ~/.openmerit/config.json. `openmerit
// setup` runs the same steps. Nothing switches connection on its own; a failed check keeps the
// previous settings.
// - claude-code: the user's own Claude Code and its login (`claude auth login`), run through pi-claude-bridge,
//   which connect installs into ~/.openmerit/claude-bridge.
// - codex: pi's ChatGPT Plus/Pro sign-in (browser, or a device code on a server). Pi keeps the
//   tokens in ~/.openmerit/agent/auth.json (0600) and refreshes them. Without --model, connect keeps
//   the most capable Codex model (by catalogue ECI) that the account's plan accepts.
// - api: a Pi provider, model and key.
import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type { Prompter } from "./cli/prompt.ts";
import { loadCatalogue } from "./catalogue/catalogue.ts";
import { isAbsolute } from "node:path";
import { bridgeDir, bridgeInstalled, claudeBinary, DEFAULT_CLAUDE_MODEL, installClaudeBridge } from "./harness/claude-bridge.ts";
import { CODEX_PROVIDER, createHarness, detectAgents, harnessRuntime, runClaude, verifyHarness } from "./harness/harness.ts";
import { readGlobalConfig, storeSecret, updateGlobalConfig, type CredentialRef, type HarnessKind, type HarnessSettings } from "./state/config.ts";

export interface ConnectFlags {
  /** Model for claude-code (default DEFAULT_CLAUDE_MODEL) or codex (default: the best the ChatGPT plan allows). */
  model?: string;
  apiProvider?: string;
  apiModel?: string;
  apiKeyEnv?: string;
  /** Sign in to ChatGPT with a device code instead of the browser (the default without a terminal). */
  deviceCode?: boolean;
  /** Accept defaults and never prompt. */
  nonInteractive?: boolean;
}

export interface PromptContext { prompter: Prompter | null; log: (line: string) => void; env: Record<string, string | undefined>; flags: { nonInteractive?: boolean } }
export interface ConnectContext extends PromptContext { root: string; flags: ConnectFlags }

export const HARNESS_LABEL: Record<HarnessKind, string> = { "claude-code": "Claude Code", codex: "Codex (ChatGPT sign-in)", api: "an API key" };

const interactive = (ctx: PromptContext) => !!ctx.prompter && !ctx.flags.nonInteractive;

export async function confirm(ctx: PromptContext, question: string, fallback: boolean) { return interactive(ctx) ? ctx.prompter!.confirm(question, fallback) : fallback; }

/** A key from an environment variable (kept as a reference) or typed in (stored in ~/.openmerit/secrets.json). */
export async function credential(ctx: PromptContext, label: string, envNames: string[], secretName: string, flagEnv?: string): Promise<CredentialRef | null> {
  if (flagEnv) return ctx.env[flagEnv] ? { env: flagEnv } : (() => { throw new Error(`$${flagEnv} is not set.`); })();
  const present = envNames.find(name => ctx.env[name]?.trim());
  if (present && await confirm(ctx, `Use $${present} for the ${label}?`, true)) return { env: present };
  if (!interactive(ctx)) return null;
  const value = await ctx.prompter!.secret(`${label} (input hidden; stored in ~/.openmerit/secrets.json, outside the repository):`);
  return value ? storeSecret(secretName, value, ctx.env) : null;
}

/** Pi's login prompts and notices in the terminal, or on stderr only without one (device code). */
function authInteraction(ctx: ConnectContext): AuthInteraction {
  return {
    async prompt(prompt: AuthPrompt) {
      if (prompt.type === "select") {
        const ids = prompt.options.map(option => option.id);
        const device = ids.find(id => id === "device_code");
        if (device && (ctx.flags.deviceCode || !interactive(ctx))) return device;
        if (!interactive(ctx)) return ids[0]!;
        return ctx.prompter!.choose(prompt.message, prompt.options.map(option => ({ value: option.id, label: option.label })), ids[0]);
      }
      if (!interactive(ctx)) throw new Error(`${prompt.message} needs a terminal. Rerun with --device-code.`);
      return prompt.type === "secret" ? ctx.prompter!.secret(prompt.message) : ctx.prompter!.ask(prompt.message, "", prompt.signal);
    },
    notify(event) {
      if (event.type === "auth_url") ctx.log(`  Open this URL to sign in to ChatGPT:\n  ${event.url}${event.instructions ? `\n  ${event.instructions}` : ""}`);
      else if (event.type === "device_code") ctx.log(`  On any device, open ${event.verificationUri} and enter the code ${event.userCode}${event.expiresInSeconds ? ` within ${Math.round(event.expiresInSeconds / 60)} minutes` : ""}.`);
      else ctx.log(`  ${event.message}`);
    },
  };
}

/** OpenAI's reply when a ChatGPT plan does not include a Codex model. */
const NOT_ON_PLAN = /not supported when using Codex with a ChatGPT account/i;

/** Pi's Codex models, most capable (by the bundled catalogue's ECI) first. */
async function codexModelsByEci(env: Record<string, string | undefined>): Promise<string[]> {
  const eci = new Map(loadCatalogue().models.map(model => [model.id, model.eci ?? 0]));
  const score = (id: string) => eci.get(`openai/${id}`) ?? 0;
  return (await harnessRuntime(env)).getModels(CODEX_PROVIDER).map(model => model.id).sort((a, b) => score(b) - score(a));
}

/** Makes sure the chosen connection is signed in. Returns false when the user declined. */
async function signIn(ctx: ConnectContext, kind: HarnessKind): Promise<boolean> {
  if (kind === "api") return true;
  if (kind === "claude-code") {
    if (!isAbsolute(claudeBinary(ctx.env))) throw new Error("Claude Code is not installed: OpenMerit Harness runs your own `claude`. Install it (https://claude.com/claude-code), then run `openmerit connect claude-code` again; or set OPENMERIT_CLAUDE_BIN to its path.");
    if (!bridgeInstalled(ctx.env)) {
      ctx.log(`  Installing the Claude Code bridge into ${bridgeDir(ctx.env)}; it runs your own Claude Code…`);
      installClaudeBridge(ctx.env);
    }
  }
  const agent = (await detectAgents(ctx.env)).find(item => item.kind === kind)!;
  if (agent.loggedIn) return true;
  if (kind === "claude-code") {
    if (!interactive(ctx)) throw new Error("Claude Code is not logged in. Run `openmerit connect claude-code` in a terminal to log in, or on a server set CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`.");
    if (!(await confirm(ctx, "Claude Code is not logged in. Log in with your Claude subscription now?", true))) return false;
    await ctx.prompter!.handOver(() => runClaude(["auth", "login"], { env: ctx.env, interactive: true }));
    return true;
  }
  ctx.log("  Signing in to ChatGPT (Plus or Pro) for Codex models. OpenMerit keeps the sign-in in ~/.openmerit/agent/auth.json.");
  const runtime = await harnessRuntime(ctx.env);
  await runtime.login(CODEX_PROVIDER, "oauth", authInteraction(ctx));
  await runtime.settleCredentialWrites();
  ctx.log("  ✓ Signed in to ChatGPT.");
  return true;
}

/**
 * Connects OpenMerit Harness. With `kind`, connects that; without it, keeps a working saved
 * connection when the user agrees, and otherwise asks which to use.
 */
export async function connect(ctx: ConnectContext, kind?: HarnessKind): Promise<HarnessSettings | null> {
  const existing = readGlobalConfig(ctx.env).harness;
  if (existing && !kind) {
    ctx.log(`Checking the current harness connection (${HARNESS_LABEL[existing.kind]}${existing.model ? `, ${existing.model}` : ""})…`);
    const check = await createHarness(existing, ctx.env).then(harness => verifyHarness(harness, ctx.root), (error: unknown) => ({ ok: false as const, detail: error instanceof Error ? error.message : String(error) }));
    if (check.ok) {
      ctx.log(`  ✓ OpenMerit Harness runs on ${HARNESS_LABEL[existing.kind]} (${check.detail}).`);
      if (await confirm(ctx, "Keep this harness connection?", true)) {
        const saved = { ...existing, verifiedAt: new Date().toISOString() };
        updateGlobalConfig({ harness: saved }, ctx.env);
        return saved;
      }
    } else ctx.log(`  ✗ The saved harness connection failed: ${check.detail}`);
  }
  for (;;) {
    if (!kind) {
      if (!interactive(ctx)) throw new Error("Choose how to power OpenMerit Harness: `openmerit connect claude-code`, `codex` or `api`.");
      const agents = await detectAgents(ctx.env);
      kind = await ctx.prompter!.choose<HarnessKind>("Which should power OpenMerit Harness?", [
        ...agents.map(agent => ({ value: agent.kind, label: `${HARNESS_LABEL[agent.kind]} (${agent.detail})` })),
        { value: "api", label: "An API provider, key and model" },
      ], agents.find(agent => agent.loggedIn)?.kind ?? "claude-code");
    }
    const settings: HarnessSettings = { kind };
    if (kind === "api") {
      const provider = ctx.flags.apiProvider ?? (interactive(ctx) ? await ctx.prompter!.ask("Pi provider for the harness (anthropic, openai, openrouter, google, ...)", existing?.api?.provider ?? "anthropic") : "anthropic");
      const suggested = (existing?.api?.provider === provider ? existing.api.model : undefined) ?? (provider === "openai" ? "gpt-6.1-sol" : provider === "openrouter" ? "anthropic/claude-sonnet-5.5" : "claude-sonnet-5-5");
      const model = ctx.flags.apiModel ?? (interactive(ctx) ? await ctx.prompter!.ask("Model", suggested) : suggested);
      const envNames = { anthropic: ["ANTHROPIC_API_KEY"], openai: ["OPENAI_API_KEY"], openrouter: ["OPENROUTER_API_KEY"], google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] }[provider] ?? [];
      const apiKey = await credential(ctx, `${provider} API key for the harness`, envNames, `harness-${provider}`, ctx.flags.apiKeyEnv);
      if (!apiKey) throw new Error("The API harness needs a key: pass --api-key-env <VAR>.");
      settings.api = { provider, model, apiKey };
    } else {
      const chosen = ctx.flags.model ?? (existing?.kind === kind ? existing.model : undefined);
      if (chosen || kind === "claude-code") settings.model = chosen ?? DEFAULT_CLAUDE_MODEL;
      ctx.log(settings.model ? `  Model: ${settings.model} (change it with --model).` : "  Model: the most capable Codex model your ChatGPT plan allows (choose one with --model).");
    }
    let check: { ok: boolean; detail: string } = { ok: false, detail: "no model to try" };
    try {
      if (!(await signIn(ctx, kind))) return null;
      // Which Codex models a ChatGPT account may use depends on its plan, and OpenAI does not list them: try them by ECI.
      const models = kind === "codex" && !settings.model ? await codexModelsByEci(ctx.env) : [settings.model];
      for (const model of models) {
        if (model) settings.model = model;
        ctx.log(`Verifying that ${HARNESS_LABEL[kind]}${model ? ` (${model})` : ""} powers OpenMerit Harness…`);
        check = await verifyHarness(await createHarness(settings, ctx.env), ctx.root);
        if (check.ok || !NOT_ON_PLAN.test(check.detail)) break;
        ctx.log(`  ${model} is not available on this ChatGPT plan.`);
      }
    } catch (error) { check = { ok: false, detail: error instanceof Error ? error.message : String(error) }; }
    if (check.ok) {
      ctx.log(`  ✓ ${HARNESS_LABEL[kind]} answered through OpenMerit Harness (${check.detail}).`);
      const saved = { ...settings, verifiedAt: new Date().toISOString() };
      updateGlobalConfig({ harness: saved }, ctx.env);
      return saved;
    }
    ctx.log(`  ✗ ${HARNESS_LABEL[kind]} did not answer: ${check.detail}`);
    if (!interactive(ctx)) throw new Error(`${HARNESS_LABEL[kind]} could not power the harness: ${check.detail}${existing ? ". Your previous harness settings are unchanged." : ""}`);
    const next = await ctx.prompter!.choose("What now?", [{ value: "retry", label: `Retry ${HARNESS_LABEL[kind]}` }, { value: "other", label: "Choose another connection" }, { value: "quit", label: existing ? "Stop and keep the previous settings" : "Stop" }], "retry");
    if (next === "quit") return null;
    if (next === "other") kind = undefined;
  }
}
