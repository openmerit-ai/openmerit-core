import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const known = value => value && !['Unattributed', 'Unattributed route'].includes(value);
const scope = record => known(record.route) ? `route:${record.route}` : known(record.provider) ? `provider:${record.provider}` : null;
const exactKey = record => JSON.stringify([record.id, record.occurredAt, record.model, record.provider, record.route]);
const requestKey = record => record.requestId && scope(record) ? JSON.stringify([scope(record), record.model, record.requestId]) : null;
const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'durationMs', 'cost', 'currency', 'costKind', 'agentId', 'taskId'];

// Sources arrive in precedence order. Only shared recorded identifiers merge;
// similar timestamps, equal token counts, or matching model names never do.
export function reconcileActivity(batches) {
  const groups = [], exact = new Map(), requests = new Map();
  const counts = batches.map(batch => ({ sourceId: batch.sourceId, records: batch.records.length, included: 0, duplicates: 0, excluded: 0 }));
  for (let rank = 0; rank < batches.length; rank++) {
    for (const record of batches[rank].records) {
      const key = exactKey(record), request = requestKey(record);
      let group = exact.get(key) ?? (request ? requests.get(request) : null);
      if (!group) { group = { record: { ...record }, rank, sources: new Set(), members: [], conflicts: new Set() }; groups.push(group); }
      else {
        counts[rank].duplicates++;
        const old = group.record;
        if (old.status !== 'running' && record.status !== 'running') for (const field of fields) {
          if (old[field] != null && record[field] != null && old[field] !== record[field]) group.conflicts.add(field);
        }
        if (old.status === 'running' && record.status !== 'running') group.record = { ...record };
      }
      group.sources.add(record.sourceId); group.members.push({ rank, sourceId: record.sourceId });
      exact.set(key, group); if (request) requests.set(request, group);
    }
  }
  // If sources cover the same connection/model but don't supply a common
  // identity, don't assert that their unmatched weak records are additive.
  const coverage = new Map();
  for (const group of groups) {
    const key = JSON.stringify([scope(group.record), group.record.model]);
    if (!coverage.has(key)) coverage.set(key, []);
    coverage.get(key).push(group);
  }
  const excluded = new Set();
  for (const items of coverage.values()) {
    const ranks = new Set(items.flatMap(group => group.members.map(member => member.rank)));
    if (ranks.size < 2) continue;
    const primary = Math.min(...ranks);
    const primaryRecords = items.filter(group => group.members.some(member => member.rank === primary));
    for (const group of items) {
      if (group.members.some(member => member.rank === primary)) continue;
      const unresolved = !requestKey(group.record) || primaryRecords.some(item => !requestKey(item.record));
      if (unresolved) { excluded.add(group); counts[group.rank].excluded++; }
    }
  }
  const included = groups.filter(group => !excluded.has(group));
  const ids = new Map(); for (const group of included) ids.set(group.record.id, (ids.get(group.record.id) ?? 0) + 1);
  const records = included.map(group => {
    counts[group.rank].included++;
    return { ...group.record,
      ...(ids.get(group.record.id) > 1 ? { originalId: group.record.id, id: `request:${hash(exactKey(group.record))}` } : {}),
      sourceIds: [...group.sources],
      ...(group.conflicts.size ? { conflictingFields: [...group.conflicts] } : {}),
    };
  });
  return { records, sources: counts, duplicates: counts.reduce((sum, source) => sum + source.duplicates, 0),
    excluded: excluded.size, conflicts: included.filter(group => group.conflicts.size).length };
}
