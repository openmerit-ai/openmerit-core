#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { METRIC_CATALOG, OPENMERIT_SCHEMA_DIALECT } from "../packages/protocol/src/index.ts";
import { OpenMeritCoordinator, ProjectStore, verifyFrontierSnapshot } from "../packages/core/src/index.ts";

const BASELINE_MODEL = process.env.OPENMERIT_DEMO_BASELINE_MODEL ?? "openai/gpt-4.1-mini";
const CANDIDATE_MODELS = (process.env.OPENMERIT_DEMO_CANDIDATE_MODELS ?? "openai/gpt-4o-mini")
  .split(",").map((model) => model.trim()).filter(Boolean);
let CASES = [];
let objectives = [];
const REPETITIONS = Number.parseInt(process.env.OPENMERIT_DEMO_REPETITIONS ?? "2", 10);
const MAX_SPEND_USD = Number.parseFloat(process.env.OPENMERIT_DEMO_MAX_SPEND_USD ?? "1");
const PI_MODEL = process.env.OPENMERIT_DEMO_PI_MODEL ?? "openrouter/openai/gpt-4.1";
const DEMO_SEED = process.env.OPENMERIT_DEMO_SEED ?? randomUUID();
let RUN_COUNT = 0;
let APPLICATION_CALL_LIMIT = 0;
let randomState = [...DEMO_SEED].reduce((value, character) => Math.imul(value ^ character.charCodeAt(0), 16777619), 2166136261) >>> 0;

function randomUnit() {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState / 0x1_0000_0000;
}

function shuffle(items) {
  for (let index = items.length - 1; index > 0; index--) {
    const swapWith = Math.floor(randomUnit() * (index + 1));
    [items[index], items[swapWith]] = [items[swapWith], items[index]];
  }
  return items;
}

if (!Number.isInteger(REPETITIONS) || REPETITIONS < 2 || REPETITIONS > 5) {
  throw new Error("OPENMERIT_DEMO_REPETITIONS must be an integer from 2 to 5.");
}
if (CANDIDATE_MODELS.length < 1 || CANDIDATE_MODELS.length > 2 || CANDIDATE_MODELS.includes(BASELINE_MODEL)) {
  throw new Error("Configure one or two distinct OPENMERIT_DEMO_CANDIDATE_MODELS, excluding the baseline model.");
}
if (!Number.isFinite(MAX_SPEND_USD) || MAX_SPEND_USD <= 0 || MAX_SPEND_USD > 5) {
  throw new Error("OPENMERIT_DEMO_MAX_SPEND_USD must be greater than $0 and at most $5.");
}

const now = () => new Date().toISOString();
const sha = (value) => createHash("sha256").update(value).digest("hex");
const safeFile = (value) => value.replaceAll(/[^a-zA-Z0-9._-]/g, "-");
const targetId = "demo-sentiment-route";
const profileId = "demo-sentiment-profile";
const evidenceRoot = "artifacts";

function evidence(id, uri, source = "evaluation_artifact", digest) {
  return { id, source, uri, ...(digest ? { digest: `sha256:${digest}` } : {}) };
}

const descriptor = {
  id: "pi-demo-runner",
  name: "Pi with bounded OpenMerit demo executor",
  version: "0.1.0-demo",
  protocolVersions: ["0.1"],
  capabilities: [
    "user_confirmation", "evaluation_authoring", "observability_instrumentation", "production_observation",
    "candidate_discovery", "challenger_execution", "frontier_calculation", "model_mutation",
    "post_swap_verification", "rollback",
  ],
  executionModes: ["non_interactive"],
  structuredOutput: {
    schemaDialect: OPENMERIT_SCHEMA_DIALECT,
    presentation: "adapter_validation",
    enforcement: "adapter",
  },
  automation: {
    supportedSignals: ["product_task_completed", "metric_window_available", "scheduled_tick", "model_catalog_changed", "verification_window_completed"],
    persistentScheduling: false,
    backgroundExecution: false,
    wakeupProvisioning: "none",
  },
};

const adapter = { descriptor, async dispatch(intent) { return { accepted: true, harnessJobId: `demo-${intent.id}` }; } };

async function readOpenRouterKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const authPath = join(homedir(), ".pi", "agent", "auth.json");
  const auth = JSON.parse(await readFile(authPath, "utf8"));
  const key = auth.openrouter?.key;
  if (typeof key !== "string" || !key) {
    throw new Error(`No OpenRouter key found in ${authPath}; set OPENROUTER_API_KEY or run pi auth login --provider openrouter.`);
  }
  return key;
}

