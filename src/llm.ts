/** Minimal provider clients for judge and strategist requests. */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "./store.js";
import type { TaskImage } from "./task-input.js";
import type { MeritChatClient, ModelProvider, ModelProviderAdapter, ProviderChatResult } from "./providers.js";
import type { ModelRoute } from "./types.js";
import { legacyOpenRouterRoute } from "./routes.js";

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

export function directChatClient(key: string): MeritChatClient {
  const id = (model: string | ModelRoute) => typeof model === "string" ? model : model.meritId;
  return {
    chat: (model, prompt, maxTokens, temperature) => chat(key, id(model), prompt, maxTokens, temperature),
    chatWithImages: (model, prompt, images, maxTokens) =>
      chatWithImages(key, id(model), prompt, images, maxTokens),
  };
}

interface PiMessage {
  role?: string;
  content?: unknown;
  usage?: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } };
  stopReason?: string;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part): part is { type: string; text?: string } =>
    !!part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => part.text ?? "").join("\n");
}

/** Use pi's model registry and credential store without exposing provider secrets to OpenMerit. */
export class PiCliChatClient implements ModelProviderAdapter {
  readonly id = "pi-cli";
  constructor(
    private readonly executable = process.env.OPENMERIT_PI_BIN?.trim() || "pi",
    private readonly onSpend?: (usd: number) => void,
  ) {}

  chat(model: string | ModelRoute, prompt: string, _maxTokens: number, _temperature: number): Promise<ProviderChatResult> {
    return this.run(model, prompt, []);
  }

  chatWithImages(model: string | ModelRoute, prompt: string, images: TaskImage[], _maxTokens: number): Promise<ProviderChatResult> {
    return this.run(model, prompt, images);
  }

  private async run(target: string | ModelRoute, prompt: string, images: TaskImage[]): Promise<ProviderChatResult> {
    const route = typeof target === "string" ? legacyOpenRouterRoute(target) : target;
    const dir = mkdtempSync(join(tmpdir(), "openmerit-pi-chat-"));
    try {
      const imageArgs = images.map((image, index) => {
        const suffix = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" } as Record<string, string>)[image.mimeType];
        if (!suffix) throw new Error(`unsupported pi image: ${image.mimeType}`);
        const file = join(dir, `image-${index}.${suffix}`);
        writeFileSync(file, Buffer.from(image.data, "base64"));
        return `@${file}`;
      });
      const child = spawn(this.executable, [
        "--provider", route.provider, "--model", route.modelId, "--mode", "json", "--offline",
        "--no-extensions", "--no-tools", "--print", ...imageArgs, prompt,
      ], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      const code = await new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (value) => resolve(value ?? 1));
      });
      let answer = "";
      let promptTokens = 0;
      let completionTokens = 0;
      let totalTokens = 0;
      let costUsd = 0;
      let failed = false;
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        let event: { type?: string; message?: PiMessage };
        try { event = JSON.parse(line) as typeof event; } catch { continue; }
        if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
        answer = textContent(event.message.content) || answer;
        promptTokens += event.message.usage?.input ?? 0;
        completionTokens += event.message.usage?.output ?? 0;
        totalTokens += event.message.usage?.totalTokens ?? 0;
        costUsd += event.message.usage?.cost?.total ?? 0;
        if (event.message.stopReason === "error") failed = true;
      }
      if (code !== 0 || failed || !answer.trim()) {
        throw new Error(`pi model call ${route.provider}/${route.modelId} failed: ` +
          (stderr.trim().slice(0, 240) || `exit ${code}, empty answer`));
      }
      this.onSpend?.(costUsd);
      return { content: answer, usage: {
        prompt_tokens: promptTokens || undefined,
        completion_tokens: completionTokens || undefined,
        total_tokens: totalTokens || promptTokens + completionTokens || undefined,
        costUsd,
      } };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
