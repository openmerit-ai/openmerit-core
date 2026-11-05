// Seeds the ledger, submits every fixture enrollment and claim, waits for each to reach human
// approval (or fail), and scores the agents against the fixtures' expected outcomes. Scores are
// also sent to Langfuse when LANGFUSE_* are set, on the trace of the agent being scored.
// Usage: npm run scenarios -- [--only <fixture-name>] [--timeout-minutes 20]
//          [--model openrouter/<id>] [--out results.json]
// --model runs every agent on one model, to compare Scout's candidates; without it each agent uses
// its recorded choice in src/models.ts. --out writes each check plus model cost and latency from Langfuse.

import { parseArgs } from "node:util";
import { CLAIM_FIXTURES, ENROLLMENT_FIXTURES } from "../fixtures/claims.ts";
import { toClaimSubmissionXml } from "../src/domain/eclaim.ts";
import type { Member } from "../src/domain/types.ts";
import type { ClaimRecord, EnrollmentRecord } from "../src/ledger.ts";
import { type LangfuseEnv, postScore, runKey, traceIdFor, VERSIONS } from "../src/tracing.ts";
import { baseUrl, call } from "./client.ts";

const { values } = parseArgs({ options: { only: { type: "string" }, "timeout-minutes": { type: "string", default: "20" }, model: { type: "string" }, out: { type: "string" } } });
const model = values.model ? { provider: values.model.split("/")[0] as "openrouter" | "cloudflare", id: values.model.split("/").slice(1).join("/") } : undefined;
const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const deadline = Date.now() + Number(values["timeout-minutes"]) * 60_000;
const claims = CLAIM_FIXTURES.filter((fixture) => !values.only || fixture.name === values.only);
const enrollments = ENROLLMENT_FIXTURES.filter((fixture) => !values.only || fixture.name === values.only);
const langfuse: LangfuseEnv = {
  LANGFUSE_PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY,
  LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY,
  LANGFUSE_BASE_URL: process.env.LANGFUSE_BASE_URL ?? "https://us.cloud.langfuse.com",
  LANGFUSE_ENVIRONMENT: "playground",
};

console.log(`Model ${values.model ?? "recorded choices (src/models.ts)"}`);
console.log(`Run ${runId} against ${baseUrl} · openmerit@${VERSIONS.openmerit} · agents@${VERSIONS.agents} · pi@${VERSIONS.pi}`);
await call("POST", "/admin/seed");

for (const fixture of enrollments) await call("POST", "/enrollments", { application: fixture.application, runId, model });
for (const fixture of claims) {
  const xml = toClaimSubmissionXml(fixture.claim, { senderId: fixture.claim.providerId, receiverId: fixture.claim.payerId, transactionDate: fixture.claim.activities[0]!.start, dispositionFlag: "TEST" });
  await call("POST", "/claims", { xml, bill: fixture.bill, runId, model });
}

