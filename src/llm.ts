/** Minimal provider clients for judge and strategist requests. */

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

export type ChatResult = ProviderChatResult;

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

class GeminiProvider implements ModelProvider {
  readonly id = "google";
  constructor(private readonly key: string) {}
  private async call(model: string, prompt: string, images: TaskImage[] = [], maxTokens: number): Promise<ChatResult> {
    const name = model.split("/", 2).at(-1) ?? model;
    const parts: unknown[] = [{ text: prompt }, ...images.map((image) => ({ inline_data: { mime_type: image.mimeType, data: image.data } }))];
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(name)}:generateContent?key=${encodeURIComponent(this.key)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { maxOutputTokens: maxTokens, temperature: images.length ? 0 : undefined } }),
    });
    if (!res.ok) throw new Error(`Google Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const raw = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } };
    return { content: raw.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "", usage: { prompt_tokens: raw.usageMetadata?.promptTokenCount, completion_tokens: raw.usageMetadata?.candidatesTokenCount, total_tokens: raw.usageMetadata?.totalTokenCount } };
  }
  chat(model: string, prompt: string, maxTokens: number): Promise<ChatResult> { return this.call(model, prompt, [], maxTokens); }
  chatWithImages(model: string, prompt: string, images: TaskImage[], maxTokens: number): Promise<ChatResult> { return this.call(model, prompt, images, maxTokens); }
}

export function providerFor(model: string, fallbackKey: string): ModelProvider {
  const id = model.split("/", 1)[0] || "openrouter";
  // OpenRouter model IDs are vendor/model (for example openai/gpt-4o-mini).
  // Direct providers require an explicit opt-in to avoid routing those IDs
  // away from OpenRouter when users have multiple credentials configured.
  if (id === "openai" && process.env.OPENMERIT_DIRECT_PROVIDER === "openai" && process.env.OPENAI_API_KEY)
    return new OpenAICompatibleProvider(id, "https://api.openai.com/v1", process.env.OPENAI_API_KEY);
  if (id === "google" && process.env.OPENMERIT_DIRECT_PROVIDER === "google" && process.env.GEMINI_API_KEY)
    return new GeminiProvider(process.env.GEMINI_API_KEY);
  return new OpenAICompatibleProvider("openrouter", OR, fallbackKey);
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
