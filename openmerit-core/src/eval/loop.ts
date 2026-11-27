// The grading loop, one state machine for the CLI and the cloud app: OpenMerit shows sampled answers
// with its own grade, and a person marks each answer Looks good or Doesn't look right, with an optional
// note. Where a person and the eval disagree, the eval is wrong: it is written again from their notes
// and measured again. Once they agree on every sample, the person has accepted the eval, and it is
// saved as the task's Eval, versioned.
//
// Grade-first (`gradeFirst`, the CLI): the answers come from a trial run, the current model's and one
// cheaper model's, and the search runs only on the accepted eval. Otherwise (the cloud app, until it
// moves to this order) the answers come from a search, and a regenerated eval is searched again.
//
// Marking the current model's own answer Doesn't look right makes the accepted Eval the bar instead of
// the current model's score (`bar: "criteria"`): the search then runs once more against the criteria,
// with the current model as one candidate. The coding agent never grades; a person does.
import { redact, type Criteria } from "../engine/index.ts";
import type { Harness } from "../harness/harness.ts";
import { writeCases, type Complete } from "../ranking/cases.ts";
import { readJson, stepChecksFor } from "../ranking/graders.ts";
import type { Case, TaskBundle } from "../ranking/types.ts";
import { harnessWriter, GENERATED_CASES, type GeneratedEval } from "./generated.ts";

/** One answer shown for grading, redacted, with OpenMerit's grade of it. */
export interface Sample {
  /** `<role>:<case>`, unique in a round. */
  id: string;
  caseId: string;
  kind: string;
  model: string;
  /** `current`: the current model's answer; `trial`: the cheaper model a grade-first trial ran; `candidate`: the pick's, or the best measured finalist's. */
  role: "current" | "trial" | "candidate";
  input: string;
  output: string;
  toolCalls: { name: string; arguments: string }[];
  pass: boolean;
  /** The spec's checks (C…, G…, S…) it failed, when the grader named them. */
  failedChecks: string[];
  reason?: string;
}

/** A case's answer as a run kept it, before sampling: what `createMeasure`'s `onCase` gives a host. */
export interface CaseAnswer extends Omit<Sample, "id" | "role" | "model" | "input"> { input: unknown }

/** What a person said about one sample: the answer looks good, or it does not, and why. */
export interface SampleGrade { sampleId: string; verdict: "good" | "bad"; note?: string }

/** A run's artifact: the sampled answers and grades, redacted. The Pi transcripts are not kept. */
export interface RunArtifact { round: number; evalVersion: number; samples: Sample[] }

export interface LoopState {
  /** 1-based: each search of the loop is one round. */
  round: number;
  /** The version of the Eval being measured: a regenerated eval is the next one. */
  evalVersion: number;
  /** The version a person accepted and the host saves, or 0 while none is. */
  savedVersion: number;
  bar: "current" | "criteria";
  /** `trial`: a grade-first loop's trial run is next; `searching`: a search is, before grading. */
  status: "trial" | "searching" | "grading" | "regenerating" | "accepted";
  /** Grade before any search: the samples come from a trial run, and the search runs once the eval is accepted. */
  gradeFirst?: boolean;
  artifact: RunArtifact | null;
  /** Each graded round, oldest first. */
  history: { round: number; evalVersion: number; bar: LoopState["bar"]; grades: SampleGrade[] }[];
}

export type LoopEvent =
  | { type: "searched"; artifact: Omit<RunArtifact, "round" | "evalVersion"> }
  | { type: "tried"; artifact: Omit<RunArtifact, "round" | "evalVersion"> }
  | { type: "graded"; grades: readonly SampleGrade[] }
  | { type: "regenerated" };

/** Answers shown per model: failed ones first, then passed ones, spread over kinds of case. */
export const SAMPLES_PER_MODEL = 6;

/** A loop measuring `evalVersion` (1 for a new eval, a saved Eval's own version to reuse it) against `bar`; `gradeFirst` grades a trial run before any search. */
export function startLoop(evalVersion = 1, bar: LoopState["bar"] = "current", gradeFirst = false): LoopState {
  return { round: 1, evalVersion, savedVersion: 0, bar, status: gradeFirst ? "trial" : "searching", artifact: null, history: [], ...(gradeFirst ? { gradeFirst: true } : {}) };
}

