import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { initialize, choosePlanOptions, parseBudget } from '../src/cli.mjs';
import { loadConfig, saveJSON, readJSON, snapshot, configPath, statePath, filesAt, validateConfig, reservationFor } from '../src/config.mjs';
import { makePlan, savePlan, validatePlan } from '../src/scout.mjs';
import { parseOutput, invocation, connectionFailure, runAgent, preflight } from '../src/adapters.mjs';
import { evaluate, acquireLock, budgetUsed, watch } from '../src/runner.mjs';
import { execute } from '../src/process.mjs';
import { isVolatile, compareReports, formatReport } from '../src/report.mjs';

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'om-eval-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  await initialize(root); const config = await loadConfig(root);
  config.scope = 'existing'; config.connections = [{ id: 'route', scoutId: 'lab/model', agent: 'claude', model: 'native-version' }];
  config.budget.maxUsd = 20; config.repeats.max = 4;
  await saveJSON(join(root, configPath), config); await savePlan(root, await makePlan(config, mockScout));
  return { root, config };
}
const mockScout = async (_url, options) => {
  const body = JSON.parse(options.body);
  return Response.json({ recommendations: [{ id: 'lab/model', name: 'Model', rank: 1 }], selection: { modelIds: body.modelIds ?? null }, ranking: { mode: 'benchmarks' }, warnings: [] });
};
const success = { output: '{"name":"Mira Chen","count":7}', usage: { input: 100, output: 10, cached: 0 }, costUsd: .01, seconds: 1, status: 'ok', observedModels: ['native-version'] };
const runnerOptions = { agentRunner: async () => structuredClone(success), checkAgent: async () => 'test-v1' };

