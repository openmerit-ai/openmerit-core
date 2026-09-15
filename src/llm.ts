/** Minimal OpenRouter chat client for catalog and trial requests. */

import { existsSync, readFileSync } from "node:fs";
import { paths } from "./store.js";
import type { TaskImage } from "./task-input.js";
import type { ModelProvider, ProviderChatResult } from "./providers.js";

const OR = "https://openrouter.ai/api/v1";

/** Load OPENROUTER_API_KEY from env or ~/.openmerit/.env. */
export function loadKey(): string {
  const envFile = paths.envFile();
  if (existsSync(envFile)) {
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

async function request<T>(key: string, path: string, body?: unknown, baseUrl = OR, tries = 3): Promise<T> {
  for (let attempt = 0; attempt < tries; attempt++) {
    const res = await fetch(baseUrl + path, {
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

class OpenAICompatibleProvider implements ModelProvider {
  constructor(public readonly id: string, private readonly baseUrl: string, private readonly key: string) {}
  private model(model: string): string { return this.id === "openrouter" ? model : model.split("/", 2).at(-1) ?? model; }
  async chat(model: string, prompt: string, maxTokens: number, temperature: number): Promise<ChatResult> {
    const r = await request<{ choices: { message?: { content?: string | null } }[]; usage?: ChatResult["usage"] }>(this.key, "/chat/completions", { model: this.model(model), messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature }, this.baseUrl);
    return { content: r.choices[0]?.message?.content ?? "", usage: r.usage ?? {} };
  }
  async chatWithImages(model: string, prompt: string, images: TaskImage[], maxTokens: number): Promise<ChatResult> {
    const content = [{ type: "text", text: prompt }, ...images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } }))];
    const r = await request<{ choices: { message?: { content?: string | null } }[]; usage?: ChatResult["usage"] }>(this.key, "/chat/completions", { model: this.model(model), messages: [{ role: "user", content }], max_tokens: maxTokens, temperature: 0 }, this.baseUrl);
    return { content: r.choices[0]?.message?.content ?? "", usage: r.usage ?? {} };
  }
}

export function providerFor(model: string, fallbackKey: string): ModelProvider {
  const id = model.split("/", 1)[0] || "openrouter";
  if (id === "openrouter") return new OpenAICompatibleProvider(id, OR, fallbackKey);
  if (id === "openai") return new OpenAICompatibleProvider(id, "https://api.openai.com/v1", process.env.OPENAI_API_KEY ?? fallbackKey);
  throw new Error(`provider ${id} is not supported for judge/strategist requests yet`);
}

export async function chat(
  key: string,
  model: string,
  prompt: string,
  maxTokens: number,
  temperature: number,
): Promise<ChatResult> {
  return providerFor(model, key).chat(model, prompt, maxTokens, temperature);
}

/** Send a visual grading request through the same OpenRouter account. */
export async function chatWithImages(
  key: string, model: string, prompt: string, images: TaskImage[], maxTokens: number,
): Promise<ChatResult> {
  return providerFor(model, key).chatWithImages(model, prompt, images, maxTokens);
}