async function runPiBuild(appDir, repairRequest) {
  const prompt = [
    "Build a tiny Node.js ES-module sentiment-classifier application in this directory for an OpenMerit live demo.",
    "Create app.mjs exporting async function answer(input). The app must make a real POST request to https://openrouter.ai/api/v1/chat/completions.",
    "Use the model field from .openmerit-demo-route.json in this same directory when present, otherwise use the exported DEFAULT_MODEL constant openai/gpt-4.1-mini.",
    "Read the application credential only from process.env.OPENROUTER_API_KEY. Never print, return, save, or include the credential in errors.",
    "Input is {text}; ask the model to classify sentiment as exactly positive, neutral, or negative and return JSON {sentiment, rationale}.",
    "Use temperature 0, JSON response format, and the exact OpenRouter Chat Completions usage option usage: { include: true } (not a string). Return {model, result, usage, costUsd, startedAt, completedAt} using actual response values, including actual OpenRouter usage.cost. Throw on HTTP errors, absent usage/cost, invalid JSON, or missing sentiment. Do not fabricate metrics.",
    "Use only built-in Node modules. Add a one-line package.json setting type=module if useful. Do not create a web server, tests, README, or extra features.",
    "Also infer an evaluation plan from this specific app and create demo-plan.json with exactly: {taskName, goal, cases, metricRationales}. Provide 3 to 5 distinct representative input cases as {id, text, expected}; expected must be positive, neutral, or negative. metricRationales must include one {metricId, rationale} for each of task_success, task_quality, structured_output_reliability, input_token_consumption, output_token_consumption, end_to_end_task_latency, total_task_cost. Explain why each is relevant and observable here; do not claim unsupported telemetry. IMPORTANT: task_success means this application call returned a parseable response; task_quality is graded only by exact sentiment-label match. Rationale plausibility is NOT graded. The runner repeats each same case and independently measures provider usage/cost, timestamps, schema validity, call completion, and exact-label outcomes.",
    "Write the files now, then read them back and syntax-check app.mjs. Do not call the application provider during the build.",
    ...(repairRequest ? [repairRequest] : []),
  ].join("\n");
  const piEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "OPENROUTER_API_KEY"));
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("pi", ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--thinking", "off", "--model", PI_MODEL, "--tools", "read,write,edit,bash", "--print", "--", prompt], {
      cwd: appDir,
      stdio: "inherit",
      env: piEnvironment,
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 150_000);
    child.once("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Pi app-build turn ended (${signal ?? `exit ${code}`}).`));
    });
  });
}

