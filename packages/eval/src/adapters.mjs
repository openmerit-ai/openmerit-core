import { execute, agentEnvironment } from './process.mjs';

const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const sum = values => values.length && values.every(v => v !== null) ? values.reduce((a, b) => a + b, 0) : null;
const maximum = values => values.some(v => v !== null) ? Math.max(...values.filter(v => v !== null)) : null;
export const agents = ['claude', 'codex', 'opencode'];

export function connectionFailure(text) {
  if (/budget_exhausted|error_max_budget_usd|(?:maximum|exceeded|exhausted|insufficient).{0,25}(?:budget|credits)|(?:budget|credits).{0,25}(?:exceeded|exhausted)/i.test(text)) return 'budget_exhausted';
  if (/(?:bwrap|bubblewrap|sandbox|landlock|seccomp|unshare|user namespace|uid_map).{0,160}(?:failed|not permitted|unavailable|denied)|failed to (?:start|initialize|create).{0,40}sandbox/i.test(text)) return 'sandbox_unavailable';
  if (/\b(?:HTTP\s*)?401\b.{0,30}(?:unauthorized|authentication)|unauthorized|authentication[_ -]?(?:error|required)|invalid api key|not logged in|please log in/i.test(text)) return 'authentication';
  if (/model.{0,100}(?:not supported|not found|not available|does not exist)|(?:unknown|invalid|unsupported) model|ProviderModelNotFoundError/i.test(text)) return 'model_unavailable';
  if (/rejected permission|permission.{0,30}(?:denied|rejected)|not allowed to use.{0,30}tool/i.test(text)) return 'permission_denied';
  return null;
}

function toolFailure(text) {
  const reason = connectionFailure(text);
  // A task's own HTTP/auth/budget errors are task outcomes, not evidence that
  // the coding agent's provider connection failed.
  return ['sandbox_unavailable', 'permission_denied'].includes(reason) ? reason : null;
}

