// Seeds the ledger, submits every fixture enrollment and claim, waits for each to reach human
// approval (or fail), and scores the run at three levels in Langfuse when LANGFUSE_* are set:
// - task: the Worker posts model-calls, rejected-tool-calls and result-recorded on every agent trace;
// - agent: this runner posts each agent's checks (line-decisions-correct, ...) on that agent's trace;
// - environment: this runner posts claim-correct, payment-correct and review-load on the claim's
//   final agent trace (fraud, or the agent that failed), which is also the claim's experiment item,
//   and enrollment-correct on the enrollment agent's trace, which is the application's experiment item.
// Claims run as an experiment (dataset run) on Sahra's `sahra-outpatient-claims` dataset and
// enrollments on `sahra-enrollments`, both upserted by this runner first.
// Usage: npm run scenarios -- [--only <fixture-name>] [--timeout-minutes 20]
//          [--model openrouter/<id> | --model intake=openrouter/<id>,coding=openrouter/<id>] [--out results.json]
// --model runs every agent, or only the named agents, on another model to compare Scout's candidates;
// agents not named use their recorded choice in src/models.ts. --out writes each check, the claim
// outcomes, and model cost and latency from Langfuse.

import { parseArgs } from "node:util";
import { CLAIM_FIXTURES, ENROLLMENT_FIXTURES } from "../fixtures/claims.ts";
import { toClaimSubmissionXml } from "../src/domain/eclaim.ts";
import type { Member } from "../src/domain/types.ts";
import type { ClaimRecord, EnrollmentRecord } from "../src/ledger.ts";
import { type AgentRole, effectiveModels, overridesLabel, parseModelFlag } from "../src/models.ts";
import { type ExperimentContext, type LangfuseEnv, postScore, runKey, spanIdFor, traceIdFor, VERSIONS } from "../src/tracing.ts";
import { baseUrl, call } from "./client.ts";

const DATASET = "sahra-outpatient-claims";
const ENROLLMENT_DATASET = "sahra-enrollments";

const { values } = parseArgs({ options: { only: { type: "string" }, "timeout-minutes": { type: "string", default: "20" }, model: { type: "string" }, out: { type: "string" } } });
const models = parseModelFlag(values.model);
const runModels = effectiveModels(models);
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
const authorization = langfuse.LANGFUSE_PUBLIC_KEY && langfuse.LANGFUSE_SECRET_KEY ? `Basic ${btoa(`${langfuse.LANGFUSE_PUBLIC_KEY}:${langfuse.LANGFUSE_SECRET_KEY}`)}` : null;

/** Calls the Langfuse public API, waiting out rate limits (429). Returns null for 404 when allowed. */
async function langfuseApi<T>(method: string, path: string, body?: unknown, options: { allowNotFound?: boolean } = {}): Promise<T | null> {
  if (!authorization) throw new Error("Langfuse keys are not set");
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${langfuse.LANGFUSE_BASE_URL}${path}`, {
      method,
      headers: { authorization, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 429 && attempt < 6) {
      const seconds = Number(response.headers.get("retry-after")) || 5 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      continue;
    }
    if (response.status === 404 && options.allowNotFound) return null;
    const text = await response.text();
    if (!response.ok) throw new Error(`Langfuse ${method} ${path} → ${response.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  }
}

const submissionXml = (fixture: (typeof CLAIM_FIXTURES)[number]): string =>
  toClaimSubmissionXml(fixture.claim, { senderId: fixture.claim.providerId, receiverId: fixture.claim.payerId, transactionDate: fixture.claim.activities[0]!.start, dispositionFlag: "TEST" });

type DatasetItem = { id: string; input: unknown; expectedOutput: unknown; metadata: Record<string, string> };

/** Upserts one of Sahra's datasets and its items (item ID = claim or application ID), and returns the dataset ID. */
async function ensureDataset(name: string, description: string, items: DatasetItem[]): Promise<string> {
  const dataset =
    (await langfuseApi<{ id: string }>("GET", `/api/public/v2/datasets/${encodeURIComponent(name)}`, undefined, { allowNotFound: true })) ??
    (await langfuseApi<{ id: string }>("POST", "/api/public/v2/datasets", { name, description, metadata: { owner: "Sahra Health", plan: "Sahra Essential" } }));
  if (!dataset?.id) throw new Error(`Langfuse returned no ID for dataset ${name}`);
  for (const item of items) await langfuseApi("POST", "/api/public/dataset-items", { datasetName: name, ...item });
  return dataset.id;
}