/**
 * A task's checks for the criteria bar: its criteria (C…), and the guardrails (G…) and step checks (S…)
 * every case must pass. A task that lists no criteria, such as a label task, has one: the expected
 * answer, which a failed case misses, so the bar is never met by a model that fails every case.
 */
export function criteriaOf(bundle: TaskBundle, passRate?: number): Criteria {
  return {
    criteria: bundle.criteria?.length ? bundle.criteria.map((_, index) => `C${index + 1}`) : ["the expected answer"],
    guardrails: [...(bundle.guardrails ?? []).map((_, index) => `G${index + 1}`), ...stepChecksFor(bundle).checks.map(check => check.id)],
    ...(passRate === undefined ? {} : { passRate }),
  };
}

/**
 * A harness that answers through `complete`, such as a host's metered model call, for `reviseEval` where
 * no coding agent runs. It reads no files; the reply's cost is the caller's to count.
 */
export function completeHarness(complete: Complete): Harness {
  return {
    kind: "api", label: "OpenMerit", usage: { calls: 0, costUsd: 0, unknownCost: 0, inputTokens: 0, outputTokens: 0 },
    async json<T>(request: { system: string; prompt: string; schema: Record<string, unknown> }): Promise<T> {
      const read = readJson(await complete({ system: request.system, prompt: `${request.prompt}\n\nReply with JSON only, matching this JSON schema:\n${JSON.stringify(request.schema)}` }));
      if (!read.ok || !read.value || typeof read.value !== "object") throw new Error("The eval's reviser did not answer with a JSON object.");
      return read.value as T;
    },
  };
}

/** Where a person and the eval disagree: an answer the eval passed that does not look right, or one it failed that does. */
export const disagrees = (sample: Pick<Sample, "pass">, grade: Pick<SampleGrade, "verdict">) => sample.pass !== (grade.verdict === "good");

/**
 * The next state. `searched` (or a grade-first loop's `tried`) shows its samples; `graded` needs one
 * grade per sample, and accepts the eval when a person agrees with it on every sample, else asks for
 * the eval again (`regenerating`). After a search, a changed bar searches again before accepting; in a
 * grade-first loop the search has not run yet, so the eval is accepted with the new bar. `regenerated`
 * measures the new version: a trial run when grading first, else a search.
 */
export function advanceLoop(state: LoopState, event: LoopEvent): LoopState {
  switch (event.type) {
    case "searched":
      if (state.status !== "searching") throw new Error(`The loop is ${state.status}, not searching.`);
      return { ...state, status: "grading", artifact: { ...event.artifact, round: state.round, evalVersion: state.evalVersion } };
    case "tried":
      if (state.status !== "trial") throw new Error(`The loop is ${state.status}, not on its trial run.`);
      return { ...state, status: "grading", artifact: { ...event.artifact, round: state.round, evalVersion: state.evalVersion } };
    case "graded": {
      if (state.status !== "grading" || !state.artifact) throw new Error(`The loop is ${state.status}, not grading.`);
      const samples = state.artifact.samples;
      const grades = new Map(event.grades.map(grade => [grade.sampleId, grade]));
      const missing = samples.filter(sample => !grades.has(sample.id));
      if (missing.length) throw new Error(`Grade every sample: ${missing.map(sample => sample.id).join(", ")} ${missing.length === 1 ? "has" : "have"} no grade.`);
      const unknown = event.grades.filter(grade => !samples.some(sample => sample.id === grade.sampleId));
      if (unknown.length) throw new Error(`Not a sample of this round: ${unknown.map(grade => grade.sampleId).join(", ")}.`);
      const graded = samples.map(sample => grades.get(sample.id)!);
      // A current model whose own answer does not look right is no longer the bar.
      const bar = state.bar === "criteria" || samples.some(sample => sample.role === "current" && grades.get(sample.id)!.verdict === "bad") ? "criteria" : "current";
      const history = [...state.history, { round: state.round, evalVersion: state.evalVersion, bar: state.bar, grades: graded }];
      if (samples.some(sample => disagrees(sample, grades.get(sample.id)!))) return { ...state, bar, status: "regenerating", history };
      // Agreement on every sample accepts this eval. After a search, a new bar still needs the search run against it; grading first, no search has run yet.
      if (bar !== state.bar && !state.gradeFirst) return { ...state, bar, status: "searching", round: state.round + 1, artifact: null, history, savedVersion: state.evalVersion };
      return { ...state, bar, status: "accepted", history, savedVersion: state.evalVersion };
    }
    case "regenerated":
      if (state.status !== "regenerating") throw new Error(`The loop is ${state.status}, not regenerating.`);
      return { ...state, status: state.gradeFirst ? "trial" : "searching", round: state.round + 1, evalVersion: state.evalVersion + 1, artifact: null };
  }
}

