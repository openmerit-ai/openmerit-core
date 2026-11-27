// One CLI command per MCP tool of the server (src/server/tools.ts): `openmerit recommend` calls
// openmerit_recommend, `openmerit eval-command` calls openmerit_eval_command. Each argument is a flag
// named after it (job_id is --job-id); objects and arrays take JSON, @file or - for stdin, and
// --input takes every argument at once. The command prints the tool's text, or with --json its
// structured result, the same fields a coding agent gets.
import { readFileSync } from "node:fs";
import { call, callTool, requireConnection } from "./client.ts";
import { TOOLS } from "./server/tools.ts";

interface Property { type?: string | string[]; description?: string }
type Tool = (typeof TOOLS)[number];

const PREFIX = "openmerit_";
/** The command for a tool: openmerit_eval_command is eval-command. */
export const commandName = (tool: string) => tool.slice(PREFIX.length).replaceAll("_", "-");
export const TOOL_COMMANDS: ReadonlyMap<string, Tool> = new Map(TOOLS.map(tool => [commandName(tool.name), tool]));

const flag = (property: string) => `--${property.replaceAll("_", "-")}`;
const types = (property: Property) => [property.type ?? "object"].flat();
const properties = (tool: Tool) => (tool.inputSchema.properties ?? {}) as Record<string, Property>;
const required = (tool: Tool) => ("required" in tool.inputSchema ? tool.inputSchema.required : []) as readonly string[];

/** A JSON value from an argument: the JSON itself, @path for a file's contents, or - for stdin. */
function json(text: string, name: string): unknown {
  const source = text === "-" ? readFileSync(0, "utf8") : text.startsWith("@") ? readFileSync(text.slice(1), "utf8") : text;
  try { return JSON.parse(source) as unknown; } catch { throw new Error(`${name} takes JSON, @file or - for stdin.`); }
}

function value(property: Property, text: string, name: string): unknown {
  const kinds = types(property);
  if (kinds.includes("null") && text === "null") return null;
  if (kinds.includes("number") || kinds.includes("integer")) {
    const number = Number(text);
    if (text.trim() === "" || !Number.isFinite(number)) throw new Error(`${name} takes a number.`);
    return number;
  }
  if (kinds.includes("boolean")) {
    if (text !== "true" && text !== "false") throw new Error(`${name} is true or false.`);
    return text === "true";
  }
  if (kinds.includes("string")) return text;
  return json(text, name);
}

export function parseToolArgs(tool: Tool, args: string[]): { input: Record<string, unknown>; json: boolean } {
  const props = properties(tool);
  const byFlag = new Map(Object.keys(props).map(key => [flag(key), key]));
  let input: Record<string, unknown> = {};
  const flags: Record<string, unknown> = {};
  let asJson = false;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const next = () => {
      if (eq > 0) return arg.slice(eq + 1);
      const following = args[++at];
      if (following === undefined) throw new Error(`${name} needs a value.`);
      return following;
    };
    if (name === "--json") { asJson = true; continue; }
    if (name === "--input") {
      const whole = json(next(), "--input");
      if (!whole || typeof whole !== "object" || Array.isArray(whole)) throw new Error("--input takes a JSON object of the tool's arguments.");
      input = whole as Record<string, unknown>;
      continue;
    }
    const key = byFlag.get(name);
    if (!key) throw new Error(`Unknown option ${arg} for openmerit ${commandName(tool.name)}. Run \`openmerit ${commandName(tool.name)} --help\`.`);
    const property = props[key]!;
    // A boolean flag alone is true.
    if (types(property).includes("boolean") && eq < 0 && (args[at + 1] === undefined || args[at + 1]!.startsWith("--"))) { flags[key] = true; continue; }
    flags[key] = value(property, next(), name);
  }
  const merged = { ...input, ...flags };
  const missing = required(tool).filter(key => merged[key] === undefined);
  if (missing.length) throw new Error(`openmerit ${commandName(tool.name)} needs ${missing.map(flag).join(" and ")}.`);
  return { input: merged, json: asJson };
}

export function toolHelp(tool: Tool): string {
  const props = properties(tool), needed = new Set(required(tool));
  const lines = Object.entries(props).map(([key, property]) => {
    const kinds = types(property);
    const takes = kinds.includes("boolean") ? "" : kinds.includes("string") ? " <text>" : kinds.includes("number") ? " <number>" : " <json|@file|->";
    return `  ${`${flag(key)}${takes}`.padEnd(30)} ${needed.has(key) ? "(required) " : ""}${property.description ?? ""}`;
  });
  return [`openmerit ${commandName(tool.name)}: ${tool.title.replace(/^OpenMerit: /, "")} (MCP tool ${tool.name})`, "", tool.description, "",
    "Options:", ...lines, `  ${"--input <json|@file|->".padEnd(30)} Every argument as one JSON object; flags override it`, `  ${"--json".padEnd(30)} Print the structured result instead of the text`].join("\n");
}

/** Runs a tool command against the server the CLI uses. */
export async function toolCommand(command: string, args: string[], log: (line: string) => void): Promise<void> {
  const tool = TOOL_COMMANDS.get(command)!;
  if (args.includes("--help") || args.includes("-h")) return void process.stdout.write(`${toolHelp(tool)}\n`);
  const { input, json: asJson } = parseToolArgs(tool, args);
  const answer = await callTool(requireConnection(), tool.name, input);
  if (asJson) process.stdout.write(`${JSON.stringify(answer.data, null, 2)}\n`);
  else (answer.isError ? log : (line: string) => process.stdout.write(`${line}\n`))(answer.text);
  if (answer.isError) process.exitCode = 1;
}

interface Me { mode: string; user: { id: string }; account: { id: string; name: string | null }; role: string; plan: { name: string | null; status: string } }

/** `openmerit whoami`: the server, organization and role the CLI acts as. */
export async function whoami(args: string[]): Promise<void> {
  const conn = requireConnection();
  const { status, body } = await call<Me & { error?: string }>(conn, "/api/me");
  if (status !== 200) throw new Error(`${conn.server} answered ${status}: ${body?.error ?? "no account"}.`);
  if (args.includes("--json")) return void process.stdout.write(`${JSON.stringify({ server: conn.server, ...body }, null, 2)}\n`);
  const plan = body.mode === "self-hosted" ? "self-hosted" : body.plan.status === "none" || body.plan.status === "canceled" ? "no plan" : `${body.plan.name ?? "OpenMerit"} plan`;
  process.stdout.write(`${body.account.name ?? body.account.id} (${body.account.id}) on ${conn.server}, as ${body.role}; ${plan}\n`);
}
