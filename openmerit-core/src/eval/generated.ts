// The cases OpenMerit writes for a task from its spec, on the harness: the case writer's reply shape and
// its mocked tool results. The grading loop (loop.ts) writes an eval again with it from a person's notes.
import type { Harness } from "../harness/harness.ts";
import type { Complete } from "../ranking/cases.ts";
import type { Case, TaskBundle } from "../ranking/types.ts";

export interface GeneratedEval { bundle: TaskBundle; cases: Case[] }

/** Cases the harness writes for a task, besides the examples it found. */
export const GENERATED_CASES = 12;

const parseJson = (text: string): unknown => { try { return text.trim() ? JSON.parse(text) : undefined; } catch { return undefined; } };
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** A tool result the harness writes: `whenJson` holds the arguments it answers, or is empty for any call. */
export interface ToolResultReply { name: string; whenJson: string; resultJson: string }

/** Tool results by tool name, as openmerit/ranking takes them: one result, or a list of `{ when?, result }` matched on the call's arguments. */
export function toolResultsOf(items: readonly ToolResultReply[] | undefined, tools: ReadonlySet<string> | null = null): Record<string, unknown> {
  const byTool = new Map<string, { when?: Record<string, unknown>; result: unknown }[]>();
  for (const item of items ?? []) {
    if (!item.name || (tools && !tools.has(item.name))) continue;
    const when = parseJson(item.whenJson ?? ""), result = parseJson(item.resultJson) ?? item.resultJson;
    byTool.set(item.name, [...byTool.get(item.name) ?? [], { ...(isObject(when) && Object.keys(when).length ? { when } : {}), result }]);
  }
  return Object.fromEntries([...byTool].map(([name, entries]) => [name, entries.length === 1 && !entries[0]!.when ? entries[0]!.result : entries]));
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
