import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { knownInvoiceScore } from "../src/invoice-eval.js";
import { projectVisibleInvoice, scoreInvoice } from "../src/invoice-score.js";
import { PROMPT, score } from "../benchmark/invoice_ocr/benchmark.ts";
import { project_visible } from "../benchmark/invoice_ocr/audit_results.ts";

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

  it("keeps the packaged runtime scorer aligned with the audited benchmark", () => {
    const truth = JSON.parse(readFileSync(join(dataDir, "invoice_01_ground_truth.json"), "utf8"));
    const changed = structuredClone(truth);
    changed.po_number = "not visible and excluded";
    changed.line_items[0].amount = -1;
    for (const actual of [truth, changed, null]) {
      expect(scoreInvoice(projectVisibleInvoice(truth), projectVisibleInvoice(actual)))
        .toEqual(score(project_visible(truth), project_visible(actual)));
    }
  });
});
