// OpenMerit's local MCP server: newline-delimited JSON-RPC 2.0 over stdio, for Claude Code, Codex and
// other MCP clients. Stdout carries protocol messages only; progress goes to stderr. It runs the
// same workflow and SQLite state as the CLI. Questions and approvals come back as structured
// `questions` for the client to ask the user; the server never prompts on a terminal.
import { createInterface } from "node:readline";
import { renderRun, renderStep } from "./cli/render.ts";
import { localContext, missingSetup, startRun } from "./local.ts";
import { advanceInDaemon } from "./daemon/daemon.ts";
import { step, type Answers } from "./scout/workflow.ts";
import { checkForUpdate, packageVersion, updateNotice, type UpdateInfo } from "./update.ts";

const PROTOCOL = "2025-06-18";

const TOOLS = [
  {
    name: "openmerit_status",
    title: "OpenMerit status",
    description: "Read-only. Reports whether OpenMerit is set up for a repository (harness, candidate endpoints, Langfuse, eval budget), the installed package and catalogue versions, and whether a newer openmerit is available.",
    inputSchema: { type: "object", properties: { cwd: { type: "string", description: "Repository directory (default: the server's working directory)" } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "openmerit_scout",
    title: "OpenMerit Scout",
    description: "Runs OpenMerit Scout: scans the repository's model usages, lets the user pick a model and its agents/tasks, runs Scout Model Binary Search with the task's existing eval (the current model on every item, ECI-ranked candidates screened on five items it passes, five finalists on every item; paid model requests, within the run's eval budget; per-item results read back read-only from the Langfuse experiment the eval records, or from the eval's own report), ranks the cheapest finalists at least as good as the current model, and can edit the application's model configuration. Call without runId to start; each call returns `questions` when it needs the user. Show every question (with its detail) to the user and pass their answers back in `answers`, keyed by question id, with the same runId. Never answer approval, budget or configuration questions on the user's behalf. Not read-only: it sends code context to the harness, spends on evals and can change files, each only after the matching approval.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Repository directory (default: the server's working directory)" },
        runId: { type: "string", description: "Run to continue; omit to start a new run" },
        answers: { type: "object", description: "Answers keyed by question id: strings, string arrays, booleans or numbers", additionalProperties: true },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "openmerit_history",
    title: "OpenMerit history",
    description: "Read-only. Lists this repository's Scout runs, including failed, interrupted and budget-paused ones, or shows one run's results, eval runs, spend, budget approvals and configuration decisions.",
    inputSchema: { type: "object", properties: { cwd: { type: "string" }, runId: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

type Json = Record<string, unknown>;

export async function serveMcp(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout, env: Record<string, string | undefined> = process.env) {
  const send = (message: Json) => output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const log = (line: string) => process.stderr.write(`[openmerit] ${line}\n`);
  let update: UpdateInfo | null = null;
  const updateCheck = checkForUpdate(env).then(info => { update = info; return info; });
  const running = new Set<string>();

  const call = async (name: string, args: Json): Promise<{ text: string; data: Json; isError?: boolean }> => {
    const cwd = typeof args.cwd === "string" && args.cwd ? args.cwd : process.cwd();
    const progress: string[] = [];
    const ctx = localContext({ cwd, env, log: line => { progress.push(line); log(line); } });
    const notice = update ? updateNotice(update) : null;
    try {
      if (name === "openmerit_status") {
        const missing = missingSetup(ctx);
        const data = { repository: ctx.repo.root, ready: !missing.length, missing, packageVersion: packageVersion(), catalogueVersion: ctx.catalogue.version, update, history: ctx.state.listRuns(ctx.repo.id, 5).map(run => ({ id: run.id, status: run.status, phase: run.phase })) };
        return { text: `${missing.length ? `Not ready. Run \`openmerit setup\` in ${ctx.repo.root} for: ${missing.join("; ")}.` : `Ready in ${ctx.repo.root}.`} openmerit ${data.packageVersion}, catalogue ${data.catalogueVersion}.${notice ? ` ${notice}` : ""}`, data };
      }
      if (name === "openmerit_history") {
        ctx.state.reapInterrupted(ctx.repo.id);
        if (typeof args.runId === "string") {
          const run = ctx.state.getRun(args.runId);
          if (!run || run.repoId !== ctx.repo.id) return { text: `No run ${args.runId} in ${ctx.repo.root}.`, data: {}, isError: true };
          const current = step(ctx, run.id, [], []);
          return { text: renderRun(ctx.state, run, current), data: { run: { ...run, state: undefined }, step: current, units: ctx.state.units(run.id), budget: ctx.state.budgetEvents(run.id), decisions: ctx.state.decisions(run.id) } };
        }
        const runs = ctx.state.listRuns(ctx.repo.id);
        return { text: runs.map(run => `${run.id} ${run.status} ${run.phase} ${run.createdAt}`).join("\n") || "No runs yet.", data: { runs: runs.map(run => ({ id: run.id, status: run.status, phase: run.phase, createdAt: run.createdAt, model: run.state.model ?? null, tasks: run.state.selected ?? [], spend: ctx.state.spend(run.id), budgetUsd: run.budgetUsd, packageVersion: run.packageVersion, catalogueVersion: run.catalogueVersion })) } };
      }
      if (name === "openmerit_scout") {
        const missing = missingSetup(ctx);
        if (missing.length) return { text: `OpenMerit is not set up for ${ctx.repo.root}. Ask the user to run \`openmerit setup\` in a terminal there.`, data: { status: "needs_setup", missing } };
        const runId = typeof args.runId === "string" && args.runId ? args.runId : startRun(ctx);
        if (running.has(runId)) return { text: `Run ${runId} is already being advanced by another call.`, data: { runId, status: "busy" }, isError: true };
        running.add(runId);
        try {
          const result = await advanceInDaemon({ runId, cwd, env, answers: (args.answers && typeof args.answers === "object" ? args.answers : {}) as Answers, log: line => { progress.push(line); log(line); } });
          const questions = result.questions.map(question => `- [${question.id}] (${question.kind}) ${question.prompt}${question.options ? `\n  Options: ${question.options.map(option => `${option.value}${option.label !== option.value ? ` = ${option.label}` : ""}`).join(" | ")}` : ""}${question.detail ? `\n  ${question.detail.split("\n").join("\n  ")}` : ""}`).join("\n");
          const text = [
            ...(notice ? [notice] : []), ...result.notices,
            questions ? `Run ${runId} needs the user (${result.status}). Ask them, then call openmerit_scout again with runId "${runId}" and answers keyed by question id:\n${questions}` : renderStep(result),
          ].join("\n\n");
          return { text, data: { ...result, progress: progress.slice(-40), ...(update ? { update } : {}) }, ...(result.status === "failed" ? { isError: true } : {}) };
        } finally { running.delete(runId); }
      }
      return { text: `Unknown tool ${name}`, data: {}, isError: true };
    } finally { ctx.state.close(); }
  };

  const handle = async (message: Json) => {
    const id = message.id as string | number | undefined;
    const method = message.method as string | undefined;
    if (!method) return;
    try {
      if (method === "initialize") {
        const info = await Promise.race([updateCheck, new Promise<null>(resolve => setTimeout(() => resolve(null), 3000))]);
        const notice = info ? updateNotice(info) : null;
        send({ id, result: { protocolVersion: (message.params as Json | undefined)?.protocolVersion ?? PROTOCOL, capabilities: { tools: {}, logging: {} }, serverInfo: { name: "openmerit", version: packageVersion() },
          instructions: `OpenMerit Scout finds cheaper models that perform at least as well as the current one on a repository's own evals. Relay every question it returns to the user.${notice ? ` ${notice}` : ""}` } });
        return;
      }
      if (method === "notifications/initialized") {
        const info = await updateCheck;
        const notice = updateNotice(info);
        if (notice) send({ method: "notifications/message", params: { level: "warning", logger: "openmerit", data: notice } });
        return;
      }
      if (method === "ping") return void send({ id, result: {} });
      if (method === "tools/list") return void send({ id, result: { tools: TOOLS } });
      if (method === "tools/call") {
        const params = (message.params ?? {}) as { name?: string; arguments?: Json };
        const result = await call(params.name ?? "", params.arguments ?? {});
        return void send({ id, result: { content: [{ type: "text", text: result.text }], structuredContent: result.data, ...(result.isError ? { isError: true } : {}) } });
      }
      if (method === "logging/setLevel") return void send({ id, result: {} });
      if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    } catch (error) {
      if (id !== undefined) send({ id, result: { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true } });
    }
  };

  const lines = createInterface({ input });
  const pending = new Set<Promise<void>>();
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: Json;
    try { message = JSON.parse(line) as Json; } catch { send({ id: null, error: { code: -32700, message: "Parse error" } }); continue; }
    const work = handle(message).finally(() => pending.delete(work));
    pending.add(work);
  }
  await Promise.all(pending);
}