async function readUsageData(key, models) {
  const response = await fetch("https://openrouter.ai/api/v1/models", { headers: { Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`OpenRouter model catalogue returned HTTP ${response.status}.`);
  const body = await response.json();
  const found = new Map(body.data.map((item) => [item.id, item]));
  for (const modelId of models) {
    if (!found.has(modelId)) throw new Error(`Requested model ${modelId} is not in the current OpenRouter catalogue.`);
    const pricing = found.get(modelId).pricing;
    if (!Number.isFinite(Number(pricing?.prompt)) || !Number.isFinite(Number(pricing?.completion))) {
      throw new Error(`OpenRouter did not provide usable catalogue pricing for ${modelId}.`);
    }
  }
  return Object.fromEntries(models.map((id) => [id, {
    inputPricePerToken: Number(found.get(id).pricing.prompt),
    outputPricePerToken: Number(found.get(id).pricing.completion),
    source: "https://openrouter.ai/api/v1/models",
    checkedAt: now(),
  }]));
}

async function callApplication(appDir, modelId, taskCase, key) {
  await writeFile(join(appDir, ".openmerit-demo-route.json"), `${JSON.stringify({ model: modelId }, null, 2)}\n`, { mode: 0o600 });
  const previous = process.env.OPENROUTER_API_KEY;
  const previousCwd = process.cwd();
  process.env.OPENROUTER_API_KEY = key;
  process.env.OPENMERIT_APP_MODEL_ID = modelId;
  try {
    process.chdir(appDir);
    const application = await import(`${new URL(`file://${join(appDir, "app.mjs")}`).href}?run=${randomUUID()}`);
    const answer = application.answer ?? application.default?.answer ?? application.default;
    if (typeof answer !== "function") throw new Error("Pi-built app must export answer(input) as a named or default function.");
    const result = await answer({ text: taskCase.text });
    if (result.model !== modelId) {
      const error = new Error(`Application used ${result.model}, expected ${modelId}.`);
      error.applicationCall = { modelId: result.model, costUsd: Number(result.costUsd) };
      throw error;
    }
    if (!result.usage || !Number.isFinite(Number(result.usage.prompt_tokens)) || !Number.isFinite(Number(result.usage.completion_tokens))) {
      throw new Error("Application did not return provider-reported input and output token counts.");
    }
    if (!Number.isFinite(Number(result.costUsd)) || Number(result.costUsd) < 0) {
      throw new Error("Application did not return provider-reported request cost.");
    }
    const parsed = typeof result.result === "string" ? JSON.parse(result.result) : result.result;
    if (!parsed || typeof parsed.sentiment !== "string") throw new Error("Application output is missing sentiment.");
    const allowed = new Set(["positive", "neutral", "negative"]);
    const schemaValid = allowed.has(parsed.sentiment.toLowerCase()) && typeof parsed.rationale === "string";
    const success = schemaValid;
    const quality = parsed.sentiment.toLowerCase() === taskCase.expected ? 1 : 0;
    const started = Date.parse(result.startedAt);
    const completed = Date.parse(result.completedAt);
    if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
      throw new Error("Application timestamps are invalid.");
    }
    return {
      runId: randomUUID(), caseId: taskCase.id, modelId, expected: taskCase.expected,
      actual: parsed.sentiment.toLowerCase(), schemaValid, success,
      quality,
      inputTokens: Number(result.usage.prompt_tokens), outputTokens: Number(result.usage.completion_tokens),
      costUsd: Number(result.costUsd), latencyMs: completed - started,
      startedAt: result.startedAt, completedAt: result.completedAt,
    };
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
    delete process.env.OPENMERIT_APP_MODEL_ID;
    process.chdir(previousCwd);
  }
}

async function sample(appDir, modelId, key, calls, spend) {
  const jobs = [];
  for (const taskCase of CASES) for (let repetition = 0; repetition < REPETITIONS; repetition++) {
    jobs.push({ taskCase, repetition });
  }
  shuffle(jobs);
  const rows = [];
  for (const [index, job] of jobs.entries()) {
    if (calls.count >= APPLICATION_CALL_LIMIT) throw new Error("Demo application-call limit reached.");
    const row = await callApplication(appDir, modelId, job.taskCase, key);
    calls.count++;
    spend.value += row.costUsd;
    if (spend.value > MAX_SPEND_USD) throw new Error(`Live API spend exceeded demo cap ($${MAX_SPEND_USD.toFixed(2)}).`);
    rows.push({ ...row, repetition: job.repetition + 1, order: index + 1 });
  }
  return rows;
}

async function sampleComparison(appDir, modelIds, key, calls, spend, runFile) {
  const jobs = [];
  for (const taskCase of CASES) for (let repetition = 0; repetition < REPETITIONS; repetition++) jobs.push({ taskCase, repetition });
  shuffle(jobs);
  const byModel = new Map(modelIds.map((modelId) => [modelId, []]));
  const chronological = [];
  for (const [index, job] of jobs.entries()) {
    const modelOrder = shuffle([...modelIds]);
    for (const [position, modelId] of modelOrder.entries()) {
      if (calls.count >= APPLICATION_CALL_LIMIT) throw new Error("Demo application-call limit reached.");
      const row = await callApplication(appDir, modelId, job.taskCase, key);
      calls.count++;
      spend.value += row.costUsd;
      if (spend.value > MAX_SPEND_USD) throw new Error(`Live API spend exceeded demo cap ($${MAX_SPEND_USD.toFixed(2)}).`);
      const compared = { ...row, repetition: job.repetition + 1, order: index + 1, randomizedModelOrder: position + 1 };
      byModel.get(modelId).push(compared);
      chronological.push(compared);
    }
  }
  await writeRows(artifactsDirFor(runFile), runFile, "challenger", chronological);
  const result = new Map();
  for (const [modelId, rows] of byModel) {
    const content = `${rows.map((row) => JSON.stringify({ ...row, stage: "challenger", recordedAt: now() })).join("\n")}\n`;
    const path = join(artifactsDirFor(runFile), `${safeFile(modelId)}-challenger.jsonl`);
    await writeFile(path, content, { mode: 0o600 });
    result.set(modelId, { rows, ref: evidence(`${safeFile(modelId)}-challenger`, `file://artifacts/${safeFile(modelId)}-challenger.jsonl`, "evaluation_artifact", sha(content)) });
  }
  return result;
}

function artifactsDirFor(runFile) {
  return dirname(runFile);
}

async function writeRows(artifactsDir, runFile, stage, rows) {
  const content = `${rows.map((row) => JSON.stringify({ ...row, stage, recordedAt: now() })).join("\n")}\n`;
  await writeFile(runFile, content, { flag: "a", mode: 0o600 });
  return content;
}

function aggregate(rows, modelId) {
  const mean = (key) => rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
  const rate = (predicate) => rows.filter(predicate).length / rows.length;
  return {
    task_success: rate((row) => row.success),
    task_quality: mean("quality"),
    structured_output_reliability: rate((row) => row.schemaValid),
    input_token_consumption: mean("inputTokens"),
    output_token_consumption: mean("outputTokens"),
    total_task_cost: rows.reduce((sum, row) => sum + row.costUsd, 0),
    end_to_end_task_latency: mean("latencyMs"),
    modelId,
  };
}

function buildObjectives(metricRationales) {
  const aggregations = new Map([
    ["task_success", "rate"], ["task_quality", "mean"], ["structured_output_reliability", "rate"],
    ["input_token_consumption", "mean"], ["output_token_consumption", "mean"],
    ["end_to_end_task_latency", "mean"], ["total_task_cost", "mean"],
  ]);
  return metricRationales.map(({ metricId, rationale }) => ({
    metricId, required: true, minimumSamples: RUN_COUNT, tolerance: 0,
    samplingPlan: {
      strategy: "repeated_representative_task_set", representativeCaseCount: CASES.length,
      repetitionsPerCase: REPETITIONS, aggregation: aggregations.get(metricId), rationale,
    },
    ...(metricId === "task_success" ? { constraint: { operator: "at_least", value: 2 / 3 } } : {}),
  }));
}

function validateDemoPlan(plan) {
  const labels = new Set(["positive", "neutral", "negative"]);
  if (!plan || typeof plan.taskName !== "string" || !plan.taskName.trim() || typeof plan.goal !== "string" || !plan.goal.trim()) {
    throw new Error("Pi's demo-plan.json must include a taskName and goal.");
  }
  if (!Array.isArray(plan.cases) || plan.cases.length < 3 || plan.cases.length > 5) {
    throw new Error("Pi's evaluation plan must include 3–5 representative cases.");
  }
  const caseIds = new Set();
  for (const item of plan.cases) {
    if (!item || typeof item.id !== "string" || !item.id || caseIds.has(item.id) || typeof item.text !== "string" || !item.text.trim() || !labels.has(item.expected)) {
      throw new Error("Pi's evaluation cases require unique IDs, non-empty text, and an expected sentiment label.");
    }
    caseIds.add(item.id);
  }
  const expectedMetrics = ["task_success", "task_quality", "structured_output_reliability", "input_token_consumption", "output_token_consumption", "end_to_end_task_latency", "total_task_cost"];
  if (!Array.isArray(plan.metricRationales)) throw new Error("Pi's evaluation plan must include metric rationales.");
  const seen = new Set();
  for (const item of plan.metricRationales) {
    if (!item || !expectedMetrics.includes(item.metricId) || typeof item.rationale !== "string" || !item.rationale.trim() || seen.has(item.metricId)) {
      throw new Error("Pi's metric plan includes an unsupported, duplicate, or unexplained metric.");
    }
    seen.add(item.metricId);
  }
  const missing = expectedMetrics.filter((metricId) => !seen.has(metricId));
  if (missing.length) throw new Error(`Pi's plan omitted metrics this demo can measure: ${missing.join(", ")}.`);
  const qualityRationale = plan.metricRationales.find((item) => item.metricId === "task_quality").rationale.toLowerCase();
  if (!/(exact|correct|label|match)/.test(qualityRationale) || /(rationale (quality|plausibility)|plausib|explanation quality|style quality)/.test(qualityRationale)) {
    throw new Error("The task_quality rationale must describe exact sentiment-label matching; rationale quality is not graded by this demo.");
  }
  const successRationale = plan.metricRationales.find((item) => item.metricId === "task_success").rationale.toLowerCase();
  if (!/(response|return|parse|complet)/.test(successRationale) || /exact.*label|label.*exact/.test(successRationale)) {
    throw new Error("The task_success rationale must describe a returned/parseable call; exact label correctness is measured separately as task_quality.");
  }
  return plan;
}

function records(rows, modelId, evidenceRef) {
  const values = aggregate(rows, modelId);
  const start = rows.map((row) => row.startedAt).sort()[0];
  const end = rows.map((row) => row.completedAt).sort().at(-1);
  const definitions = [
    ["task_success", "rate", "ratio", "evaluator"],
    ["task_quality", "mean", "score", "evaluator"],
    ["structured_output_reliability", "rate", "ratio", "evaluator"],
    ["input_token_consumption", "mean", "tokens", "observed"],
    ["output_token_consumption", "mean", "tokens", "observed"],
    ["end_to_end_task_latency", "mean", "milliseconds", "derived"],
    ["total_task_cost", "sum", "usd", "observed"],
  ];
  return definitions.map(([metricId, aggregation, unit, method]) => ({
    targetId, metricId, state: "measured", scope: "sample_window", direction: METRIC_CATALOG.find((item) => item.id === metricId).direction,
    method, aggregation, value: values[metricId], unit,
    sampleCount: rows.length, window: { startedAt: start, endedAt: end }, evidence: [evidenceRef],
    note: `Measured from ${rows.length} real OpenRouter-backed application calls using ${modelId}.`,
  }));
}

function intervalComparison(profile, left, right) {
  let better = false;
  let uncertain = false;
  for (const objective of profile.objectives) {
    const a = left.metrics.find((metric) => metric.metricId === objective.metricId);
    const b = right.metrics.find((metric) => metric.metricId === objective.metricId);
    if (!a || !b || a.value === undefined || b.value === undefined || a.unit !== b.unit) {
      return { state: "unresolved", reasons: [`${objective.metricId}: incompatible evidence`] };
    }
    const direction = METRIC_CATALOG.find((metric) => metric.id === objective.metricId)?.direction;
    if (direction === "maximize") {
      if (a.value + objective.tolerance < b.value) return { state: "does_not_dominate", reasons: [`${objective.metricId}: proven worse`] };
      if (a.value > b.value + objective.tolerance) better = true;
    } else {
      if (a.value > b.value + objective.tolerance) return { state: "does_not_dominate", reasons: [`${objective.metricId}: proven worse`] };
      if (a.value + objective.tolerance < b.value) better = true;
    }
    if (a.value !== b.value && Math.abs(a.value - b.value) <= objective.tolerance) uncertain = true;
  }
  if (uncertain) return { state: "unresolved", reasons: ["one or more objective intervals do not establish ordering"] };
  return better
    ? { state: "dominates", reasons: ["proven no worse on every measured objective and materially better on at least one"] }
    : { state: "does_not_dominate", reasons: ["no objective is materially better"] };
}

function makeFrontier(profile, assessments, manifest) {
  const comparisons = assessments.flatMap((candidate) => assessments.filter((other) => other !== candidate).map((other) => ({
    candidateId: candidate.candidateId, otherCandidateId: other.candidateId,
    ...intervalComparison(profile, candidate, other),
  })));
  const dominated = new Set(comparisons.filter((item) => item.state === "dominates").map((item) => item.otherCandidateId));
  const unresolved = new Set(comparisons.filter((item) => item.state === "unresolved").flatMap((item) => [item.candidateId, item.otherCandidateId]));
  const frontier = assessments.map((item) => item.candidateId).filter((id) => !dominated.has(id) && !unresolved.has(id));
  const snapshot = {
    id: `demo-frontier-${randomUUID()}`, targetId, taskProfileId: profile.id, taskProfileRevision: profile.revision,
    productRevision: assessments[0].productRevision, createdAt: now(), frontierCandidateIds: frontier,
    dominatedCandidateIds: [...dominated], ineligibleCandidateIds: [], unresolvedCandidateIds: [...unresolved],
    comparisons, assessmentIds: assessments.map((item) => item.id),
    calculationEvidence: [manifest],
  };
  const verification = verifyFrontierSnapshot(profile, assessments, snapshot);
  if (!verification.valid) throw new Error(`OpenMerit rejected calculated frontier: ${verification.errors.join("; ")}`);
  return snapshot;
}

async function main() {
  const key = await readOpenRouterKey();
  const root = await mkdtemp(join(tmpdir(), "openmerit-demo-"));
  const appDir = join(root, "app");
  const artifactsDir = join(root, evidenceRoot);
  await mkdir(appDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
  console.log(`Demo sandbox: ${root}`);
  console.log(`Pi is building a small LLM application with ${PI_MODEL}.`);
  await runPiBuild(appDir);
  const appPath = join(appDir, "app.mjs");
  await readFile(appPath, "utf8");
  const syntax = spawn("node", ["--check", appPath], { stdio: "inherit" });
  await new Promise((resolvePromise, rejectPromise) => {
    syntax.once("error", rejectPromise);
    syntax.once("exit", (code) => code === 0 ? resolvePromise() : rejectPromise(new Error("Pi-generated app failed its syntax check.")));
  });
  let planContent;
  let plan;
  try {
    planContent = await readFile(join(appDir, "demo-plan.json"), "utf8");
    plan = validateDemoPlan(JSON.parse(planContent));
  } catch (error) {
    console.log("Pi's first evaluation plan did not meet the bounded metric/case contract; asking Pi to complete it before any measured runs.");
    await runPiBuild(appDir, `Repair demo-plan.json so it is valid JSON with taskName and goal, 3–5 distinct cases [{id,text,expected}], and metricRationales [{metricId,rationale}] for exactly the supported metrics: task_success, task_quality, structured_output_reliability, input_token_consumption, output_token_consumption, end_to_end_task_latency, total_task_cost. For this sentiment classifier, expected labels must be positive, neutral, or negative. task_success means a parseable response returned; exact-label correctness is task_quality. task_quality must say it is graded only by exact sentiment-label matching; do not claim rationale plausibility, because the runner does not grade rationale text. Keep app.mjs unchanged and do not call the provider. Original validation: ${error instanceof Error ? error.message : String(error)}`);
    planContent = await readFile(join(appDir, "demo-plan.json"), "utf8");
    plan = validateDemoPlan(JSON.parse(planContent));
  }
  CASES = plan.cases;
  RUN_COUNT = CASES.length * REPETITIONS;
  APPLICATION_CALL_LIMIT = (CANDIDATE_MODELS.length + 3) * RUN_COUNT + 2;
  objectives = buildObjectives(plan.metricRationales);
  const planArtifact = `${JSON.stringify(plan, null, 2)}\n`;
  await writeFile(join(artifactsDir, "demo-plan.json"), planArtifact, { mode: 0o600 });
  const planEvidence = evidence("pi-inferred-evaluation-plan", "file://artifacts/demo-plan.json", "evaluation_artifact", sha(planArtifact));
  const allModels = [...new Set([BASELINE_MODEL, ...CANDIDATE_MODELS])];
  const catalogue = await readUsageData(key, allModels);
  const catalogueContent = `${JSON.stringify(catalogue, null, 2)}\n`;
  await writeFile(join(artifactsDir, "model-catalogue.json"), catalogueContent, { mode: 0o600 });
  const catalogueEvidence = evidence("openrouter-model-catalogue-snapshot", "file://artifacts/model-catalogue.json", "evaluation_artifact", sha(catalogueContent));
  const store = new ProjectStore(root);
  const coordinator = new OpenMeritCoordinator(store, adapter);
  const startTime = now();
  const state = {
    schemaVersion: 1,
    cycle: { id: `demo-cycle-${randomUUID()}`, stage: "unconfigured", verifiedSwapCount: 0, baselineEvidenceSufficient: false },
    automation: { setupNudgeShown: true, observedCompletedTasks: 0, lastAssessmentTaskCount: 0, processedSignalIds: [] },
    updatedAt: startTime,
  };
  await store.initialize({ schemaVersion: 1, taskProfiles: [] }, state);

  const profile = {
    id: profileId, revision: 1, name: plan.taskName,
    goal: plan.goal,
    applicationTarget: {
      id: targetId, kind: "application_llm_call", name: `Pi-built ${plan.taskName} route`,
      applicationId: "pi-openmerit-sandbox-demo", callSites: ["app/app.mjs#answer"], routeKey: ".openmerit-demo-route.json:model", confirmedAt: now(),
    },
    objectives,
    createdAt: now(), confirmedAt: now(),
  };
  const policy = {
    mode: "supervised_graduation", evaluationBudget: { currency: "USD", maximumSpend: MAX_SPEND_USD, maximumCandidateCount: allModels.length, maximumRunsPerCandidate: RUN_COUNT },
    automaticSwapsEnabled: true, confirmationRequiredUntilVerifiedSwaps: 0, requirePostSwapVerification: true,
    rollbackOnRegression: true,
    checkPolicy: {
      baselineAssessment: { afterCompletedTasks: RUN_COUNT },
      frontierReassessment: { afterCompletedTasks: 100, onModelCatalogChange: true },
      regressionCheck: { afterCompletedTasks: 100, thresholds: [{ metricId: "task_success", relativeChangeAtLeast: 0.15 }] },
      postSwapVerification: { afterCompletedTasks: RUN_COUNT }, cooldownSeconds: 0,
      execution: { mode: "active_session_only", infrastructureChangesAllowed: false },
    },
  };
  const incumbent = { targetId, candidateId: BASELINE_MODEL, modelId: BASELINE_MODEL, reasons: ["Initial sandbox application route; verified against the live model catalogue."] };
  const calls = { count: 0 };
  const spend = { value: 0 };
  const runFile = join(artifactsDir, "application-runs.jsonl");
  const setupIntent = await coordinator.issue("establish_evals", { additionalConstraints: { expectedIncumbentModelId: BASELINE_MODEL } });
  let smoke;
  try {
    smoke = await callApplication(appDir, CANDIDATE_MODELS[0], CASES[0], key);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Application used ")) throw error;
    calls.count++;
    spend.value += Number(error.applicationCall?.costUsd ?? 0);
    if (spend.value > MAX_SPEND_USD) throw new Error(`Live API spend exceeded demo cap ($${MAX_SPEND_USD.toFixed(2)}).`);
    await writeFile(join(artifactsDir, "setup-smoke-route-mismatch.json"), `${JSON.stringify({ expectedModel: CANDIDATE_MODELS[0], ...error.applicationCall, resultExcludedFromMetrics: true }, null, 2)}\n`, { mode: 0o600 });
    console.log("Pi-built route did not honor its route file on the first smoke call; asking Pi to repair that route before measuring.");
    await runPiBuild(appDir, "Repair the route selection bug in app.mjs. The smoke test wrote .openmerit-demo-route.json with a `model` field and answer() still used DEFAULT_MODEL. Ensure answer() asynchronously reads this file on every call (this module imports fs/promises, so use await fs.readFile; do not use readFileSync), and sends that selected model. Keep the exported DEFAULT_MODEL fallback. Do not call the application provider; syntax-check your repair.");
    const syntax = spawn("node", ["--check", appPath], { stdio: "inherit" });
    await new Promise((resolvePromise, rejectPromise) => {
      syntax.once("error", rejectPromise);
      syntax.once("exit", (code) => code === 0 ? resolvePromise() : rejectPromise(new Error("Pi route repair failed its syntax check.")));
    });
    smoke = await callApplication(appDir, CANDIDATE_MODELS[0], CASES[0], key);
  }
  calls.count++;
  spend.value += smoke.costUsd;
  if (spend.value > MAX_SPEND_USD) throw new Error(`Live API spend exceeded demo cap ($${MAX_SPEND_USD.toFixed(2)}).`);
  const smokeContent = `${JSON.stringify(smoke, null, 2)}\n`;
  await writeFile(join(artifactsDir, "setup-smoke.json"), smokeContent, { mode: 0o600 });
  await coordinator.acceptResult({
    protocolVersion: "0.1", intentId: setupIntent.intent.id, status: "succeeded", completedAt: now(),
    summary: "Pi-built app passed a live route-selection smoke call; repeated representative-task evaluation plan configured in a disposable sandbox.",
    evidence: [evidence("pi-built-app", "file://app/app.mjs", "harness_trace", sha(await readFile(appPath))), planEvidence, evidence("application-smoke", "file://artifacts/setup-smoke.json", "observability_record", sha(smokeContent))],
    outputs: {
      taskProfile: profile, incumbent, policy,
      observability: { targetId, status: "ready", requiredMetricIds: objectives.map((item) => item.metricId), coveredMetricIds: objectives.map((item) => item.metricId), missingMetricIds: [], checkedAt: now() },
      preliminaryModelLeads: CANDIDATE_MODELS.map((modelId) => ({ targetId, modelId, estimatedPrice: { currency: "USD", inputPerMillionTokens: Number(catalogue[modelId].inputPricePerToken) * 1_000_000, outputPerMillionTokens: Number(catalogue[modelId].outputPricePerToken) * 1_000_000, sourceUri: catalogue[modelId].source, checkedAt: catalogue[modelId].checkedAt }, reputation: { summary: "Current OpenRouter catalogue entry; reputation is not inferred in this bounded demo.", sourceUri: catalogue[modelId].source, checkedAt: catalogue[modelId].checkedAt } })),
    },
  });
  const runAndPersist = async (modelId, stage) => {
    const rows = await sample(appDir, modelId, key, calls, spend);
    const content = `${rows.map((row) => JSON.stringify({ ...row, stage, recordedAt: now() })).join("\n")}\n`;
    await writeRows(artifactsDir, runFile, stage, rows);
    const artifactName = `${safeFile(modelId)}-${stage}.jsonl`;
    await writeFile(join(artifactsDir, artifactName), content, { mode: 0o600 });
    return { rows, ref: evidence(`${safeFile(modelId)}-${stage}`, `file://artifacts/${artifactName}`, stage === "baseline" ? "observability_record" : "evaluation_artifact", sha(content)) };
  };

  console.log(`Pi inferred task: ${plan.taskName}. ${plan.goal}`);
  console.log(`Pi proposed ${objectives.length} metrics; collection plan: ${CASES.length} representative cases × ${REPETITIONS} repetitions per model.`);
  for (const objective of objectives) console.log(`  ${objective.metricId}: ${objective.samplingPlan.rationale}`);
  console.log(`Application candidates: ${allModels.join(", ")}. Hard caps: ${APPLICATION_CALL_LIMIT} application calls and $${MAX_SPEND_USD.toFixed(2)} application-provider spend.`);
  const assessmentIntent = await coordinator.issue("run_assessment");
  const baseline = await runAndPersist(BASELINE_MODEL, "baseline");
  const baselineRecords = records(baseline.rows, BASELINE_MODEL, baseline.ref);
  await coordinator.acceptResult({
    protocolVersion: "0.1", intentId: assessmentIntent.intent.id, status: "succeeded", completedAt: now(),
    summary: "Baseline metrics computed only from repeated live application calls.", evidence: [baseline.ref],
    outputs: { targetId, baselineEvidenceSufficient: baselineRecords.every((metric) => metric.sampleCount >= RUN_COUNT && metric.evidence.length > 0), metrics: baselineRecords },
  });

  const candidateDescriptors = allModels.map((modelId) => ({ targetId, candidateId: modelId, modelId, reasons: [modelId === BASELINE_MODEL ? "Configured incumbent." : "Exact model ID available in current OpenRouter catalogue; selected for a bounded live trial."] }));
  const discoveryIntent = await coordinator.issue("discover_candidates");
  await coordinator.acceptResult({
    protocolVersion: "0.1", intentId: discoveryIntent.intent.id, status: "succeeded", completedAt: now(),
    summary: "Frozen incumbent and catalogue-available candidate set for this sandbox trial.", evidence: [catalogueEvidence],
    outputs: { targetId, candidates: candidateDescriptors },
  });

  console.log("Running the same shuffled representative cases through each frozen candidate.");
  const trialIntent = await coordinator.issue("run_challenger_trials");
  const comparisonStartedAt = now();
  const trialResults = await sampleComparison(appDir, allModels, key, calls, spend, runFile);
  const trialEndAt = now();
  const assessments = [];
  for (const modelId of allModels) {
    const { rows, ref } = trialResults.get(modelId);
    assessments.push({
      id: `assessment-${safeFile(modelId)}`, targetId, taskProfileId: profile.id, taskProfileRevision: profile.revision,
      candidateId: modelId, modelId, modelVersion: modelId, productRevision: `sha256:${sha(await readFile(appPath))}`,
      harnessId: descriptor.id, startedAt: comparisonStartedAt, completedAt: trialEndAt,
      metrics: records(rows, modelId, ref),
    });
  }
  console.log(`Measured comparison results (${RUN_COUNT} calls/model; descriptive demo sample):`);
  for (const assessment of assessments) {
    const value = (metricId) => assessment.metrics.find((metric) => metric.metricId === metricId).value;
    console.log(`  ${assessment.modelId}: success=${value("task_success").toFixed(2)}, quality=${value("task_quality").toFixed(2)}, schema=${value("structured_output_reliability").toFixed(2)}, cost=$${value("total_task_cost").toFixed(6)}, mean latency=${value("end_to_end_task_latency").toFixed(0)}ms`);
  }
  const manifestData = { seed: DEMO_SEED, modelOrderRandomizedWithinEachInput: true, evaluationPlanDigest: sha(planArtifact), representativeCases: CASES, repetitions: REPETITIONS, models: allModels, applicationFileDigest: sha(await readFile(appPath)), catalogue, observedAt: { startedAt: comparisonStartedAt, completedAt: trialEndAt } };
  const manifestPath = join(artifactsDir, "experiment-manifest.json");
  const manifestContent = `${JSON.stringify(manifestData, null, 2)}\n`;
  await writeFile(manifestPath, manifestContent, { mode: 0o600 });
  const manifest = evidence("live-comparison-manifest", "file://artifacts/experiment-manifest.json", "evaluation_artifact", sha(manifestContent));
  await coordinator.acceptResult({
    protocolVersion: "0.1", intentId: trialIntent.intent.id, status: "succeeded", completedAt: now(),
    summary: `Collected ${assessments.length} model assessments from ${assessments.length * RUN_COUNT} live, measured application calls.`, evidence: [manifest, catalogueEvidence],
    outputs: { targetId, assessments, experimentManifest: manifest },
  });

  const frontier = makeFrontier(profile, assessments, manifest);
  const frontierChallengers = frontier.frontierCandidateIds.filter((id) => id !== BASELINE_MODEL);
  const recommendation = frontierChallengers.sort((a, b) =>
    assessments.find((item) => item.candidateId === a).metrics.find((metric) => metric.metricId === "total_task_cost").value -
    assessments.find((item) => item.candidateId === b).metrics.find((metric) => metric.metricId === "total_task_cost").value)[0];
  let postSwapMetrics = null;
  const frontierIntent = await coordinator.issue("calculate_frontier");
  await coordinator.acceptResult({
    protocolVersion: "0.1", intentId: frontierIntent.intent.id, status: "succeeded", completedAt: now(),
    summary: "Calculated a candidate Pareto frontier and verified it against the OpenMerit conformance checker.", evidence: [manifest],
    outputs: {
      targetId, assessments, frontierSnapshot: frontier,
      ...(recommendation ? { recommendation: { targetId, frontierSnapshotId: frontier.id, selectedCandidateId: recommendation, currentCandidateId: BASELINE_MODEL, reasons: ["Selected from the verified Pareto frontier using the demo's stated lowest-measured-total-cost preference; other trade-offs remain visible in the assessments."], preferenceEvidence: [manifest] } } : {}),
    },
  });

  const currentState = await store.readState();
  const action = (await import("../packages/core/src/index.ts")).nextImprovementAction(currentState.cycle);
  if (action.action === "issue_intent" && action.intentKind === "apply_model_swap") {
    const swapIntent = await coordinator.issue("apply_model_swap");
    await writeFile(join(appDir, ".openmerit-demo-route.json"), `${JSON.stringify({ model: recommendation, appliedAt: now(), approvedBy: "disposable-demo-policy" }, null, 2)}\n`, { mode: 0o600 });
    await coordinator.acceptResult({
      protocolVersion: "0.1", intentId: swapIntent.intent.id, status: "succeeded", completedAt: now(),
      summary: "Changed only the generated demo application's route file to the verified frontier candidate.", evidence: [evidence("applied-route", "file://app/.openmerit-demo-route.json", "harness_trace")],
      outputs: { targetId, appliedCandidateId: recommendation, previousCandidateId: BASELINE_MODEL },
    });
    console.log(`OpenMerit proposed ${recommendation}; sandbox application route changed from ${BASELINE_MODEL}.`);
    const post = await runAndPersist(recommendation, "post-swap");
    const postRecords = records(post.rows, recommendation, post.ref);
    postSwapMetrics = aggregate(post.rows, recommendation);
    const baselineByMetric = new Map(baselineRecords.map((item) => [item.metricId, item]));
    const regressions = postRecords.filter((metric) => {
      const initial = baselineByMetric.get(metric.metricId);
      if (!initial || initial.value === undefined || metric.value === undefined) return true;
      if (["task_success", "task_quality", "structured_output_reliability"].includes(metric.metricId)) return metric.value < initial.value;
      return false;
    });
    const verifyIntent = await coordinator.issue("verify_model_swap");
    await coordinator.acceptResult({
      protocolVersion: "0.1", intentId: verifyIntent.intent.id, status: "succeeded", completedAt: now(),
      summary: regressions.length ? `Post-swap check found regressions in ${regressions.map((item) => item.metricId).join(", ")}.` : "Post-swap repeated representative checks passed without quality or schema regression.", evidence: [post.ref],
      outputs: { targetId, verified: regressions.length === 0, regressionDetected: regressions.length > 0 },
    });
    if (regressions.length) throw new Error(`Post-swap regression detected: ${regressions.map((item) => item.metricId).join(", ")}. See ${runFile}`);
    console.log(`Post-swap verification passed: ${recommendation} served all ${RUN_COUNT} additional application calls.`);
  } else {
    console.log(`No swap: OpenMerit found no different, verified frontier recommendation. Decision: ${action.reason}`);
  }

  await writeFile(join(artifactsDir, "summary.json"), `${JSON.stringify({
    demoSandbox: root, piModel: PI_MODEL, baselineModel: BASELINE_MODEL, candidates: allModels,
    samplesPerModel: RUN_COUNT, representativeCases: CASES.length, repetitionsPerCase: REPETITIONS, randomizationSeed: DEMO_SEED,
    applicationCalls: calls.count, measuredApplicationProviderSpendUsd: spend.value, codingHarnessSpend: "not measured; excluded from the application-provider cap",
    baseline: aggregate(baseline.rows, BASELINE_MODEL),
    comparison: Object.fromEntries(assessments.map((item) => [item.modelId, Object.fromEntries(item.metrics.map((metric) => [metric.metricId, metric.value]))])),
    postSwap: postSwapMetrics,
    frontier: { candidates: frontier.frontierCandidateIds, dominated: frontier.dominatedCandidateIds, unresolved: frontier.unresolvedCandidateIds },
    proposedModel: recommendation ?? null, verifiedSwap: (await store.readState()).cycle.stage === "swap_verified",
    modelCatalogue: catalogue, generatedApp: "app/app.mjs", runEvidence: "artifacts/application-runs.jsonl",
    interpretationNote: `Demo-scale point estimates from ${RUN_COUNT} samples per model are descriptive only, not model reliability claims.`,
  }, null, 2)}\n`, { mode: 0o600 });
  console.log(`Evidence and OpenMerit state: ${root}`);
  console.log(`Measured application-provider spend: $${spend.value.toFixed(6)} across ${calls.count} application calls (Pi coding-model spend is not measured or included).`);
}

main().catch((error) => {
  console.error(`OpenMerit sandbox demo failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
