import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from '../../dist/core/src/index.js';
import { harnessModel, limits, taskPolicy, applicationConfig } from './config.mjs';
import { task, models, fixtures, rubric } from './task.mjs';
import { root, json, save } from './work.mjs';
import { classify } from './application.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 45832);
const local = process.env.DEMO_LOCAL === '1';
const policy=taskPolicy(task.id);
let child, startedAt, busy = false, stopped = false, failure = null, tries = 0, transcript = [], toolCalls = 0;
let serial = Promise.resolve();
const promptsSent = new Set();
const redact = value => {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [process.env.OPENROUTER_API_KEY, process.env.DEMO_PROXY_TOKEN]) if (secret) text = text.replaceAll(secret, '[redacted]');
  return text.replace(/sk-or-v1-[a-zA-Z0-9]+/g, '[redacted]');
};
const log = (message, kind = 'info') => { transcript.push({ at: new Date().toISOString(), message: redact(message).slice(0, 2500), kind }); transcript = transcript.slice(-100); };
const send = message => { if (!child || stopped) throw new Error('The Pi session is not running.'); child.stdin.write(JSON.stringify(message) + '\n'); };
const prompt = message => send({ type: 'prompt', message, streamingBehavior: 'followUp' });
const fail = message => { failure = redact(message); log(failure, 'error'); child?.kill('SIGTERM'); };

async function advance() {
  if (stopped || failure) return;
  const state = await json('.openmerit/state.json');
  if (state?.activeIntent) {
    const retry = `continue-${state.activeIntent.id}`;
    if (!promptsSent.has(retry)) {
      promptsSent.add(retry);
      prompt('The browser visitor has already explicitly confirmed authorization.json and the prepared policy. Continue the active OpenMerit intent now using demo_work. Submit the saved artifact name with the active intentId and a truthful summary to openmerit_complete_intent. The bridge loads the exact measured evidence.');
    } else fail('The harness stopped before completing its active intent. No successful outcome is claimed.');
    return;
  }
  if (state?.lastResult?.status === 'failed') return fail(state.lastResult.summary);
  if (state?.cycle.stage === 'collecting_baseline') {
    const measured = await json('evidence/result-baseline.json');
    if (!measured && !promptsSent.has('baseline')) {
      promptsSent.add('baseline');
      prompt('Setup is complete. Call demo_work with phase baseline, then call openmerit_report_signal with artifact baseline. Do not complete an intent for this measurement window.');
    } else if (measured && !state.automation.baselineMetricWindows?.length && !promptsSent.has('report-baseline')) {
      promptsSent.add('report-baseline'); prompt('The measured baseline artifact is ready. Call openmerit_report_signal with artifact baseline now.');
    } else if (measured && state.automation.baselineMetricWindows?.length && !promptsSent.has('assess')) {
      promptsSent.add('assess'); prompt('/openmerit assess');
    }
  } else if (state?.cycle.stage === 'swap_applied' && !promptsSent.has('verify')) {
    promptsSent.add('verify');
    prompt('The authorized change is applied. Call demo_work with phase verification_window, then call openmerit_report_signal with artifact verification_window. Wait for the verification intent before completing it.');
  }
}

