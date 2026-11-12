#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { configureHarness, openRuntime, pickScoutModel } from "./pi/harness.ts";
import type { Grader } from "./scout/evaluators/pi.ts";

const HELP = `OpenMerit: find the right model for your task.

Usage:
  openmerit                          Pi coding agent with OpenMerit Scout (/scout, scout_* tools)
  openmerit login                    Connect a subscription or API key (Pi's /login)
  openmerit status                   Connected providers, Scout's model and Langfuse
  openmerit scout "<task>" [options] Scout agent: reads the task and codebase, runs the search, recommends a model
  openmerit run [options]            The search alone, without the agent (for CI and coding agents)
  openmerit candidates [options]     ECI-ranked candidates the connected providers can run
  openmerit pi [pi args]             Pi itself, with the Scout extension

Options:
  --codebase <dir>          Project Scout reads (default: current directory)
  --langfuse-dataset <name> Labelled Langfuse dataset
  --dataset <file.jsonl>    Local labelled items {id?, input, expectedOutput}; pushed to Langfuse
  --evaluator <module.mts>  Evaluator module that runs your real harness (relative to the current directory)
  --system-prompt <text>    run: production system prompt for the built-in Pi evaluator
  --grader <exact|contains|json|judge>  run: how the Pi evaluator checks a reply (default json)
  --rubric <text>           run: rubric for the judge grader
  --task <text>             run: task description recorded with the experiments
  --providers <a,b>         Candidate providers (default: every connected provider)
  --tools                   Candidates must support tool calls
  --max-price <usd>         Max list price per million input+output tokens
  --exclude <a,b>           Drop candidates whose provider/id contains any of these
  --model <provider/id>     Model Scout itself runs on
  --sample-size <n>         Items per binary-search probe (default 5)
  --finalists <n>           Finalists run on every item (default 5)
  --repeats <n>             Runs of every item per finalist (default 3)
  --execute                 Allow spending provider credit (otherwise plan only)
  --json                    Machine-readable output

Credentials come from Pi: API keys in the environment (OPENROUTER_API_KEY, ANTHROPIC_API_KEY,
OPENAI_API_KEY, ...), subscriptions via \`openmerit login\`, or CLAUDE_CODE_OAUTH_TOKEN. Langfuse:
LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL (Cloud or self-hosted). No OpenMerit account.`;

const [command = "", ...rest] = process.argv.slice(2);
configureHarness();

async function launchPi(args: string[]) {
  const { main } = await import("@earendil-works/pi-coding-agent");
  const { createScoutExtension } = await import("./pi/extension.ts");
  await main(args, { extensionFactories: [{ name: "openmerit-scout", factory: createScoutExtension({ allowSpend: "ask" }) }] });
}

function options(args: string[]) {
  return parseArgs({
    args, allowPositionals: true,
    options: {
      codebase: { type: "string" }, "langfuse-dataset": { type: "string" }, dataset: { type: "string" }, evaluator: { type: "string" },
      "system-prompt": { type: "string" }, grader: { type: "string" }, rubric: { type: "string" }, task: { type: "string" },
      providers: { type: "string" }, tools: { type: "boolean" }, "max-price": { type: "string" }, exclude: { type: "string" },
      model: { type: "string" }, "sample-size": { type: "string" }, finalists: { type: "string" }, repeats: { type: "string" },
      execute: { type: "boolean", default: false }, json: { type: "boolean", default: false }, help: { type: "boolean" },
    },
  });
}

type Values = ReturnType<typeof options>["values"];
const list = (value?: string) => value?.split(",").map(item => item.trim()).filter(Boolean);
const filterFrom = (values: Values) => ({
  ...(values.providers ? { providers: list(values.providers)! } : {}), ...(values.tools ? { tools: true } : {}),
  ...(values["max-price"] ? { maxPrice: Number(values["max-price"]) } : {}), ...(values.exclude ? { exclude: list(values.exclude)! } : {}),
});
const log = (line: string) => process.stderr.write(`${line}\n`);

async function hostFor(values: Values) {
  const { runtime, caller, models } = await openRuntime();
  const scout = await pickScoutModel(runtime, values.model).catch(() => null);
  return { runtime, scout, host: { caller, models, cwd: resolve(values.codebase ?? "."), env: process.env, log, ...(scout ? { scoutModel: `${scout.provider}/${scout.id}` } : {}) } };
}

