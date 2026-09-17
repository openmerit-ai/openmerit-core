import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listBenchmarkJobs, listBenchmarks, saveBenchmark, saveBenchmarkJob } from "../src/benchmark-jobs.js";

describe("benchmark job registry", () => {
  it("persists versioned definitions and validates schedules", () => {
    process.env.OPENMERIT_HOME = mkdtempSync(join(tmpdir(), "openmerit-jobs-"));
    saveBenchmark({ schemaVersion: 1, id: "invoice-v1", taskKey: "abc", taskLabel: "invoice", instructions: "extract", inputModalities: ["image"], createdAt: "now", updatedAt: "now" });
    saveBenchmarkJob({ schemaVersion: 1, id: "job-1", benchmarkId: "invoice-v1", trigger: "interval", schedule: { everyMinutes: 60 }, action: "ask_harness", enabled: true, updatedAt: "now" });
    expect(listBenchmarks()).toHaveLength(1);
    expect(listBenchmarkJobs()[0]?.benchmarkId).toBe("invoice-v1");
    expect(() => saveBenchmarkJob({ schemaVersion: 1, id: "bad", benchmarkId: "invoice-v1", trigger: "interval", schedule: { everyMinutes: 0 }, action: "report", enabled: true, updatedAt: "now" })).toThrow();
  });
});
