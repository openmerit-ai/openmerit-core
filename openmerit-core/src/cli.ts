#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HELP = `OpenMerit: find cheaper models that perform at least as well as the ones your code uses today,
measured with an eval OpenMerit writes from a review of your code, and your own evals when you have them.
Scout runs locally with no account; the other commands are clients of an OpenMerit server, openmerit.ai
or one you run with \`openmerit server start\`.

Usage:
  openmerit setup                 Connect OpenMerit Harness (as openmerit connect does), register the MCP
                                  server, and configure this repository: candidate endpoints and allowed
                                  models, default eval budget. Rerunnable.
  openmerit connect [claude-code|codex|api]
                                  Power OpenMerit Harness with Claude Code (its own login), Codex models
                                  (a ChatGPT Plus/Pro sign-in) or an API key. Signs in when needed.
  openmerit scout                 Scan model usages, pick a model and tasks, binary-search cheaper models on your eval
                                  candidates, compare with the current model, optionally configure.
  openmerit scout --resume <run>  Continue a paused, interrupted or failed run.
  openmerit history [<run>]       This repository's runs, or one run in detail.
  openmerit eval <dir>            Run an eval Scout wrote (.openmerit/evals/<task>) under the eval contract: one model
                                  (OPENMERIT_MODEL) on OPENAI_BASE_URL, the judge OPENMERIT_JUDGE_MODEL on the same
                                  endpoint unless OPENMERIT_JUDGE_BASE_URL and OPENMERIT_JUDGE_API_KEY say otherwise.
  openmerit server start [--port <n>]
                                  Start the self-hosted OpenMerit server (the one openmerit.ai runs) in the
                                  background on 127.0.0.1 (default port 7330; its engine also takes the port + 1, + 2,
                                  + 3 and + 11), and print a sign-in link for its web app.
  openmerit server [status|stop|link]
                                  Whether it runs, stop it, or a new one-time sign-in link for its web app.
  openmerit login [--server <url>] [--token-file <path>]
                                  Sign in to openmerit.ai (default) or a self-hosted server; the commands
                                  below then use it. Without a login they use the server this machine runs.
  openmerit logout                Forget that sign-in.
  openmerit whoami [--json]       The server, organization and role the CLI acts as.

Commands for the server's MCP tools (each takes the tool's arguments as flags, --input <json|@file|->,
and --json; \`openmerit <command> --help\` lists them):
  openmerit recommend             Start measuring cheaper models for a task (openmerit_recommend)
  openmerit result --job-id <id>  A job's state, questions or result (openmerit_result)
  openmerit answer                Send the user's answers to a job's questions (openmerit_answer)
  openmerit confirmation          Whether the user confirmed a held request (openmerit_confirmation)
  openmerit eval-command          Measure a task with the repository's eval, self-hosted (openmerit_eval_command)
  openmerit tasks                 The account's tasks (openmerit_tasks)
  openmerit eval --task-id <id>   A task's accepted eval (openmerit_eval)
  openmerit retire --task-id <id> Stop re-running a task (openmerit_retire)

  openmerit mcp                   These tools as a stdio MCP server for Claude Code, Codex and other clients,
                                  forwarded to the server the CLI uses.
  openmerit daemon [status|stop]  The background process that runs Scout (started by scout when needed).
                                  Without an argument it runs in the foreground.

Scout options:
  --answer <id=value>   Answer a question without a prompt (repeatable), as --json returns them
  --json                Print the run state as JSON and stop at the first question

Connect options (setup takes them too, with --harness <claude-code|codex|api> and --harness-model <id>):
  --model <id>          Model for claude-code or codex
  --device-code         Sign in to ChatGPT with a code entered on any device (for servers)
  --api-provider <pi provider> --api-model <id> --api-key-env <VAR>
  --yes                 Accept defaults; never prompt

Setup options (for scripts; interactive setup asks instead):
  --harness <claude-code|codex|api>  --harness-model <id>  --device-code
  --api-provider <pi provider> --api-model <id> --api-key-env <VAR>
  --endpoint <openrouter:VAR | openai:VAR | id=https://host/v1:VAR> (repeatable)
  --allowed-models <a,b>  --budget <usd>  --register-mcp | --no-register-mcp
  --yes                 Accept defaults; never prompt`;

