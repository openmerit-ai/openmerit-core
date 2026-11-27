// `openmerit setup`: registers `openmerit mcp` with Claude Code and Codex, through their own `mcp add`
// commands, and says how to get a server for it: `openmerit login` for openmerit.ai, or `openmerit
// server start` on this machine. Rerunnable; an existing "openmerit" entry is left alone.
import { spawnSync } from "node:child_process";
import type { Prompter } from "./cli/prompt.ts";
import { connection } from "./client.ts";

type Env = Record<string, string | undefined>;
type Client = "claude-code" | "codex";
const NAME: Record<Client, string> = { "claude-code": "Claude Code", codex: "Codex" };
const bin = (kind: Client, env: Env) => (kind === "claude-code" ? env.OPENMERIT_CLAUDE_BIN ?? "claude" : env.OPENMERIT_CODEX_BIN ?? "codex");

export interface SetupContext {
  prompter: Prompter | null;
  log: (line: string) => void;
  env: Env;
  /** The command that starts `openmerit mcp`, as clients should run it. */
  mcpCommand: string[];
  flags: { registerMcp?: boolean };
}

/** Registers the MCP server with the clients on PATH; returns the ones that have it now. */
export async function runSetup(ctx: SetupContext): Promise<Client[]> {
  const clients = (["claude-code", "codex"] as const).filter(kind => !spawnSync(bin(kind, ctx.env), ["--version"], { env: ctx.env, stdio: "ignore" }).error);
  const register = clients.length > 0 && (ctx.flags.registerMcp ?? (ctx.prompter ? await ctx.prompter.confirm(`Register OpenMerit's MCP server with ${clients.map(kind => NAME[kind]).join(" and ")}?`, true) : true));
  const registered: Client[] = [];
  if (register) {
    for (const kind of clients) {
      const get = spawnSync(bin(kind, ctx.env), ["mcp", "get", "openmerit"], { encoding: "utf8", env: ctx.env });
      if (get.status === 0) { ctx.log(`  ${NAME[kind]} already has an "openmerit" MCP server; left unchanged.`); registered.push(kind); continue; }
      const args = kind === "claude-code" ? ["mcp", "add", "--scope", "user", "openmerit", "--", ...ctx.mcpCommand] : ["mcp", "add", "openmerit", "--", ...ctx.mcpCommand];
      const add = spawnSync(bin(kind, ctx.env), args, { encoding: "utf8", env: ctx.env });
      if (add.status === 0) { ctx.log(`  ✓ Registered OpenMerit's MCP server with ${NAME[kind]}.`); registered.push(kind); }
      else ctx.log(`  ✗ Could not register with ${NAME[kind]}: ${(add.stderr || add.stdout).trim().slice(0, 200)}`);
    }
  } else ctx.log(`  MCP server not registered${clients.length ? "" : ": no claude or codex CLI on PATH"}. To add it to another client, register the stdio command: ${ctx.mcpCommand.join(" ")}`);
  const conn = connection(ctx.env);
  ctx.log(conn ? `\nThe MCP server and the CLI use ${conn.server}${conn.mode === "self-hosted" ? " (self-hosted)" : ""}.`
    : "\nNext, give them a server: `openmerit login` to use openmerit.ai, or `openmerit server start` to run one on this machine.");
  return registered;
}
