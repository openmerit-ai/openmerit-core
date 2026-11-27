#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HELP = `OpenMerit: find the cheapest model that does each task in your code as well as the one it uses
today. The CLI and its MCP server are clients of an OpenMerit server: openmerit.ai, or one you run on this
machine with \`openmerit server start\`.

Usage:
  openmerit setup                 Register the MCP server with Claude Code and Codex, and say how to get a server.
  openmerit connect [claude-code|codex|api]
                                  Power OpenMerit Harness with Claude Code (its own login), Codex models
                                  (a ChatGPT Plus/Pro sign-in) or an API key. Signs in when needed.
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

Connect options:
  --model <id>          Model for claude-code or codex
  --device-code         Sign in to ChatGPT with a code entered on any device (for servers)
  --api-provider <pi provider> --api-model <id> --api-key-env <VAR>
  --yes                 Accept defaults; never prompt

Setup options:
  --register-mcp | --no-register-mcp  Register without asking, or skip it
  --yes                 Accept defaults; never prompt`;

const started = Date.now();
const [command = "help", ...rest] = process.argv.slice(2);
const log = (line: string) => process.stderr.write(`${line}\n`);
/** The commands for the server's MCP tools (tool-cli.ts), which print their own help. test/server/cli.test.ts checks them against the tools. */
const TOOL_COMMAND_NAMES = ["recommend", "result", "answer", "confirmation", "eval-command", "tasks", "eval", "retire"];
const ownHelp = TOOL_COMMAND_NAMES.includes(command);
const isHelp = command === "help" || command === "--help" || command === "-h" || (!ownHelp && (rest.includes("--help") || rest.includes("-h")));
const isVersion = command === "--version" || command === "-v" || command === "version";
// The command's name for telemetry, never its arguments. `mcp` reports each tool call instead.
const tracked = isHelp ? "help" : isVersion ? "version" : command === "mcp" ? null
  : ["setup", "connect", "server", "login", "logout", "whoami", ...TOOL_COMMAND_NAMES].includes(command) ? command : "unknown";
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
  const { values } = parseArgs({ args, options: { "register-mcp": { type: "boolean" }, "no-register-mcp": { type: "boolean" }, yes: { type: "boolean" } } });
  const { runSetup } = await import("./setup.ts");
  const { terminalPrompter } = await import("./cli/prompt.ts");
  const prompter = process.stdin.isTTY === true && !values.yes ? terminalPrompter() : null;
  try {
    await runSetup({ prompter, log, env: process.env, mcpCommand: mcpCommand(), flags: values["register-mcp"] ? { registerMcp: true } : values["no-register-mcp"] ? { registerMcp: false } : {} });
  } finally { prompter?.close(); }
}

async function connectCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    model: { type: "string" }, "device-code": { type: "boolean" }, "api-provider": { type: "string" }, "api-model": { type: "string" }, "api-key-env": { type: "string" }, yes: { type: "boolean" },
  } });
  const [kind] = positionals;
  if (kind && !["claude-code", "codex", "api"].includes(kind)) throw new Error("Connect claude-code, codex or api.");
  const { connect } = await import("./connect.ts");
  const { globalConfigLabel } = await import("./state/config.ts");
  const { terminalPrompter } = await import("./cli/prompt.ts");
  const interactive = process.stdin.isTTY === true && !values.yes;
  const prompter = interactive ? terminalPrompter() : null;
  try {
    const saved = await connect({ root: process.cwd(), prompter, log, env: process.env, flags: {
      ...(values.model ? { model: values.model } : {}), ...(values["device-code"] ? { deviceCode: true } : {}), ...(values["api-provider"] ? { apiProvider: values["api-provider"] } : {}),
      ...(values["api-model"] ? { apiModel: values["api-model"] } : {}), ...(values["api-key-env"] ? { apiKeyEnv: values["api-key-env"] } : {}), ...(!interactive ? { nonInteractive: true } : {}),
    } }, kind as "claude-code" | "codex" | "api" | undefined);
    if (saved) log(`Saved to ${globalConfigLabel()}.`);
    else process.exitCode = 1;
  } finally { prompter?.close(); }
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
  if (!["setup", "connect"].includes(command)) throw new Error(`Unknown command "${command}". Run \`openmerit help\`.`);
  const took = await update(false);
  // The updated version ran the command and reported it.
  if (took !== null) { process.exitCode = took; handedOver = true; return; }
  if (command === "setup") return setup(rest);
  return connectCommand(rest);
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