const started = Date.now();
const [command = "help", ...rest] = process.argv.slice(2);
const log = (line: string) => process.stderr.write(`${line}\n`);
/** The commands for the server's MCP tools (tool-cli.ts), which print their own help. test/server/cli.test.ts checks them against the tools. */
const TOOL_COMMAND_NAMES = ["recommend", "result", "answer", "confirmation", "eval-command", "tasks", "eval", "retire"];
const ownHelp = TOOL_COMMAND_NAMES.includes(command);
const isHelp = command === "help" || command === "--help" || command === "-h" || (!ownHelp && (rest.includes("--help") || rest.includes("-h")));
const isVersion = command === "--version" || command === "-v" || command === "version";
// The command's name for telemetry, never its arguments. `mcp` reports each tool call instead, and the
// daemon that scout and mcp start in the background is not a command someone ran.
const tracked = isHelp ? "help" : isVersion ? "version" : command === "mcp" || (command === "daemon" && !rest[0]) ? null
  : ["setup", "connect", "scout", "history", "daemon", "eval", "server", "login", "logout", "whoami", ...TOOL_COMMAND_NAMES].includes(command) ? command : "unknown";
let handedOver = false;

async function update(json: boolean): Promise<number | null> {
  const { checkForUpdate, offerUpdate } = await import("./update.ts");
  const info = await checkForUpdate();
  if (!info.available) return null;
  const interactive = process.stdin.isTTY === true && !json;
  if (!interactive) { log(`openmerit ${info.latest} is available (installed ${info.current}). Update with: npm install -g openmerit@${info.latest}`); return null; }
  const { terminalPrompter } = await import("./cli/prompt.ts");
  const prompter = terminalPrompter();
  try { return await offerUpdate(info, { interactive, confirm: question => prompter.confirm(question, true), log, argv: process.argv.slice(2) }); } finally { prompter.close(); }
}

function mcpCommand(): string[] {
  const self = realpathSync(fileURLToPath(import.meta.url));
  const found = spawnSync("sh", ["-c", "command -v openmerit"], { encoding: "utf8" }).stdout.trim();
  try { if (found && realpathSync(found) === self) return ["openmerit", "mcp"]; } catch { /* fall through */ }
  return [process.execPath, self, "mcp"];
}

async function setup(args: string[]) {
  const { values } = parseArgs({ args, options: {
    harness: { type: "string" }, "harness-model": { type: "string" }, "api-provider": { type: "string" }, "api-model": { type: "string" }, "api-key-env": { type: "string" },
    endpoint: { type: "string", multiple: true }, "allowed-models": { type: "string" }, budget: { type: "string" }, "register-mcp": { type: "boolean" }, "no-register-mcp": { type: "boolean" },
    yes: { type: "boolean" }, "device-code": { type: "boolean" },
  } });
  if (values.harness && !["claude-code", "codex", "api"].includes(values.harness)) throw new Error("--harness is claude-code, codex or api");
  const { runSetup } = await import("./setup.ts");
  const { State } = await import("./state/db.ts");
  const { findRepo } = await import("./state/paths.ts");
  const { terminalPrompter } = await import("./cli/prompt.ts");
  const interactive = process.stdin.isTTY === true && !values.yes;
  const prompter = interactive ? terminalPrompter() : null;
  const state = new State();
  try {
    const result = await runSetup({
      repo: findRepo(process.cwd()), state, prompter, log, env: process.env, mcpCommand: mcpCommand(),
      flags: {
        ...(values.harness ? { harness: values.harness as "claude-code" | "codex" | "api" } : {}), ...(values["harness-model"] ? { harnessModel: values["harness-model"] } : {}),
        ...(values["device-code"] ? { deviceCode: true } : {}), ...(values["api-provider"] ? { apiProvider: values["api-provider"] } : {}), ...(values["api-model"] ? { apiModel: values["api-model"] } : {}), ...(values["api-key-env"] ? { apiKeyEnv: values["api-key-env"] } : {}),
        ...(values.endpoint ? { endpoints: values.endpoint } : {}), ...(values["allowed-models"] ? { allowedModels: values["allowed-models"].split(",").map(item => item.trim()).filter(Boolean) } : {}),
        ...(values.budget ? { budget: Number(values.budget) } : {}), ...(values["register-mcp"] ? { registerMcp: true } : values["no-register-mcp"] ? { registerMcp: false } : {}),
        ...(!interactive ? { nonInteractive: true } : {}),
      },
    });
    if (!result.harness) process.exitCode = 1;
  } finally { prompter?.close(); state.close(); }
}

