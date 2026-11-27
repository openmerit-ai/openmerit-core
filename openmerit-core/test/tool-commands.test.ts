// Every MCP tool the server lists has an openmerit command with the same arguments: the help lists it,
// it prints the tool's own help, and its flags become the tool's arguments.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { commandName, parseToolArgs, TOOL_COMMANDS } from "../src/tool-cli.ts";
import { TOOLS } from "../src/server/tools.ts";

const cli = (...args: string[]) => execFileSync(process.execPath, [new URL("../src/cli.ts", import.meta.url).pathname, ...args], {
  encoding: "utf8", env: { ...process.env, OPENMERIT_NO_UPDATE_CHECK: "1", OPENMERIT_TELEMETRY: "0" },
});

test("every MCP tool has a CLI command, listed in the help, with its own --help", () => {
  const help = cli("help");
  for (const tool of TOOLS) {
    const command = commandName(tool.name);
    assert.ok(TOOL_COMMANDS.has(command), tool.name);
    assert.ok(help.includes(`openmerit ${command} `) && help.includes(`(${tool.name})`), `openmerit help lists ${command}`);
    assert.match(cli(command, "--help"), new RegExp(`^openmerit ${command}: .*\\(MCP tool ${tool.name}\\)`), `${command} --help prints the tool's help`);
  }
});

test("a tool command's flags are the tool's arguments, typed as its schema says", () => {
  const recommend = TOOL_COMMANDS.get("recommend")!;
  assert.deepEqual(parseToolArgs(recommend, ["--job-id", "job_1", "--budget-usd=12.5", "--json"]), { input: { job_id: "job_1", budget_usd: 12.5 }, json: true });
  assert.deepEqual(parseToolArgs(recommend, ["--input", '{"environment":"a/b","job_id":"x"}', "--job-id", "y"]).input, { environment: "a/b", job_id: "y" }, "flags override --input");
  assert.deepEqual(parseToolArgs(TOOL_COMMANDS.get("answer")!, ["--job-id", "j", "--answers", '{"label_check":["a"]}']).input, { job_id: "j", answers: { label_check: ["a"] } });
  assert.deepEqual(parseToolArgs(TOOL_COMMANDS.get("eval-command")!, ["--task-id", "t", "--clear", "--threshold", "null"]).input, { task_id: "t", clear: true, threshold: null });
  assert.throws(() => parseToolArgs(recommend, ["--budget-usd", "lots"]), /takes a number/);
  assert.throws(() => parseToolArgs(TOOL_COMMANDS.get("result")!, []), /needs --job-id/);
});
