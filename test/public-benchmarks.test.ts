import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenRouterBenchmarkSource, listPublicBenchmarks, savePublicBenchmark } from "../src/public-benchmarks.js";

afterEach(() => { vi.unstubAllGlobals(); delete process.env.OPENMERIT_HOME; });

describe("public benchmark sources", () => {
  it("normalizes OpenRouter scores and persists provenance", async () => {
    process.env.OPENMERIT_HOME = mkdtempSync(join(tmpdir(), "openmerit-public-"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ source: "artificial-analysis", model_permaslug: "openai/gpt-4o", intelligence_index: 71.2,
        pricing: { prompt: "0.0000025", completion: "0.00001" } }], meta: { as_of: "2026-09-17T00:00:00Z" },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const points = await new OpenRouterBenchmarkSource("key", "https://example.test").fetch({ taskType: "intelligence" });
    savePublicBenchmark(points);
    expect(points[0]).toMatchObject({ model: "openai/gpt-4o", scores: { intelligence_index: 71.2 }, benchmark: "artificial-analysis" });
    expect(listPublicBenchmarks()).toHaveLength(1);
  });
});
