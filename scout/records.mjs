import { finite, publicURL, digest } from './utils.mjs';
import { validateRegistry, registry as seed } from './registry.mjs';

export const catalogueVersion = 2;
// A stored inspection's record is the enclosing research record itself. Keep one
// copy: the duplicate doubled the research data that every refresh step loads.
const dropInspectionRecord = r => r.inspection?.record ? { ...r, inspection: (({ record, ...rest }) => rest)(r.inspection) } : r;
// Normalized records are the maintained catalogue; snapshots are derived views.
export function toRecords(snapshot) {
  const evidence = new Map(snapshot.models.map(m=>[m.id,m]));
  const inventory = new Map((snapshot.catalogue ?? snapshot.models).map(m=>[m.id,m]));
  for (const m of snapshot.models) if (!inventory.has(m.id)) inventory.set(m.id,m);
  const models = [], endpoints = [], observations = [];
  for (const m of inventory.values()) {
    const { evidence: ignored, endpoints: routes, ...model } = { ...m, ...(evidence.get(m.id) ?? {}) };
    models.push({...model,facts:m.facts??model.facts,metadataInspection:m.metadataInspection??model.metadataInspection});
    for (const e of m.endpoints ?? []) endpoints.push({ ...e, canonicalModelId: m.id });
    for (const [i,e] of (evidence.get(m.id)?.evidence ?? []).entries()) observations.push({ ...e, id: `${m.id}|${e.benchmark}|${i}`, modelId: m.id });
  }
  return { version: catalogueVersion,discoveryState:snapshot.discoveryState??{},discoverySummary:snapshot.discoverySummary??null,selectionMetadataVersion:snapshot.selectionMetadataVersion??null,checkedAt: snapshot.checkedAt, registry: snapshot.registry ?? seed, models, endpoints, benchmarks: snapshot.benchmarks, observations, sources: snapshot.sources,
    specialists: snapshot.specialists ?? [], specialistProfiles: snapshot.specialistProfiles ?? [], contracts: snapshot.contracts ?? [], decisionScores: snapshot.decisionScores ?? {}, benchmarkMethodologies: snapshot.benchmarkMethodologies, benchmarkDescriptions: snapshot.benchmarkDescriptions,
    research: (snapshot.research ?? []).map(dropInspectionRecord), researchState: snapshot.researchState ?? {}, researchPending:snapshot.researchPending??[], refreshSummary:snapshot.refreshSummary??null, publication: snapshot.publication ?? null };
}

export function validateRecords(records) {
  if (records.version !== catalogueVersion || !records.models.length || !records.benchmarks.length) throw new Error('Incomplete catalogue.');
  validateRegistry(records.registry);
  const unique = rows => { const ids=new Set(); for(const r of rows) { if(typeof r.id !== 'string' || !r.id || ids.has(r.id)) throw new Error('Duplicate or invalid record identity.'); ids.add(r.id); } return ids; };
  const models=unique(records.models), benchmarks=unique(records.benchmarks), capabilities=new Set(records.registry.capabilities.map(c=>c.id));
  unique(records.endpoints); unique(records.observations);
  for(const e of records.endpoints) {
    if(!models.has(e.canonicalModelId) || !e.modelId || !e.protocol || !publicURL(e.url ?? records.sources.find(s=>s.id===e.source)?.url)) throw new Error('Invalid endpoint identity or provenance.');
    for(const key of ['inputPrice','outputPrice']) if(e[key] !== null && e[key] !== undefined && (finite(e[key]) === null || e[key] < 0)) throw new Error('Invalid price.');
  }
  unique(records.contracts ?? []);
  for(const c of records.contracts ?? []) if(!c.model || !c.modelId || !c.operations?.length || !publicURL(c.api) || !publicURL(c.url) || finite(c.inputPrice) === null || c.inputPrice < 0 || finite(c.outputPrice) === null || c.outputPrice < 0) throw new Error('Invalid decision contract.');
  for(const d of Object.values(records.decisionScores ?? {})) if(finite(d?.quality) === null || d.quality < 0 || d.quality > 1 || !d.results?.length || d.results.some(r=>finite(r.percentile) === null || !publicURL(r.url))) throw new Error('Invalid decision score.');
  for(const b of records.benchmarks) if(!Array.isArray(b.tags) || b.tags.some(t=>!capabilities.has(t))) throw new Error('Unknown capability reference.');
  for(const o of records.observations) if(!models.has(o.modelId) || !benchmarks.has(o.benchmark) || finite(o.score) === null || o.score < 0 || o.score > 1 || !publicURL(o.url)) throw new Error('Invalid observation or provenance.');
  return records;
}

export function toSnapshot(records) {
  const evidence=new Map(), endpoints=new Map();
  for(const e of records.endpoints) { const rows=endpoints.get(e.canonicalModelId)??[]; rows.push(e);endpoints.set(e.canonicalModelId,rows); }
  for(const o of records.observations) { const rows=evidence.get(o.modelId)??[];const {modelId,id,...e}=o;rows.push(e);evidence.set(o.modelId,rows); }
  const catalogue=records.models.map(m=>({...m,endpoints:endpoints.get(m.id)??[],evidence:evidence.get(m.id)??[]}));
  return { version:1,dataVersion:20,discoveryState:records.discoveryState??{},discoverySummary:records.discoverySummary??null,selectionMetadataVersion:records.selectionMetadataVersion??null,checkedAt:records.checkedAt,availableModels:catalogue.filter(m=>m.endpoints.length).length,catalogue,models:catalogue.filter(m=>m.evidence.length),benchmarks:records.benchmarks,sources:records.sources,
    registry:records.registry,specialists:records.specialists,specialistProfiles:records.specialistProfiles,contracts:records.contracts??[],decisionScores:records.decisionScores??{},benchmarkMethodologies:records.benchmarkMethodologies,benchmarkDescriptions:records.benchmarkDescriptions,research:(records.research??[]).map(dropInspectionRecord),researchState:records.researchState,researchPending:records.researchPending??[],refreshSummary:records.refreshSummary,publication:records.publication };
}

// Hash each record independently before the small catalogue root. This retains
// canonical content addressing without serializing a second full archive in RAM.
export async function publicationDigest(records) {
  const entries=[];
  for(const [key,value] of Object.entries(records).sort(([a],[b])=>a.localeCompare(b))) {
    if(value===undefined)continue;
    if(Array.isArray(value)){const rows=[];for(const row of value)rows.push(await digest(row));entries.push([key,await digest(rows)]);}
    else entries.push([key,await digest(value)]);
  }
  return digest([4,entries]);
}
export function publicationPredecessor(records) {
  return records?{publication:records.publication??null,benchmarks:records.benchmarks.map(b=>({id:b.id,interpretation:{status:b.interpretation?.status}}))}:null;
}

export async function validatePublication(records, previous) {
  validateRecords(records);
  const currentReady=records.benchmarks.filter(b=>b.interpretation?.status==='ready');
  if(!currentReady.length || !records.observations.length) throw new Error('No validated evidence to publish.');
  if(previous) {
    const ready=new Set(currentReady.map(b=>b.id));
    const lost=previous.benchmarks.filter(b=>b.interpretation?.status==='ready' && !ready.has(b.id));
    if(lost.length) throw new Error('Publication would discard previously validated benchmark records.');
  }
  return { id: (await publicationDigest(records)).slice(0,32), servingVersion:4, checkedAt: records.checkedAt, models:records.models.length, benchmarks:records.benchmarks.length, observations:records.observations.length };
}
