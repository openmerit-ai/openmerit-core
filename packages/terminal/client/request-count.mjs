// Live records always mean one request. Group counts are confined to our sample schema.
export function requestWeight(record, snapshot) {
  return snapshot?.mode === 'sample' && ['enterprise-groups', 'comparison-groups'].includes(snapshot.simulation?.kind) && Number.isSafeInteger(record.sampleRequests) && record.sampleRequests > 0 ? record.sampleRequests : 1;
}
export function requestCount(records, snapshot) {
  return records.reduce((count, record) => count + requestWeight(record, snapshot), 0);
}
