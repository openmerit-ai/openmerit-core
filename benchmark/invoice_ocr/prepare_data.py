#!/usr/bin/env python3
"""Download a deterministic 10-invoice slice with exact ground truth."""

from __future__ import annotations

import json
import pathlib
import urllib.parse
import urllib.request


ROOT = pathlib.Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
HF_ROWS_URL = "https://datasets-server.huggingface.co/rows"
DATASET = "alamgirqazi/invoice-ocr-synthetic"
DATASET_REVISION = "44ddfd3c0c373b69f377910f83c4164a1e52d52c"

# Four clean, three faded, and three bad-scan invoices, with no repeated base
# document. The chosen rows span freelancer, corporate, modern, and utility
# layouts. Offsets are pinned to the dataset revision above.
ROW_INDICES = [2, 5, 6, 7, 947, 948, 949, 1888, 1890, 1892]

TARGET_SCALAR_FIELDS = [
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
]
TARGET_LINE_ITEM_FIELDS = [
    "description",
    "quantity",
    "unit_price",
    "amount",
]


def fetch_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.load(response)


def download(url: str, path: pathlib.Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "openmerit-invoice-benchmark/1.0"})
    with urllib.request.urlopen(request, timeout=120) as response:
        path.write_bytes(response.read())


def target_from_row(row: dict) -> dict:
    target = {name: row.get(name) for name in TARGET_SCALAR_FIELDS}
    target["line_items"] = [
        {name: item.get(name) for name in TARGET_LINE_ITEM_FIELDS}
        for item in (row.get("line_items") or [])
    ]
    return target


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {
        "dataset": DATASET,
        "dataset_revision": DATASET_REVISION,
        "license": "CC BY 4.0",
        "rows": [],
    }

    for sequence, row_idx in enumerate(ROW_INDICES, start=1):
        query = urllib.parse.urlencode(
            {
                "dataset": DATASET,
                "config": "default",
                "split": "train",
                "offset": row_idx,
                "length": 1,
            }
        )
        payload = fetch_json(f"{HF_ROWS_URL}?{query}")
        record = payload["rows"][0]
        if record["row_idx"] != row_idx:
            raise RuntimeError(f"Expected row {row_idx}, received {record['row_idx']}")

        row = record["row"]
        if not row.get("invoice_number"):
            raise RuntimeError(f"Selected row {row_idx} is not an invoice")

        image_name = f"invoice_{sequence:02d}_row_{row_idx}.jpg"
        image_path = DATA_DIR / image_name
        download(row["image"]["src"], image_path)

        ground_truth_name = f"invoice_{sequence:02d}_ground_truth.json"
        ground_truth_path = DATA_DIR / ground_truth_name
        ground_truth_path.write_text(
            json.dumps(target_from_row(row), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

        manifest["rows"].append(
            {
                "invoice_id": f"invoice_{sequence:02d}",
                "row_idx": row_idx,
                "file_name": row["file_name"],
                "quality": row["quality"],
                "template": row["_template_used"],
                "image": image_name,
                "ground_truth": ground_truth_name,
            }
        )

    (DATA_DIR / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Prepared {len(manifest['rows'])} invoices in {DATA_DIR}")


if __name__ == "__main__":
    main()