test('init preserves project instructions, refuses overwrites, and keeps budget disabled', async t => {
  const root = await mkdtemp(join(tmpdir(), 'om-init-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'AGENTS.md'), 'Keep my rules.'); await initialize(root);
  assert.match(await readFile(join(root, 'AGENTS.md'), 'utf8'), /^Keep my rules\./);
  assert.equal((await loadConfig(root)).budget.maxUsd, 0);
  await assert.rejects(initialize(root), /Already exists/);
});
test('Scout receives only descriptions and IDs, requires explicit choice, and verifies scope acknowledgement', async t => {
  const { config } = await project(t);
  await assert.rejects(makePlan({ ...config, scope: null }, mockScout), /Choose a scope/);
  const plan = await makePlan(config, async (url, options) => {
    assert.deepEqual(JSON.parse(options.body), { prompt: config.tasks[0].description, modelIds: ['lab/model'] }); return mockScout(url, options);
  });
  validatePlan(config, plan);
  await assert.rejects(makePlan(config, async () => Response.json({ recommendations: [], selection: { modelIds: null } })), /acknowledge/);
  const all = { ...config, scope: 'all', connections: [] };
  const unknown = await makePlan(all, mockScout);
  assert.throws(() => validatePlan(all, unknown), /authenticated agent connection/);
});
test('native event adapters retain unknowns, cache accounting, failures and full-turn usage', () => {
  const claude = parseOutput('claude', JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 }, total_cost_usd: .02, modelUsage: { version: {} } }));
  assert.deepEqual(claude.usage, { input: 35, output: 3, cached: 20 }); assert.equal(claude.costUsd, .02);
  const codex = parseOutput('codex', [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 25, output_tokens: 5, cached_input_tokens: 20 } })].join('\n'));
  assert.equal(codex.costUsd, null); assert.equal(codex.usage.input, 25); assert.equal(codex.output, 'ok');
  const steps = [{ type: 'step_finish', part: { reason: 'tool-calls', cost: .01, tokens: { input: 10, output: 3, reasoning: 2, cache: { read: 8, write: 0 } } } }, { type: 'step_finish', part: { reason: 'stop', cost: .02, tokens: { input: 20, output: 4, reasoning: 1, cache: { read: 5, write: 0 } } } }];
  const oc = parseOutput('opencode', steps.map(e => JSON.stringify(e)).join('\n'));
  assert.equal(oc.costUsd, .03); assert.equal(oc.usage.input, 43); assert.equal(oc.usage.output, 10); assert.equal(oc.completed, true);
  assert.equal(parseOutput('opencode', JSON.stringify(steps[0])).completed, false);
  assert.equal(parseOutput('claude', '{"type":"result","subtype":"error_max_turns","is_error":true}').completed, false);
  assert.equal(parseOutput('codex', 'unstructured output').usage, null);
  for (const agent of ['claude', 'codex', 'opencode']) assert.ok(!invocation({ agent, model: 'chosen' }, .25).some(a => /skip-permissions|bypass|resume|continue/.test(a)));
});
test('three balanced rounds use fresh workspaces, a frozen fixture and graders outside the workspace', async t => {
  const { root } = await project(t); const seen = new Set(); let calls = 0;
  const result = await evaluate(root, { ...runnerOptions, agentRunner: async (_c, _p, options) => {
    assert.ok(!seen.has(options.cwd)); seen.add(options.cwd);
    assert.equal(await readFile(join(options.cwd, 'request.txt'), 'utf8'), 'Customer: Mira Chen\nItems: 7\n');
    await assert.rejects(readFile(join(options.cwd, 'eval/grade.mjs')), /ENOENT/);
    await writeFile(join(options.cwd, 'request.txt'), 'modified by agent');
    if (++calls === 1) await writeFile(join(root, 'eval/fixtures/json/request.txt'), 'changed during run');
    return structuredClone(success);
  } });
  assert.equal(result.status, 'complete'); assert.equal(result.rows.length, 6); assert.equal(result.summary[0].runs, 3);
  assert.equal(result.summary[0].quality, 1); assert.ok(result.rows.every(r => r.round <= 3));
});
test('intermediate commentary does not contaminate final-output grading', () => {
  const codex = [{ type: 'item.completed', item: { type: 'agent_message', text: 'I will read the file.' } }, { type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } }, { type: 'turn.completed' }];
  assert.equal(parseOutput('codex', codex.map(JSON.stringify).join('\n')).output, '{"ok":true}');
  const opencode = [{ type: 'text', part: { messageID: 'a', text: 'Reading the file.' } }, { type: 'step_finish', part: { messageID: 'a', reason: 'tool-calls' } }, { type: 'text', part: { messageID: 'b', text: '{"ok":true}' } }, { type: 'step_finish', part: { messageID: 'b', reason: 'stop' } }];
  assert.equal(parseOutput('opencode', opencode.map(JSON.stringify).join('\n')).output, '{"ok":true}');
});
test('CLI revisions compare, but changed tasks/graders/model versions do not', async t => {
  const { root } = await project(t);
  const before = await evaluate(root, runnerOptions);
  await writeFile(join(root, 'eval/tool.mjs'), 'console.log("changed")');
  const after = await evaluate(root, runnerOptions);
  assert.notEqual(before.revision, after.revision); assert.ok(after.comparison); assert.equal(after.comparison[0].qualityDelta, 0);
  await writeFile(join(root, 'eval/grade.mjs'), 'console.log("{\\"quality\\":0.5}")');
  const changedGrader = await evaluate(root, runnerOptions); assert.equal(changedGrader.comparison, null);
  assert.equal(compareReports({ ...after, status: 'budget_stopped' }, before), null);
});
test('volatile outcomes extend every candidate/variant to max repetitions', async t => {
  const { root } = await project(t); let n = 0;
  const report = await evaluate(root, { ...runnerOptions, agentRunner: async () => ({ ...success, seconds: ++n % 2 ? 1 : 20, output: n <= 2 ? '{}' : success.output }) });
  assert.equal(report.rows.length, 8); assert.ok(report.summary.every(r => r.runs === 4));
  assert.equal(isVolatile(report.rows), true);
});
test('unknown charges reserve the full allowance and survive another invocation', async t => {
  const { root, config } = await project(t); config.budget = { maxUsd: .5, reservationUsd: .25 }; await saveJSON(join(root, configPath), config);
  const unknown = { ...runnerOptions, agentRunner: async () => ({ ...success, costUsd: null, usage: null }) };
  const report = await evaluate(root, unknown);
  assert.equal(report.status, 'budget_stopped'); assert.equal(report.rows.length, 2);
  assert.equal(report.summary[0].meanCostUsd, null); assert.equal(report.summary[0].inputTokens, null);
  assert.equal(budgetUsed(await readJSON(join(root, statePath, 'budget.json'))), .5);
  await assert.rejects(evaluate(root, unknown), /budget.*exhausted/);
});
test('corrupt budget entries fail closed and variant files cannot replace frozen task inputs', async t => {
  for (const costUsd of [-1, 'free', undefined]) assert.throws(() => budgetUsed({ version: 1, entries: [{ reservationUsd: .25, costUsd }] }), /Invalid budget/);
  const { root, config } = await project(t);
  await writeFile(join(root, 'request.txt'), 'different input'); config.variants[0].files = ['request.txt'];
  await assert.rejects(snapshot(root, config), /overwrites a fixture/);
});
test('interrupted attempts retain their reservation, and invalid graders stop immediately', async t => {
  const { root } = await project(t);
  await assert.rejects(evaluate(root, { ...runnerOptions, agentRunner: async () => { throw new Error('crash'); } }), /crash/);
  assert.equal(budgetUsed(await readJSON(join(root, statePath, 'budget.json'))), .25);
  await writeFile(join(root, 'eval/grade.mjs'), 'console.log("{\\"quality\\":8}")');
  const report = await evaluate(root, runnerOptions);
  assert.equal(report.status, 'invalid'); assert.equal(report.rows.length, 1); assert.equal(report.rows[0].quality, null);
});
test('authentication and model access failures stop after one attempt without grading model quality', async t => {
  const { root } = await project(t);
  assert.equal(connectionFailure('The selected model is not supported when using this account.'), 'model_unavailable');
  assert.equal(connectionFailure('HTTP 401 Unauthorized'), 'authentication');
  assert.equal(connectionFailure('temporary network failure'), null);
  const report = await evaluate(root, { ...runnerOptions, agentRunner: async () => ({ ...success, status: 'agent_error', failureReason: 'model_unavailable', costUsd: null }) });
  assert.equal(report.status, 'connection_blocked'); assert.equal(report.rows.length, 1); assert.equal(report.rows[0].quality, null);
});
test('partial emitted costs cannot release the reservation after an unsuccessful process', async t => {
  const root = await mkdtemp(join(tmpdir(), 'om-partial-')); t.after(() => rm(root, { recursive: true, force: true }));
  const command = join(root, 'agent');
  await writeFile(command, '#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"step_finish",part:{reason:"tool-calls",cost:0,tokens:{input:20,output:5}}}));process.exit(1);', { mode: 0o700 });
  const result = await runAgent({ agent: 'opencode', model: 'm', command }, 'task', { cwd: root, reservationUsd: .25 });
  assert.equal(result.status, 'agent_error'); assert.equal(result.costUsd, null); assert.equal(result.partialCostUsd, null);
});
test('Claude budget stops preserve per-model usage without doubling cache or cost', () => {
  const parsed = parseOutput('claude', JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', terminal_reason: 'budget_exhausted', is_error: true,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, total_cost_usd: .0528,
    modelUsage: { m: { inputTokens: 707, outputTokens: 196, cacheReadInputTokens: 21771, cacheCreationInputTokens: 8342, costUSD: .0528 } } }));
  assert.equal(parsed.failureReason, 'budget_exhausted');
  assert.deepEqual(parsed.usage, { input: 30820, output: 196, cached: 21771 });
  assert.equal(parsed.costUsd, .0528);
});
test('missing native pricing remains unknown and partial step costs remain visible', () => {
  assert.equal(parseOutput('claude', JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0 })).costUsd, null);
  const result = parseOutput('opencode', [
    { type: 'step_finish', part: { reason: 'tool-calls', cost: .02 } },
    { type: 'step_finish', part: { reason: 'stop', cost: 0 } },
  ].map(JSON.stringify).join('\n'));
  assert.equal(result.completed, true); assert.equal(result.costUsd, null); assert.equal(result.partialCostUsd, .02);
});
test('successful exits with native budget or sandbox failures are blocked, not scored', async t => {
  const { root } = await project(t), command = join(root, 'native-agent');
  const cases = [
    { agent: 'claude', events: [{ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: .03 }], reason: 'budget_exhausted', reportStatus: 'budget_stopped' },
    { agent: 'codex', events: [{ type: 'item.completed', item: { type: 'command_execution', exit_code: 1, aggregated_output: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted' } }, { type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 5 } }], reason: 'sandbox_unavailable', reportStatus: 'environment_blocked' },
    { agent: 'opencode', events: [{ type: 'tool_use', part: { state: { status: 'error', error: 'permission denied' } } }, { type: 'step_finish', part: { reason: 'stop', cost: .02 } }], reason: 'permission_denied', reportStatus: 'environment_blocked' },
  ];
  for (const c of cases) {
    await writeFile(command, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(c.events.map(JSON.stringify).join('\n'))});`, { mode: 0o700 });
    const result = await runAgent({ agent: c.agent, model: 'm', command }, 'task', { cwd: root, reservationUsd: .25 });
    assert.equal(result.failureReason, c.reason); assert.notEqual(result.status, 'ok');
    const report = await evaluate(root, { ...runnerOptions, agentRunner: async () => result });
    assert.equal(report.status, c.reportStatus); assert.equal(report.rows.length, 1); assert.equal(report.rows[0].quality, null);
    assert.equal(report.summary[0].failures, 0); assert.equal(report.summary[0].blockedAttempts, 1); assert.equal(report.summary[0].scoredRuns, 0);
    assert.equal(report.comparison, null); assert.match(formatReport(report), /Blocked attempts are unscored/);
    if (c.agent === 'claude') assert.equal(report.rows[0].partialCostUsd, .03);
  }
});
test('ordinary incorrect outputs still score zero; task content cannot masquerade as a host block', async t => {
  const { root } = await project(t);
  const report = await evaluate(root, { ...runnerOptions, agentRunner: async () => ({ ...success, output: '{"wrong":true}' }) });
  assert.equal(report.status, 'complete'); assert.ok(report.rows.every(r => r.quality === 0));
  assert.equal(report.summary[0].blockedAttempts, 0); assert.equal(report.summary[0].failedTaskChecks, 3);
  for (const events of [
    [{ type: 'item.completed', item: { type: 'agent_message', text: 'Explain HTTP 401 unauthorized, budget_exhausted and permission denied.' } }, { type: 'turn.completed' }],
    [{ type: 'item.completed', item: { type: 'command_execution', exit_code: 0, aggregated_output: 'bwrap: operation not permitted' } }, { type: 'turn.completed' }],
    [{ type: 'item.completed', item: { type: 'command_execution', exit_code: 1, aggregated_output: 'AssertionError: expected 2 but got 3' } }, { type: 'turn.completed' }],
    [{ type: 'item.completed', item: { type: 'command_execution', exit_code: 1, aggregated_output: 'Application test failed: HTTP 401 Unauthorized' } }, { type: 'turn.completed' }],
    [{ type: 'item.completed', item: { type: 'command_execution', exit_code: 1, aggregated_output: 'Test expected budget_exhausted but got success' } }, { type: 'turn.completed' }],
  ]) assert.equal(parseOutput('codex', events.map(JSON.stringify).join('\n')).failureReason, null);
});
test('cost estimates never release reserved allowance, including older ledger entries', async t => {
  const { root, config } = await project(t); config.budget = { maxUsd: .5, reservationUsd: .25 }; await saveJSON(join(root, configPath), config);
  const result = await evaluate(root, runnerOptions);
  assert.equal(result.status, 'budget_stopped'); assert.equal(result.rows.length, 2); assert.equal(result.budgetUsedUsd, .5);
  assert.equal(budgetUsed({ version: 1, entries: [{ reservationUsd: .25, costUsd: .01 }] }), .25);
  assert.equal(budgetUsed({ version: 1, entries: [{ reservationUsd: .25, costUsd: .3 }] }), .3);
  await assert.rejects(evaluate(root, runnerOptions), /exhausted/);
});
test('Linux sandbox preflight runs a free local probe and stops before reserving or invoking models', async t => {
  const { root } = await project(t); const commands = [];
  const fakeExecute = async (_command, args) => {
    commands.push(args);
    if (args[0] === '--version') return { code: 0, stdout: 'codex test', stderr: '' };
    if (args[0] === 'exec') return { code: 0, stdout: '--json --ephemeral --sandbox', stderr: '' };
    if (args[0] === 'sandbox') return { code: 0, stdout: 'Usage: codex sandbox [COMMAND]...', stderr: '' };
    return { code: 1, stdout: '', stderr: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted' };
  };
  let paidCalls = 0;
  const report = await evaluate(root, { agentRunner: async () => { paidCalls++; return success; }, checkAgent: () => preflight({ agent: 'codex' }, { cwd: root, platform: 'linux', executeCommand: fakeExecute }) });
  assert.equal(paidCalls, 0); assert.equal(report.status, 'environment_blocked'); assert.equal(report.rows.length, 0); assert.equal(report.budgetUsedUsd, 0);
  assert.equal(commands.at(-1)[2], 'sandbox'); assert.ok(commands.at(-1).includes('sandbox_mode="workspace-write"'));
  await assert.rejects(readJSON(join(root, statePath, 'budget.json')), /ENOENT/);
});
test('partial estimates above the reservation are retained across blocked retries', async t => {
  const { root } = await project(t);
  const result = await evaluate(root, { ...runnerOptions, agentRunner: async () => ({ ...success, status: 'budget_exhausted', failureReason: 'budget_exhausted', costUsd: null, partialCostUsd: .4 }) });
  assert.equal(result.budgetUsedUsd, .4); assert.equal(result.summary[0].meanCostUsd, null); assert.equal(result.summary[0].partialReportedCostUsd, .4);
});
test('project lock prevents overlapping runners, and watched files exclude result writes', async t => {
  const { root } = await project(t); const unlock = await acquireLock(root);
  await assert.rejects(acquireLock(root), /owns this project/); await unlock();
  const controller = new AbortController(); let reports = 0;
  await watch(root, { ...runnerOptions, intervalMs: 5, signal: controller.signal, onReport: async () => {
    reports++; if (reports === 1) await writeFile(join(root, 'eval/tool.mjs'), '// next revision'); else controller.abort();
  } });
  assert.equal(reports, 2);
});
test('fixtures reject symlinks, outside paths and credential files', async t => {
  const { root, config } = await project(t);
  await symlink('/tmp', join(root, 'escape'));
  for (const paths of [['escape'], ['../anything'], ['.env.demo']]) await assert.rejects(filesAt(root, paths));
  assert.ok((await snapshot(root, config)).revision);
});
test('subprocess execution passes literal input and terminates a hung command', async () => {
  const echo = await execute(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: '$(do-not-execute) `literal`' });
  assert.equal(echo.stdout, '$(do-not-execute) `literal`');
  const timeout = await execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 30 });
  assert.equal(timeout.reason, 'timeout');
});

test('budget setup follows scope, asks a custom amount only when selected, and has no default', async t => {
  const { config } = await project(t); config.scope = null; config.budget.maxUsd = 0;
  for (const [answers, expected] of [[['existing', '1'], 10], [['all', '2', '12.50'], 12.5], [['existing', '3'], 'unlimited']]) {
    const prompts = [], queue = [...answers];
    const chosen = await choosePlanOptions(config, { ask: async prompt => { prompts.push(prompt); return queue.shift(); } });
    assert.match(prompts[0], /existing project connections/); assert.match(prompts[1], /budget/);
    assert.equal(prompts.length, expected === 12.5 ? 3 : 2);
    assert.equal(chosen.budget.maxUsd, expected); assert.equal(chosen.budget.reservationUsd, 'auto');
    if (expected === 12.5) assert.match(prompts[2], /How much/);
  }
  const answers = ['existing', '', 'nonsense', '2', '0', 'Infinity', 'unlimited', '.50'], messages = [];
  const selected = await choosePlanOptions(config, { ask: async () => answers.shift(), tell: text => messages.push(text) });
  assert.equal(selected.budget.maxUsd, .5); assert.equal(messages.length, 5);
  assert.equal(config.budget.maxUsd, 0); assert.equal(config.scope, null);
});
test('saved budget choices are reused and noninteractive setup fails closed', async t => {
  const { config } = await project(t);
  for (const maxUsd of [10, 4.25, 'unlimited']) {
    config.budget.maxUsd = maxUsd;
    const chosen = await choosePlanOptions(config, { ask: async () => assert.fail('Must reuse the saved choice') });
    assert.deepEqual(chosen, config);
  }
  config.budget.maxUsd = 0;
  await assert.rejects(choosePlanOptions(config), /Choose an evaluation budget/);
  await assert.rejects(choosePlanOptions({ ...config, scope: null }, { budget: '10' }), /Choose a scope/);
  const chosen = await choosePlanOptions(config, { scope: 'all', budget: 'unlimited' });
  assert.equal(chosen.scope, 'all'); assert.equal(chosen.budget.maxUsd, 'unlimited');
  await assert.rejects(choosePlanOptions(config, { ask: async () => { throw new Error('Input closed'); } }), /Input closed/);
  assert.equal(config.budget.maxUsd, 0);
});
test('budget parsing cannot accidentally turn invalid amounts into unlimited spending', async t => {
  for (const input of ['', ' ', '0', '-10', 'NaN', 'Infinity', 'null', '1e3', '1.234', '10junk', '99999999999999999']) assert.throws(() => parseBudget(input), /positive USD/);
  assert.equal(parseBudget('$10'), 10); assert.equal(parseBudget(' 12.50 '), 12.5); assert.equal(parseBudget('unlimited'), 'unlimited');
  const { config } = await project(t);
  for (const maxUsd of [null, undefined, Infinity, NaN, '10', 'none']) assert.throws(() => validateConfig({ ...config, budget: { maxUsd, reservationUsd: 'auto' } }), /maxUsd/);
  validateConfig({ ...config, budget: { maxUsd: 'unlimited', reservationUsd: 'auto' } });
});
test('automatic reservations fit a small allowance without altering repeat limits', async t => {
  const { root, config } = await project(t); const plan = await readJSON(join(root, statePath, 'plan.json'));
  config.budget = { maxUsd: .06, reservationUsd: 'auto' };
  assert.equal(reservationFor(config, plan), .01);
  await saveJSON(join(root, configPath), config);
  const report = await evaluate(root, { ...runnerOptions, agentRunner: async () => ({ ...success, costUsd: .001 }) });
  assert.equal(report.rows.length, 6); assert.equal(report.status, 'complete'); assert.equal(report.reservationUsd, .01);
  assert.ok(Math.abs(report.budgetUsedUsd - .06) < 1e-10);
  await assert.rejects(evaluate(root, runnerOptions), /exhausted/);
});
test('no fixed cap keeps the ledger, task limits, timeouts and native permissions', async t => {
  const { root, config } = await project(t); config.budget = { maxUsd: 'unlimited', reservationUsd: 'auto' };
  config.repeats.max = 10; await saveJSON(join(root, configPath), config);
  await saveJSON(join(root, statePath, 'budget.json'), { version: 1, entries: [{ reservationUsd: 50, costUsd: null }] });
  let attempts = 0;
  const report = await evaluate(root, { ...runnerOptions, agentRunner: async (_connection, _prompt, options) => {
    assert.equal(options.unlimitedBudget, true); assert.equal(options.timeoutMs, config.timeoutSeconds * 1000);
    return { ...success, output: ++attempts <= 2 ? '{}' : success.output, costUsd: null };
  } });
  assert.equal(report.status, 'complete'); assert.equal(report.rows.length, 20); assert.equal(report.budgetUsedUsd, 55);
  assert.equal(report.budgetLimitUsd, 'unlimited'); assert.match(formatReport(report), /Budget: no fixed cap/);
  const capped = invocation({ agent: 'claude', model: 'm' }, .25), uncapped = invocation({ agent: 'claude', model: 'm' }, .25, true);
  assert.ok(capped.includes('--max-budget-usd')); assert.ok(!uncapped.includes('--max-budget-usd'));
  assert.deepEqual(uncapped, capped.slice(0, -2));
  config.budget.maxUsd = 10; await saveJSON(join(root, configPath), config);
  await assert.rejects(evaluate(root, runnerOptions), /exhausted/);
  assert.equal(budgetUsed(await readJSON(join(root, statePath, 'budget.json'))), 55);
});
test('unlimited mode still rejects corrupt ledgers and stops on an explicit cancellation', async t => {
  const { root, config } = await project(t); config.budget.maxUsd = 'unlimited'; await saveJSON(join(root, configPath), config);
  const report = await evaluate(root, { ...runnerOptions, agentRunner: async () => ({ ...success, status: 'cancelled', failureReason: 'cancelled', costUsd: null }) });
  assert.equal(report.status, 'cancelled'); assert.equal(report.rows.length, 1); assert.equal(report.rows[0].quality, null);
  await saveJSON(join(root, statePath, 'budget.json'), { version: 1, entries: [{ reservationUsd: .25, costUsd: -1 }] });
  await assert.rejects(evaluate(root, runnerOptions), /Invalid budget ledger/);
});

test('CLI planning persists explicit budgets through replans and Scout failures without resetting usage', async t => {
  let requests = 0, unavailable = false;
  const server = createServer(async (req, res) => {
    requests++; let input = ''; for await (const chunk of req) input += chunk;
    assert.deepEqual(JSON.parse(input), { prompt: config.tasks[0].description, modelIds: ['lab/model'] });
    const response = unavailable ? new Response('', { status: 503 }) : await mockScout('', { body: input });
    res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text());
  });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { root, config } = await project(t);
  config.budget = { maxUsd: 0, reservationUsd: 'auto' };
  config.scoutURL = `http://127.0.0.1:${server.address().port}/recommend`;
  await saveJSON(join(root, configPath), config);
  const ledgerPath = join(root, statePath, 'budget.json');
  const ledger = { version: 1, entries: [{ reservationUsd: 2, costUsd: null }] };
  await saveJSON(ledgerPath, ledger);
  const cli = (...args) => execute(process.execPath, ['--input-type=module', '-e', `const { main } = await import(${JSON.stringify(new URL('../src/cli.mjs', import.meta.url).href)}); try { await main(process.argv.slice(1)); } catch (error) { console.error(error.message); process.exitCode = 1; }`, ...args, '--path', root], { timeoutMs: 8000 });

  for (const args of [['plan'], ['plan', '--budget', '0'], ['plan', '--budget', 'NaN'], ['run', '--budget', '10'], ['plan', '--budget', '10', '--budget', '20']]) {
    const result = await cli(...args); assert.equal(result.code, 1, result.stderr);
    assert.equal((await loadConfig(root)).budget.maxUsd, 0); assert.equal(requests, 0);
    await assert.rejects(readFile(join(root, statePath, 'lock', 'pid')), /ENOENT/);
  }
  for (const amount of ['10', '3.75', 'unlimited']) {
    const result = await cli('plan', '--budget', amount); assert.equal(result.code, 0, result.stderr);
    assert.equal((await loadConfig(root)).budget.maxUsd, amount === 'unlimited' ? amount : Number(amount));
    assert.equal(JSON.parse(result.stdout).tasks[0].candidates[0].scoutId, 'lab/model');
    assert.deepEqual(await readJSON(ledgerPath), ledger);
    const again = await cli('plan'); assert.equal(again.code, 0, again.stderr);
  }
  const previousPlan = await readJSON(join(root, statePath, 'plan.json'));
  unavailable = true;
  const failed = await cli('plan', '--budget', '20'); assert.equal(failed.code, 1); assert.match(failed.stderr, /HTTP 503/);
  assert.equal((await loadConfig(root)).budget.maxUsd, 20);
  assert.deepEqual(await readJSON(join(root, statePath, 'plan.json')), previousPlan);
  assert.deepEqual(await readJSON(ledgerPath), ledger);
  await assert.rejects(readFile(join(root, statePath, 'lock', 'pid')), /ENOENT/);
  unavailable = false;
  assert.equal((await cli('plan')).code, 0); assert.equal((await loadConfig(root)).budget.maxUsd, 20);
});
