import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { knownInvoiceScore } from "../src/invoice-eval.js";
import { PROMPT } from "../benchmark/invoice_ocr/benchmark.ts";

const dataDir = join(process.cwd(), "benchmark", "invoice_ocr", "data");

describe("pinned invoice image grading", () => {
  it("uses the visibility-audited exact scorer for the pinned image and prompt", async () => {
    const image = { type: "image" as const, mimeType: "image/jpeg",
      data: readFileSync(join(dataDir, "invoice_01_row_2.jpg")).toString("base64") };
    const truth = readFileSync(join(dataDir, "invoice_01_ground_truth.json"), "utf8");
    const good = await knownInvoiceScore(PROMPT, [image], truth);
    expect(good?.score).toBe(1);
    expect(good?.why).toContain("pinned invoice_01");
    const piPrompt = readFileSync(join(process.cwd(), "examples", "invoice-prompt.txt"), "utf8");
    expect((await knownInvoiceScore(piPrompt, [image], truth))?.score).toBe(1);
    const bad = await knownInvoiceScore(PROMPT, [image], "not JSON");
    expect(bad?.score).toBe(0);
    expect(await knownInvoiceScore("a different prompt", [image], truth)).toBeNull();
  });
});
