/** State directory layout + JSONL persistence. All state lives under OPENMERIT_HOME (default ~/.openmerit). */

import { createHash } from "node:crypto";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function stateDir(): string {
  const dir = process.env.OPENMERIT_HOME ?? join(homedir(), ".openmerit");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export const paths = {
  policy: () => join(stateDir(), "policy.json"),
  trials: () => join(stateDir(), "trials.jsonl"),
  recommendations: () => join(stateDir(), "recommendations.jsonl"),
  events: () => join(stateDir(), "events.jsonl"),
  harnessState: () => join(stateDir(), "harness-state.json"),
  ledger: () => join(stateDir(), "ledger.json"),
  sessionJob: (marker: string) => join(stateDir(), "jobs", sha1(marker) + ".json"),
  trialTrace: (id: string) => join(stateDir(), "traces", "trials", `${sha1(id)}.jsonl`),
};

export function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

/** Stable task key from a task statement. */
export function taskKey(taskText: string): string {
  const normalized = taskText.toLowerCase().replace(/\s+/g, " ").trim();
  return sha1(normalized);
}

export function appendJsonl(file: string, obj: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  appendFileSync(file, JSON.stringify(obj) + "\n");
}

export interface JsonlReadResult<T> {
  records: T[];
  /** One-based line numbers that could not be parsed. */
  invalidLines: number[];
}

/**
 * Read append-only state without letting one interrupted or malformed line
 * hide the remaining history. Diagnostics can surface invalid line numbers.
 */
export function readJsonlReport<T>(file: string): JsonlReadResult<T> {
  if (!existsSync(file)) return { records: [], invalidLines: [] };
  const records: T[] = [];
  const invalidLines: number[] = [];
  for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      invalidLines.push(index + 1);
    }
  }
  return { records, invalidLines };
}

export function readJsonl<T>(file: string): T[] {
  return readJsonlReport<T>(file).records;
}

export interface JsonReadResult<T> {
  value: T;
  exists: boolean;
  valid: boolean;
  error?: string;
}

export function readJsonReport<T>(file: string, fallback: T): JsonReadResult<T> {
  if (!existsSync(file)) return { value: fallback, exists: false, valid: true };
  try {
    return { value: JSON.parse(readFileSync(file, "utf8")) as T, exists: true, valid: true };
  } catch (error) {
    return { value: fallback, exists: true, valid: false, error: (error as Error).message };
  }
}

export function readJson<T>(file: string, fallback: T): T {
  return readJsonReport(file, fallback).value;
}

export function writeJson(file: string, obj: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, JSON.stringify(obj, null, 2) + "\n");
    renameSync(temp, file);
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}
