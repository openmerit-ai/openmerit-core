// The eval OpenMerit generates for a task when Scout reviews it: the task spec the review prompt wrote
// (bundle.json) and the cases written from it (cases.json), saved in `.openmerit/evals/<task>/`. It runs
// under the eval contract like any eval: once per model and item set, with every model call sent to
// OPENAI_BASE_URL, and per-item pass or fail as its result. Scout runs it in-process; `openmerit eval
// <dir>` runs it from a shell. Each case's tools answer with their mocked results, never real ones.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CandidateUnavailable, MemoryLedger } from "../engine/index.ts";
import type { Harness } from "../harness/harness.ts";
import { createClient, type EndpointConfig } from "../ranking/clients.ts";
import { writeCases, type Complete } from "../ranking/cases.ts";
import { graderFor } from "../ranking/graders.ts";
import { createMeasure } from "../ranking/measure.ts";
import { caseKind, type Case, type TaskBundle } from "../ranking/types.ts";
import type { CaseAnswer } from "./loop.ts";
import type { EvalOutcome } from "./runner.ts";
import { toolResultsOf, type ToolResultReply } from "../review/index.ts";

export interface GeneratedEval { bundle: TaskBundle; cases: Case[] }

/** Cases the harness writes for a task, besides the examples it found. */
export const GENERATED_CASES = 12;

/** Where a task's generated eval lives, relative to the project root. */
export const generatedDir = (task: string) => `.openmerit/evals/${task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "task"}`;

/** What `eval.json` says about a saved Eval: its version, the bar it measures against, and when a person accepted it. */
export interface EvalVersion { version: number; bar: "current" | "criteria"; acceptedAt: string }

/** Saves an Eval a person accepted: the spec, the cases and `eval.json`. */
export function saveGeneratedEval(root: string, dir: string, value: GeneratedEval, version?: EvalVersion): void {
  const path = resolve(root, dir);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "bundle.json"), `${JSON.stringify(value.bundle, null, 2)}\n`);
  writeFileSync(join(path, "cases.json"), `${JSON.stringify(value.cases, null, 2)}\n`);
  if (version) writeFileSync(join(path, "eval.json"), `${JSON.stringify(version, null, 2)}\n`);
}

/** A saved Eval's version; one saved before versions were kept is version 1 against the current model. */
export function loadEvalVersion(root: string, dir: string): EvalVersion {
  const path = join(resolve(root, dir), "eval.json");
  const saved = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Partial<EvalVersion> : {};
  return { version: Number.isInteger(saved.version) && saved.version! >= 1 ? saved.version! : 1, bar: saved.bar === "criteria" ? "criteria" : "current", acceptedAt: typeof saved.acceptedAt === "string" ? saved.acceptedAt : "" };
}

export function loadGeneratedEval(root: string, dir: string): GeneratedEval {
  const path = resolve(root, dir);
  if (!existsSync(join(path, "bundle.json")) || !existsSync(join(path, "cases.json"))) throw new Error(`${dir} has no bundle.json and cases.json: it is not an eval OpenMerit generated.`);
  return { bundle: JSON.parse(readFileSync(join(path, "bundle.json"), "utf8")) as TaskBundle, cases: JSON.parse(readFileSync(join(path, "cases.json"), "utf8")) as Case[] };
}

const CASES_SCHEMA = {
  type: "object", additionalProperties: false, required: ["cases"],
  properties: { cases: { type: "array", items: { type: "object", additionalProperties: false, required: ["kind", "input", "expected", "toolResults"], properties: {
    kind: { type: "string", enum: ["typical", "edge", "guardrail"] },
    input: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "value"], properties: { name: { type: "string" }, value: { type: "string" } } } },
    expected: { type: "string", description: "The label, the expected JSON as a string, or a short reference answer." },
    toolResults: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "whenJson", "resultJson"], properties: { name: { type: "string" }, whenJson: { type: "string", description: "The call's arguments this result answers, as JSON, or empty for any call." }, resultJson: { type: "string", description: "What the tool returns, as JSON." } } } },
  } } } },
};

/** The case writer on the harness: its reply, in the shape `writeCases` reads. */
export function harnessWriter(harness: Harness, json: boolean, signal?: AbortSignal): Complete {
  return async ({ system, prompt }) => {
    const reply = await harness.json<{ cases: { kind: string; input: { name: string; value: string }[]; expected: string; toolResults?: ToolResultReply[] }[] }>({
      system, prompt: `${prompt}\n\nGive each input as a list of {name, value}, "expected" as a string${json ? " holding the expected JSON object" : ""}, and toolResults as a list of {name, whenJson, resultJson} (empty when the call offers no tools): for a tool the case calls with different arguments, such as a lookup per code, one entry per call with its arguments in whenJson; else whenJson empty.`, schema: CASES_SCHEMA, ...(signal ? { signal } : {}),
    });
    const parse = (text: string) => { try { return JSON.parse(text) as unknown; } catch { return undefined; } };
    return JSON.stringify({ cases: (reply.cases ?? []).map(item => ({
      kind: item.kind, input: Object.fromEntries((item.input ?? []).map(entry => [entry.name, entry.value])), expected: json ? parse(item.expected) : item.expected,
      toolResults: toolResultsOf(item.toolResults),
    })) });
  };
}

