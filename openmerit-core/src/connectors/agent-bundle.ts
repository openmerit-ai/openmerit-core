// A coding agent's task bundle as a connection, as the cloud app receives it from openmerit_recommend:
// one task, its examples and the cases written for it, a grader from its output kind, and the code
// refs its Change port edits. The host measures the cases (openmerit/ranking's `createMeasure`).
import type { CatalogueModel } from "../engine/catalogue.ts";
import { proposeEdit, type EditTarget } from "../engine/change.ts";
import type { ChangePort, Connector } from "../engine/connector.ts";
import type { EvidencePart, Grader, Source } from "../engine/evidence.ts";
import type { Case, TaskBundle } from "../ranking/types.ts";

const SOURCE = { connector: "agent-bundle", detail: "openmerit_recommend" };

/** The graders that apply to a job's cases: expected answers from the examples, answers the user confirmed in the label check, the answers the case writer wrote, or a judge for free text. */
function graders(bundle: TaskBundle, cases: readonly Case[]): Grader[] {
  if (bundle.output.kind === "text") return [{ kind: "judge", description: "a judge model against each case's reference answer" }];
  const what = bundle.output.kind === "label" ? "labels" : "JSON answers";
  const given = new Set((bundle.examples ?? []).filter(example => example.expected !== undefined).map(example => JSON.stringify(example.input)));
  const fromExamples = cases.some(item => item.origin === "example" && given.has(JSON.stringify(item.input)));
  const confirmed = cases.some(item => (item.origin === "example" && !given.has(JSON.stringify(item.input))) || (item.origin === "written" && item.approved === true));
  const unconfirmed = cases.some(item => item.origin === "written" && item.approved !== true);
  return [
    ...(fromExamples ? [{ kind: "expected_output" as const, description: `the expected ${what} of your examples` }] : []),
    ...(confirmed ? [{ kind: "confirmed_label" as const, description: `${what} you confirmed in the label check` }] : []),
    ...(unconfirmed ? [{ kind: "written_answer" as const, description: `the ${what} OpenMerit wrote for its cases` }] : []),
  ];
}

export function agentBundle(input: { bundle: TaskBundle; baselineEndpoint: string | null; find: (id: string) => CatalogueModel | null }): Connector & { evidence: () => EvidencePart; change: ChangePort } {
  const { bundle } = input;
  return {
    id: "agent-bundle", capabilities: ["list", "evidence", "change"], writes: false,
    list: () => [{ name: bundle.task, currentModel: bundle.current.model }],
    evidence: () => ({
      priority: [{ value: { kind: "request" }, source: SOURCE }],
      refs: (bundle.codeRefs ?? []).map(ref => ({ value: ref, source: { connector: "agent-bundle", detail: `${ref.file}:${ref.line}` } })),
    }),
    change: {
      propose: (task: string, target: EditTarget) => proposeEdit({ task, current: bundle.current.model, refs: bundle.codeRefs ?? [], pick: target, baselineEndpoint: input.baselineEndpoint, find: input.find }),
    },
  };
}

/** The evidence of the cases a job measures: real ones (examples, traces) and written ones, with their grader. The CLI passes its review's source. */
export function caseEvidence(bundle: TaskBundle, cases: readonly Case[], source: Source = SOURCE): EvidencePart {
  const real = cases.filter(item => item.origin !== "written"), written = cases.filter(item => item.origin === "written");
  return {
    graders: graders(bundle, cases).map(value => ({ value, source })),
    cases: [
      ...(real.length ? [{ value: { kind: "real" as const, count: real.length, description: `${real.length} ${real.some(item => item.origin === "trace") ? "recorded" : "example"} case${real.length === 1 ? "" : "s"}` }, source }] : []),
      ...(written.length ? [{ value: { kind: "written" as const, count: written.length, description: `${written.length} written case${written.length === 1 ? "" : "s"}${written.every(item => item.approved) ? " you approved" : ""}` }, source: { connector: source.connector, detail: "the case writer" } }] : []),
    ],
  };
}