const text = (value: unknown, length = 4000) => {
  const raw = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const redacted = redact(raw ?? "");
  return redacted.length > length ? `${redacted.slice(0, length - 1)}…` : redacted;
};

/**
 * Up to `perModel` answers of each model for a person to grade, redacted: failed answers first, then
 * passed ones, taking kinds of case in turn so each kind shows. `models` are the current model's and
 * the candidate's answers, by model ID.
 */
export function pickSamples(models: readonly { model: string; role: Sample["role"]; answers: readonly CaseAnswer[] }[], perModel = SAMPLES_PER_MODEL): Sample[] {
  const samples: Sample[] = [];
  for (const { model, role, answers } of models) {
    const spread = (list: readonly CaseAnswer[]) => {
      const byKind = new Map<string, CaseAnswer[]>();
      for (const answer of list) byKind.set(answer.kind, [...byKind.get(answer.kind) ?? [], answer]);
      const queues = [...byKind.values()], out: CaseAnswer[] = [];
      while (queues.some(queue => queue.length)) for (const queue of queues) { const next = queue.shift(); if (next) out.push(next); }
      return out;
    };
    const failed = spread(answers.filter(answer => !answer.pass)), passed = spread(answers.filter(answer => answer.pass));
    // Half and half when both have enough, so a person sees what the eval failed and what it passed.
    const half = Math.ceil(perModel / 2), fail = Math.min(failed.length, Math.max(half, perModel - passed.length));
    for (const answer of [...failed.slice(0, fail), ...passed.slice(0, perModel - fail)]) {
      samples.push({
        id: `${role}:${answer.caseId}`, caseId: answer.caseId, kind: answer.kind, model, role, input: text(answer.input), output: text(answer.output),
        toolCalls: answer.toolCalls.map(call => ({ name: call.name, arguments: text(call.arguments, 1000) })), pass: answer.pass, failedChecks: answer.failedChecks,
        ...(answer.reason ? { reason: redact(answer.reason) } : {}),
      });
    }
  }
  return samples;
}

/** Rounds of the grading loop one run takes before it stops asking for grades. */
export const MAX_ROUNDS = 3;
export const GRADE_HINT = "or bad: <why> to add a note. A person answers this, not a coding agent.";

/** A grade question, in the shape both hosts' questions take. */
export interface GradeQuestion { id: string; kind: "choice"; prompt: string; detail: string; options: { value: "good" | "bad"; label: string }[]; hint: string }

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "task";

/** One question per sample of a round, the same in the CLI and the cloud app: the answer with its input, tool calls and OpenMerit's grade. */
export function gradeQuestions(task: string, loop: LoopState): GradeQuestion[] {
  const samples = loop.artifact!.samples;
  return samples.map((sample, index) => ({
    // The round is in the ID: one advance can grade a round, measure the next and ask again, with the same answers.
    id: `grade_${slug(task)}_r${loop.round}_${index + 1}`, kind: "choice", prompt: `${task}, answer ${index + 1} of ${samples.length}: does it look right?`,
    detail: [
      `${sample.model} (${sample.role === "current" ? "your current model" : sample.role === "trial" ? "a cheaper model" : "a candidate"}), ${sample.kind} case ${sample.caseId}${loop.round > 1 ? `, round ${loop.round}` : ""}`,
      `Input:\n${sample.input}`,
      `Answer:\n${sample.output || "(no text)"}`,
      ...(sample.toolCalls.length ? [`Tool calls: ${sample.toolCalls.map(call => `${call.name}(${call.arguments})`).join("; ")}`] : []),
      `OpenMerit's grade: ${sample.pass ? "passed" : `failed${sample.reason ? `: ${sample.reason}` : ""}`}`,
    ].join("\n"),
    options: [{ value: "good", label: "Looks good" }, { value: "bad", label: "Doesn't look right" }],
    hint: GRADE_HINT,
  }));
}