let experiment: ExperimentContext | undefined;
let enrollmentExperiment: ExperimentContext | undefined;
if (authorization) {
  const datasetId = await ensureDataset(
    DATASET,
    "Sahra Health outpatient claims under Sahra Essential: one item per fixture claim, with the outcome a correct pipeline produces.",
    CLAIM_FIXTURES.map((fixture) => ({ id: fixture.claim.id, input: { name: fixture.name, description: fixture.description, xml: submissionXml(fixture), bill: fixture.bill }, expectedOutput: fixture.expected, metadata: { fixture: fixture.name } })),
  );
  const enrollmentDatasetId = await ensureDataset(
    ENROLLMENT_DATASET,
    "Sahra Health enrollment applications under Sahra Essential: one item per fixture application, with the eligibility decision and declared conditions a correct enrollment agent records.",
    ENROLLMENT_FIXTURES.map((fixture) => ({ id: fixture.application.applicationId, input: { name: fixture.name, application: fixture.application }, expectedOutput: fixture.expected, metadata: { fixture: fixture.name } })),
  );
  const name = `${overridesLabel(models)}-${runId}`;
  const metadata = { openmerit_version: VERSIONS.openmerit, ...Object.fromEntries(Object.entries(runModels).map(([role, model]) => [`model_${role}`, model])) };
  experiment = { id: runId, name, datasetId, metadata };
  enrollmentExperiment = { id: `${runId}--enrollments`, name, datasetId: enrollmentDatasetId, metadata };
}

console.log(`Models ${Object.entries(runModels).map(([role, model]) => `${role}=${model}${models[role as AgentRole] ? "" : " (recorded)"}`).join(", ")}`);
console.log(`Run ${runId} against ${baseUrl} · openmerit@${VERSIONS.openmerit} · agents@${VERSIONS.agents} · pi@${VERSIONS.pi}`);
if (experiment) console.log(`Datasets ${DATASET}, ${ENROLLMENT_DATASET} · experiment ${experiment.name}`);
await call("POST", "/admin/seed");

for (const fixture of enrollments) await call("POST", "/enrollments", { application: fixture.application, runId, models, experiment: enrollmentExperiment });
for (const fixture of claims) await call("POST", "/claims", { xml: submissionXml(fixture), bill: fixture.bill, runId, models, experiment });

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

