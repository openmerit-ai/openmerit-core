#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HELP = `OpenMerit: find cheaper models that perform at least as well as the ones your code uses today,
measured with your own evals. Runs locally; no OpenMerit account.

Usage:
  openmerit setup                 Connect OpenMerit Harness (as openmerit connect does), register the MCP
                                  server, and configure this repository: read-only Langfuse, candidate
                                  endpoints and allowed models, default eval budget. Rerunnable.
  openmerit connect [claude-code|codex|api]
                                  Power OpenMerit Harness with Claude Code (its own login), Codex models
                                  (a ChatGPT Plus/Pro sign-in) or an API key. Signs in when needed.
  openmerit scout                 Scan model usages, pick a model and tasks, binary-search cheaper models on your eval
                                  candidates, compare with the current model, optionally configure.
  openmerit scout --resume <run>  Continue a paused, interrupted or failed run.
  openmerit history [<run>]       This repository's runs, or one run in detail.
  openmerit mcp                   The local MCP server (stdio), for Claude Code, Codex and other clients.
  openmerit daemon [status|stop]  The background process that runs Scout (started by scout and mcp when needed).
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
  --langfuse-url <url> --langfuse-public-key-env <VAR> --langfuse-secret-key-env <VAR>
  --yes                 Accept defaults; never prompt`;

const [command = "help", ...rest] = process.argv.slice(2);
const log = (line: string) => process.stderr.write(`${line}\n`);

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
    "langfuse-url": { type: "string" }, "langfuse-public-key-env": { type: "string" }, "langfuse-secret-key-env": { type: "string" }, yes: { type: "boolean" }, "device-code": { type: "boolean" },
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
        ...(values["langfuse-url"] ? { langfuseUrl: values["langfuse-url"] } : {}), ...(values["langfuse-public-key-env"] ? { langfusePublicKeyEnv: values["langfuse-public-key-env"] } : {}),
        ...(values["langfuse-secret-key-env"] ? { langfuseSecretKeyEnv: values["langfuse-secret-key-env"] } : {}), ...(!interactive ? { nonInteractive: true } : {}),
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

async function main() {
  if (command === "help" || command === "--help" || command === "-h" || rest.includes("--help") || rest.includes("-h")) return void process.stdout.write(`${HELP}\n`);
  if (command === "--version" || command === "-v" || command === "version") return void process.stdout.write(`${(await import("./update.ts")).packageVersion()}\n`);
  if (command === "mcp") return (await import("./mcp.ts")).serveMcp();
  if (command === "daemon") return daemon(rest);
  if (!["setup", "connect", "scout", "history"].includes(command)) throw new Error(`Unknown command "${command}". Run \`openmerit help\`.`);
  const took = await update(rest.includes("--json"));
  if (took !== null) { process.exitCode = took; return; }
  if (command === "setup") return setup(rest);
  if (command === "connect") return connectCommand(rest);
  if (command === "scout") return scout(rest);
  return history(rest);
}

main().catch((error: unknown) => {
  process.stderr.write(`openmerit: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