export function invocation(connection, reservationUsd, unlimitedBudget = false) {
  const model = connection.model;
  if (connection.agent === 'claude') return ['-p', '--output-format', 'json', '--model', model, '--no-session-persistence', '--permission-mode', 'dontAsk', '--allowedTools', 'Read,Glob,Grep,Bash,Edit,Write', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', ...(unlimitedBudget ? [] : ['--max-budget-usd', String(reservationUsd)])];
  if (connection.agent === 'codex') return ['exec', '--json', '--model', model, '--sandbox', 'workspace-write', '--skip-git-repo-check', '--ephemeral', '-'];
  if (connection.agent === 'opencode') return ['run', '--format', 'json', '--model', model, '--auto'];
  throw new Error('Unknown agent. Use claude, codex or opencode.');
}

export function parseOutput(agent, stdout) {
  let events;
  try { const parsed = JSON.parse(stdout); events = Array.isArray(parsed) ? parsed : [parsed]; }
  catch { events = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
  let output = '', usage = null, costUsd = null, partialCostUsd = null, completed = false, failed = false, failureReason = null;
  // Only native failure fields are evidence of a blocked execution. Task text,
  // successful tool output and model commentary can legitimately discuss errors.
  const errors = events.filter(e => ['error', 'turn.failed'].includes(e.type));
  for (const event of errors) failureReason ??= connectionFailure(JSON.stringify(event));
  const observedModels = new Set();
  if (agent === 'claude') {
    const result = events.findLast(e => e.type === 'result');
    if (result) {
      completed = result.subtype === 'success' && !result.is_error;
      failed = !completed; output = result.result ?? '';
      const u = result.usage;
      if (u) usage = { input: sum([number(u.input_tokens), number(u.cache_read_input_tokens ?? 0), number(u.cache_creation_input_tokens ?? 0)]), output: number(u.output_tokens), cached: number(u.cache_read_input_tokens ?? 0) };
      const models = Object.values(result.modelUsage ?? {});
      if (models.length) {
        const modelUsage = { input: sum(models.map(m => sum([number(m.inputTokens), number(m.cacheReadInputTokens ?? 0), number(m.cacheCreationInputTokens ?? 0)]))), output: sum(models.map(m => number(m.outputTokens))), cached: sum(models.map(m => number(m.cacheReadInputTokens ?? 0))) };
        // A budget stop can emit zero aggregate usage but nonzero per-model usage.
        usage = Object.fromEntries(Object.keys(modelUsage).map(k => [k, maximum([usage?.[k] ?? null, modelUsage[k]])]));
      }
      costUsd = maximum([number(result.total_cost_usd), sum(models.map(m => number(m.costUSD)))]);
      for (const model of Object.keys(result.modelUsage ?? {})) observedModels.add(model);
      if (failed) failureReason ??= connectionFailure(JSON.stringify({ subtype: result.subtype, terminal_reason: result.terminal_reason, errors: result.errors }));
      if (result.permission_denials?.length) failureReason ??= 'permission_denied';
    }
  } else if (agent === 'codex') {
    const turns = events.filter(e => e.type === 'turn.completed');
    completed = turns.length > 0;
    failed = events.some(e => ['turn.failed', 'error'].includes(e.type));
    output = events.findLast(e => e.type === 'item.completed' && e.item?.type === 'agent_message')?.item.text ?? '';
    if (turns.length) usage = { input: sum(turns.map(e => number(e.usage?.input_tokens))), output: sum(turns.map(e => number(e.usage?.output_tokens))), cached: sum(turns.map(e => number(e.usage?.cached_input_tokens))) };
    for (const event of events.filter(e => e.type === 'item.completed' && e.item?.type === 'command_execution' && (e.item.exit_code > 0 || e.item.status === 'failed'))) {
      failureReason ??= toolFailure(event.item.aggregated_output ?? '');
    }
  } else if (agent === 'opencode') {
    const steps = events.filter(e => e.type === 'step_finish');
    const finalStep = steps.findLast(e => ['stop', 'end_turn'].includes(e.part?.reason));
    completed = !!finalStep;
    failed = events.some(e => e.type === 'error');
    const texts = events.filter(e => e.type === 'text');
    output = finalStep?.part?.messageID ? texts.filter(e => e.part?.messageID === finalStep.part.messageID).map(e => e.part?.text ?? '').join('\n') : texts.at(-1)?.part?.text ?? '';
    if (steps.length) {
      usage = { input: sum(steps.map(e => sum([number(e.part?.tokens?.input), number(e.part?.tokens?.cache?.read ?? 0), number(e.part?.tokens?.cache?.write ?? 0)]))), output: sum(steps.map(e => sum([number(e.part?.tokens?.output), number(e.part?.tokens?.reasoning ?? 0)]))), cached: sum(steps.map(e => number(e.part?.tokens?.cache?.read ?? 0))) };
      const costs = steps.map(e => number(e.part?.cost));
      costUsd = costs.every(c => c !== null && c > 0) ? sum(costs) : null;
      if (costUsd === null) partialCostUsd = sum(costs.filter(c => c !== null && c > 0));
    }
    for (const event of events.filter(e => e.type === 'tool_use' && e.part?.state?.status === 'error')) failureReason ??= toolFailure(event.part.state.error ?? '');
  }
  // Native zero prices can mean missing pricing metadata, not free inference.
  return { output, usage, costUsd: costUsd > 0 ? costUsd : null, partialCostUsd, completed: completed && !failed, failureReason, observedModels: [...observedModels] };
}

export async function preflight(connection, { cwd, executeCommand = execute, platform = process.platform } = {}) {
  const command = connection.command ?? connection.agent;
  const options = { cwd, timeoutMs: 10_000, env: agentEnvironment(connection.env) };
  const version = await executeCommand(command, ['--version'], options);
  const help = await executeCommand(command, connection.agent === 'codex' ? ['exec', '--help'] : connection.agent === 'opencode' ? ['run', '--help'] : ['--help'], options);
  const flags = connection.agent === 'codex' ? ['--json', '--ephemeral', '--sandbox'] : connection.agent === 'claude' ? ['--output-format', '--no-session-persistence', '--max-budget-usd'] : ['--format', '--model', '--auto'];
  if (version.code !== 0 || help.code !== 0 || !flags.every(f => (help.stdout + help.stderr).includes(f))) throw new Error(`${connection.agent} lacks the required non-interactive JSON interface. Update it or set this connection's command to a compatible executable.`);
  if (connection.agent === 'codex' && platform === 'linux') {
    const sandboxHelp = await executeCommand(command, ['sandbox', '--help'], options);
    const legacy = /^\s+linux\s/m.test(sandboxHelp.stdout);
    const probe = await executeCommand(command, ['-c', 'sandbox_mode="workspace-write"', 'sandbox', ...(legacy ? ['linux'] : []), '--', process.execPath, '-e', 'process.stdout.write("openmerit-sandbox-ok")'], options);
    if (probe.code !== 0 || probe.reason || probe.stdout !== 'openmerit-sandbox-ok') {
      throw Object.assign(new Error('Codex sandbox could not run a local probe. Fix host sandbox support before evaluating; no model request was made.'), { failureReason: 'sandbox_unavailable' });
    }
  }
  return version.stdout.trim().slice(0, 160);
}

export async function runAgent(connection, prompt, options) {
  const result = await execute(connection.command ?? connection.agent, invocation(connection, options.reservationUsd, options.unlimitedBudget), { ...options, input: prompt, env: agentEnvironment(connection.env) });
  const parsed = parseOutput(connection.agent, result.stdout);
  const failureReason = parsed.failureReason ?? (result.code !== 0 ? connectionFailure(result.stderr) : null) ?? (['spawn_failed', 'cancelled', 'output_limit'].includes(result.reason) ? result.reason : null);
  const status = failureReason === 'budget_exhausted' ? 'budget_exhausted' : ['sandbox_unavailable', 'permission_denied', 'spawn_failed'].includes(failureReason) ? 'environment_error' : result.reason ?? (failureReason || result.code !== 0 || !parsed.completed ? 'agent_error' : 'ok');
  return { ...parsed, costUsd: status === 'ok' ? parsed.costUsd : null, partialCostUsd: status === 'ok' ? parsed.partialCostUsd : maximum([parsed.costUsd, parsed.partialCostUsd]), costBasis: parsed.costUsd === null && parsed.partialCostUsd === null ? 'unknown' : 'agent_estimate', seconds: result.seconds, status, failureReason };
}
