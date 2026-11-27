// Settings in ~/.openmerit/config.json: how OpenMerit Harness is powered, with credential references
// only. Secret values live in ~/.openmerit/secrets.json (0600). Writes keep keys OpenMerit does not
// know about.
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

/** How history names a harness, such as `api:openrouter/anthropic/claude-sonnet-5.5` or `codex`. */
export const harnessLabel = (settings: HarnessSettings) => `${settings.kind}${settings.kind === "api" ? `:${settings.api?.provider}/${settings.api?.model}` : settings.model ? `:${settings.model}` : ""}`;

export interface GlobalConfig {
  harness?: HarnessSettings;
  [key: string]: unknown;
}

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
/** The global settings file as messages show it: the default home abbreviated, an OPENMERIT_HOME one in full. */
export const globalConfigLabel = (env: Record<string, string | undefined> = process.env) => (env.OPENMERIT_HOME ? globalConfigPath(env) : "~/.openmerit/config.json");
const secretsPath = (env?: Record<string, string | undefined>) => join(openmeritHome(env), "secrets.json");

export const readGlobalConfig = (env?: Record<string, string | undefined>) => readJson<GlobalConfig>(globalConfigPath(env)) ?? {};

/** Merges `patch` into the stored object, keeping every other key. */
export function updateGlobalConfig(patch: Partial<GlobalConfig>, env?: Record<string, string | undefined>) {
  const next = { ...readGlobalConfig(env), ...patch };
  writeJson(globalConfigPath(env), next);
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
