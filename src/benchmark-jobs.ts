/** Durable benchmark definitions and scheduler-neutral refresh jobs. */
import { appendJsonl, paths, readJsonl } from "./store.js";
import type { BenchmarkDefinition, BenchmarkJob } from "./types.js";

export function saveBenchmark(definition: BenchmarkDefinition): void {
  appendJsonl(paths.benchmarks(), definition);
}

export function saveBenchmarkJob(job: BenchmarkJob): void {
  if (job.trigger === "interval" && (!job.schedule || !Number.isInteger(job.schedule.everyMinutes) || job.schedule.everyMinutes < 1))
    throw new Error("interval benchmark jobs require everyMinutes >= 1");
  appendJsonl(paths.benchmarkJobs(), job);
}

export function listBenchmarks(): BenchmarkDefinition[] {
  const latest = new Map<string, BenchmarkDefinition>();
  for (const item of readJsonl<BenchmarkDefinition>(paths.benchmarks())) latest.set(item.id, item);
  return [...latest.values()];
}

export function listBenchmarkJobs(): BenchmarkJob[] {
  const latest = new Map<string, BenchmarkJob>();
  for (const item of readJsonl<BenchmarkJob>(paths.benchmarkJobs())) latest.set(item.id, item);
  return [...latest.values()].filter((job) => job.enabled);
}

export function dueBenchmarkJobs(now = Date.now()): BenchmarkJob[] {
  return listBenchmarkJobs().filter((job) => {
    if (job.trigger !== "interval" || !job.schedule) return false;
    if (!job.lastRunAt) return true;
    const last = Date.parse(job.lastRunAt);
    return Number.isFinite(last) && now - last >= job.schedule.everyMinutes * 60_000;
  });
}
