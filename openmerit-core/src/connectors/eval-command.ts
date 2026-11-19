// The repository's own eval as a connection, for the local CLI: the strongest grader there is (the
// customer's eval decides pass or fail per item), real items, and the Measure port. The host runs the
// command, since it owns the metering proxy and the record of finished runs a resume replays.
import type { Connector, MeasurePort } from "../engine/connector.ts";
import type { Measurement, MeasureCall } from "../engine/evaluate.ts";
import type { EvidencePart } from "../engine/evidence.ts";
import type { Rung } from "../engine/search.ts";

export interface EvalCommandInput<T extends Rung> {
  command: string;
  /** Where per-item results come from, such as a Langfuse score, for the report's \"Based on\" line. */
  scoredBy?: string;
  /** Item count, when the eval says how many it runs. */
  items?: number | null;
  /** One run of the command for `option` (null: the current model) on `items` (null: every item). Null leaves the option unmeasured. */
  run: (option: T | null, items: readonly string[] | null, call: MeasureCall) => Promise<Measurement | null>;
  /** The screening items, the same on a resume. */
  sample: MeasurePort<T>["sample"];
}

/** What the eval contributes: the customer's own grader, and its items as real cases. */
export function evalEvidence(input: { command: string; scoredBy?: string; items?: number | null }): EvidencePart {
  const source = { connector: "eval-command", detail: input.command };
  return {
    graders: [{ value: { kind: "customer_eval", description: `your eval's pass or fail per item${input.scoredBy ? ` (${input.scoredBy})` : ""}` }, source }],
    cases: [{ value: { kind: "real", count: input.items ?? 0, description: input.items ? `${input.items} items of your eval` : "the items of your eval" }, source }],
  };
}

export function evalCommand<T extends Rung>(input: EvalCommandInput<T>): Omit<Connector, "measure"> & { measure: MeasurePort<T> } {
  return { id: "eval-command", capabilities: ["evidence", "measure"], writes: false, evidence: () => evalEvidence(input), measure: { measure: input.run, sample: input.sample } };
}
