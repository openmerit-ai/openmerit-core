/** A pi text task may carry images embedded in its saved session message. */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { taskKey } from "./store.js";

export interface TaskImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface TaskFile {
  path: string;
  name: string;
  size: number;
  sha256: string;
}

/** Recover files Pi expanded into a task message (for example @invoice.pdf). */
export function sessionFiles(text: string): TaskFile[] {
  const files: TaskFile[] = [];
  const seen = new Set<string>();
  const re = /<file\s+name=["']([^"']+)["'][^>]*>/g;
  for (const match of text.matchAll(re)) {
    const file = match[1];
    if (!file || seen.has(file) || !existsSync(file)) continue;
    try {
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > 100_000_000) continue;
      files.push({ path: file, name: basename(file), size: stat.size,
        sha256: createHash("sha256").update(readFileSync(file)).digest("hex") });
      seen.add(file);
    } catch { /* inaccessible attachment */ }
  }
  return files;
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
export function taskInputKey(text: string, images: TaskImage[], files: TaskFile[] = []): string {
  if (images.length === 0 && files.length === 0) return taskKey(text);
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const hashes = images.map((image) => `${image.mimeType}:` +
    createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex"));
  const fileHashes = files.map((file) => `${file.name}:${file.sha256}`).join(",");
  return taskKey(`${normalized}\nimages:${hashes.join(",")}\nfiles:${fileHashes}`);
}
