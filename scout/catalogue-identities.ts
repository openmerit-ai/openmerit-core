// Reviewed canonical identities (2026-10-28). Canonical identities for models no source introduces (LiteLLM lists routes but never creates identities), and route links automatic matching cannot make. Moving aliases such as -latest and -preview are deliberately not linked: their target changes over time.
// Every entry names an ID a source already lists; identities here are stored with
// basis 'reviewed-model' and Models.dev takes over an ID it later introduces.
export interface ReviewedModel { id: string; lab: string; name: string; kind: string }
export interface ReviewedRoute { provider: string; route: string; model: string }

export const reviewedModels: readonly ReviewedModel[] = [
  { id: 'cloudflare/clef', lab: 'cloudflare', name: 'Clef', kind: 'decision' },
  { id: 'cloudflare/clef-flash', lab: 'cloudflare', name: 'Clef Flash', kind: 'decision' },
  { id: 'cloudflare/clef-omni', lab: 'cloudflare', name: 'Clef Omni', kind: 'decision' },
  { id: 'nace/drex-v1.0', lab: 'nace', name: 'Drex 1.0', kind: 'decision' },
  { id: 'nace/drex-v1.5', lab: 'nace', name: 'Drex 1.5', kind: 'decision' },
  { id: 'nace/drex-v2.0', lab: 'nace', name: 'Drex 2.0', kind: 'decision' },
  { id: 'bespokelabs/bespoke-nimble-9b', lab: 'bespokelabs', name: 'Bespoke Nimble 9B', kind: 'decision' },
  { id: 'perplexity/pplx-decider-v1-27b', lab: 'perplexity', name: 'Perplexity Decider 1 27B', kind: 'decision' },
  { id: 'perplexity/pplx-decider-v1.1-27b', lab: 'perplexity', name: 'Perplexity Decider 1.1 27B', kind: 'decision' },
  { id: 'convaiinnovations/laya-english', lab: 'convaiinnovations', name: 'Laya English', kind: 'decision' },
  { id: 'convaiinnovations/laya-multilingual', lab: 'convaiinnovations', name: 'Laya Multilingual', kind: 'decision' },
  { id: 'strands/strands-decider-2b-hobson-v19', lab: 'strands', name: 'Strands Decider 2B (Hobson v19)', kind: 'decision' },
];

export const reviewedRoutes: readonly ReviewedRoute[] = [
  { provider: 'cloudflare-workers-ai', route: '@cf/cloudflare/clef', model: 'cloudflare/clef' },
  { provider: 'cloudflare-workers-ai', route: 'clef', model: 'cloudflare/clef' },
  { provider: 'cloudflare-workers-ai', route: '@cf/cloudflare/clef-flash', model: 'cloudflare/clef-flash' },
  { provider: 'cloudflare-workers-ai', route: 'clef-flash', model: 'cloudflare/clef-flash' },
  { provider: 'cloudflare-workers-ai', route: '@cf/cloudflare/clef-omni', model: 'cloudflare/clef-omni' },
  { provider: 'cloudflare-workers-ai', route: 'clef-omni', model: 'cloudflare/clef-omni' },
  { provider: 'litellm:nace', route: 'drex-v1.0', model: 'nace/drex-v1.0' },
  { provider: 'litellm:nace', route: 'drex-v1.5', model: 'nace/drex-v1.5' },
  { provider: 'litellm:nace', route: 'drex-v2.0', model: 'nace/drex-v2.0' },
  { provider: 'litellm:bespoke', route: 'bespokelabs/Bespoke-Nimble-9B', model: 'bespokelabs/bespoke-nimble-9b' },
  { provider: 'perplexity', route: 'pplx-decider-v1-27b', model: 'perplexity/pplx-decider-v1-27b' },
  { provider: 'perplexity', route: 'pplx-decider-v1.1-27b', model: 'perplexity/pplx-decider-v1.1-27b' },
  { provider: 'litellm:laya', route: 'english', model: 'convaiinnovations/laya-english' },
  { provider: 'litellm:laya', route: 'multilingual', model: 'convaiinnovations/laya-multilingual' },
  { provider: 'litellm:strands_decider', route: 'strands-decider-2B-hobson-v19', model: 'strands/strands-decider-2b-hobson-v19' },
];