async function connectCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    model: { type: "string" }, "device-code": { type: "boolean" }, "api-provider": { type: "string" }, "api-model": { type: "string" }, "api-key-env": { type: "string" }, yes: { type: "boolean" },
  } });
  const [kind] = positionals;
  if (kind && !["claude-code", "codex", "api"].includes(kind)) throw new Error("Connect claude-code, codex or api.");
  const { connect } = await import("./connect.ts");
  const { globalConfigLabel } = await import("./state/config.ts");
  const { findRepo } = await import("./state/paths.ts");
  const { terminalPrompter } = await import("./cli/prompt.ts");
  const interactive = process.stdin.isTTY === true && !values.yes;
  const prompter = interactive ? terminalPrompter() : null;
  let root = process.cwd();
  try { root = findRepo(root).root; } catch { /* outside a repository: the check reads nothing */ }
  try {
    const saved = await connect({ root, prompter, log, env: process.env, flags: {
      ...(values.model ? { model: values.model } : {}), ...(values["device-code"] ? { deviceCode: true } : {}), ...(values["api-provider"] ? { apiProvider: values["api-provider"] } : {}),
      ...(values["api-model"] ? { apiModel: values["api-model"] } : {}), ...(values["api-key-env"] ? { apiKeyEnv: values["api-key-env"] } : {}), ...(!interactive ? { nonInteractive: true } : {}),
    } }, kind as "claude-code" | "codex" | "api" | undefined);
    if (saved) log(`Saved to ${globalConfigLabel()}. Next: openmerit setup in a repository, or openmerit scout.`);
    else process.exitCode = 1;
  } finally { prompter?.close(); }
}

async function scout(args: string[]) {
  const { values } = parseArgs({ args, options: { resume: { type: "string" }, answer: { type: "string", multiple: true }, json: { type: "boolean", default: false } } });
  const { localContext, missingSetup, startRun } = await import("./local.ts");
  const { advanceInDaemon } = await import("./daemon/daemon.ts");
  type Answers = import("./scout/workflow.ts").Answers;
  const { renderComparison, renderStep } = await import("./cli/render.ts");
  const { askQuestion, terminalPrompter, workingTicker } = await import("./cli/prompt.ts");
  const controller = new AbortController();
  let interrupts = 0;
  process.on("SIGINT", () => { if (++interrupts > 1) process.exit(130); log("\nStopping; the run is saved. Ctrl-C again to quit now."); controller.abort(); });
  const ctx = localContext({ cwd: process.cwd(), log, signal: controller.signal });
  const interactive = process.stdin.isTTY === true && !values.json;
  const prompter = interactive ? terminalPrompter() : null;
  try {
    const missing = missingSetup(ctx);
    if (missing.length) {
      if (values.json) return void process.stdout.write(`${JSON.stringify({ status: "needs_setup", missing }, null, 2)}\n`);
      throw new Error(`Run \`openmerit setup\` first:\n  - ${missing.join("\n  - ")}`);
    }
    const runId = values.resume ?? startRun(ctx);
    let answers: Answers = Object.fromEntries((values.answer ?? []).map(item => {
      const at = item.indexOf("=");
      if (at < 1) throw new Error(`--answer ${item}: write <question id>=<value>`);
      return [item.slice(0, at), item.slice(at + 1)];
    }));
    let compared = false;
    for (;;) {
      const ticker = values.json ? null : workingTicker();
      const result = await advanceInDaemon({ runId, cwd: process.cwd(), env: process.env, answers, log: ticker?.log ?? log, signal: controller.signal }).finally(() => ticker?.stop());
      answers = {};
      for (const notice of result.notices) log(notice);
      if (result.questions.length && prompter && !controller.signal.aborted) {
        // The comparison comes before the question whether to configure its result.
        if (result.result && !compared) { process.stdout.write(`${result.result.tasks.map(task => renderComparison(task, runId)).join("\n\n")}\n`); compared = true; }
        for (const question of result.questions) {
          if (question.id === "budget_amount" && (answers.budget_action === "decline" || answers.budget_action === "continue")) continue;
          answers[question.id] = await askQuestion(prompter, question, log);
        }
        continue;
      }
      if (values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        if (result.questions.length) log(`Waiting for ${result.questions.map(question => question.id).join(", ")}. Answer: openmerit scout --resume ${runId} --answer <id>=<value>`);
        process.stdout.write(`${renderStep(result, { comparisons: !compared })}\n`);
      }
      if (result.status === "failed" || result.status === "interrupted") process.exitCode = 1;
      return;
    }
  } finally { prompter?.close(); ctx.state.close(); }
}

