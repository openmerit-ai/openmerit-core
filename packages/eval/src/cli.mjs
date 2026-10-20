import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { agents, preflight } from './adapters.mjs';
import { configPath, statePath, starter, loadConfig, readJSON, saveJSON } from './config.mjs';
import { makePlan, savePlan } from './scout.mjs';
import { acquireLock, evaluate, watch } from './runner.mjs';
import { formatReport } from './report.mjs';

export const help = `OpenMerit · Agent evaluations (source preview)

  openmerit eval init                 Add a starter suite and project agent instructions
  openmerit eval doctor               Check installed Claude Code, Codex and OpenCode CLIs
  openmerit eval plan [--scope existing|all] [--budget <USD|unlimited>]
                                     Choose scope and budget, then freeze Scout's shortlist
  openmerit eval run [--json]         Evaluate the frozen shortlist in fresh workspaces
  openmerit eval watch [--json]       Repeat after selected CLI/docs/fixture files change
  openmerit eval report [--json]      Read the latest result without running models

  --path <directory>                 Project directory (default: current directory)

Configure .openmerit/eval.json: explicit agent connections, task fixtures, local
graders, CLI variants, 3–10 repeats, and a cumulative budget. Init starts at $0.
Plan asks for $10, a custom amount, or no fixed cap; nothing is preselected.
Saved choices and prior budget usage persist across reruns. --budget changes
the total allowance, not the amount remaining. Reservations are automatic.
Scout receives task descriptions and, for existing scope, model IDs only.
Run/watch execute local agents and may incur charges. No background daemon.
`;

const instructions = `<!-- openmerit-eval:start -->
## OpenMerit agent evaluations

When building or changing this project's CLI, tools or harness documentation, use
\`openmerit eval\` to compare task performance. Skip this workflow when
\`OPENMERIT_EVAL=1\` to avoid recursive evaluations.

- Read .openmerit/eval.json and run \`openmerit eval doctor\`.
- Ask once: "Models available through this project's existing connections, or all models Scout indexes?" Use \`eval plan --scope existing\` or \`--scope all\`. Reuse the saved choice. Never infer endpoint access from a model name or expose credentials.
- Then ask once: "What budget should OpenMerit use for this project's evaluations? 1. $10; 2. Custom amount (how much?); 3. No fixed cap." Pass the explicit answer as \`eval plan --budget 10\`, \`--budget <amount>\` or \`--budget unlimited\`, together with scope on first setup. Never choose a default or infer unlimited spending. Reuse an existing positive or unlimited budget unless the user changes it. The allowance is cumulative across reruns, not reset by edits or replanning. Reservations are internal; do not ask the user to calculate them. No fixed cap still has bounded tasks, 3–10 repetitions, timeouts and user-controlled watch; subsequent watched edits can incur further charges until stopped.
- Declare real connections with Scout model IDs, agent-native model IDs, and environment variable NAMES. Existing scope uses this project-declared inventory. All scope may require new authenticated connections before execution.
- Replace starter cases with representative tasks, fresh fixtures and deterministic standalone Node graders. A grader reads {workspace, output} JSON on stdin and returns {quality: 0..1}. Keep answer keys outside agent workspaces. Include a bare variant and a CLI/docs variant where useful.
- Confirm the suite and variants before enabling paid runs, using the budget already selected above. Do not ask again for an unchanged authorized budget. Then plan once, run a baseline, make the requested CLI changes, and run again. Use \`eval watch\` only when the user wants continuous local reruns; it exits with the terminal and retains budget usage across restarts.
- Report quality, failures, tokens, reported costs and elapsed time per task/model/variant. A shortlist is a prior, not measured success. Do not claim missing costs are zero or that 3–10 repeats prove an exact ordering. Keep fresh holdouts for final validation.
- If a compatible watcher is already active, let it run; never start overlapping loops. Do not overwrite the frozen plan merely because the CLI changed.
<!-- openmerit-eval:end -->`;

