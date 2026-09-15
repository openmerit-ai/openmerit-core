/** A pi text task may carry images embedded in its saved session message. */

import { createHash } from "node:crypto";
import { taskKey } from "./store.js";

export interface TaskImage {
  type: "image";
  data: string;
  mimeType: string;
}

const SUPPORTED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export function sessionImages(content: unknown): TaskImage[] | null {
  if (!Array.isArray(content)) return [];
  const images: TaskImage[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") return null;
    if (part.type === "text") continue;
    if (part.type !== "image" || typeof part.data !== "string" ||
        typeof part.mimeType !== "string" || !SUPPORTED.has(part.mimeType) ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(part.data)) return null;
    images.push({ type: "image", data: part.data, mimeType: part.mimeType });
  }
  return images;
}

/** Text-only keys remain compatible; image bytes distinguish same-prompt documents. */
export function taskInputKey(text: string, images: TaskImage[]): string {
  if (images.length === 0) return taskKey(text);
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const hashes = images.map((image) => `${image.mimeType}:` +
    createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex"));
  return taskKey(`${normalized}\nimages:${hashes.join(",")}`);
}
