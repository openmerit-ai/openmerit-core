// `openmerit setup`: detect → explicit choice → verify → persist, rerunnable. Global: how OpenMerit
// Harness is powered, and the MCP registration with Claude Code/Codex. Per repository: read-only
// Langfuse, candidate endpoints with allowed models, and the default eval budget. Re-running keeps
// working settings unless the user replaces them, and a failed connection is offered for retry or
// reconfiguration; nothing switches provider on its own.
import { spawnSync } from "node:child_process";
import { createHarness, detectAgents, verifyHarness } from "./harness/harness.ts";
import { createLangfuseConnector } from "./connectors/langfuse/index.ts";
import type { Prompter } from "./cli/prompt.ts";
import {
  DEFAULT_BUDGET_USD, describeCredential, OPENAI_ENDPOINT, OPENROUTER_ENDPOINT, readGlobalConfig, readRepoConfig, resolveCredential, storeSecret, updateGlobalConfig, updateRepoConfig,
  type CredentialRef, type Endpoint, type HarnessKind, type HarnessSettings, type LangfuseSettings,
} from "./state/config.ts";
import type { State } from "./state/db.ts";
import type { Repo } from "./state/paths.ts";

export interface SetupFlags {
  harness?: HarnessKind;
  harnessModel?: string;
  apiProvider?: string;
  apiModel?: string;
  apiKeyEnv?: string;
  /** `openrouter:ENV_VAR`, `openai:ENV_VAR` or `<id>=<baseUrl>:ENV_VAR` (OpenAI-compatible). */
  endpoints?: string[];
  allowedModels?: string[];
  budget?: number;
  registerMcp?: boolean;
  langfuseUrl?: string;
  langfusePublicKeyEnv?: string;
  langfuseSecretKeyEnv?: string;
  /** Accept defaults and never prompt. */
  nonInteractive?: boolean;
}

interface SetupContext { repo: Repo; state: State; prompter: Prompter | null; log: (line: string) => void; env: Record<string, string | undefined>; fetch?: typeof fetch; flags: SetupFlags; mcpCommand: string[] }

const AGENT_LABEL: Record<HarnessKind, string> = { "claude-code": "Claude Code", codex: "Codex", api: "an API key" };

async function confirm(ctx: SetupContext, question: string, fallback: boolean) { return ctx.prompter && !ctx.flags.nonInteractive ? ctx.prompter.confirm(question, fallback) : fallback; }

/** A key from an environment variable (kept as a reference) or typed in (stored in ~/.openmerit/secrets.json). */
async function credential(ctx: SetupContext, label: string, envNames: string[], secretName: string, flagEnv?: string): Promise<CredentialRef | null> {
  if (flagEnv) return ctx.env[flagEnv] ? { env: flagEnv } : (() => { throw new Error(`$${flagEnv} is not set.`); })();
  const present = envNames.find(name => ctx.env[name]?.trim());
  if (present && await confirm(ctx, `Use $${present} for ${label}? (OpenMerit stores the variable name, not the key)`, true)) return { env: present };
  if (!ctx.prompter || ctx.flags.nonInteractive) return null;
  const value = await ctx.prompter.secret(`${label} (input hidden; stored in ~/.openmerit/secrets.json, outside the repository):`);
  return value ? storeSecret(secretName, value, ctx.env) : null;
}

export async function verifyEndpoint(endpoint: Endpoint, env: Record<string, string | undefined>, fetcher: typeof fetch = fetch): Promise<{ ok: boolean; detail: string }> {
  const key = resolveCredential(endpoint.apiKey, env);
  if (!key) return { ok: false, detail: `no key (${describeCredential(endpoint.apiKey)} is empty)` };
  const url = endpoint.kind === "openrouter" ? `${endpoint.baseUrl.replace(/\/$/, "")}/key` : `${endpoint.baseUrl.replace(/\/$/, "")}/models`;
  try {
    const response = await fetcher(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000), redirect: "manual" });
    await response.body?.cancel();
    return response.ok ? { ok: true, detail: "key accepted" } : { ok: false, detail: `HTTP ${response.status}${response.status === 401 ? " (key rejected or expired)" : ""}` };
  } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : String(error) }; }
}

