// Independent provider metadata. Provider adapters describe contracts, never rank boosts.
import { providerURL } from './provider-links.mjs';
import {digest} from './utils.mjs';
export const catalogueURL = 'https://models.dev/api.json';
export const reportedFact = (field,value,url,basis) => ({field,value,url,basis});
const native = {
  openai: ['openai', 'https://api.openai.com/v1/responses', 'responses'],
  anthropic: ['anthropic', 'https://api.anthropic.com/v1/messages', 'messages'],
  google: ['google', 'https://generativelanguage.googleapis.com/v1beta/models', 'generateContent'],
  deepseek: ['deepseek', 'https://api.deepseek.com/chat/completions', 'chat-completions'],
  mistral: ['mistralai', 'https://api.mistral.ai/v1/chat/completions', 'chat-completions'],
  xai: ['x-ai', 'https://api.x.ai/v1/chat/completions', 'chat-completions'],
  cohere: ['cohere', 'https://api.cohere.com/v2/chat', 'chat'],
  moonshotai: ['moonshotai', 'https://api.moonshot.ai/v1/chat/completions', 'chat-completions'],
  minimax: ['minimax', 'https://api.minimax.io/v1/chat/completions', 'chat-completions'],
  zai: ['z-ai', 'https://api.z.ai/api/paas/v4/chat/completions', 'chat-completions'],
};
const finite = v => Number.isFinite(v) && v >= 0 ? v : null;
const safe = v => typeof v === 'string' && /^[\w./:+-]{1,160}$/.test(v);
// Metadata coverage is independent of reviewed native API contracts. A feed
// owner is a hosting service here, not necessarily the model's creator.
export function providerMetadata(data) {
  if(!data||typeof data!=='object')return [];
  return Object.values(data).flatMap(feed=>typeof feed?.name==='string'?Object.values(feed.models??{}).flatMap(m=>safe(m.id)?[{service:feed.name,modelId:m.id,name:m.name??m.id,family:typeof m.family==='string'?m.family:null,release_date:typeof m.release_date==='string'&&Number.isFinite(Date.parse(m.release_date))?m.release_date:null,url:catalogueURL}]:[]):[]);
}
export async function catalogueInventory(reported,existing,checkedAt) {
  const covered=new Set(existing.flatMap(m=>(m.endpoints??[]).map(e=>JSON.stringify([e.provider,e.modelId]))));
  const rows=[];
  for(const record of reported) {
    if(covered.has(JSON.stringify([record.service,record.modelId])))continue;
    rows.push({id:`listed:${await digest([record.service,record.modelId])}`,name:record.name,provider:null,endpoints:[],evidence:[],facts:[],modalities:[],outputModalities:[],parameters:[],inputPrice:null,outputPrice:null,speed:null,
      catalogueSource:{service:record.service,modelId:record.modelId},discovery:{source:'modelsdev',url:record.url,checkedAt}});
  }
  return rows;
}
// A text side output (for example lyrics accompanying audio) is not a general
// text-generation contract. Mixed-output endpoints need a reviewed task contract.
export const textOutputOnly = outputs => Array.isArray(outputs) && outputs.length === 1 && outputs[0] === 'text';
export function routerEndpoint(model, checkedAt) {
  return { id: `openrouter:chat:${model.id}`, provider: 'OpenRouter', modelId: model.id, api: 'https://openrouter.ai/api/v1/chat/completions', protocol: 'chat-completions',
    inputPrice: model.inputPrice, outputPrice: model.outputPrice, modalities: model.modalities, outputModalities: model.outputModalities, parameters: model.parameters,
    facts:model.routerExpiry?[reportedFact('expiresAt',model.routerExpiry,'https://openrouter.ai/api/v1/models','Announced expiry of this OpenRouter route, not all deployments of this model.')]:[],
    context: model.routerContext ?? model.context ?? null, source: 'models', checkedAt, url: providerURL(model.id), pricingBasis: 'OpenRouter advertised token rates; endpoint may route across hosts.', deployment: 'hosted', configuration: 'provider default' };
}
export function parseProviderCatalogue(data, checkedAt) {
  if (!data || typeof data !== 'object' || !data.openai?.models || !data.google?.models) throw new Error('Invalid independent provider catalogue.');
  const records = [];
  for (const [provider, [namespace, api, protocol]] of Object.entries(native)) {
    const feed = data[provider]; if (!feed) continue;
    for (const m of Object.values(feed.models ?? {})) {
      if (!safe(m.id) || !textOutputOnly(m.modalities?.output) || m.status === 'deprecated' || m.release_date > checkedAt.slice(0, 10)) continue;
      const id = `${namespace}/${m.id}`;
      const parameters = [m.tool_call && 'tools', m.structured_output && 'structured_outputs'].filter(Boolean);
      const endpoint = { id: `${provider}:${protocol}:${m.id}`, provider: feed.name, modelId: m.id, api, protocol,
        inputPrice: finite(m.cost?.input), outputPrice: finite(m.cost?.output), modalities: m.modalities.input, outputModalities: m.modalities.output, parameters, source: 'modelsdev', checkedAt,
        context:m.limit?.context??null, url: providerURL(id) ?? feed.doc, pricingBasis: 'Provider rates reported by Models.dev; verify current tiers with the provider.', deployment: 'hosted', configuration: 'provider default', status: m.status ?? 'listed' };
      records.push({ id, name: m.name ?? m.id, provider: feed.name, canonical: id, repository: null, modalities: m.modalities.input, outputModalities: m.modalities.output, parameters, context: m.limit?.context ?? null,
        facts:[reportedFact('creator',feed.name,catalogueURL,'Creator reported by the provider catalogue.'),...(m.family?[reportedFact('family',m.family,catalogueURL,'Model family reported by the provider catalogue.')]:[]),...(m.release_date&&Number.isFinite(Date.parse(m.release_date))?[reportedFact('releasedAt',m.release_date,catalogueURL,'Exact model release date reported by the provider catalogue; not its last update.')]:[])],
        inputPrice: endpoint.inputPrice, outputPrice: endpoint.outputPrice, speed: null, evidence: [], endpoints: [endpoint] });
    }
  }
  if (records.length < 10) throw new Error('Independent catalogue coverage too small.');
  return records;
}
export function mergeCatalogues(routerModels, independent) {
  const models = new Map(routerModels.map(m => [m.id, m]));
  const norm = v => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const item of independent) {
    // Match only a unique name within the same publisher; never merge fine-tunes
    // or different dated model IDs based on fuzzy similarity.
    const aliases = [...models.values()].filter(m => m.id.split('/')[0] === item.id.split('/')[0] && norm(m.name) === norm(item.name));
    const existing = models.get(item.id) ?? (aliases.length === 1 && !/\d{4}-?\d{2}-?\d{2}/.test(item.id) ? aliases[0] : null);
    if (existing) {existing.endpoints.push(...item.endpoints);existing.facts=[...(existing.facts??[]).filter(f=>!(item.facts??[]).some(x=>x.field===f.field)),...(item.facts??[])];}
    else models.set(item.id, item);
  }
  return [...models.values()];
}
