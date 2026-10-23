// Opt-in semantic acceptance. Local mode makes paid interpretation calls using
// OPENAI_API_KEY; --live uses the hosted service. No candidate models are executed.
// Usage: node scout/experiments/audit-interpretation.mjs /tmp/report.json [--live]
import { writeFile } from 'node:fs/promises';
import interpretationCases from './interpretation-cases.json' with { type: 'json' };
import formatCases from './format-cases.json' with { type: 'json' };
import sqlCases from './sql-cases.json' with { type: 'json' };
import specialistCases from './specialist-cases.json' with { type: 'json' };
import snapshot from '../snapshot.json' with { type: 'json' };
import { classifyPrompt } from '../decisions.mjs';
import { matchSpecialists } from '../specialists.mjs';
import { createIndex, recommend } from '../rank.mjs';

const [report, flag] = process.argv.slice(2), live = flag === '--live';
if (!report || (flag && !live) || process.argv.length > 4) throw new Error('Usage: audit-interpretation.mjs /path/report.json [--live]');
if (!live && !process.env.OPENAI_API_KEY) throw new Error('Local semantic acceptance requires OPENAI_API_KEY.');
const cases = [...interpretationCases, ...formatCases, ...sqlCases, ...specialistCases];
const index = live ? null : createIndex(snapshot), results = [];
for (const c of cases) {
  const started = performance.now(), channel = live ? 'api' : 'local';
  let result, interpretation, rankingMs = null;
  if (live) {
    const request = { prompt: c.prompt };
    const response = await fetch('https://openmerit.ai/scout/api/recommend', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`${c.id}: HTTP ${response.status}`);
    result = await response.json();
  } else {
    interpretation = await classifyPrompt(c.prompt, { apiKey: process.env.OPENAI_API_KEY });
    interpretation.task.specialistMatch = await matchSpecialists(c.prompt, interpretation.task, index.snapshot.specialistProfiles ?? [], { apiKey: process.env.OPENAI_API_KEY });
    const rankedAt = performance.now();
    result = recommend(index, c.prompt, Date.now(), interpretation.task);
    rankingMs = performance.now() - rankedAt;
  }
  const t = result.task, e = c.expect, failures = [], check = (ok, message) => { if (!ok) failures.push(message); };
  if (c.id.startsWith('hub-')) {
    check(t.specialistMatch?.status !== 'unavailable', 'Specialist comparison unavailable');
    const matchIDs = new Set((t.specialistMatch?.matches ?? []).map(m => m.profileId));
    const matched = snapshot.specialists.filter(m => matchIDs.has(m.semantic?.profileId)).map(m => m.id);
    for (const id of e.matchRepos ?? []) check(matched.includes(id), `Expected compatible repository: ${id}`);
    for (const id of e.excludeRepos ?? []) check(!matched.includes(id), `Incompatible repository admitted: ${id}`);
    if (e.hub) check(result.recommendations.some(m => m.endpoint.source === 'huggingface'), 'No compatible Hub deployment');
    if (e.specialists) check(result.specialists?.candidates.length > 0, 'No compatible specialist component');
    if (e.noHubChecks) check(t.specialistMatch?.evaluatedProfiles === 0, 'Unnecessary specialist interpretation');
  }
  if (e.generative) {
    check(result.recommendations.length > 0, 'No generative recommendations');
    check(result.recommendations.every(m => !m.endpoint.operations), 'Decision-only endpoints for generative work');
    check(result.ranking?.mode !== 'task-fit', 'Task-fit mode for generative work');
  }
  for (const [key, field] of [['vision', 'needsVision'], ['tools', 'needsTools'], ['structured', 'needsStructured'], ['unsupported', 'unsupported']]) if (key in e) check(t[field] === e[key], `${field} mismatch`);
  if ('structuredCapability' in e) check(!!t.weights.structured === e.structuredCapability, 'Structured capability mismatch');
  if (e.structured) check(result.recommendations.length > 0 && result.recommendations.every(m => m.parameters?.some(p => ['structured_outputs', 'response_format'].includes(p))), 'Required format support missing from recommendations');
  if (e.noCalibration) check(!['measured', 'mixed'].includes(result.ranking?.mode), 'Narrow calibration reused for mixed output');
  if (e.noDocuments) check(!t.weights.documents, 'Object recognition mistaken for document reading');
  if (e.documents) check(t.weights.documents >= 3, 'Document reading requirement lost');
  if (e.agentic) check(t.weights.agents === 3, 'Execution-loop requirement lost');
  if (e.kind) check(t.kind === e.kind, 'Operation mismatch');
  if (e.notKinds) check(!e.notKinds.includes(t.kind), 'Excluded operation selected');
  if (e.coding) check(t.weights.coding === 3, 'Coding requirement lost');
  if (e.labelSpace) check(t.labelSpace === e.labelSpace, 'Answer-space mismatch');
  if (e.native) {
    check(result.recommendations.some(m => m.endpoint.protocol === 'decisions'), 'Native decision endpoint lost');
    check(result.recommendations.every(m => m.quality === null), 'Contract fit presented as measured accuracy');
  }
  if (e.allBoxes) {
    check(t.outputCardinality === 'all-or-unspecified', 'Incorrect box cardinality');
    check(result.recommendations.every(m => m.endpoint.detection !== 'single-box'), 'Single-box endpoint for all instances');
  }
  if (e.clarification) check(!!t.clarification && result.recommendations.length === 0, 'Ambiguous spatial output guessed');
  if (e.unsupported) check(result.recommendations.length === 0, 'Unsupported modality got recommendations');
  results.push({ ...c, channel, failures, totalMs: performance.now() - started, rankingMs, interpretation, result });
  await writeFile(report, JSON.stringify(results, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ id: c.id, pass: !failures.length, failures }));
}
const failed = results.filter(r => r.failures.length);
console.log(JSON.stringify({ cases: results.length, passed: results.length - failed.length, failed: failed.map(r => r.id) }));
if (failed.length) process.exitCode = 1;