async function setupHarness(ctx: SetupContext): Promise<HarnessSettings | null> {
  const existing = readGlobalConfig(ctx.env).harness;
  if (existing && !ctx.flags.harness) {
    ctx.log(`Checking the current harness connection (${AGENT_LABEL[existing.kind]}${existing.model ? `, ${existing.model}` : ""})…`);
    const check = await verifyHarness(await createHarness(existing, ctx.env), ctx.repo.root).catch((error: unknown) => ({ ok: false as const, detail: String(error) }));
    if (check.ok) {
      ctx.log(`  ✓ OpenMerit Harness runs on ${AGENT_LABEL[existing.kind]} (${check.detail}).`);
      if (!(await confirm(ctx, "Keep this harness connection?", true))) return chooseHarness(ctx, existing);
      updateGlobalConfig({ harness: { ...existing, verifiedAt: new Date().toISOString() } }, ctx.env);
      return existing;
    }
    ctx.log(`  ✗ The saved harness connection failed: ${check.detail}`);
    return chooseHarness(ctx, existing);
  }
  return chooseHarness(ctx, existing);
}

async function chooseHarness(ctx: SetupContext, previous: HarnessSettings | undefined): Promise<HarnessSettings | null> {
  const agents = await detectAgents();
  for (const agent of agents) ctx.log(`  ${agent.kind === "claude-code" ? "Claude Code" : "Codex"}: ${agent.detail}`);
  let kind: HarnessKind | undefined = ctx.flags.harness;
  for (;;) {
    if (!kind) {
      if (!ctx.prompter || ctx.flags.nonInteractive) throw new Error("Choose how to power OpenMerit Harness: --harness claude-code, codex or api.");
      kind = await ctx.prompter.choose<HarnessKind>("Which should power OpenMerit Harness?", [
        ...agents.filter(agent => agent.installed).map(agent => ({ value: agent.kind, label: `${agent.kind === "claude-code" ? "Claude Code" : "Codex"} (${agent.detail})` })),
        { value: "api", label: "An API endpoint, key and model" },
      ], agents.find(agent => agent.loggedIn)?.kind ?? "api");
    }
    const settings: HarnessSettings = { kind };
    if (kind === "api") {
      const provider = ctx.flags.apiProvider ?? (ctx.prompter && !ctx.flags.nonInteractive ? await ctx.prompter.ask("Pi provider for the harness (anthropic, openai, openrouter, google, ...)", previous?.api?.provider ?? "anthropic") : "anthropic");
      const model = ctx.flags.apiModel ?? (ctx.prompter && !ctx.flags.nonInteractive ? await ctx.prompter.ask("Model", previous?.api?.model ?? (provider === "openai" ? "gpt-6.1-sol" : provider === "openrouter" ? "anthropic/claude-sonnet-5.5" : "claude-sonnet-5-5")) : "claude-sonnet-5-5");
      const envNames = { anthropic: ["ANTHROPIC_API_KEY"], openai: ["OPENAI_API_KEY"], openrouter: ["OPENROUTER_API_KEY"], google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] }[provider] ?? [];
      const apiKey = await credential(ctx, `${provider} API key for the harness`, envNames, `harness-${provider}`, ctx.flags.apiKeyEnv);
      if (!apiKey) throw new Error("The API harness needs a key.");
      settings.api = { provider, model, apiKey };
    } else if (ctx.flags.harnessModel) settings.model = ctx.flags.harnessModel;
    ctx.log(`Verifying that ${AGENT_LABEL[kind]} powers OpenMerit Harness…`);
    const check = await createHarness(settings, ctx.env).then(harness => verifyHarness(harness, ctx.repo.root), (error: unknown) => ({ ok: false as const, detail: error instanceof Error ? error.message : String(error) }));
    if (check.ok) {
      ctx.log(`  ✓ ${AGENT_LABEL[kind]} answered through OpenMerit Harness (${check.detail}).`);
      const saved = { ...settings, verifiedAt: new Date().toISOString() };
      updateGlobalConfig({ harness: saved }, ctx.env);
      return saved;
    }
    ctx.log(`  ✗ ${AGENT_LABEL[kind]} did not answer: ${check.detail}`);
    if (kind !== "api") ctx.log(`    Log in with \`${kind === "claude-code" ? "claude auth login" : "codex login"}\`, then retry. OpenMerit does not read coding-agent credentials itself.`);
    if (!ctx.prompter || ctx.flags.nonInteractive) throw new Error(`${AGENT_LABEL[kind]} could not power the harness: ${check.detail}${previous ? ". Your previous harness settings are unchanged." : ""}`);
    const next = await ctx.prompter.choose("What now?", [{ value: "retry", label: `Retry ${AGENT_LABEL[kind]}` }, { value: "other", label: "Choose another connection" }, { value: "quit", label: previous ? "Stop and keep the previous settings" : "Stop setup" }], "retry");
    if (next === "quit") return null;
    if (next === "other") kind = undefined;
  }
}

