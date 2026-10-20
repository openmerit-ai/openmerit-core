import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadConfig, snapshot, materialize, readJSON, saveJSON, statePath, digest, reservationFor } from './config.mjs';
import { validatePlan } from './scout.mjs';
import { preflight, runAgent, invocation } from './adapters.mjs';
import { execute, agentEnvironment } from './process.mjs';
import { summarize, isVolatile, compareReports } from './report.mjs';

async function optionalJSON(path) { try { return await readJSON(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
export async function acquireLock(root) {
  const lock = join(root, statePath, 'lock'); await mkdir(join(root, statePath), { recursive: true });
  try { await mkdir(lock); } catch (error) { if (error.code === 'EEXIST') throw new Error('An eval run/watch owns this project. Stop it first. After a crash, verify the PID in .openmerit/eval/lock/pid before removing that lock directory.'); throw error; }
  await writeFile(join(lock, 'pid'), String(process.pid));
  return () => rm(lock, { recursive: true, force: true });
}
export function budgetUsed(ledger) {
  if (ledger?.version !== 1 || !Array.isArray(ledger.entries) || ledger.entries.some(e => !Number.isFinite(e.reservationUsd) || e.reservationUsd <= 0 || e.costUsd !== null && (!Number.isFinite(e.costUsd) || e.costUsd < 0))) throw new Error('Invalid budget ledger. Restore it before running; never discard unknown charges.');
  // Agent prices are estimates, not provider settlement. Never release a
  // reservation on that evidence, including entries written by older previews.
  return ledger.entries.reduce((sum, e) => sum + Math.max(e.costUsd ?? 0, e.reservationUsd), 0);
}

export async function evaluate(root, { signal, onProgress = () => {}, agentRunner = runAgent, checkAgent = preflight } = {}) {
  const config = await loadConfig(root), plan = await readJSON(join(root, statePath, 'plan.json'));
  validatePlan(config, plan);
  const snap = await snapshot(root, config);
  const selected = new Set(plan.tasks.flatMap(t => t.candidates.flatMap(c => c.connections)));
  const versions = {};
  const ledgerPath = join(root, statePath, 'budget.json');
  const ledger = await optionalJSON(ledgerPath) ?? { version: 1, entries: [] };
  const reservationUsd = reservationFor(config, plan), unlimitedBudget = config.budget.maxUsd === 'unlimited';
  const exhausted = () => { const used = budgetUsed(ledger); return !unlimitedBudget && used + reservationUsd > config.budget.maxUsd + 1e-10; };
  if (exhausted()) throw new Error('Evaluation budget is exhausted or disabled. Choose a budget with eval plan --budget <USD|unlimited>; prior reservations still count.');
  const runnerVersion = (await readJSON(new URL('../../../package.json', import.meta.url))).version;
  const commands = config.connections.filter(c => selected.has(c.id)).map(c => ({ id: c.id, args: invocation(c, reservationUsd, unlimitedBudget) }));
  const report = { version: 2, runnerVersion, budgetLimitUsd: config.budget.maxUsd, reservationUsd, id: randomUUID(), startedAt: new Date().toISOString(), revision: snap.revision, compatibility: null, planHash: digest(plan.tasks), agentVersions: versions, status: 'running', rows: [], summary: [] };
  const reportPath = join(root, statePath, 'runs', `${report.startedAt.replace(/[:.]/g, '-')}-${report.id}.json`);
  const previous = await optionalJSON(join(root, statePath, 'latest.json'));
  const temp = await mkdtemp(join(tmpdir(), 'openmerit-eval-'));
  const checkpoint = async () => { report.summary = summarize(report.rows); await saveJSON(reportPath, report); };
  try {
    await checkpoint();
    for (const connection of config.connections.filter(c => selected.has(c.id))) {
      try { versions[connection.id] = await checkAgent(connection, { cwd: temp }); }
      catch (error) { error.connection = connection.id; throw error; }
    }
    // Graders are copied outside all agent workspaces, before any trial runs.
    for (const task of snap.tasks) await materialize(task.graderFiles, join(temp, 'graders', task.id));
    outer: for (const task of snap.tasks) {
      const taskPlan = plan.tasks.find(t => t.id === task.id);
      const cells = taskPlan.candidates.flatMap(candidate => candidate.connections.flatMap(connection => snap.variants.map(variant => ({ connection: config.connections.find(c => c.id === connection), variant, candidate }))));
      for (let round = 0; round < config.repeats.max; round++) {
        // Rotate and reverse the balanced order so one candidate is not always warm/last.
        const ordered = [...cells.slice(round % cells.length), ...cells.slice(0, round % cells.length)];
        if (round % 2) ordered.reverse();
        for (const { connection, variant, candidate } of ordered) {
          if (signal?.aborted) { report.status = 'cancelled'; report.reason = 'Interrupted'; break outer; }
          if (exhausted()) { report.status = 'budget_stopped'; report.reason = 'Cumulative budget cannot admit another reserved attempt.'; break outer; }
          const entry = { id: randomUUID(), run: report.id, reservationUsd, costUsd: null, settled: false };
          ledger.entries.push(entry); await saveJSON(ledgerPath, ledger);
          const workspace = join(temp, entry.id); await mkdir(workspace);
          await materialize(task.fixtureFiles, workspace, task.fixture);
          await materialize(variant.sourceFiles, workspace);
          const prompt = `${task.prompt}\n\n${variant.instructions}\n\nThis is an isolated evaluation attempt. Do not run OpenMerit evaluation commands or inspect paths outside this workspace.`;
          const result = await agentRunner(connection, prompt, { cwd: workspace, timeoutMs: config.timeoutSeconds * 1000, signal, reservationUsd, unlimitedBudget });
          entry.costUsd = result.costUsd; entry.costBasis = result.costBasis ?? (result.costUsd === null ? 'unknown' : 'agent_estimate');
          entry.partialCostUsd = result.partialCostUsd ?? null; entry.reservationUsd = Math.max(entry.reservationUsd, result.partialCostUsd ?? 0); entry.settled = true; await saveJSON(ledgerPath, ledger);
          let quality = result.status === 'ok' || result.failureReason ? null : 0, status = result.status;
          if (result.status === 'ok') {
            const grader = await execute(process.execPath, [join(temp, 'graders', task.id, task.grader)], { cwd: temp, env: agentEnvironment(), input: JSON.stringify({ workspace, output: result.output }), timeoutMs: 30_000, signal });
            try {
              const value = JSON.parse(grader.stdout);
              if (grader.code !== 0 || grader.reason || typeof value.quality !== 'number' || !Number.isFinite(value.quality) || value.quality < 0 || value.quality > 1) throw new Error('Invalid grade');
              quality = value.quality;
            } catch { status = 'grader_error'; }
          }
          const row = { task: task.id, connection: connection.id, agent: connection.agent, requestedModel: connection.model, observedModels: result.observedModels, scoutId: candidate.scoutId, scoutRank: candidate.rank, variant: variant.id, round: round + 1, quality, status, failureReason: result.failureReason ?? null, usage: result.usage, costUsd: result.costUsd, partialCostUsd: result.partialCostUsd ?? null, costBasis: entry.costBasis, seconds: result.seconds };
          report.rows.push(row); await checkpoint(); await rm(workspace, { recursive: true, force: true });
          onProgress(row);
          if (result.failureReason) {
            report.status = result.failureReason === 'budget_exhausted' ? 'budget_stopped' : result.failureReason === 'cancelled' ? 'cancelled' : ['sandbox_unavailable', 'permission_denied', 'spawn_failed'].includes(result.failureReason) ? 'environment_blocked' : 'connection_blocked';
            report.reason = `${connection.id}: ${result.failureReason}. This attempt is unscored; resolve the execution block before retrying.`;
            break outer;
          }
          if (status === 'grader_error') { report.status = 'invalid'; report.reason = `Grader failed for ${task.id}. Fix it before collecting more trials.`; break outer; }
        }
        if (round + 1 >= config.repeats.min && !isVolatile(report.rows.filter(r => r.task === task.id))) break;
      }
    }
    if (report.status === 'running') report.status = 'complete';
  } catch (error) {
    if (error.failureReason) {
      report.status = 'environment_blocked'; report.reason = `${error.connection}: ${error.failureReason}. ${error.message}`;
      report.blockers = [{ connection: error.connection, failureReason: error.failureReason }];
    } else {
      report.status = 'error'; report.reason = 'Execution failed; unsettled reservations remain charged. Check configuration and agent authentication.';
      throw error;
    }
  } finally {
    report.finishedAt = new Date().toISOString(); report.budgetUsedUsd = budgetUsed(ledger);
    report.compatibility = digest({ accountingVersion: report.version, snapshot: snap.compatibility, versions, runnerVersion, commands, observedModels: Object.fromEntries([...selected].sort().map(id => [id, [...new Set(report.rows.filter(r => r.connection === id).flatMap(r => r.observedModels ?? []))].sort()])) });
    report.summary = summarize(report.rows); report.comparison = compareReports(report, previous);
    await saveJSON(reportPath, report); await saveJSON(join(root, statePath, 'latest.json'), report);
    await rm(temp, { recursive: true, force: true });
  }
  return report;
}

export async function watch(root, { signal, onReport, onProgress, intervalMs = 1500, ...options } = {}) {
  let last = null, pending = null;
  while (!signal?.aborted) {
    const config = await loadConfig(root), current = (await snapshot(root, config)).revision;
    if (current !== last && current === pending) {
      const result = await evaluate(root, { signal, onProgress, ...options });
      onReport?.(result); last = result.revision;
      if (result.status !== 'complete') return result;
    }
    pending = current;
    await new Promise(resolve => { const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, intervalMs); signal?.addEventListener('abort', done, { once: true }); });
  }
}