async function history(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: "boolean", default: false } } });
  const { localContext } = await import("./local.ts");
  const { step } = await import("./scout/workflow.ts");
  const { renderHistory, renderRun } = await import("./cli/render.ts");
  const ctx = localContext({ cwd: process.cwd() });
  try {
    ctx.state.reapInterrupted(ctx.repo.id);
    const id = positionals[0];
    if (id) {
      const run = ctx.state.getRun(id);
      if (!run || run.repoId !== ctx.repo.id) throw new Error(`No run ${id} in ${ctx.repo.root}.`);
      const current = step(ctx, id, [], []);
      process.stdout.write(values.json ? `${JSON.stringify({ run, step: current, units: ctx.state.units(id), budget: ctx.state.budgetEvents(id), decisions: ctx.state.decisions(id), events: ctx.state.events(id) }, null, 2)}\n` : `${renderRun(ctx.state, run, current)}\n`);
      return;
    }
    const runs = ctx.state.listRuns(ctx.repo.id);
    process.stdout.write(values.json ? `${JSON.stringify(runs.map(run => ({ ...run, spend: ctx.state.spend(run.id) })), null, 2)}\n` : `${renderHistory(ctx.state, runs)}\n`);
  } finally { ctx.state.close(); }
}

async function daemon(args: string[]) {
  const { healthy, readDaemonInfo, serveDaemon, stopDaemon } = await import("./daemon/daemon.ts");
  const [action] = args;
  if (!action) return serveDaemon();
  if (action === "stop") return void log((await stopDaemon()) ? "Stopped the OpenMerit daemon. Runs it was working on continue with `openmerit scout --resume <run>`." : "The OpenMerit daemon is not running.");
  if (action !== "status") throw new Error(`Unknown daemon command "${action}". Use \`openmerit daemon status\` or \`openmerit daemon stop\`.`);
  const info = readDaemonInfo();
  if (info && await healthy(info)) return void process.stdout.write(`running: openmerit ${info.version}, pid ${info.pid}, 127.0.0.1:${info.port}, since ${info.startedAt}\n`);
  process.stdout.write("not running\n");
}

