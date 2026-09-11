/** Minimal OpenRouter chat client (port of model_search/main.py's transport). */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "./store.js";

const OR = "https://openrouter.ai/api/v1";

/** Load OPENROUTER_API_KEY from env, ~/.openmerit/.env, or the legacy model_search/.env. */
export function loadKey(): string {
  for (const envFile of [
    paths.envFile(),
    join(dirname(dirname(fileURLToPath(import.meta.url))), "model_search", ".env"),
  ]) {
    if (!existsSync(envFile)) continue;
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const [k, ...v] = t.split("=");
      if (process.env[k.trim()] === undefined) process.env[k.trim()] = v.join("=").trim();
    }
  }
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("missing OPENROUTER_API_KEY (env or ~/.openmerit/.env)");
  return key;
}

async function request<T>(key: string, path: string, body?: unknown, tries = 3): Promise<T> {
  for (let attempt = 0; attempt < tries; attempt++) {
    const res = await fetch(OR + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json", "X-Title": "openmerit" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) return (await res.json()) as T;
    const detail = (await res.text()).slice(0, 400);
    if ([429, 500, 502, 503].includes(res.status) && attempt < tries - 1) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    throw new Error(`OpenRouter HTTP ${res.status}: ${detail}`);
  }
  throw new Error("unreachable");
}

export interface ChatResult {
  content: string;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export async function chat(
  key: string,
  model: string,
  prompt: string,
  maxTokens: number,
  temperature: number,
): Promise<ChatResult> {
  const r = await request<{
    choices: { message?: { content?: string | null } }[];
    usage?: ChatResult["usage"];
  }>(key, "/chat/completions", {
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
    temperature,
  });
  return { content: r.choices[0]?.message?.content ?? "", usage: r.usage ?? {} };
}
