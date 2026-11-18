// Runs in progress, kept current: while a page shows any element marked data-live="<run id>",
// it polls that run every few seconds. Torph (https://torph.lochie.me) morphs each data-morph
// text, the meter follows the progress, and Liveline (https://benji.org/liveline) draws the pass
// rate so far in .live-spark and .live-chart. When a run changes status or finishes, the page
// renders again, which shows the report.
import { TextMorph } from "torph";
import type { Api, JobView, Report } from "./api.ts";
import type { Draw } from "./live-chart.ts";

const POLL_MS = 3000;

/** The texts a live run shows, by data-morph name. Pages render the same texts first. */
export function liveText(job: JobView): Record<string, string> {
  const live = job.live;
  const status = job.status === "running"
    ? live?.minutesLeft ? `Measuring · about ${live.minutesLeft} min left` : "Measuring"
    : job.status === "queued" ? "Queued" : job.status === "needs_input" ? "Waiting for your answer" : job.status;
  return {
    status,
    cases: live ? `${live.done} of ${live.total}` : job.progress.planned ? `${job.progress.measured} of about ${job.progress.planned}` : "–",
    rate: live && live.done ? `${Math.round((live.passes / live.done) * 100)}%` : "–",
  };
}

let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

export function stopLive(): void { clearTimeout(timer); generation += 1; }

export function startLive(root: HTMLElement, api: Api, refresh: () => Promise<void>): void {
  stopLive();
  const current = generation;
  const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-live][data-status]"));
  if (!rows.length) return;
  const shown = new Map(rows.map((row) => [row.dataset.live!, row.dataset.status!]));
  const morphs = new Map<HTMLElement, TextMorph>();
  const shownText = new Map<HTMLElement, string>();
  const charts = new Map<HTMLElement, Promise<Draw>>();

  const update = (id: string, job: JobView): void => {
    const text = liveText(job);
    for (const element of Array.from(root.querySelectorAll<HTMLElement>(`[data-live="${id}"][data-morph]`))) {
      const next = text[element.dataset.morph ?? ""];
      // Torph adds its own nodes to the element, so compare with the last text shown, not textContent.
      if (next === undefined || next === (shownText.get(element) ?? element.textContent)) continue;
      let morph = morphs.get(element);
      if (!morph) morphs.set(element, morph = new TextMorph({ element }));
      morph.update(next);
      shownText.set(element, next);
    }
    const share = job.live ? job.live.done / job.live.total : job.progress.planned ? job.progress.measured / job.progress.planned : 0;
    for (const bar of Array.from(root.querySelectorAll<HTMLElement>(`[data-live="${id}"] .meter i`))) bar.style.width = `${Math.round(Math.min(1, share) * 100)}%`;
    const live = job.live;
    if (!live?.history.length) return;
    for (const element of Array.from(root.querySelectorAll<HTMLElement>(`[data-live="${id}"]:is(.live-spark, .live-chart)`))) {
      let chart = charts.get(element);
      if (!chart) charts.set(element, chart = import("./live-chart.ts").then(({ mountChart }) => mountChart(element)));
      void chart.then((draw) => draw(live.history.map((point) => ({ time: point.time, value: point.rate })), live.history.at(-1)!.rate, live.baseline));
    }
  };

  const tick = async (): Promise<void> => {
    if (!document.hidden) {
      const ids = [...shown.keys()];
      const found = await Promise.all(ids.map((id) => api.get<JobView | Report>(`/api/runs/${encodeURIComponent(id)}`).catch(() => null)));
      if (current !== generation) return;
      const changed = ids.some((id, i) => {
        const view = found[i];
        return view && (!("report" in view && view.report === null) || view.status !== shown.get(id));
      });
      if (changed) { void refresh(); return; }
      ids.forEach((id, i) => { const view = found[i]; if (view && "report" in view && view.report === null) update(id, view); });
    }
    if (current === generation) timer = setTimeout(() => void tick(), POLL_MS);
  };
  void tick();
}