export async function initialize(root) {
  // Refuse partial overwrite of an existing suite or someone's fixtures.
  const files = {
    [configPath]: JSON.stringify(starter, null, 2) + '\n',
    'eval/fixtures/json/request.txt': 'Customer: Mira Chen\nItems: 7\n',
    'eval/tool.mjs': `import {readFileSync} from 'node:fs';\nconst s=readFileSync(process.argv[2],'utf8');\nconsole.log(JSON.stringify({name:s.match(/Customer: (.*)/)?.[1],count:Number(s.match(/Items: (\\d+)/)?.[1])}));\n`,
    'eval/grade.mjs': `let input=''; for await (const chunk of process.stdin) input+=chunk;\nconst {output}=JSON.parse(input); let quality=0;\ntry {const v=JSON.parse(output); quality=(Number(v.name==='Mira Chen')+Number(v.count===7)+Number(Object.keys(v).sort().join(',')==='count,name'))/3;} catch {}\nconsole.log(JSON.stringify({quality}));\n`,
  };
  for (const file of Object.keys(files)) {
    try { await readFile(join(root, file)); throw new Error(`Already exists: ${file}. Init does not overwrite a suite.`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const [file, body] of Object.entries(files)) { await mkdir(join(root, file, '..'), { recursive: true }); await writeFile(join(root, file), body, { flag: 'wx' }); }
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    let body = ''; try { body = await readFile(join(root, name), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!body.includes('<!-- openmerit-eval:start -->')) await writeFile(join(root, name), `${body}${body ? '\n\n' : ''}${instructions}\n`);
  }
  let ignore = ''; try { ignore = await readFile(join(root, '.gitignore'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!ignore.split('\n').includes('/.openmerit/eval/')) await writeFile(join(root, '.gitignore'), `${ignore}${ignore.endsWith('\n') || !ignore ? '' : '\n'}/.openmerit/eval/\n`);
}

export function parseBudget(value) {
  const input = value.trim();
  if (input === 'unlimited') return input;
  const amount = input.replace(/^\$/, '');
  if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(amount) || Number(amount) <= 0 || Number(amount) > Number.MAX_SAFE_INTEGER / 100) throw new Error('Enter a positive USD amount with at most two decimal places, or "unlimited" for no fixed cap.');
  return Number(amount);
}

// ask is supplied only for an interactive terminal. Coding agents pass explicit
// flags after asking the user; EOF, blank input and missing flags never consent.
export async function choosePlanOptions(config, { scope, budget, ask, tell = () => {} } = {}) {
  const next = structuredClone(config);
  if (scope) next.scope = scope;
  while (!['existing', 'all'].includes(next.scope)) {
    if (!ask) throw new Error('Choose a scope with eval plan --scope existing or --scope all, then choose --budget <USD|unlimited>.');
    const answer = (await ask('Use existing project connections or all models Scout indexes? [existing/all] ')).trim();
    if (['existing', 'all'].includes(answer)) next.scope = answer;
    else tell('Choose existing or all.');
  }
  if (budget !== undefined) next.budget = { maxUsd: parseBudget(budget), reservationUsd: 'auto' };
  while (next.budget.maxUsd === 0) {
    if (!ask) throw new Error('Choose an evaluation budget after model scope: --budget 10, --budget <USD>, or --budget unlimited. No amount is selected automatically.');
    const choice = (await ask('What budget should OpenMerit use for this project’s evaluations?\n  1. $10\n  2. Custom amount\n  3. No fixed cap (watched changes can incur further charges until stopped)\nChoose [1/2/3]: ')).trim();
    if (choice === '1') next.budget = { maxUsd: 10, reservationUsd: 'auto' };
    else if (choice === '3') next.budget = { maxUsd: 'unlimited', reservationUsd: 'auto' };
    else if (choice === '2') {
      while (next.budget.maxUsd === 0) {
        const amount = await ask('How much in USD? ');
        try {
          const parsed = parseBudget(amount);
          if (parsed === 'unlimited') throw new Error('Enter a custom USD amount.');
          next.budget = { maxUsd: parsed, reservationUsd: 'auto' };
        } catch { tell('Enter a positive USD amount with at most two decimal places.'); }
      }
    } else tell('Choose 1, 2 or 3. Nothing is selected automatically.');
  }
  return next;
}

export async function main(args) {
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(help); return; }
  const action = args.shift(); let root = process.cwd(), scope, budget, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--path' && args[i + 1]) root = resolve(args[++i]);
    else if (args[i] === '--scope' && ['existing', 'all'].includes(args[i + 1])) scope = args[++i];
    else if (args[i] === '--budget' && args[i + 1] && budget === undefined) { budget = args[++i]; parseBudget(budget); }
    else if (args[i] === '--json') json = true;
    else throw new Error(`Unknown eval argument: ${args[i]}`);
  }
  if (scope && action !== 'plan') throw new Error('--scope belongs to eval plan.');
  if (budget !== undefined && action !== 'plan') throw new Error('--budget belongs to eval plan.');
  if (action === 'init') { await initialize(root); console.log('Created .openmerit/eval.json, starter fixtures, and AGENTS.md / CLAUDE.md instructions. Declare connections, replace the starter task, and set an approved budget before running.'); return; }
  if (action === 'doctor') {
    const results = [];
    for (const agent of agents) { try { results.push({ agent, version: await preflight({ agent }), ready: true }); } catch (error) { results.push({ agent, ready: false, reason: error.message }); } }
    console.log(JSON.stringify(results, null, 2)); return;
  }
  if (action === 'report') { const report = await readJSON(join(root, statePath, 'latest.json')); console.log(json ? JSON.stringify(report, null, 2) : formatReport(report)); return; }
  if (!['plan', 'run', 'watch'].includes(action)) throw new Error('Unknown eval command. Run openmerit eval --help.');
  const unlock = await acquireLock(root);
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (action === 'plan') {
      const saved = await loadConfig(root);
      const rl = process.stdin.isTTY && !json ? createInterface({ input: process.stdin, output: process.stdout }) : null;
      const inputClosed = new AbortController();
      rl?.once('close', () => inputClosed.abort());
      let config;
      try { config = await choosePlanOptions(saved, { scope, budget, ask: rl ? question => rl.question(question, { signal: AbortSignal.any([controller.signal, inputClosed.signal]) }) : undefined, tell: message => console.log(message) }); }
      finally { rl?.close(); }
      // Preserve explicit choices even if Scout is temporarily unavailable.
      await saveJSON(join(root, configPath), config);
      const plan = await makePlan(config);
      await savePlan(root, plan);
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    const onReport = report => { console.log(json ? JSON.stringify(report) : formatReport(report)); if (report.status !== 'complete') process.exitCode = 1; };
    const onProgress = json ? () => {} : row => process.stderr.write(`${row.task} · ${row.connection} · ${row.variant} · ${row.round}: ${row.status}\n`);
    if (action === 'run') onReport(await evaluate(root, { signal: controller.signal, onProgress }));
    else { if (!json) console.log('Watching selected files. Ctrl+C stops; budget usage persists.'); await watch(root, { signal: controller.signal, onReport, onProgress }); }
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await unlock(); }
}
