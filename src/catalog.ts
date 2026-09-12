/** OpenRouter catalog fetch + snapshot diffing: the "new model release" watch. */

import { readJson, paths, writeJson } from "./store.js";
import type { CatalogEntry } from "./types.js";

const OR = "https://openrouter.ai/api/v1";

export async function fetchCatalog(key: string): Promise<Map<string, CatalogEntry>> {
  const res = await fetch(`${OR}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`OpenRouter /models HTTP ${res.status}`);
  const raw = (await res.json()) as { data?: unknown[] };
  const cat = new Map<string, CatalogEntry>();
  for (const m of raw.data ?? []) {
    const mm = m as Record<string, unknown>;
    const id = String(mm.id ?? "");
    if (!id || id.startsWith("openrouter/")) continue; // skip meta-routers
    const pricing = (mm.pricing ?? {}) as Record<string, unknown>;
    const pp = Number(pricing.prompt ?? 0);
    const pc = Number(pricing.completion ?? 0);
    if (!(pp >= 0 && pc >= 0)) continue; // skip bogus pricing
    cat.set(id, {
      id,
      name: String(mm.name ?? id),
      ctx: Number(mm.context_length ?? 0),
      pp,
      pc,
      price: Math.round((((pp + pc) / 2) * 1e6 + Number.EPSILON) * 1e4) / 1e4,
      created: typeof mm.created === "number" ? mm.created : undefined,
    });
  }
  return cat;
}

interface Snapshot {
  takenAt: string;
  ids: string[];
  /** Full entries, so the pi extension can inject models pi's registry lacks. */
  entries?: CatalogEntry[];
}

/** Diff the live catalog against the stored snapshot; returns newly appeared models. */
export function diffNewModels(
  cat: Map<string, CatalogEntry>,
  snapshot: Snapshot,
): CatalogEntry[] {
  const seen = new Set(snapshot.ids);
  return [...cat.values()].filter((e) => !seen.has(e.id));
}

export function loadSnapshot(): Snapshot {
  return readJson<Snapshot>(paths.catalogSnapshot(), { takenAt: "", ids: [] });
}

export function saveSnapshot(cat: Map<string, CatalogEntry>): void {
  writeJson(paths.catalogSnapshot(), {
    takenAt: new Date().toISOString(),
    ids: [...cat.keys()].sort(),
    entries: [...cat.values()].sort((a, b) => a.id.localeCompare(b.id)),
  } satisfies Snapshot);
}