const settledClaim = (record: ClaimRecord): boolean => ["awaiting_approval", "error", "approved", "rejected", "paid"].includes(record.state);
let claimRecords: ClaimRecord[] = [];
let enrollmentRecords: (EnrollmentRecord | null)[] = [];
while (Date.now() < deadline) {
  claimRecords = await call<ClaimRecord[]>("GET", `/claims?runId=${encodeURIComponent(runId)}`);
  enrollmentRecords = await Promise.all(enrollments.map(async (fixture) => (await call<{ enrollment: EnrollmentRecord | null }>("GET", `/enrollments/${fixture.application.applicationId}`)).enrollment));
  const done = claimRecords.filter(settledClaim).length + enrollmentRecords.filter((record) => record && record.decision !== "pending").length;
  process.stdout.write(`\r${done}/${claims.length + enrollments.length} settled`);
  if (done === claims.length + enrollments.length) break;
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
process.stdout.write("\n");

async function score(caseId: string, agent: string, name: string, value: number, comment: string): Promise<void> {
  try {
    await postScore(langfuse, { traceId: await traceIdFor(`${runKey(caseId, runId)}/${agent}`), name, value, dataType: "BOOLEAN", comment });
  } catch (error) {
    console.error(`Could not send score ${name} for ${caseId}: ${error instanceof Error ? error.message : error}`);
  }
}

let correct = 0;
let total = 0;
const results: { caseId: string; agent: string; check: string; pass: boolean; comment: string }[] = [];
const check = async (caseId: string, agent: string, name: string, pass: boolean, comment: string): Promise<boolean> => {
  total += 1;
  if (pass) correct += 1;
  results.push({ caseId, agent, check: name, pass, comment });
  await score(caseId, agent, name, pass ? 1 : 0, comment);
  return pass;
};

for (const fixture of enrollments) {
  const { enrollment: record, member } = await call<{ enrollment: EnrollmentRecord | null; member: Member | null }>("GET", `/enrollments/${fixture.application.applicationId}`);
  const id = fixture.application.applicationId;
  const decisionOk = await check(id, "enrollment", "enrollment-decision-correct", record?.decision === fixture.expected.decision, `expected ${fixture.expected.decision}, got ${record?.decision ?? "none"}`);
  let conditions = "";
  if (fixture.expected.decision === "enrolled") {
    const declared = member?.declaredConditions ?? [];
    const ok = await check(id, "enrollment", "declared-conditions-found", fixture.expected.declaredConditions.every((code) => declared.some((item) => item.startsWith(code))), `declared ${declared.join(", ") || "none"}; expected ${fixture.expected.declaredConditions.join(", ")}`);
    conditions = ` · conditions ${declared.join(", ") || "none"} ${ok ? "✓" : "✗"}`;
  }
  console.log(`${decisionOk ? "✓" : "✗"} enrollment ${fixture.name}: ${record?.decision ?? "no decision"}${conditions}`);
}

for (const fixture of claims) {
  const record = claimRecords.find((item) => item.id === fixture.claim.id);
  if (!record || record.state === "error" || !record.adjudication) {
    total += 1;
    results.push({ caseId: fixture.claim.id, agent: "pipeline", check: "claim-settled", pass: false, comment: record?.error ?? record?.state ?? "not found" });
    console.log(`✗ ${fixture.name}: ${record ? `${record.state}${record.error ? ` (${record.error})` : ""}` : "not found"}`);
    continue;
  }
  const lineResults = Object.entries(fixture.expected.lines).map(([activityId, outcome]) => {
    const line = record.adjudication?.lines.find((item) => item.activityId === activityId);
    const ok = outcome === "pay" ? !!line && !line.denialCode : !!line?.denialCode && outcome.includes(line.denialCode as (typeof outcome)[number]);
    return { activityId, ok, got: line?.denialCode ?? "pay", expected: outcome === "pay" ? "pay" : outcome.join("|") };
  });
  const decisions = await check(record.id, "adjudication", "line-decisions-correct", lineResults.every((item) => item.ok), lineResults.map((item) => `${item.activityId}: ${item.got} (expected ${item.expected})`).join("; "));
  const fraud = await check(record.id, "fraud", "fraud-recommendation-correct", !!record.fraud && fixture.expected.fraud.includes(record.fraud.recommendation), `got ${record.fraud?.recommendation}, expected ${fixture.expected.fraud.join("|")}`);
  const notes: string[] = [];
  if (fixture.expected.billMismatch) {
    const ok = await check(record.id, "intake", "bill-mismatch-found", (record.extraction?.mismatches.length ?? 0) > 0, record.extraction?.mismatches.join("; ") ?? "");
    notes.push(`mismatch ${ok ? "✓" : "✗"}`);
  }
  if (fixture.expected.codingFinding) {
    const ok = await check(record.id, "coding", "coding-finding-found", !!record.coding?.findings.some((item) => item.kind === fixture.expected.codingFinding), JSON.stringify(record.coding?.findings ?? []));
    notes.push(`${fixture.expected.codingFinding} ${ok ? "✓" : "✗"}`);
  }
  const paid = record.adjudication.totals.payment / 100;
  console.log(`${decisions && fraud ? "✓" : "✗"} ${fixture.name}: lines ${decisions ? "✓" : "✗"} · fraud ${record.fraud?.recommendation} ${fraud ? "✓" : "✗"} · pay AED ${paid.toFixed(2)} (expected ${(fixture.expected.payment / 100).toFixed(2)})${notes.length ? ` · ${notes.join(" · ")}` : ""}`);
  for (const item of lineResults.filter((result) => !result.ok)) console.log(`    ${item.activityId}: got ${item.got}, expected ${item.expected}`);
}

// Model cost and latency per agent run, from the run's Langfuse traces.
const usage: { caseId: string; agent: string; cost: number; seconds: number; generations: number }[] = [];
if (langfuse.LANGFUSE_PUBLIC_KEY && langfuse.LANGFUSE_SECRET_KEY) {
  const authorization = `Basic ${btoa(`${langfuse.LANGFUSE_PUBLIC_KEY}:${langfuse.LANGFUSE_SECRET_KEY}`)}`;
  const runs = [...enrollments.map((fixture) => [fixture.application.applicationId, "enrollment"] as const), ...claims.flatMap((fixture) => ["intake", "coding", "adjudication", "fraud"].map((agent) => [fixture.claim.id, agent] as const))];
  for (const [caseId, agent] of runs) {
    const traceId = await traceIdFor(`${runKey(caseId, runId)}/${agent}`);
    const response = await fetch(`${langfuse.LANGFUSE_BASE_URL}/api/public/v2/observations?traceId=${traceId}&fields=core,basic,usage`, { headers: { authorization } });
    if (!response.ok) continue;
    const { data } = (await response.json()) as { data: { type: string; totalCost?: number | null; latency?: number | null }[] };
    const generations = data.filter((item) => item.type === "GENERATION");
    usage.push({ caseId, agent, cost: generations.reduce((sum, item) => sum + (item.totalCost ?? 0), 0), seconds: data.find((item) => item.type === "AGENT")?.latency ?? 0, generations: generations.length });
  }
  const cost = usage.reduce((sum, item) => sum + item.cost, 0);
  const caseSeconds = new Map<string, number>();
  for (const item of usage) caseSeconds.set(item.caseId, (caseSeconds.get(item.caseId) ?? 0) + item.seconds);
  const perCase = [...caseSeconds.values()].sort((a, b) => a - b);
  console.log(`Model cost USD ${cost.toFixed(4)} over ${usage.length} agent runs · median case ${(perCase[Math.floor(perCase.length / 2)] ?? 0).toFixed(1)} s of agent time`);
}
if (values.out) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(values.out, `${JSON.stringify({ runId, model: values.model ?? null, versions: VERSIONS, correct, total, results, usage }, null, 2)}\n`);
}

console.log(`\n${correct}/${total} checks passed. Run ID ${runId}; claims now await approval: npm run approve -- <claim-id>`);
