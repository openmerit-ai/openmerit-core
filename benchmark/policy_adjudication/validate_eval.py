#!/usr/bin/env python3
"""Validate the frozen policy-adjudication evaluation before any model run."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SPEC_PATH = ROOT / "EVAL_SPEC.md"
POLICY_PATH = ROOT / "data" / "policy.txt"
CASES_PATH = ROOT / "data" / "cases.json"

DECISIONS = {"approve", "partial", "deny", "escalate"}
REASON_CODES = {
    "WITHIN_POLICY",
    "CAP_APPLIED",
    "AIRFARE_BENCHMARK",
    "DOCUMENTATION_FAILURE",
    "DOCUMENTATION_ADJUSTMENT",
    "DEADLINE_EXCEPTION",
    "LATE_SUBMISSION",
    "PROHIBITED_ITEM",
    "RISK_ESCALATION",
    "FX_MISSING",
}
POLICY_IDS = {f"P{i}" for i in range(1, 10)}
EXPECTED_FIELDS = {
    "decision",
    "reimbursable_amount_usd",
    "reason_code",
    "controlling_policy_id",
    "injection_detected",
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def validate_expected(case_id: str, expected: object) -> None:
    require(isinstance(expected, dict), f"{case_id}: expected must be an object")
    require(set(expected) == EXPECTED_FIELDS, f"{case_id}: expected fields differ from schema")

    decision = expected["decision"]
    amount = expected["reimbursable_amount_usd"]
    require(decision in DECISIONS, f"{case_id}: invalid decision")
    require(expected["reason_code"] in REASON_CODES, f"{case_id}: invalid reason code")
    require(expected["controlling_policy_id"] in POLICY_IDS, f"{case_id}: invalid policy id")
    require(type(expected["injection_detected"]) is bool, f"{case_id}: injection flag must be boolean")

    if decision == "escalate":
        require(amount is None, f"{case_id}: escalation amount must be null")
        require(
            expected["reason_code"] in {"RISK_ESCALATION", "FX_MISSING"},
            f"{case_id}: escalation reason is inconsistent",
        )
    else:
        require(type(amount) in {int, float}, f"{case_id}: amount must be numeric")
        require(amount >= 0, f"{case_id}: amount must be non-negative")
        require(round(amount, 2) == amount, f"{case_id}: amount exceeds two decimals")
        require((decision == "deny") == (amount == 0), f"{case_id}: deny/zero invariant failed")
        require((decision in {"approve", "partial"}) == (amount > 0), f"{case_id}: positive amount invariant failed")


def main() -> None:
    for path in (SPEC_PATH, POLICY_PATH, CASES_PATH):
        require(path.is_file(), f"missing eval file: {path}")
        require(path.stat().st_size > 0, f"empty eval file: {path}")

    dataset = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    require(dataset.get("version") == 1, "dataset version must be 1")
    cases = dataset.get("cases")
    require(isinstance(cases, list) and len(cases) == 12, "eval must contain exactly 12 cases")

    case_ids: list[str] = []
    injection_count = 0
    for index, case in enumerate(cases, start=1):
        require(isinstance(case, dict), f"case {index}: must be an object")
        require(
            set(case) == {"case_id", "tags", "injection_case", "case_text", "expected"},
            f"case {index}: unexpected or missing fields",
        )
        case_id = case["case_id"]
        require(isinstance(case_id, str) and case_id, f"case {index}: invalid case_id")
        case_ids.append(case_id)
        require(isinstance(case["tags"], list) and case["tags"], f"{case_id}: tags must be non-empty")
        require(isinstance(case["case_text"], str) and case["case_text"].strip(), f"{case_id}: empty case text")
        require(type(case["injection_case"]) is bool, f"{case_id}: injection_case must be boolean")
        validate_expected(case_id, case["expected"])
        require(
            case["injection_case"] == case["expected"]["injection_detected"],
            f"{case_id}: injection label and expected output disagree",
        )
        injection_count += int(case["injection_case"])

    require(len(set(case_ids)) == 12, "case_id values must be unique")
    require(injection_count == 3, "eval must contain exactly three injection cases")

    print("Frozen eval validation: PASS")
    print(f"Cases: {len(cases)} ({injection_count} injection, {len(cases) - injection_count} non-injection)")
    for path in (SPEC_PATH, POLICY_PATH, CASES_PATH):
        print(f"{path.relative_to(ROOT)} sha256={sha256(path)}")


if __name__ == "__main__":
    main()
