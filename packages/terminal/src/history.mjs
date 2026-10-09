// Shared by collector and browser. Dates describe retained request evidence.
export const ACTIVITY_RANGES = [1, 6, 24, 168, 720, 0];
export const rangeLabel = hours => ({ 1: '1h', 6: '6h', 24: '24h', 168: '7d', 720: '30d', 0: 'All time' })[hours];
export const rangeDescription = hours => hours === 0 ? 'All available history' : `Last ${rangeLabel(hours)}`;
export function historyExtent(records, observedAt) {
  const now = Date.parse(observedAt);
  let first = Infinity, last = -Infinity;
  for (const record of records) {
    const at = Date.parse(record.occurredAt);
    if (!Number.isFinite(at) || at > now) continue;
    first = Math.min(first, at); last = Math.max(last, at);
  }
  return { first: Number.isFinite(first) ? new Date(first).toISOString() : null, last: Number.isFinite(last) ? new Date(last).toISOString() : null };
}
export function activityWindow(records, hours, observedAt) {
  const now = Date.parse(observedAt);
  if (hours !== 0) return { start: now - hours * 3600000, end: now };
  const extent = historyExtent(records, observedAt);
  const end = extent.last ? Date.parse(extent.last) : now;
  return { start: extent.first ? Math.min(Date.parse(extent.first), end - 60000) : end - 3600000, end };
}
export function windowRecords(records, hours, observedAt) {
  const { start, end } = activityWindow(records, hours, observedAt);
  return records.filter(record => { const at = Date.parse(record.occurredAt); return at >= start && at <= end; });
}
export function intervalLabel(ms) {
  const [unit, divisor] = ms >= 86400000 ? ['day', 86400000] : ms >= 3600000 ? ['hour', 3600000] : ms >= 60000 ? ['minute', 60000] : ['second', 1000];
  return `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(ms / divisor)}-${unit}`;
}
export function activityTime(value, span, detail = false) {
  return new Date(value).toLocaleString([], detail ? { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : span > 86400000 ? { month: 'short', day: 'numeric', ...(span > 31536000000 ? { year: 'numeric' } : {}) } : { hour: '2-digit', minute: '2-digit' });
}