/** Adds OpenMerit's stdio MCP server to Claude Code and Codex through their own `mcp add` commands; existing entries are left alone. */
function registerMcp(ctx: SetupContext, kinds: ("claude-code" | "codex")[]) {
  for (const kind of kinds) {
    const bin = kind === "claude-code" ? ctx.env.OPENMERIT_CLAUDE_BIN ?? "claude" : ctx.env.OPENMERIT_CODEX_BIN ?? "codex";
    const get = spawnSync(bin, ["mcp", "get", "openmerit"], { encoding: "utf8", env: ctx.env });
    if (get.error) continue;
    if (get.status === 0) { ctx.log(`  ${kind === "claude-code" ? "Claude Code" : "Codex"} already has an "openmerit" MCP server; left unchanged.`); continue; }
    const args = kind === "claude-code" ? ["mcp", "add", "--scope", "user", "openmerit", "--", ...ctx.mcpCommand] : ["mcp", "add", "openmerit", "--", ...ctx.mcpCommand];
    const add = spawnSync(bin, args, { encoding: "utf8", env: ctx.env });
    ctx.log(add.status === 0 ? `  ✓ Registered OpenMerit's MCP server with ${kind === "claude-code" ? "Claude Code" : "Codex"}.` : `  ✗ Could not register with ${kind}: ${(add.stderr || add.stdout).trim().slice(0, 200)}`);
  }
}

async function setupLangfuse(ctx: SetupContext): Promise<LangfuseSettings | undefined> {
  const existing = readRepoConfig(ctx.repo.root).langfuse;
  const connector = (settings: Pick<LangfuseSettings, "baseUrl" | "publicKey" | "secretKey">) => {
    const publicKey = resolveCredential(settings.publicKey, ctx.env), secretKey = resolveCredential(settings.secretKey, ctx.env);
    if (!publicKey || !secretKey) throw new Error("the Viewer key pair is not available");
    return createLangfuseConnector({ baseUrl: settings.baseUrl, publicKey, secretKey }, { ...(ctx.fetch ? { fetch: ctx.fetch } : {}), retries: 1 });
  };
  const verify = async (settings: Pick<LangfuseSettings, "baseUrl" | "publicKey" | "secretKey">) => {
    try { const lf = connector(settings); const project = await lf.check(); await lf.verifyViewer(); return { ok: true as const, detail: `project ${project.projectName}, read-only key`, lf }; }
    catch (error) { return { ok: false as const, detail: error instanceof Error ? error.message : String(error) }; }
  };
  if (existing && !ctx.flags.langfuseUrl) {
    const check = await verify(existing);
    ctx.log(check.ok ? `  ✓ Langfuse at ${existing.baseUrl}: ${check.detail}` : `  ✗ Saved Langfuse connection failed: ${check.detail}`);
    if (check.ok && await confirm(ctx, "Keep this Langfuse connection?", true)) return { ...existing, verifiedAt: new Date().toISOString() };
    if (!check.ok && !(await confirm(ctx, "Reconfigure Langfuse now?", false))) return existing;
  } else if (!ctx.flags.langfuseUrl && !(await confirm(ctx, "Connect this repository's Langfuse (read-only aggregates)?", false))) return existing;
  for (;;) {
    const baseUrl = ctx.flags.langfuseUrl ?? (ctx.prompter ? await ctx.prompter.ask("Langfuse URL (Cloud or self-hosted)", existing?.baseUrl ?? "https://cloud.langfuse.com") : "https://cloud.langfuse.com");
    ctx.log("  OpenMerit needs a separate Viewer key pair (Project Settings → API Keys → Viewer); it never writes to Langfuse.");
    const publicKey = await credential(ctx, "Langfuse Viewer public key", ["OPENMERIT_LANGFUSE_PUBLIC_KEY"], `langfuse-public-${ctx.repo.id}`, ctx.flags.langfusePublicKeyEnv);
    const secretKey = await credential(ctx, "Langfuse Viewer secret key", ["OPENMERIT_LANGFUSE_SECRET_KEY"], `langfuse-secret-${ctx.repo.id}`, ctx.flags.langfuseSecretKeyEnv);
    if (!publicKey || !secretKey) return existing;
    const check = await verify({ baseUrl, publicKey, secretKey });
    if (check.ok) {
      ctx.log(`  ✓ Langfuse: ${check.detail}`);
      const mappings = existing?.mappings ?? [];
      if (ctx.prompter && !ctx.flags.nonInteractive) {
        const traces = await check.lf.traceNames().catch(() => []);
        const latest = ctx.state.listRuns(ctx.repo.id, 1)[0];
        const taskNames = ((latest?.state.tasks as { name: string }[] | undefined) ?? []).map(task => task.name);
        if (traces.length) ctx.log(`  Trace names with generations in the last 30 days: ${traces.slice(0, 15).map(trace => `${trace.traceName} (${trace.generations})`).join(", ")}`);
        if (taskNames.length) ctx.log(`  Tasks from the last Scout run: ${taskNames.join(", ")}`);
        for (;;) {
          const line = await ctx.prompter.ask("Map a task to Langfuse evidence as <task>=<traceName>:<score,score> (empty to finish)", "");
          if (!line) break;
          const match = /^(.+?)=([^:]+)(?::(.*))?$/.exec(line);
          if (!match) { ctx.log("  Write <task>=<traceName>:<score names>."); continue; }
          const mapping = { task: match[1]!.trim(), traceName: match[2]!.trim(), scores: (match[3] ?? "").split(",").map(item => item.trim()).filter(Boolean) };
          mappings.splice(0, mappings.length, ...mappings.filter(item => item.task !== mapping.task), mapping);
        }
      }
      return { baseUrl, publicKey, secretKey, mappings, verifiedAt: new Date().toISOString() };
    }
    ctx.log(`  ✗ Langfuse: ${check.detail}`);
    if (!ctx.prompter || ctx.flags.nonInteractive || !(await ctx.prompter.confirm("Try again?", true))) return existing;
  }
}