/** `openmerit eval <dir>`: a generated eval under the eval contract, with its result in $OPENMERIT_RESULT or on stdout. */
async function generatedEval(args: string[]) {
  const { loadGeneratedEval, runGeneratedEval } = await import("./eval/generated.ts");
  const { writeFileSync } = await import("node:fs");
  const env = process.env, dir = args[0];
  if (!dir) throw new Error("Usage: openmerit eval <dir>, such as .openmerit/evals/ticket-classifier.");
  const model = env.OPENMERIT_MODEL, baseUrl = env.OPENMERIT_BASE_URL ?? env.OPENAI_BASE_URL, apiKey = env.OPENMERIT_API_KEY ?? env.OPENAI_API_KEY;
  if (!model || !baseUrl || !apiKey) throw new Error("Set OPENMERIT_MODEL, OPENAI_BASE_URL and OPENAI_API_KEY, as the eval contract does.");
  const judgeModel = env.OPENMERIT_JUDGE_MODEL;
  const outcome = await runGeneratedEval(loadGeneratedEval(process.cwd(), dir), {
    model, baseUrl, apiKey, items: env.OPENMERIT_ITEMS ? env.OPENMERIT_ITEMS.split(",").map(item => item.trim()).filter(Boolean) : null,
    ...(judgeModel ? { judge: { model: judgeModel, baseUrl: env.OPENMERIT_JUDGE_BASE_URL ?? baseUrl, apiKey: env.OPENMERIT_JUDGE_API_KEY ?? apiKey } } : {}),
  });
  if (!outcome.ok) throw new Error(outcome.error ?? "the eval failed");
  const result = JSON.stringify({ items: outcome.items, reasons: outcome.reasons });
  if (env.OPENMERIT_RESULT) writeFileSync(env.OPENMERIT_RESULT, result);
  else process.stdout.write(`${result}\n`);
}

async function loginCommand(args: string[]) {
  const { values } = parseArgs({ args, options: { server: { type: "string" }, "token-file": { type: "string" }, "no-browser": { type: "boolean" } } });
  const { login } = await import("./client.ts");
  const signedIn = await login({ log, ...(values.server ? { server: values.server } : {}), ...(values["token-file"] ? { tokenFile: values["token-file"] } : {}), ...(values["no-browser"] ? { open: () => {} } : {}) });
  log(`Signed in to ${signedIn.server}${signedIn.mode === "self-hosted" ? " (self-hosted)" : ""}. \`openmerit whoami\` shows the organization.`);
}

async function main() {
  if (isHelp) return void process.stdout.write(`${HELP}\n`);
  if (isVersion) return void process.stdout.write(`${(await import("./update.ts")).packageVersion()}\n`);
  if (command === "mcp") return (await import("./mcp.ts")).serveMcp();
  if (command === "daemon") return daemon(rest);
  // \`openmerit eval <dir>\` runs an eval Scout wrote; with --task-id or --input it is the openmerit_eval tool.
  if (command === "eval" && !rest.some(arg => /^--(task-id|input|help)\b|^-h$/.test(arg))) return generatedEval(rest);
  if (command === "login") return loginCommand(rest);
  if (command === "logout") {
    const { logout } = await import("./client.ts");
    const was = logout();
    return void log(was ? `Signed out of ${was.server}.` : "The CLI was not signed in.");
  }
  if (command === "whoami") return (await import("./tool-cli.ts")).whoami(rest);
  const tools = await import("./tool-cli.ts");
  if (tools.TOOL_COMMANDS.has(command)) return tools.toolCommand(command, rest, log);
  if (command === "server") return (await import("./server-cli.ts")).serverCommand(rest, log);
  if (!["setup", "connect", "scout", "history"].includes(command)) throw new Error(`Unknown command "${command}". Run \`openmerit help\`.`);
  const took = await update(rest.includes("--json"));
  // The updated version ran the command and reported it.
  if (took !== null) { process.exitCode = took; handedOver = true; return; }
  if (command === "setup") return setup(rest);
  if (command === "connect") return connectCommand(rest);
  if (command === "scout") return scout(rest);
  return history(rest);
}

main().catch((error: unknown) => {
  process.stderr.write(`openmerit: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}).then(async () => {
  if (!tracked || handedOver) return;
  try {
    const { sendCommandRun } = await import("./telemetry.ts");
    await sendCommandRun({ command: tracked, surface: "cli", ok: !process.exitCode, durationMs: Date.now() - started });
  } catch { /* telemetry never affects the command */ }
});
