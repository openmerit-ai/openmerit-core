/** Pi-backed inference adapter for OpenMerit's own rubric and evaluation calls. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskImage } from "./task-input.js";
import type { InferenceAdapter, ProviderChatResult } from "./providers.js";
import type { ModelRoute } from "./types.js";
import { piProviderExtensionArgs } from "./pi-config.js";

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

/** Use the harness's model registry and credential store without owning provider credentials. */
export class PiCliChatClient implements InferenceAdapter {
  readonly id = "pi-cli";
  constructor(
    private readonly executable = process.env.OPENMERIT_PI_BIN?.trim() || "pi",
    private readonly onSpend?: (usd: number) => void,
    private readonly providerExtensions: string[] = [],
  ) {}

  chat(route: ModelRoute, prompt: string): Promise<ProviderChatResult> {
    return this.run(route, prompt, []);
  }

  chatWithImages(
    route: ModelRoute, prompt: string, images: TaskImage[],
  ): Promise<ProviderChatResult> {
    return this.run(route, prompt, images);
  }

  private async run(
    route: ModelRoute, prompt: string, images: TaskImage[],
  ): Promise<ProviderChatResult> {
    const dir = mkdtempSync(join(tmpdir(), "openmerit-pi-eval-"));
    try {
      const imageArgs = images.map((image, index) => {
        const suffix = ({
          "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
        } as Record<string, string>)[image.mimeType];
        if (!suffix) throw new Error(`unsupported pi image: ${image.mimeType}`);
        const file = join(dir, `image-${index}.${suffix}`);
        writeFileSync(file, Buffer.from(image.data, "base64"));
        return `@${file}`;
      });
      const child = spawn(this.executable, [
        "--provider", route.provider, "--model", route.modelId, "--mode", "json", "--offline",
        "--no-extensions", ...piProviderExtensionArgs(this.providerExtensions),
        "--no-tools", "--print", ...imageArgs, prompt,
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
        throw new Error(`pi evaluator ${route.provider}/${route.modelId} failed: ` +
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