function parseEndpointFlag(value: string, allowed: Endpoint["allowedModels"]): Endpoint {
  const known = /^(openrouter|openai):([A-Z_][A-Z0-9_]*)$/.exec(value);
  if (known) return { ...(known[1] === "openrouter" ? OPENROUTER_ENDPOINT : OPENAI_ENDPOINT), allowedModels: allowed, apiKey: { env: known[2]! } };
  const custom = /^([a-z0-9-]+)=(https?:\/\/[^\s]+):([A-Z_][A-Z0-9_]*)$/.exec(value);
  if (!custom) throw new Error(`--endpoint ${value}: use openrouter:ENV_VAR, openai:ENV_VAR or <id>=<baseUrl>:ENV_VAR`);
  if (allowed === "all") throw new Error("An OpenAI-compatible endpoint needs --allowed-models: the catalogue cannot tell which models it serves.");
  return { id: custom[1]!, kind: "openai-compatible", baseUrl: custom[2]!, apiKey: { env: custom[3]! }, allowedModels: allowed };
}

async function setupEndpoints(ctx: SetupContext): Promise<Endpoint[]> {
  const existing = readRepoConfig(ctx.repo.root).endpoints ?? [];
  const allowed: Endpoint["allowedModels"] = ctx.flags.allowedModels?.length ? ctx.flags.allowedModels : "all";
  if (ctx.flags.endpoints?.length) {
    const next = [...existing];
    for (const flag of ctx.flags.endpoints) {
      const endpoint = parseEndpointFlag(flag, allowed);
      const check = await verifyEndpoint(endpoint, ctx.env, ctx.fetch);
      if (!check.ok) throw new Error(`Endpoint ${endpoint.id} failed verification: ${check.detail}. Existing endpoints are unchanged.`);
      ctx.log(`  ✓ ${endpoint.id}: ${check.detail}; allowed models: ${endpoint.allowedModels === "all" ? "all" : endpoint.allowedModels.join(", ")}`);
      next.splice(0, next.length, ...next.filter(item => item.id !== endpoint.id), { ...endpoint, verifiedAt: new Date().toISOString() });
    }
    return next;
  }
  const kept: Endpoint[] = [];
  for (const endpoint of existing) {
    const check = await verifyEndpoint(endpoint, ctx.env, ctx.fetch);
    ctx.log(`  ${check.ok ? "✓" : "✗"} Endpoint ${endpoint.id} (${endpoint.baseUrl}): ${check.detail}; allowed models: ${endpoint.allowedModels === "all" ? "all" : endpoint.allowedModels.join(", ")}`);
    if (check.ok) { kept.push(await confirm(ctx, `Keep ${endpoint.id}?`, true) ? endpoint : await reconfigure(endpoint) ?? endpoint); continue; }
    const fixed = await reconfigure(endpoint);
    kept.push(fixed ?? endpoint);
  }
  async function reconfigure(endpoint: Endpoint): Promise<Endpoint | null> {
    if (!ctx.prompter || ctx.flags.nonInteractive || !(await ctx.prompter.confirm(`Enter a new key for ${endpoint.id}?`, true))) return null;
    for (;;) {
      const apiKey = await credential(ctx, `${endpoint.id} API key`, [], `endpoint-${endpoint.id}-${ctx.repo.id}`);
      if (!apiKey) return null;
      const next = { ...endpoint, apiKey };
      const check = await verifyEndpoint(next, ctx.env, ctx.fetch);
      ctx.log(`  ${check.ok ? "✓" : "✗"} ${endpoint.id}: ${check.detail}`);
      if (check.ok) return { ...next, verifiedAt: new Date().toISOString() };
      if (!(await ctx.prompter.confirm("Try again?", true))) return null;
    }
  }
  if (!ctx.prompter || ctx.flags.nonInteractive) return kept;
  if (!kept.some(item => item.kind === "openrouter") && await ctx.prompter.confirm("Add OpenRouter as a candidate endpoint, with every OpenRouter model eligible?", !kept.length)) {
    const apiKey = await credential(ctx, "OpenRouter API key (used only to run candidate evals)", ["OPENROUTER_API_KEY"], `endpoint-openrouter-${ctx.repo.id}`);
    if (apiKey) kept.push(...await added({ ...OPENROUTER_ENDPOINT, apiKey }));
  }
  if (!kept.some(item => item.kind === "openai") && await ctx.prompter.confirm("Add OpenAI as a candidate endpoint?", false)) {
    const apiKey = await credential(ctx, "OpenAI API key (used only to run candidate evals)", ["OPENAI_API_KEY"], `endpoint-openai-${ctx.repo.id}`);
    if (apiKey) kept.push(...await added({ ...OPENAI_ENDPOINT, apiKey }));
  }
  async function added(endpoint: Endpoint): Promise<Endpoint[]> {
    const models = await ctx.prompter!.ask(`Allowed models on ${endpoint.id}: "all", or IDs comma-separated`, "all");
    const next: Endpoint = { ...endpoint, allowedModels: /^all$/i.test(models) ? "all" : models.split(",").map(item => item.trim()).filter(Boolean) };
    const check = await verifyEndpoint(next, ctx.env, ctx.fetch);
    ctx.log(`  ${check.ok ? "✓" : "✗"} ${endpoint.id}: ${check.detail}`);
    return check.ok ? [{ ...next, verifiedAt: new Date().toISOString() }] : (await ctx.prompter!.confirm("Save it anyway, to fix later?", false)) ? [next] : [];
  }
  return kept;
}