/** Writes a task's cases from its spec on the harness: its examples first, then GENERATED_CASES more. */
export async function generateEval(bundle: TaskBundle, harness: Harness, signal?: AbortSignal): Promise<GeneratedEval> {
  const written = await writeCases({ bundle, complete: harnessWriter(harness, bundle.output.kind === "json", signal), count: GENERATED_CASES });
  // A case needs an input, and an expected answer unless a judge grades it; a prompt without placeholders has nothing to vary.
  return { bundle, cases: written.cases.filter(item => Object.keys(item.input).length && (item.expected !== undefined || bundle.output.kind === "text")) };
}

/** What the eval needs to run one model: the endpoint under test (the proxy) and, for judged answers, the judge's. */
export interface GeneratedRun {
  model: string; baseUrl: string; apiKey: string;
  items: readonly string[] | null;
  judge?: { model: string; baseUrl: string; apiKey: string };
  signal?: AbortSignal;
}

/** What a generated eval keeps of one model's run beyond pass or fail: why each failed item failed, the checks it failed, and each answer for grading. */
export interface GeneratedOutcome { reasons: Record<string, string>; checks: Record<string, string[]>; answers: CaseAnswer[] }

/** Runs a generated eval for one model, with the eval contract's result: pass or fail per item, and why a failed item failed. */
export async function runGeneratedEval(value: GeneratedEval, input: GeneratedRun): Promise<EvalOutcome & GeneratedOutcome> {
  const started = Date.now();
  const endpoints: EndpointConfig[] = [{ id: "candidate", kind: "openai-compatible", baseUrl: input.baseUrl, apiKey: input.apiKey, funding: "customer" }];
  if (input.judge) endpoints.push({ id: "judge", kind: "openai-compatible", baseUrl: input.judge.baseUrl, apiKey: input.judge.apiKey, funding: "customer" });
  // The proxy meters and caps spend; this ledger only keys the calls of one run.
  const client = createClient(endpoints, { model: () => null, retries: false });
  const grader = graderFor(value.bundle, input.judge ? { judge: { client, endpoint: "judge", model: input.judge.model } } : {});
  const ids = input.items?.length ? [...input.items] : value.cases.map(item => item.id);
  try {
    // Each answer is kept for a person to grade; the Pi transcript is not.
    const byId = new Map(value.cases.map(item => [item.id, item]));
    const answers: CaseAnswer[] = [];
    const onCase = (result: { caseId: string; pass: boolean; reason?: string; failedChecks?: string[] }, ran: { output: string | null; toolCalls?: readonly { name: string; arguments: string }[] } | null) => {
      const item = byId.get(result.caseId);
      if (item) answers.push({ caseId: item.id, kind: caseKind(item), input: item.input, output: ran?.output ?? "", toolCalls: (ran?.toolCalls ?? []).map(call => ({ name: call.name, arguments: call.arguments })), pass: result.pass, failedChecks: result.failedChecks ?? [], ...(result.reason ? { reason: result.reason } : {}) });
    };
    const measure = createMeasure({ bundle: value.bundle, cases: value.cases, client, grader, ledger: new MemoryLedger(), key: "eval", onCase, ...(input.signal ? { signal: input.signal } : {}) });
    const result = await measure({ model: input.model, endpoint: "candidate" }, ids);
    return {
      ok: true, exitCode: 0, durationMs: Date.now() - started,
      items: result.results.map(item => ({ id: item.caseId, pass: item.pass })),
      reasons: Object.fromEntries(result.results.flatMap(item => (item.pass || !item.reason ? [] : [[item.caseId, item.reason]]))),
      checks: Object.fromEntries(result.results.flatMap(item => (item.failedChecks?.length ? [[item.caseId, item.failedChecks]] : []))),
      answers: ids.flatMap(id => answers.filter(answer => answer.caseId === id)),
    };
  } catch (error) {
    const unavailable = error instanceof CandidateUnavailable;
    return { ok: false, exitCode: 1, durationMs: Date.now() - started, items: null, reasons: {}, checks: {}, answers: [], error: unavailable ? `the endpoint refused ${input.model}: ${error.message}` : (error as Error).message };
  }
}

/** The prefix of the repository's own eval items when they run beside a generated eval. */
export const REPO_ITEM = "repo:";
