/** State directory layout + JSONL persistence. All state lives under OPENMERIT_HOME (default ~/.openmerit). */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  catalogSnapshot: () => join(stateDir(), "catalog", "snapshot.json"),
  candidates: () => join(stateDir(), "catalog", "candidates.json"),
  benchmarksDigest: () => join(stateDir(), "benchmarks", "digest.json"),
  traceCursor: () => join(stateDir(), "traces", "cursor.json"),
  observations: () => join(stateDir(), "traces", "observations.jsonl"),
  events: () => join(stateDir(), "events.jsonl"),
  harnessState: () => join(stateDir(), "harness-state.json"),
  ledger: () => join(stateDir(), "ledger.json"),
  watchProcessed: () => join(stateDir(), "watch", "processed.json"),
  sessionJob: (marker: string) => join(stateDir(), "watch", "jobs", sha1(marker) + ".json"),
  trialTrace: (id: string) => join(stateDir(), "traces", "trials", `${sha1(id)}.jsonl`),
  envFile: () => join(stateDir(), ".env"),
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

export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function writeJson(file: string, obj: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}