async function main() {
  if (command === "" ) return launchPi(rest);
  if (command === "pi") return launchPi(rest);
  if (command === "login") return launchPi(["/login", ...rest]);
  if (command === "help" || command === "--help" || command === "-h") return void process.stdout.write(`${HELP}\n`);
  if (command === "--version" || command === "-v") {
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    return void process.stdout.write(`${pkg.version}\n`);
  }
  const { values, positionals } = options(rest);
  if (values.help) return void process.stdout.write(`${HELP}\n`);
  const service = await import("./scout/service.ts");

  if (command === "status") {
    const { host } = await hostFor(values);
    const status = await service.connections(host);
    if (values.json) return void process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    process.stdout.write(`Providers: ${Object.entries(status.providers).map(([name, count]) => `${name} (${count} models)`).join(", ") || "none"}\n`);
    process.stdout.write(`Scout model: ${status.scoutModel ?? "none"}\n`);
    process.stdout.write(`Langfuse: ${status.langfuse.connected ? `${status.langfuse.project} at ${status.langfuse.baseUrl}; datasets ${status.langfuse.datasets?.join(", ") || "none"}` : `not connected${status.langfuse.error ? ` (${status.langfuse.error})` : ""}`}\n`);
    return;
  }

  if (command === "candidates") {
    const { host } = await hostFor(values);
    const ranked = await service.candidates(host, filterFrom(values));
    if (values.json) return void process.stdout.write(`${JSON.stringify(ranked, null, 2)}\n`);
    for (const item of ranked.candidates) process.stdout.write(`${item.eci.toFixed(1).padStart(6)}  ${item.eciSource === "published" ? "         " : `${item.eciSource.slice(0, 4)} ±${(item.eciError ?? 0).toFixed(1)}`.padEnd(9)}  ${item.model}  ${item.price === null ? "?" : `$${item.price.toFixed(2)}/M`}\n`);
    process.stdout.write(`${ranked.candidates.length} candidates (${ranked.counts.published} published ECI, ${ranked.counts.estimated} estimated, ${ranked.counts.calibrated} calibrated from data/eci-estimates.csv), ${ranked.unranked.length} unranked, ${ranked.dropped.length} filtered. ${ranked.eci.attribution}\n`);
    return;
  }

  if (command === "run") {
    const { host } = await hostFor(values);
    const evaluator = values.evaluator
      ? { type: "module" as const, path: resolve(values.evaluator) }
      : (() => {
        if (!values["system-prompt"]) throw new Error("run needs --evaluator <module> or --system-prompt for the built-in Pi evaluator");
        const kind = values.grader ?? "json";
        const grader: Grader = kind === "judge" ? { type: "judge", rubric: values.rubric ?? "The output must agree with the expected output." }
          : kind === "exact" ? { type: "exact" } : kind === "contains" ? { type: "contains" } : { type: "json" };
        return { type: "pi" as const, systemPrompt: values["system-prompt"], grader };
      })();
    const params = {
      task: values.task ?? positionals.join(" ") ?? "", evaluator, filter: filterFrom(values),
      ...(values["langfuse-dataset"] ? { langfuseDataset: values["langfuse-dataset"] } : {}), ...(values.dataset ? { datasetPath: resolve(values.dataset) } : {}),
      ...(values["sample-size"] ? { sampleSize: Number(values["sample-size"]) } : {}), ...(values.finalists ? { finalists: Number(values.finalists) } : {}),
      ...(values.repeats ? { repeats: Number(values.repeats) } : {}),
    };
    if (!values.execute) {
      const planned = await service.plan(host, params);
      const out = { status: "plan_only", candidates: planned.ranked.candidates.length, datasetSize: planned.datasetSize, estimate: planned.estimate, evaluator: planned.plugin?.name ?? "pi", note: "Add --execute to run it." };
      return void process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    }
    const result = await service.run(host, params);
    process.stdout.write(values.json ? `${JSON.stringify(result.report, null, 2)}\n` : `${result.markdown}\nReport: ${result.files.markdown}\n`);
    return;
  }

  if (command === "scout") {
    const task = positionals.join(" ").trim();
    if (!task) throw new Error("Describe the task: openmerit scout \"<what the model does>\"");
    const { createAgentSession, DefaultResourceLoader, SessionManager, getAgentDir } = await import("@earendil-works/pi-coding-agent");
    const { createScoutExtension } = await import("./pi/extension.ts");
    const { runtime, scout, host } = await hostFor(values);
    if (!scout) throw new Error("No model provider is connected for Scout. Set an API key or run `openmerit login`.");
    const cwd = host.cwd;
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: getAgentDir(), noSkills: true, noPromptTemplates: true,
      extensionFactories: [{ name: "openmerit-scout", factory: createScoutExtension({ allowSpend: values.execute, log, scoutModel: host.scoutModel! }) }],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd, model: scout, thinkingLevel: "medium", modelRuntime: runtime, resourceLoader, sessionManager: SessionManager.inMemory(cwd),
      tools: ["read", "grep", "find", "ls", "scout_connections", "scout_candidates", "scout_dataset", "scout_save_dataset", "scout_run"],
    });
    log(`Scout on ${host.scoutModel} in ${cwd}${values.execute ? "" : " (plan only: add --execute to spend)"}`);
    session.subscribe((event) => {
      if (event.type === "tool_execution_start") log(`→ ${event.toolName} ${JSON.stringify(event.args ?? {}).slice(0, 300)}`);
    });
    const hints = [
      values["langfuse-dataset"] && `Use the Langfuse dataset "${values["langfuse-dataset"]}".`,
      values.dataset && `Use the local dataset ${resolve(values.dataset)}.`,
      values.evaluator && `Use the evaluator module ${resolve(values.evaluator)}.`,
      (values.providers || values.tools || values["max-price"] || values.exclude) && `Candidate filter: ${JSON.stringify(filterFrom(values))}.`,
      values["sample-size"] && `sampleSize ${values["sample-size"]}.`, values.finalists && `finalists ${values.finalists}.`, values.repeats && `repeats ${values.repeats}.`,
    ].filter(Boolean).join(" ");
    try {
      await session.prompt(`Recommend the model for this task.\n\nTask: ${task}\n\n${hints}`.trim());
      const answer = session.getLastAssistantText() ?? "";
      process.stdout.write(values.json ? `${JSON.stringify({ task, scoutModel: host.scoutModel, answer }, null, 2)}\n` : `${answer}\n`);
    } finally {
      session.dispose();
    }
    return;
  }
  throw new Error(`Unknown command "${command}". Run \`openmerit help\`.`);
}

main().catch((error: unknown) => {
  process.stderr.write(`openmerit: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
