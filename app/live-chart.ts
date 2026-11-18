// Liveline charts for live.ts, loaded only on pages that draw one, since Liveline needs React.
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { Liveline, type LivelinePoint } from "liveline";

export type Draw = (points: LivelinePoint[], value: number, baseline: { model: string; rate: number } | null) => void;

/** A full chart (.live-chart) or a sparkline (.live-spark) of a pass rate so far against the current model's. */
export function mountChart(element: HTMLElement): Draw {
  const root = createRoot(element);
  const spark = element.classList.contains("live-spark");
  const dark = matchMedia("(prefers-color-scheme: dark)");
  let last: Parameters<Draw> = [[], 0, null];
  const draw: Draw = (points, value, baseline) => {
    last = [points, value, baseline];
    const span = points.length > 1 ? points.at(-1)!.time - points[0]!.time : 0;
    root.render(createElement(Liveline, {
      data: points,
      value,
      theme: dark.matches ? "dark" : "light",
      color: getComputedStyle(document.documentElement).getPropertyValue("--green").trim(),
      window: Math.max(30, Math.ceil(span * 1.1)),
      momentum: false,
      ...(baseline ? { referenceLine: spark ? { value: baseline.rate } : { value: baseline.rate, label: baseline.model.split("/").at(-1) ?? baseline.model } } : {}),
      formatValue: (v: number) => `${v.toFixed(0)}%`,
      ...(spark
        ? { grid: false, badge: false, scrub: false, pulse: false, lineWidth: 1.5, padding: { top: 4, right: 4, bottom: 4, left: 0 } }
        : { badgeVariant: "minimal" as const }),
    }));
  };
  dark.addEventListener("change", () => draw(...last));
  return draw;
}