/** A grade from an answer: good or bad, or either with a note after a colon. */
export function readGrade(answer: unknown): Omit<SampleGrade, "sampleId"> | null {
  if (typeof answer !== "string") return null;
  const match = /^\s*(good|bad|looks good|doesn'?t look right)\s*(?::\s*([\s\S]*))?$/i.exec(answer);
  if (!match) return null;
  const note = match[2]?.trim();
  return { verdict: /^(good|looks good)$/i.test(match[1]!) ? "good" : "bad", ...(note ? { note: note.slice(0, 2000) } : {}) };
}

/** What a round's grades say about the eval, for the reviser and the case writer: each disagreement, with the person's note. */
export function feedbackOf(artifact: RunArtifact, grades: readonly SampleGrade[]): string {
  const byId = new Map(grades.map(grade => [grade.sampleId, grade]));
  const lines = artifact.samples.flatMap(sample => {
    const grade = byId.get(sample.id);
    if (!grade || !disagrees(sample, grade)) return [];
    const said = grade.verdict === "bad" ? "does not look right, although the eval passed it" : "looks good, although the eval failed it";
    return [`- Case ${sample.caseId} (${sample.kind}), ${sample.model}'s answer ${said}${sample.reason ? ` (the eval said: ${sample.reason})` : ""}.${grade.note?.trim() ? ` The person's note: ${redact(grade.note.trim())}` : ""}\n  Input: ${sample.input.slice(0, 600)}\n  Answer: ${sample.output.slice(0, 600)}`];
  });
  const agreed = artifact.samples.filter(sample => byId.get(sample.id) && !disagrees(sample, byId.get(sample.id)!)).length;
  return [...lines, `The person agreed with the eval on ${agreed} of ${artifact.samples.length} answers.`].join("\n");
}

const REVISE_SYSTEM = [
  "You are OpenMerit Harness revising a task's eval after a person graded some of its answers. The eval checks answers against the task's criteria (what makes an answer right) and guardrails (what it must never do).",
  "Where the person and the eval disagree, the eval is wrong: change, add or remove criteria and guardrails so the eval would agree with the person. Keep those the grades do not question, word for word and in order. Never change anything in the repository.",
].join("\n");

/**
 * A new eval from a round's grades: the reviser rewrites the criteria and guardrails where the person
 * and the eval disagreed, then the case writer writes the cases again with the person's notes. The
 * prompt, tools and output stay the spec's: they describe the code, which the grades do not change.
 */
export async function reviseEval(value: GeneratedEval, feedback: string, harness: Harness, signal?: AbortSignal): Promise<GeneratedEval> {
  const { bundle } = value;
  const list = (items: readonly string[] | undefined) => (items ?? []).map((item, index) => `${index + 1}. ${item}`).join("\n") || "(none)";
  const reply = await harness.json<{ criteria: string[]; guardrails: string[] }>({
    ...(signal ? { signal } : {}), system: REVISE_SYSTEM,
    prompt: `Task: ${bundle.task}${bundle.description ? `\n${bundle.description}` : ""}\n\nCriteria:\n${list(bundle.criteria)}\n\nGuardrails:\n${list(bundle.guardrails)}\n\nWhat the person said:\n${feedback}\n\nReply with the revised criteria and guardrails.`,
    schema: { type: "object", additionalProperties: false, required: ["criteria", "guardrails"], properties: { criteria: { type: "array", items: { type: "string" } }, guardrails: { type: "array", items: { type: "string" } } } },
  });
  const clean = (items: unknown, fallback: readonly string[] | undefined) => {
    const kept = Array.isArray(items) ? items.filter((item): item is string => typeof item === "string" && !!item.trim()).map(item => item.trim()).slice(0, 12) : [];
    return kept.length || !fallback?.length ? kept : [...fallback];
  };
  const revised: TaskBundle = { ...bundle, criteria: clean(reply.criteria, bundle.criteria), guardrails: clean(reply.guardrails, bundle.guardrails) };
  const written = await writeCases({ bundle: revised, complete: harnessWriter(harness, revised.output.kind === "json", signal), count: GENERATED_CASES, guidance: feedback });
  const cases: Case[] = written.cases.filter(item => Object.keys(item.input).length && (item.expected !== undefined || revised.output.kind === "text"));
  if (!cases.length) throw new Error("The case writer wrote no usable case for the revised eval.");
  return { bundle: revised, cases };
}
