// Runs in progress, scripted: a ticket finishes every couple of seconds per run. Every
// element marked data-run="<id>" follows that run. Torph (https://torph.lochie.me) morphs
// its data-morph numbers and statuses; Liveline (https://benji.org/liveline) draws its
// pass rate so far as a full chart (.live-chart) or a sparkline (.live-spark) against the
// current model's. When all tickets are done it shows the result, then starts over.
import { TextMorph } from "torph";
import type { LivelinePoint } from "liveline";
import type { Draw } from "./live-chart.js";

interface Script {
  readonly candidate: string;
  readonly baseline: { readonly model: string; readonly rate: number };
  readonly total: number;
  /** Tickets already run when the page opens, so charts start with a line. */
  readonly start: number;
  /** Tickets the candidate fails. */
  readonly fails: ReadonlySet<number>;
  readonly minutesPerTicket: number;
  readonly tickMs: number;
}

const scripts: Readonly<Record<string, Script>> = {
  // An early miss, then one more: 38 of 40, as good as GPT-5.
  p4x8n2: { candidate: "GPT-5 mini", baseline: { model: "GPT-5", rate: 95 }, total: 40, start: 14, fails: new Set([3, 19]), minutesPerTicket: 0.7, tickMs: 1600 },
  // Misses keep coming: 35 of 40, short of Claude Sonnet 5.5.
  f9d3w6: { candidate: "Gemini 3.5 Flash", baseline: { model: "Claude Sonnet 5.5", rate: 97 }, total: 40, start: 8, fails: new Set([2, 9, 15, 22, 31]), minutesPerTicket: 0.5, tickMs: 1900 },
};

// Liveline needs React, so it loads only on pages that draw a chart.
async function charts(id: string, script: Script): Promise<Draw[]> {
  const elements = Array.from(document.querySelectorAll<HTMLElement>(`[data-run="${id}"]:is(.live-chart, .live-spark)`));
  if (!elements.length) return [];
  const { mountChart } = await import("./live-chart.js");
  return elements.map((element) => mountChart(element, script.baseline));
}

async function run(id: string, script: Script): Promise<void> {
  const morphs = (name: string): TextMorph[] =>
    Array.from(document.querySelectorAll<HTMLElement>(`[data-run="${id}"][data-morph="${name}"]`), (element) => new TextMorph({ element }));
  const status = morphs("status");
  const tickets = morphs("tickets");
  const rate = morphs("rate");
  const draws = await charts(id, script);
  let done = 0;
  let passed = 0;
  let points: LivelinePoint[] = [];
  const percent = (): number => (passed / done) * 100;
  const runTicket = (): void => { done += 1; passed += script.fails.has(done) ? 0 : 1; };

  const render = (): void => {
    const value = percent();
    draws.forEach((draw) => draw(points, value));
    const minutes = Math.max(1, Math.ceil((script.total - done) * script.minutesPerTicket));
    const verdict = value >= script.baseline.rate ? `Done · matches ${script.baseline.model}` : `Done · short of ${script.baseline.model}`;
    status.forEach((morph) => morph.update(done < script.total ? `Measuring · about ${minutes} min left` : verdict));
    tickets.forEach((morph) => morph.update(`${done} of ${script.total}`));
    rate.forEach((morph) => morph.update(`${value.toFixed(0)}%`));
  };
  const restart = (): void => {
    done = 0;
    passed = 0;
    points = [];
    const now = Date.now() / 1000;
    while (done < script.start) {
      runTicket();
      points.push({ time: now - ((script.start - done) * script.tickMs) / 1000, value: percent() });
    }
    render();
  };
  const tick = (): void => {
    if (done >= script.total) restart();
    else {
      runTicket();
      points = [...points.slice(-60), { time: Date.now() / 1000, value: percent() }];
      render();
    }
    // Holds a finished result for a few ticks before the demo starts over.
    setTimeout(tick, done >= script.total ? script.tickMs * 4 : script.tickMs);
  };
  restart();
  setTimeout(tick, script.tickMs);
}

for (const [id, script] of Object.entries(scripts)) {
  if (document.querySelector(`[data-run="${id}"]`)) void run(id, script);
}
