// The human approver. Shows the proposed remittance and fraud assessment, then records the decision.
// Usage: npm run approve -- <claim-id> [approve|reject --by <name> [--note <text>]] [--run <run-id>]
// Without a decision it only shows the claim. --run names a scenario run's ledger.

import { parseArgs } from "node:util";
import type { ClaimRecord } from "../src/ledger.ts";
import { call } from "./client.ts";

const { positionals, values } = parseArgs({ allowPositionals: true, options: { by: { type: "string" }, note: { type: "string" }, run: { type: "string" } } });
const [claimId, decision] = positionals;
if (!claimId || (decision && decision !== "approve" && decision !== "reject")) {
  console.error("Usage: npm run approve -- <claim-id> [approve|reject --by <name> [--note <text>]] [--run <run-id>]");
  process.exit(2);
}

const run = values.run ? `?runId=${encodeURIComponent(values.run)}` : "";
const aed = (fils: number): string => (fils / 100).toFixed(2);
const { claim } = await call<{ claim: ClaimRecord }>("GET", `/claims/${encodeURIComponent(claimId)}${run}`);
console.log(`Claim ${claim.id} · member ${claim.memberId ?? "unknown"} · provider ${claim.providerId} · state ${claim.state}`);
for (const line of claim.adjudication?.lines ?? []) {
  console.log(`  ${line.activityId} ${line.code.padEnd(14)} gross ${aed(line.gross).padStart(8)}  member ${aed(line.patientShare).padStart(8)}  pay ${aed(line.paymentAmount).padStart(8)}  ${line.denialCode ?? ""} ${line.reason}`);
}
if (claim.adjudication) console.log(`  Total payment AED ${aed(claim.adjudication.totals.payment)}`);
if (claim.fraud) console.log(`  Fraud: ${claim.fraud.recommendation} (score ${claim.fraud.score}) · ${claim.fraud.summary}`);
if (claim.error) console.log(`  Error: ${claim.error}`);

if (decision) {
  if (!values.by?.trim()) {
    console.error("--by <name> is required to record a decision.");
    process.exit(2);
  }
  const result = await call<{ state: string }>("POST", `/claims/${encodeURIComponent(claimId)}/approval${run}`, { decision, by: values.by, note: values.note });
  console.log(`Recorded ${decision} by ${values.by}; claim is ${result.state}. Payment follows only an approval.`);
}
