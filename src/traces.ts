/**
 * Trace ingestion: read pi session files (JSONL entry trees) and extract
 * per-task observations (model, cost, tokens, latency, errors). Incremental
 * via a per-file byte-offset cursor, so the background track never re-reads.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { paths, readJson, taskKey, writeJson } from "./store.js";
import type { TaskObservation } from "./types.js";

export function defaultSessionsDir(): string {
  return join(homedir(), ".pi", "agent", "sessions");
}

interface Cursor {
  offsets: Record<string, number>;
}

function listSessionFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSessionFiles(p));
    else if (entry.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text"
        ? String((b as { text?: string }).text ?? "")
        : ""))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

interface SessionEntry {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    provider?: string;
    model?: string;
    stopReason?: string;
    usage?: { totalTokens?: number; cost?: { total?: number } };
    timestamp?: number;
  };
}

/** Extract observations from the entries of one session file. */
export function observationsFromEntries(entries: SessionEntry[], sessionFile: string): TaskObservation[] {
  const obs: TaskObservation[] = [];
  let current: TaskObservation | null = null;

  for (const e of entries) {
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;

    if (m.role === "user") {
      if (current) obs.push(current);
      const text = textOf(m.content);
      if (!text.trim()) {
        current = null;
        continue;
      }
      current = {
        taskKey: taskKey(text),
        taskLabel: text.replace(/\s+/g, " ").trim().slice(0, 120),
        model: null,
        costUsd: 0,
        tokens: 0,
        latencyMs: null,
        errors: 0,
        ts: e.timestamp ?? new Date().toISOString(),
        sessionFile,
      };
      continue;
    }

    if (!current) continue;

    if (m.role === "assistant") {
      if (!current.model && m.provider && m.model) current.model = `${m.provider}/${m.model}`;
      current.costUsd += m.usage?.cost?.total ?? 0;
      current.tokens += m.usage?.totalTokens ?? 0;
      if (m.stopReason === "error") current.errors += 1;
      if (typeof m.timestamp === "number") {
        const start = Date.parse(current.ts);
        if (!Number.isNaN(start)) current.latencyMs = Math.max(0, m.timestamp - start);
      }
    } else if (m.role === "toolResult") {
      const tr = m as { isError?: boolean };
      if (tr.isError) current.errors += 1;
    }
  }
  if (current) obs.push(current);
  return obs;
}

/** Read new bytes of every session file since the last run; returns fresh observations. */
export function ingestNewTraces(sessionsDir = defaultSessionsDir()): TaskObservation[] {
  const cursor = readJson<Cursor>(paths.traceCursor(), { offsets: {} });
  const fresh: TaskObservation[] = [];

  for (const file of listSessionFiles(sessionsDir)) {
    const size = statSync(file).size;
    const from = cursor.offsets[file] ?? 0;
    if (size <= from) continue;
    const buf = readFileSync(file);
    const chunk = buf.subarray(from).toString("utf8");
    // Drop a trailing partial line; it will be re-read next tick.
    const lastNl = chunk.lastIndexOf("\n");
    const complete = lastNl >= 0 ? chunk.slice(0, lastNl + 1) : "";
    const entries: SessionEntry[] = [];
    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as SessionEntry);
      } catch {
        /* skip corrupt line */
      }
    }
    fresh.push(...observationsFromEntries(entries, file));
    cursor.offsets[file] = from + Buffer.byteLength(complete);
  }

  writeJson(paths.traceCursor(), cursor);
  return fresh;
}
