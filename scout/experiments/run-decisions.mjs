// Run explicitly: node scout/experiments/run-decisions.mjs /absolute/results.json
// Sends only the committed synthetic cases to OpenAI and incurs API usage.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createIndex, recommend } from '../rank.mjs';
import { interpretPrompt } from '../capabilities.mjs';
import { cases } from './decisions-cases.mjs';
import { interpretWithDecisions, questions } from './decisions.mjs';

if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY in the environment; never put it in the command.');
if (!process.argv[2]) throw new Error('Pass an output JSON path.');
const destination = resolve(process.argv[2]);
const raw = await readFile(new URL('../snapshot.json', import.meta.url), 'utf8');
const snapshot = JSON.parse(raw), index = createIndex(snapshot), now = Date.parse(snapshot.checkedAt);
const hash = value => createHash('sha256').update(value).digest('hex');
const brief = result => ({ ids: result.recommendations.map(m => m.id), names: result.recommendations.map(m => m.name), scores: result.recommendations.map(m => m.score), eligible: result.eligibleModels ?? 0, elapsedMs: result.elapsedMs,
  modelsWithoutDeclaredTools: result.recommendations.filter(m => !m.parameters.includes('tools')).map(m => m.id) });
const matches = (task, expected) => Object.entries(expected).map(([dimension, wanted]) => ({ dimension, wanted, actual: ['needsVision', 'needsStructured', 'unsupported'].includes(dimension) ? task[dimension] : !!task.weights[dimension] })).map(c => ({ ...c, pass: c.wanted === c.actual }));
const report = { startedAt: new Date().toISOString(), status: 'running', model: 'gpt-6-luna', snapshot: { checkedAt: snapshot.checkedAt, sha256: hash(raw), models: snapshot.models.length, benchmarks: snapshot.benchmarks.length },
  rubricSha256: hash(JSON.stringify(questions)), casesSha256: hash(JSON.stringify(cases)),
  method: 'Prewritten synthetic diagnostic cases. One request per prompt, sequential, no retries or application cache. Same frozen snapshot, hard filters and 80/13/7 scoring formula for both interpreters. Capability weights: absent/uncertain=0, useful=1, required=3; existing document multiplier=2. Memory and tool-interface requirements are recorded separately, not fabricated as benchmark evidence. No candidate model executes the tasks.',
  evidence: { memorySeries: snapshot.benchmarks.filter(b => /memory|longmem|locomo/i.test(b.name)).map(b => b.name), functionCallingSeries: snapshot.benchmarks.filter(b => /bfcl|function.call/i.test(b.name)).map(b => ({ name: b.name, matchedModels: snapshot.models.filter(m => m.evidence.some(e => e.benchmark === b.id)).length })) },
  runs: [] };
await mkdir(dirname(destination), { recursive: true });
// Repeats are fixed in advance and excluded from accuracy counts.
const scheduled = [...cases.map(c => ({ ...c, repeat: false })), ...[0, 1, 0, 1].map(i => ({ ...cases[i], repeat: true }))];
for (const fixture of scheduled) {
  const baselineTask = interpretPrompt(fixture.prompt);
  const baseline = brief(recommend(index, fixture.prompt, now));
  const run = { id: fixture.id, pair: fixture.pair, repeat: fixture.repeat, prompt: fixture.prompt, expected: fixture.expected, expectedMemory: fixture.memory, expectedTools: fixture.tools, baseline: { task: baselineTask, checks: matches(baselineTask, fixture.expected), ranking: baseline } };
  try {
    const response = await interpretWithDecisions(fixture.prompt, { apiKey: process.env.OPENAI_API_KEY });
    const ranking = brief(recommend(index, fixture.prompt, now, response.task));
    run.decisions = { ...response, checks: matches(response.task, fixture.expected), ranking, memoryPass: response.task.requirements.memory === fixture.memory, toolsPass: response.task.requirements.tools === fixture.tools };
    run.rankingChanged = baseline.ids.join('|') !== ranking.ids.join('|');
    console.log(JSON.stringify({ id: run.id, repeat: run.repeat, baselineFailures: run.baseline.checks.filter(c => !c.pass).map(c => c.dimension), decisionsFailures: run.decisions.checks.filter(c => !c.pass).map(c => c.dimension), memory: response.task.requirements.memory, tools: response.task.requirements.tools, durationMs: response.durationMs, top5: ranking.names }));
  } catch (error) {
    run.error = error.name === 'TimeoutError' ? 'Request timed out.' : error.message;
    console.log(JSON.stringify({ id: run.id, error: run.error }));
  }
  report.runs.push(run);
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
}
const primary = report.runs.filter(r => !r.repeat), successful = primary.filter(r => r.decisions);
const score = key => ({ checks: primary.reduce((sum, r) => sum + (r[key]?.checks.length ?? Object.keys(r.expected).length), 0), passed: primary.reduce((sum, r) => sum + (r[key]?.checks.filter(c => c.pass).length ?? 0), 0), fullyCorrectCases: primary.filter(r => r[key]?.checks.every(c => c.pass)).length });
const times = report.runs.filter(r => r.decisions).map(r => r.decisions.durationMs).sort((a, b) => a - b);
const percentile = p => times[Math.max(0, Math.ceil(times.length * p) - 1)];
const tokens = report.runs.reduce((sum, r) => sum + (r.decisions?.usage?.input_tokens ?? 0), 0);
const variants = report.runs.filter(r => r.pair === 'invoice' && r.decisions);
report.summary = { cases: primary.length, successes: successful.length, failures: primary.length - successful.length,
  baseline: score('baseline'), decisions: score('decisions'), memoryCorrect: successful.filter(r => r.decisions.memoryPass).length, toolsCorrect: successful.filter(r => r.decisions.toolsPass).length,
  rankingsChanged: successful.filter(r => r.rankingChanged).length,
  invoiceDistinctRankings: { baseline: new Set(variants.map(r => r.baseline.ranking.ids.join('|'))).size, decisions: new Set(variants.map(r => r.decisions.ranking.ids.join('|'))).size, requests: variants.length },
  apiLatencyMs: { samples: times.length, min: times[0], p50: percentile(.5), p95: percentile(.95), max: times.at(-1) }, inputTokens: tokens,
  estimatedCostUSD: tokens * .1 / 1_000_000, pricingBasis: 'Published Decisions rate of $0.10/1M input tokens, excluding account-specific premiums; estimate, not invoice.' };
report.status = 'complete'; report.completedAt = new Date().toISOString();
await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.summary, null, 2));
console.log(`Saved ${destination}`);
