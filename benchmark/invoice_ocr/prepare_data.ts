#!/usr/bin/env node
/** Download a deterministic 10-invoice slice with exact ground truth. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT, "data");
const HF_ROWS_URL = "https://datasets-server.huggingface.co/rows";
const DATASET = "alamgirqazi/invoice-ocr-synthetic";
const DATASET_REVISION = "44ddfd3c0c373b69f377910f83c4164a1e52d52c";

// Four clean, three faded, and three bad-scan invoices, with no repeated base
// document. The chosen rows span freelancer, corporate, modern, and utility
// layouts. Offsets are pinned to the dataset revision above.
const ROW_INDICES = [2, 5, 6, 7, 947, 948, 949, 1888, 1890, 1892];

const TARGET_SCALAR_FIELDS = [
  "supplier_name",
  "customer_name",
  "invoice_number",
  "po_number",
  "document_date",
  "due_date",
  "document_currency",
  "document_total_net",
  "document_total_tax",
  "document_total_amount",
];
const TARGET_LINE_ITEM_FIELDS = [
  "description",
  "quantity",
  "unit_price",
  "amount",
];

async function fetchJson(url: string): Promise<any> {
  // Divergence from Python: urllib sent "User-Agent: Python-urllib/3.x" here;
  // undici sends its own default UA. No explicit header, mirroring the Python.
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

async function download(url: string, path: string): Promise<void> {
  const response = await fetch(url, {
    headers: { "User-Agent": "openmerit-invoice-benchmark/1.0" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));
}

function target_from_row(row: any): Record<string, any> {
  const target: Record<string, any> = {};
  for (const name of TARGET_SCALAR_FIELDS) {
    target[name] = row[name] ?? null;
  }
  target["line_items"] = (row["line_items"] || []).map((item: any) => {
    const projected: Record<string, any> = {};
    for (const name of TARGET_LINE_ITEM_FIELDS) {
      projected[name] = item[name] ?? null;
    }
    return projected;
  });
  return target;
}

async function main(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const manifest: Record<string, any> = {
    dataset: DATASET,
    dataset_revision: DATASET_REVISION,
    license: "CC BY 4.0",
    rows: [],
  };

  for (const [index, rowIdx] of ROW_INDICES.entries()) {
    const sequence = index + 1;
    // Divergence from Python: urllib.parse.urlencode encodes spaces as "+"
    // while URLSearchParams uses "%20"; the HF datasets-server accepts both
    // (verified empirically) and no parameter here contains a space anyway.
    const query = new URLSearchParams({
      dataset: DATASET,
      config: "default",
      split: "train",
      offset: String(rowIdx),
      length: "1",
    });
    const payload = await fetchJson(`${HF_ROWS_URL}?${query}`);
    const record = payload["rows"][0];
    if (record["row_idx"] !== rowIdx) {
      throw new Error(`Expected row ${rowIdx}, received ${record["row_idx"]}`);
    }

    const row = record["row"];
    if (!row["invoice_number"]) {
      throw new Error(`Selected row ${rowIdx} is not an invoice`);
    }

    const imageName = `invoice_${String(sequence).padStart(2, "0")}_row_${rowIdx}.jpg`;
    const imagePath = join(DATA_DIR, imageName);
    await download(row["image"]["src"], imagePath);

    const groundTruthName = `invoice_${String(sequence).padStart(2, "0")}_ground_truth.json`;
    const groundTruthPath = join(DATA_DIR, groundTruthName);
    // Divergence from Python: json.dumps(indent=2, ensure_ascii=False) renders
    // floats like 2220.0 as "2220.0"; JSON.stringify renders them as "2220".
    // Parsed content is identical.
    writeFileSync(
      groundTruthPath,
      JSON.stringify(target_from_row(row), null, 2) + "\n",
    );

    manifest["rows"].push({
      invoice_id: `invoice_${String(sequence).padStart(2, "0")}`,
      row_idx: rowIdx,
      file_name: row["file_name"],
      quality: row["quality"],
      template: row["_template_used"],
      image: imageName,
      ground_truth: groundTruthName,
    });
  }

  writeFileSync(
    join(DATA_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(`Prepared ${manifest["rows"].length} invoices in ${DATA_DIR}`);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