export async function runSetup(ctx: SetupContext): Promise<{ harness: HarnessSettings | null; endpoints: Endpoint[]; langfuse: boolean; budgetUsd: number }> {
  ctx.log("OpenMerit setup\n\n1. OpenMerit Harness (global)");
  const harness = await setupHarness(ctx);
  if (!harness) return { harness: null, endpoints: [], langfuse: false, budgetUsd: DEFAULT_BUDGET_USD };
  const agents = (await detectAgents()).filter(agent => agent.installed).map(agent => agent.kind);
  if (agents.length && (ctx.flags.registerMcp ?? await confirm(ctx, `Register OpenMerit's MCP server with ${agents.map(kind => (kind === "claude-code" ? "Claude Code" : "Codex")).join(" and ")}?`, true))) registerMcp(ctx, agents);
  ctx.log(`\n2. This repository: ${ctx.repo.root}`);
  const langfuse = await setupLangfuse(ctx);
  const endpoints = await setupEndpoints(ctx);
  if (!endpoints.length) ctx.log("  No candidate endpoints: Scout needs at least one to evaluate models. Run setup again to add one.");
  const current = readRepoConfig(ctx.repo.root).budget?.defaultUsd ?? DEFAULT_BUDGET_USD;
  let budgetUsd = ctx.flags.budget ?? current;
  if (ctx.flags.budget === undefined && ctx.prompter && !ctx.flags.nonInteractive) {
    const answer = Number(await ctx.prompter.ask("Default eval budget per Scout run, USD", String(current)));
    if (Number.isFinite(answer) && answer > 0) budgetUsd = answer;
  }
  updateRepoConfig(ctx.repo.root, { endpoints, budget: { defaultUsd: budgetUsd }, ...(langfuse ? { langfuse } : {}) });
  ctx.log(`\nSaved. Harness: ${AGENT_LABEL[harness.kind]}. Endpoints: ${endpoints.map(item => item.id).join(", ") || "none"}. Langfuse: ${langfuse ? "read-only" : "not connected"}. Eval budget: $${budgetUsd.toFixed(2)} per run.\nSettings: ~/.openmerit/config.json (global) and .openmerit/config.json (this repository; credential references only). Next: openmerit scout`);
  return { harness, endpoints, langfuse: !!langfuse, budgetUsd };
}
