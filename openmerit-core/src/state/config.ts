// Settings. Global (~/.openmerit/config.json): how OpenMerit Harness is powered. Per repository
// (<repo>/.openmerit/config.json): Langfuse, candidate endpoints, allowed models, evals and the eval
// budget, with credential references only. Secret values live in ~/.openmerit/secrets.json (0600),
// outside every repository. Writes keep keys OpenMerit does not know about.
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openmeritHome } from "./paths.ts";

/** Where a credential comes from: an environment variable, or a value OpenMerit stored in secrets.json. */
export type CredentialRef = { env: string } | { secret: string };

export type HarnessKind = "claude-code" | "codex" | "api";

export interface HarnessSettings {
  kind: HarnessKind;
  /** Model the coding agent uses for harness inference; its own default when absent. */
  model?: string;
  /** For kind "api": a Pi provider (anthropic, openai, openrouter, ...) and model. */
  api?: { provider: string; model: string; apiKey: CredentialRef };
  verifiedAt?: string;
}

export interface GlobalConfig {
  harness?: HarnessSettings;
  [key: string]: unknown;
}

export type EndpointKind = "openrouter" | "openai" | "openai-compatible";

export interface Endpoint {
  id: string;
  kind: EndpointKind;
  /** OpenAI-compatible API root, such as https://openrouter.ai/api/v1. */
  baseUrl: string;
  apiKey: CredentialRef;
  /** "all" for every catalogue model the endpoint serves, or explicit model IDs (catalogue or endpoint IDs). */
  allowedModels: "all" | string[];
  verifiedAt?: string;
}

/** Which Langfuse scores and traces measure a task. Read-only aggregates. */
export interface LangfuseMapping {
  task: string;
  traceName: string;
  scores: string[];
}

export interface LangfuseSettings {
  baseUrl: string;
  publicKey: CredentialRef;
  secretKey: CredentialRef;
  mappings: LangfuseMapping[];
  verifiedAt?: string;
}

/** How OpenMerit runs a task's existing eval for one model. See README "Eval contract". */
export interface EvalSpec {
  command: string;
  cwd?: string;
  /** Extra variables for the eval; `{{model}}`, `{{items}}` and `{{experiment}}` are filled in. */
  env?: Record<string, string>;
  /** Helper files the harness wrote (and the user approved) to run the existing eval. */
  helpers?: string[];
  /** The eval's own acceptance threshold: the minimum pass rate, 0 to 1. */
  threshold?: number;
  /**
   * The eval records each run as a Langfuse experiment named $OPENMERIT_EXPERIMENT on this dataset,
   * with a per-item score. OpenMerit reads pass/fail back with the Viewer key. Without it, the eval
   * reports its items in $OPENMERIT_RESULT.
   */
  langfuse?: { dataset: string; score: string; min?: number };
  description?: string;
}

export interface RepoConfig {
  langfuse?: LangfuseSettings;
  endpoints?: Endpoint[];
  budget?: { defaultUsd: number };
  evals?: Record<string, EvalSpec>;
  /** Glob patterns, relative to the repository root, of files or directories Scout's scan skips. */
  scan?: { exclude?: string[] };
  /** Runs of every item for the current model and each finalist; default 3. */
  repeats?: number;
  [key: string]: unknown;
}

export const DEFAULT_BUDGET_USD = 10;
export const DEFAULT_REPEATS = 3;

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must hold a JSON object`);
  return value as T;
}

function writeJson(path: string, value: unknown, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(temp, path);
  chmodSync(path, mode);
}

export const globalConfigPath = (env?: Record<string, string | undefined>) => join(openmeritHome(env), "config.json");
export const repoConfigPath = (root: string) => join(root, ".openmerit", "config.json");
const secretsPath = (env?: Record<string, string | undefined>) => join(openmeritHome(env), "secrets.json");

export const readGlobalConfig = (env?: Record<string, string | undefined>) => readJson<GlobalConfig>(globalConfigPath(env)) ?? {};
export const readRepoConfig = (root: string) => readJson<RepoConfig>(repoConfigPath(root)) ?? {};

/** Merges `patch` into the stored object, keeping every other key. */
export function updateGlobalConfig(patch: Partial<GlobalConfig>, env?: Record<string, string | undefined>) {
  const next = { ...readGlobalConfig(env), ...patch };
  writeJson(globalConfigPath(env), next);
  return next;
}

export function updateRepoConfig(root: string, patch: Partial<RepoConfig>) {
  const next = { ...readRepoConfig(root), ...patch };
  writeJson(repoConfigPath(root), next);
  return next;
}

export function storeSecret(name: string, value: string, env?: Record<string, string | undefined>): CredentialRef {
  const secrets = readJson<Record<string, string>>(secretsPath(env)) ?? {};
  secrets[name] = value;
  writeJson(secretsPath(env), secrets, 0o600);
  return { secret: name };
}

export function resolveCredential(ref: CredentialRef | undefined, env: Record<string, string | undefined> = process.env): string | null {
  if (!ref) return null;
  if ("env" in ref) return env[ref.env]?.trim() || null;
  return readJson<Record<string, string>>(secretsPath(env))?.[ref.secret] ?? null;
}

export const describeCredential = (ref: CredentialRef) => ("env" in ref ? `$${ref.env}` : "stored in ~/.openmerit/secrets.json");

/** Default candidate pool: OpenRouter with every model eligible. */
export const OPENROUTER_ENDPOINT: Omit<Endpoint, "apiKey"> = { id: "openrouter", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1", allowedModels: "all" };
export const OPENAI_ENDPOINT: Omit<Endpoint, "apiKey"> = { id: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", allowedModels: "all" };