async function start() {
  if (startedAt) throw new Error('This session has already started.');
  if (!process.env.OPENROUTER_API_KEY && !process.env.DEMO_PROXY_TOKEN) throw new Error('Live inference is not configured.');
  startedAt = new Date().toISOString();
  await mkdir(root(), { recursive: true });
  await save('authorization.json', { confirmedAt: startedAt, task:task.id, policy });
  await save('application-config.json', applicationConfig(task,models[0].id));
  await save('baseline-config.json', applicationConfig(task,models[0].id));
  const instructions = `This is a prepared, bounded OpenMerit demonstration. The visitor confirmed the policy in authorization.json through the browser. The application route, synthetic fixtures, exact-match grader, model shortlist, and helper operations were prepared by the demo author. Do not claim you generated them. You must use the real OpenMerit extension and complete its active intents with actual evidence.\n\nFor establish_evals use demo_work phase setup. For every other intent use demo_work with the intent kind as phase. Call openmerit_complete_intent with the exact active intentId, artifact set to the demo_work phase, and a short truthful summary. The demo bridge loads the saved measured outputs and evidence into the canonical adapter; OpenMerit validates them. Do not invent evidence. The tool's measurements are real application calls, never your own usage. For an error, report a failed intent with the actual reason; do not retry paid work in a loop.\n\nThe host will request baseline and verification_window collection separately. For those, use demo_work then openmerit_report_signal with artifact equal to the phase name. The host handles user approval with /openmerit approve. Never approve a change on behalf of the visitor. Do not ask for setup approval again: it is already recorded. Do not change policy, tools, models, or fixtures. Keep responses brief.\n`;
  await writeFile(join(root(), 'AGENTS.md'), instructions);
  await mkdir(join(root(), '.pi'), { recursive: true });
  if (process.env.DEMO_INFERENCE_URL) {
    const baseUrl = process.env.DEMO_INFERENCE_URL.replace(/\/chat\/completions$/, '');
    const agentDir = join(root(), '.pi-agent');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { openrouter: { baseUrl, apiKey: '$DEMO_PROXY_TOKEN' } } }));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  }
  const store = new ProjectStore(root());
  await store.initialize({ schemaVersion: 1, taskProfiles: [] }, {
    schemaVersion: 1, cycle: { id: 'demo-cycle', stage: 'unconfigured', activeCandidateId: 'incumbent', verifiedSwapCount: 0, baselineEvidenceSufficient: false },
    automation: { setupNudgeShown: false, observedCompletedTasks: 0, lastAssessmentTaskCount: 0 }, updatedAt: startedAt,
  });
  const pi = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const piCli = join(dirname(pi), 'cli.js');
  const extension = join(here, 'adapter.mjs');
  child = spawn(process.execPath, [piCli, '--mode', 'rpc', '--provider', 'openrouter', '--model', harnessModel,
    '--thinking', 'off', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
    '-e', extension, '-e', join(here, 'extension.mjs'),
    '--tools', 'demo_work,openmerit_complete_intent,openmerit_report_signal',
  ], { cwd: root(), env: { ...process.env, DEMO_WORKSPACE: root() }, stdio: ['pipe', 'pipe', 'pipe'] });
  let pending = '';
  child.stdout.on('data', chunk => {
    pending += chunk.toString();
    if (pending.length > 2_000_000) return fail('Pi output exceeded the session limit.');
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      let item; try { item = JSON.parse(line); } catch { continue; }
      if (item.type === 'agent_start') busy = true;
      if (item.type === 'agent_end') { busy = false; serial = serial.then(advance).catch(e => fail(e.message)); }
      if (item.type === 'tool_execution_start') {
        if (++toolCalls > 36) return fail('The session reached its tool-call limit.');
        log(`${item.toolName}${item.args?.phase ? ` · ${item.args.phase}` : ''}`, 'tool');
      }
      if (item.type === 'tool_execution_end' && item.isError) {
        log(item.result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || 'A tool failed.', 'error');
      }
      if (item.type === 'extension_ui_request') {
        if (item.method === 'notify') log(item.message ?? 'OpenMerit notification.');
        if (['select', 'confirm', 'input', 'editor'].includes(item.method)) {
          send({ type: 'extension_ui_response', id: item.id, cancelled: true });
          fail('Pi requested an unexpected dialog. This prepared flow needs operator attention.');
        }
      }
      if (item.type === 'response' && !item.success) log(item.error ?? 'Pi rejected a request.', 'error');
      if (item.type === 'message_end' && item.message?.stopReason === 'error') fail(item.message.errorMessage ?? 'The harness model failed.');
      if (item.type === 'message_end' && item.message?.role === 'assistant') {
        const text = item.message.content?.filter(c => c.type === 'text').map(c => c.text).join('\n');
        if (text) log(text, 'assistant');
      }
    }
  });
  child.stderr.on('data', chunk => log(redact(chunk.toString()), 'diagnostic'));
  child.on('error', e => fail(e.message));
  child.on('exit', code => {
    busy = false;
    if (!stopped && !failure && code !== 0) fail(`Pi exited with code ${code}.`);
  });
  setTimeout(() => { stopped = true; child?.kill('SIGTERM'); log('The ten-minute sandbox session has ended.'); }, limits.lifetimeSeconds * 1000).unref();
  log('Visitor confirmed the prepared fixture policy. Starting Pi with the OpenMerit extension.');
  prompt('/openmerit setup');
}

