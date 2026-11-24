// The eval editor, shared by a task's Eval tab and the review queue: what the judge checks (criteria
// and guardrails, one per line) and the cases, each with its input, its expected answer and whether
// it is measured. The cloud app keeps the accepted eval and a draft under review; the coding agent writes the accepted one to the repository.
import type { EvalCase, EvalSpec, TaskOutput } from "../api.ts";
import { html, type Html } from "../html.ts";

// Rows enough to show the text without scrolling, up to eight.
const rows = (text: string): number => Math.min(8, Math.max(2, text.split("\n").reduce((sum, line) => sum + Math.ceil((line.length + 1) / 42), 0)));
const shown = (value: unknown): string => (value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2));

function expectedField(item: EvalCase, index: number, output: TaskOutput): Html {
  const name = `case.${index}.expected`;
  if (output.kind === "label") {
    const current = typeof item.expected === "string" ? item.expected : "";
    return html`<select name="${name}" aria-label="Expected answer for ${item.id}"><option value=""${current ? "" : html` selected`}>No answer yet</option>${output.labels.map((label) => html`<option value="${label}"${label === current ? html` selected` : ""}>${label}</option>`)}</select>`;
  }
  return html`<textarea name="${name}" rows="${rows(shown(item.expected))}" spellcheck="false" aria-label="Expected answer for ${item.id}" placeholder="${output.kind === "json" ? "The expected JSON" : "A reference answer for the judge"}">${shown(item.expected)}</textarea>`;
}

/** A case is measured unless someone left it out: a written case unticked in the label check, or one unticked here. */
export const measured = (item: EvalCase): boolean => item.approved !== false && item.expected !== undefined;

export function evalForm(spec: EvalSpec, cases: EvalCase[], output: TaskOutput, options: { action: string; submit: string; base: string | null; id?: string; editable: boolean; extra?: Html }): Html {
  const disabled = options.editable ? "" : html` disabled`;
  return html`<form class="eval-form" data-action="${options.action}"${options.id ? html` data-id="${options.id}"` : ""} data-base="${options.base ?? ""}" autocomplete="off">
    <fieldset${disabled}>
      <div class="card form eval-spec">
        <label>Criteria<span class="sub">What a right answer does, one per line. The judge checks every case on each.</span>
          <textarea name="criteria" rows="${Math.max(2, (spec.criteria ?? []).length + 1)}">${(spec.criteria ?? []).join("\n")}</textarea></label>
        <label>Guardrails<span class="sub">What the call must never do, one per line.</span>
          <textarea name="guardrails" rows="${Math.max(2, (spec.guardrails ?? []).length + 1)}">${(spec.guardrails ?? []).join("\n")}</textarea></label>
      </div>
      <div class="tablewrap eval-cases" style="margin-top: 12px">
        <table>
          <thead><tr><th>Case</th><th>Input</th><th>Expected answer</th><th>Include</th></tr></thead>
          <tbody>${cases.map((item, index) => html`<tr${measured(item) ? "" : html` class="dropped"`}>
            <td>${item.id}<span class="sub">${item.origin === "written" ? `written${item.kind ? ` · ${item.kind}` : ""}` : item.origin}</span></td>
            <td>${Object.entries(item.input).map(([key, value]) => html`<label class="eval-input"><span class="sub">${key}</span><textarea name="case.${index}.input.${key}" rows="${rows(value)}" spellcheck="false">${value}</textarea></label>`)}</td>
            <td>${expectedField(item, index, output)}</td>
            <td><input type="checkbox" name="case.${index}.keep" aria-label="Include ${item.id}"${item.approved !== false ? html` checked` : ""}></td>
          </tr>`)}</tbody>
        </table>
      </div>
      <p class="note">Runs measure the included cases that have an expected answer. A case left out stays in the eval, so later reviews do not add it back.</p>
      <p class="form-error" role="alert" hidden></p>
      ${options.editable ? html`<p class="eval-actions"><button class="btn primary" type="submit">${options.submit}</button>${options.extra ?? ""}</p>` : ""}
    </fieldset>
  </form>`;
}

/** The spec and cases the form holds, from the cases it was drawn from. */
export function readEvalForm(form: HTMLFormElement, spec: EvalSpec, cases: EvalCase[], output: TaskOutput): { spec: EvalSpec; cases: EvalCase[] } {
  const data = new FormData(form);
  const lines = (name: string) => String(data.get(name) ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  return {
    spec: { ...spec, criteria: lines("criteria"), guardrails: lines("guardrails") },
    cases: cases.map((item, index) => {
      const input = Object.fromEntries(Object.keys(item.input).map((key) => [key, String(data.get(`case.${index}.input.${key}`) ?? item.input[key])]));
      const text = String(data.get(`case.${index}.expected`) ?? "").trim();
      let expected: unknown = text || undefined;
      if (text && output.kind === "json") { try { expected = JSON.parse(text) as unknown; } catch { throw new Error(`The expected answer for ${item.id} is not valid JSON.`); } }
      const { expected: _old, approved: _approved, ...rest } = item;
      return { ...rest, input, ...(expected === undefined ? {} : { expected }), approved: data.get(`case.${index}.keep`) === "on" };
    }),
  };
}

export function formError(form: HTMLFormElement, failure: unknown): void {
  const box = form.querySelector<HTMLElement>(".form-error");
  if (box) { box.textContent = failure instanceof Error ? failure.message : "Something went wrong. Try again."; box.hidden = false; }
}
