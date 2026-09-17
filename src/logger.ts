import { appendJsonl, paths, readJsonl } from "./store.js";

export type LogLevel = "error" | "warn" | "info" | "debug";
const rank: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function configuredLevel(): LogLevel {
  const value = process.env.OPENMERIT_LOG_LEVEL;
  return value === "error" || value === "warn" || value === "debug" ? value : "info";
}

export function log(level: LogLevel, component: string, event: string, message: string, details?: Record<string, unknown>): void {
  if (rank[level] > rank[configuredLevel()]) return;
  appendJsonl(paths.logs(), { ts: new Date().toISOString(), level, component, event, message, ...(details ? { details } : {}) });
}

export function readLogs(level?: LogLevel): Record<string, unknown>[] {
  const minimum = level ? rank[level] : -1;
  return readJsonl<Record<string, unknown>>(paths.logs()).filter((item) =>
    typeof item.level === "string" && (rank[item.level as LogLevel] ?? -1) <= minimum || minimum < 0);
}