async function score(caseId: string, agent: string, name: string, value: number, comment: string, onRoot = false): Promise<void> {
  try {
    const key = `${runKey(caseId, runId)}/${agent}`;
    const environment = onRoot ? { observationId: await spanIdFor(`${key}/agent`), metadata: { level: "environment", agent } } : {};
    await postScore(langfuse, { traceId: await traceIdFor(key), name, value, dataType: "BOOLEAN", comment, ...environment });
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
  const passed: boolean[] = [];
  const decisionOk = await check(id, "enrollment", "enrollment-decision-correct", record?.decision === fixture.expected.decision, `expected ${fixture.expected.decision}, got ${record?.decision ?? "none"}`);
  let conditions = "";
  if (fixture.expected.decision === "enrolled") {
    const declared = member?.declaredConditions ?? [];
    const ok = await check(id, "enrollment", "declared-conditions-found", fixture.expected.declaredConditions.every((code) => declared.some((item) => item.startsWith(code))), `declared ${declared.join(", ") || "none"}; expected ${fixture.expected.declaredConditions.join(", ")}`);
    conditions = ` · conditions ${declared.join(", ") || "none"} ${ok ? "✓" : "✗"}`;
    passed.push(ok);
  }
  passed.push(decisionOk);
  // Environment level: the application's one agent trace is its experiment item, as a claim's final agent trace is.
  await score(id, "enrollment", "enrollment-correct", passed.every(Boolean) ? 1 : 0, `${passed.filter(Boolean).length}/${passed.length} checks passed`, true);
  console.log(`${decisionOk ? "✓" : "✗"} enrollment ${fixture.name}: ${record?.decision ?? "no decision"}${conditions}`);
}

/** The claim's last agent run: fraud, or the first agent that did not record its result (as in ClaimFlow). */
const finalAgent = (record: ClaimRecord): AgentRole => (!record.extraction ? "intake" : !record.coding ? "coding" : !record.adjudication ? "adjudication" : "fraud");

// Environment-level outcome of each claim, posted on its final agent trace's root observation.
const outcomes: { caseId: string; trace: AgentRole; claimCorrect: boolean; paymentCorrect: boolean; reviewLoad: boolean | null }[] = [];
async function postOutcome(record: ClaimRecord, claimCorrect: boolean, paymentCorrect: boolean, reviewLoad: boolean | null, comments: { claim: string; payment: string; review?: string }): Promise<void> {
  const agent = finalAgent(record);
  outcomes.push({ caseId: record.id, trace: agent, claimCorrect, paymentCorrect, reviewLoad });
  await score(record.id, agent, "claim-correct", claimCorrect ? 1 : 0, comments.claim, true);
  await score(record.id, agent, "payment-correct", paymentCorrect ? 1 : 0, comments.payment, true);
  if (reviewLoad !== null) await score(record.id, agent, "review-load", reviewLoad ? 1 : 0, comments.review ?? "", true);
}

for (const fixture of claims) {
  const record = claimRecords.find((item) => item.id === fixture.claim.id);
  const expectedPayment = (fixture.expected.payment / 100).toFixed(2);
  if (!record || record.state === "error" || !record.adjudication) {
    total += 1;
    results.push({ caseId: fixture.claim.id, agent: "pipeline", check: "claim-settled", pass: false, comment: record?.error ?? record?.state ?? "not found" });
    const state = record ? `${record.state}${record.error ? ` (${record.error})` : ""}` : "not found";
    if (record) await postOutcome(record, false, false, null, { claim: `claim did not settle: ${state}`, payment: `no adjudication; expected AED ${expectedPayment}` });
    console.log(`✗ ${fixture.name}: ${state}`);
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
  const passed = [decisions, fraud];
  if (fixture.expected.billMismatch) {
    const ok = await check(record.id, "intake", "bill-mismatch-found", (record.extraction?.mismatches.length ?? 0) > 0, record.extraction?.mismatches.join("; ") ?? "");
    passed.push(ok);
    notes.push(`mismatch ${ok ? "✓" : "✗"}`);
  }
  if (fixture.expected.codingFinding) {
    const ok = await check(record.id, "coding", "coding-finding-found", !!record.coding?.findings.some((item) => item.kind === fixture.expected.codingFinding), JSON.stringify(record.coding?.findings ?? []));
    passed.push(ok);
    notes.push(`${fixture.expected.codingFinding} ${ok ? "✓" : "✗"}`);
  }
  const paid = (record.adjudication.totals.payment / 100).toFixed(2);
  const paymentOk = record.adjudication.totals.payment === fixture.expected.payment;
  const recommendation = record.fraud?.recommendation;
  const onlyPay = fixture.expected.fraud.length === 1 && fixture.expected.fraud[0] === "pay";
  await postOutcome(record, passed.every(Boolean), paymentOk, record.fraud ? onlyPay && recommendation !== "pay" : null, {
    claim: `${passed.filter(Boolean).length}/${passed.length} checks passed`,
    payment: `pay AED ${paid}, expected AED ${expectedPayment}`,
    review: `fraud recommended ${recommendation}; expected ${fixture.expected.fraud.join("|")}`,
  });
  console.log(`${decisions && fraud ? "✓" : "✗"} ${fixture.name}: lines ${decisions ? "✓" : "✗"} · fraud ${recommendation} ${fraud ? "✓" : "✗"} · pay AED ${paid} (expected ${expectedPayment}) ${paymentOk ? "✓" : "✗"}${notes.length ? ` · ${notes.join(" · ")}` : ""}`);
  for (const item of lineResults.filter((result) => !result.ok)) console.log(`    ${item.activityId}: got ${item.got}, expected ${item.expected}`);
}

// Model cost and latency per agent run, from the run's Langfuse traces.
const usage: { caseId: string; agent: string; cost: number; seconds: number; generations: number }[] = [];
if (authorization) {
  const runs = [...enrollments.map((fixture) => [fixture.application.applicationId, "enrollment"] as const), ...claims.flatMap((fixture) => (["intake", "coding", "adjudication", "fraud"] as const).map((agent) => [fixture.claim.id, agent] as const))];
  for (const [caseId, agent] of runs) {
    const traceId = await traceIdFor(`${runKey(caseId, runId)}/${agent}`);
    let data: { type: string; totalCost?: number | null; latency?: number | null }[];
    try {
      data = (await langfuseApi<{ data: typeof data }>("GET", `/api/public/v2/observations?traceId=${traceId}&fields=core,basic,usage`))?.data ?? [];
    } catch {
      continue;
    }
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
  writeFileSync(values.out, `${JSON.stringify({ runId, model: values.model ?? null, models: runModels, experiment: experiment?.name ?? null, versions: VERSIONS, correct, total, results, outcomes, usage }, null, 2)}\n`);
}

const count = (pick: (item: (typeof outcomes)[number]) => boolean | null): number => outcomes.filter((item) => pick(item) === true).length;
console.log(`\nClaims correct ${count((item) => item.claimCorrect)}/${claims.length} · payment correct ${count((item) => item.paymentCorrect)}/${claims.length} · review load ${count((item) => item.reviewLoad)}`);
console.log(`${correct}/${total} checks passed. Run ID ${runId}; claims now await approval: npm run approve -- <claim-id>`);
