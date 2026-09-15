#!/usr/bin/env node
/** Validate the frozen policy-adjudication evaluation before any model run. */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, relative } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CASES_PATH,
  DECISIONS,
  POLICY_IDS,
  POLICY_PATH,
  REASON_CODES,
  REQUIRED_FIELDS,
  ROOT,
  SPEC_PATH,
  file_sha256,
  requireCondition,
} from "./benchmark.ts";

function isPlainObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameKeys(value: Record<string, any>, expected: string[]): boolean {
  const keys = Object.keys(value);
  const expectedSet = new Set(expected);
  return keys.length === expectedSet.size && keys.every((key) => expectedSet.has(key));
}

export function validate_expected(caseId: string, expected: unknown): void {
  requireCondition(isPlainObject(expected), `${caseId}: expected must be an object`);
  requireCondition(
    sameKeys(expected, REQUIRED_FIELDS),
    `${caseId}: expected fields differ from schema`,
  );

  const decision = expected.decision;
  const amount = expected.reimbursable_amount_usd;
  requireCondition(DECISIONS.includes(decision), `${caseId}: invalid decision`);
  requireCondition(REASON_CODES.includes(expected.reason_code), `${caseId}: invalid reason code`);
  requireCondition(
    POLICY_IDS.includes(expected.controlling_policy_id),
    `${caseId}: invalid policy id`,
  );
  requireCondition(
    typeof expected.injection_detected === "boolean",
    `${caseId}: injection flag must be boolean`,
  );

  if (decision === "escalate") {
    requireCondition(amount === null, `${caseId}: escalation amount must be null`);
    requireCondition(
      expected.reason_code === "RISK_ESCALATION" || expected.reason_code === "FX_MISSING",
      `${caseId}: escalation reason is inconsistent`,
    );
  } else {
    requireCondition(typeof amount === "number", `${caseId}: amount must be numeric`);
    requireCondition(amount >= 0, `${caseId}: amount must be non-negative`);
    requireCondition(
      Math.round(amount * 100) / 100 === amount,
      `${caseId}: amount exceeds two decimals`,
    );
    requireCondition(
      (decision === "deny") === (amount === 0),
      `${caseId}: deny/zero invariant failed`,
    );
    requireCondition(
      (decision === "approve" || decision === "partial") === (amount > 0),
      `${caseId}: positive amount invariant failed`,
    );
  }
}

export function main(): void {
  const program = basename(process.argv[1] ?? "validate_eval.ts");
  for (const argument of process.argv.slice(2)) {
    if (argument === "-h" || argument === "--help") {
      console.log(`usage: ${program} [-h]`);
      process.exit(0);
    }
    console.error(`usage: ${program} [-h]`);
    console.error(`${program}: error: unrecognized arguments: ${argument}`);
    process.exit(2);
  }

  for (const path of [SPEC_PATH, POLICY_PATH, CASES_PATH]) {
    requireCondition(existsSync(path), `missing eval file: ${path}`);
    requireCondition(statSync(path).size > 0, `empty eval file: ${path}`);
  }

  const dataset = JSON.parse(readFileSync(CASES_PATH, "utf8"));
  requireCondition(dataset.version === 1, "dataset version must be 1");
  const cases = dataset.cases;
  requireCondition(
    Array.isArray(cases) && cases.length === 12,
    "eval must contain exactly 12 cases",
  );

  const caseIds: string[] = [];
  let injectionCount = 0;
  for (const [index, benchmarkCase] of cases.entries()) {
    requireCondition(isPlainObject(benchmarkCase), `case ${index + 1}: must be an object`);
    requireCondition(
      sameKeys(benchmarkCase, [
        "case_id",
        "tags",
        "injection_case",
        "case_text",
        "expected",
      ]),
      `case ${index + 1}: unexpected or missing fields`,
    );
    const caseId = benchmarkCase.case_id;
    requireCondition(
      typeof caseId === "string" && caseId.length > 0,
      `case ${index + 1}: invalid case_id`,
    );
    caseIds.push(caseId);
    requireCondition(
      Array.isArray(benchmarkCase.tags) && benchmarkCase.tags.length > 0,
      `${caseId}: tags must be non-empty`,
    );
    requireCondition(
      typeof benchmarkCase.case_text === "string" && benchmarkCase.case_text.trim().length > 0,
      `${caseId}: empty case text`,
    );
    requireCondition(
      typeof benchmarkCase.injection_case === "boolean",
      `${caseId}: injection_case must be boolean`,
    );
    validate_expected(caseId, benchmarkCase.expected);
    requireCondition(
      benchmarkCase.injection_case === benchmarkCase.expected.injection_detected,
      `${caseId}: injection label and expected output disagree`,
    );
    injectionCount += Number(benchmarkCase.injection_case);
  }

  requireCondition(new Set(caseIds).size === 12, "case_id values must be unique");
  requireCondition(injectionCount === 3, "eval must contain exactly three injection cases");

  console.log("Frozen eval validation: PASS");
  console.log(
    `Cases: ${cases.length} (${injectionCount} injection, ` +
      `${cases.length - injectionCount} non-injection)`,
  );
  for (const path of [SPEC_PATH, POLICY_PATH, CASES_PATH]) {
    console.log(`${relative(ROOT, path)} sha256=${file_sha256(path)}`);
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
