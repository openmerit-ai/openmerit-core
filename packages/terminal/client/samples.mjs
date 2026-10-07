// Liveline connects adjacent points. Only pass the latest uninterrupted run:
// null readings, clock reversals, and missed collection windows are gaps.
export function contiguousSamples(history, field, interval) {
  let points = [];
  for (const sample of history) {
    const time = Date.parse(sample.at) / 1000, value = sample[field];
    if (!Number.isFinite(time) || !Number.isFinite(value)) { points = []; continue; }
    const previous = points.at(-1);
    if (previous && (time <= previous.time || time - previous.time > interval * 1.75)) points = [];
    points.push({ time, value });
  }
  return points;
}

export function nearestSample(points, time) {
  return points.reduce((best, point) => !best || Math.abs(point.time - time) < Math.abs(best.time - time) ? point : best, null);
}
