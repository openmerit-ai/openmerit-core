// Customer-side usage reads. A missing generation or price is unknown, never zero.
import { setTimeout as delay } from "node:timers/promises";

export interface Observation {
  type: string;
  endTime?: string | null;
  totalCost?: number | null;
  latency?: number | null;
  metadata?: { generations?: string | number };
}

export interface AgentUsage {
  caseId: string;
  agent: string;
  cost: number | null;
  seconds: number | null;
  generations: number;
  complete: boolean;
}

/** Wait for the root's declared generation count and every generation's price. */
export async function collectUsage(
  runs: { caseId: string; agent: string; traceId: string }[],
  read: (traceId: string, signal: AbortSignal) => Promise<Observation[]>,
  { timeoutMs = 120_000, intervalMs = 5_000 } = {},
): Promise<AgentUsage[]> {
  const signal = AbortSignal.timeout(timeoutMs);
  const usage: AgentUsage[] = runs.map(({ caseId, agent }) => ({ caseId, agent, cost: null, seconds: null, generations: 0, complete: false }));
  while (!signal.aborted) {
    for (const [index, run] of runs.entries()) {
      const item = usage[index]!;
      if (item.complete) continue;
      try {
        const data = await read(run.traceId, signal);
        const root = data.find(row => row.type === "AGENT");
        const generations = data.filter(row => row.type === "GENERATION");
        const expected = Number(root?.metadata?.generations ?? NaN);
        item.generations = generations.length;
        item.seconds = typeof root?.latency === "number" && Number.isFinite(root.latency) && root.latency >= 0 ? root.latency : null;
        item.complete = !!root?.endTime && Number.isSafeInteger(expected) && expected >= 0 && generations.length === expected
          && generations.every(row => typeof row.totalCost === "number" && Number.isFinite(row.totalCost) && row.totalCost >= 0);
        item.cost = item.complete ? generations.reduce((sum, row) => sum + row.totalCost!, 0) : null;
      } catch {
        // Retain an explicit incomplete row for outages, rate limits and timeout.
      }
      if (signal.aborted) break;
    }
    if (usage.every(item => item.complete) || signal.aborted) break;
    try { await delay(intervalMs, undefined, { signal }); } catch { break; }
  }
  return usage;
}
