import contracts from './endpoint-contracts.json' with { type: 'json' };

// Reviewed contracts and refreshed decision routes remain part of public status.
export function contractModels(snapshot = null) {
  const scores = snapshot?.decisionScores ?? {}, byTail = new Map();
  for (const id of Object.keys(scores)) { const tail = id.split('/').pop(); byTail.set(tail, byTail.has(tail) ? null : scores[id]); }
  return [...contracts.entries.map(e => ({ ...e, checkedAt: contracts.reviewedAt })), ...(snapshot?.contracts ?? [])].map(e => ({ id: e.model, name: e.name, provider: e.provider, modalities: e.modalities, parameters: e.parameters, context: e.context ?? null,
    inputPrice: e.inputPrice, outputPrice: e.outputPrice, evidence: [], speed: null, decisionScore: scores[e.model] ?? byTail.get(e.modelId) ?? null,
    endpoint: { ...e, deployment: 'hosted', configuration: 'fixed typed questions' } }));
}