async function state() {
  const s = await json('.openmerit/state.json');
  const batches = {};
  for (const name of ['baseline', 'trial-1', 'trial-2', 'verification']) {
    const batch = await json(`evidence/${name}.json`);
    if (batch) batches[name] = batch;
  }
  let progress = [];
  try { progress = (await readFile(join(root(), 'evidence/progress.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { /* No progress yet. */ }
  return { startedAt, busy, stopped, failure, task:task.id, build: process.env.DEMO_BUILD ?? 'local-development', models, harnessModel,
    cycle: s?.cycle, activeIntent: s?.activeIntent?.kind, batches, transcript, progress: progress.slice(-40),
    comparison: await json('evidence/comparison.json'), config: await json('application-config.json'), diff: await json('evidence/configuration-diff.json'),
    rollback: await json('evidence/rollback.json'), triesRemaining: Math.max(0, (task.maximumTries ?? 4) - tries) };
}

async function body(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > 6000) throw new Error('Request is too large.'); }
  return data ? JSON.parse(data) : {};
}
function respond(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(redact(data));
}

export const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/health') return respond(res, { ok: true });
    const path = pathname.replace(/^\/demo\/api/, '');
    if (local && ['POST', 'DELETE'].includes(req.method) && req.headers.origin !== `http://127.0.0.1:${port}` && req.headers.origin !== `http://localhost:${port}` && !process.env.DEMO_TEST_CLIENT) return respond(res, { error: 'Origin is not allowed.' }, 403);
    if (req.method === 'GET' && path === '/config') return respond(res, { enabled: true, task:task.id, models, harnessModel, sampleCount: fixtures.length, verificationCount: task.verificationCount ?? 6, policy, limits:{...limits,maxOutputTokens:task.maxOutputTokens ?? limits.maxOutputTokens} });
    if (req.method === 'GET' && path === '/session') return respond(res, await state());
    if (req.method === 'POST' && path === '/session') {
      const input = await body(req); if (input.confirmed !== true) throw new Error('Confirm the demo policy to start.');
      if (input.task && input.task !== task.id) throw new Error('This sandbox is bound to another task.');
      await start(); return respond(res, await state(), 201);
    }
    if (req.method === 'POST' && path === '/approve') {
      const input = await body(req), s = await json('.openmerit/state.json');
      if (stopped || failure || busy || s?.activeIntent || s?.cycle.stage !== 'frontier_ready' || !s.cycle.proposedCandidateId || input.candidateId !== s.cycle.proposedCandidateId) throw new Error('This proposal is not available for approval.');
      if (await json('approval.json')) throw new Error('This proposal was already approved.');
      await save('approval.json', { candidateId: input.candidateId, at: new Date().toISOString() });
      prompt('/openmerit approve'); return respond(res, { accepted: true });
    }
    if (req.method === 'POST' && path === '/try') {
      const input = await body(req), s = await json('.openmerit/state.json');
      if (!startedAt || stopped || failure || busy || s?.activeIntent || !['frontier_ready', 'swap_verified', 'monitoring'].includes(s?.cycle.stage)) throw new Error('Finish the comparison before trying another input.');
      if (s?.cycle.stage === 'frontier_ready' && s.cycle.proposedCandidateId) throw new Error('Approve and verify the model change first.');
      if (tries >= (task.maximumTries ?? 4)) throw new Error('This session has reached its custom-input limit.');
      const text = input.text ?? input.email;
      if (typeof text !== 'string' || text.length < 5 || text.length > 1200) throw new Error('Use an input between 5 and 1,200 characters.');
      tries++;
      const config = await json('application-config.json');
      const [before, after] = await Promise.all([classify(text, models[0].id), classify(text, config.model)]);
      return respond(res, { before, after, scored: false });
    }
    if (req.method === 'GET' && path === '/evidence') {
      const files = {};
      for (const file of await readdir(join(root(), 'evidence')).catch(() => [])) if (file.endsWith('.json')) files[file] = await json(`evidence/${file}`);
      files['openmerit-state.json'] = await json('.openmerit/state.json');
      files['openmerit-config.json'] = await json('.openmerit/config.json');
      try { files['openmerit-audit'] = (await readFile(join(root(), '.openmerit/events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse); } catch { /* No events yet. */ }
      return respond(res, { task:task.id, environment:local?'local':'cloudflare', rubric, fixtures, files, build: process.env.DEMO_BUILD ?? 'local-development' });
    }
    if (req.method === 'DELETE' && path === '/session') { stopped = true; child?.kill('SIGTERM'); return respond(res, { stopped: true }); }
    if (local && req.method === 'GET') {
      const site = resolve(here, '../../site');
      const file = resolve(site, '.' + (pathname === '/demo' || pathname === '/demo/' ? '/demo/index.html' : pathname));
      if (!file.startsWith(site + '/')) return respond(res, { error: 'Not found.' }, 404);
      const bytes = await readFile(file);
      const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }); return res.end(bytes);
    }
    respond(res, { error: 'Not found.' }, 404);
  } catch (error) { respond(res, { error: redact(error.message) }, 400); }
});
server.listen(port, local ? '127.0.0.1' : '0.0.0.0', () => console.log(`Demo runner listening on ${port}.`));
process.on('SIGTERM', () => { stopped = true; child?.kill('SIGTERM'); server.close(); });
