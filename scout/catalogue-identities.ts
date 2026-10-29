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

// Reviewed leaderboard aliases (2026-10-29): a board's display name or Hugging Face repository
// for one catalogue model, on boards of one kind (catalogue-boards.ts linkResults; MTEB is
// 'embedding') and, where the name alone is generic, only on boards whose ID starts with
// `board`. Reviewed against the live boards and the deployed catalogue (cat_model_merged) on
// 29 October 2026. Only the same model and version: never a sibling, size, preview or newer
// release, and nothing a board names without a version. Where the catalogue holds the same
// model twice (a gateway ID and the maker's), the one with the maker's or most routes is named.
export interface ReviewedAlias { name: string; model: string; kind: string; board?: string }
export const reviewedAliases: readonly ReviewedAlias[] = [
  // Image: the catalogue holds each twice.
  { name: 'FLUX.2 [pro]', model: 'black-forest-labs/flux.2-pro', kind: 'image' },
  { name: 'FLUX.2 [flex]', model: 'black-forest-labs/flux.2-flex', kind: 'image' },
  { name: 'FLUX.2 [max]', model: 'bfl/flux-2-max', kind: 'image' },
  { name: 'Seedream 5.0 Pro', model: 'bytedance/seedream-5.0-pro', kind: 'image' },
  { name: 'Seedream 5.0 Lite', model: 'bytedance/seedream-5.0-lite', kind: 'image' },
  // Video. Arena's resolution suffixes (-720p, -480p) are run settings of one model.
  { name: 'Veo 3.1', model: 'google/veo-3.1-generate-001', kind: 'video' },
  { name: 'Veo 3.1 Fast', model: 'google/veo-3.1-fast-generate-001', kind: 'video' },
  { name: 'Veo 3.1 Lite', model: 'google/veo-3.1-lite-generate-001', kind: 'video' },
  { name: 'MiniMax H3', model: 'minimax/MiniMax-H3', kind: 'video' },
  { name: 'minimax-h3', model: 'minimax/MiniMax-H3', kind: 'video' },
  { name: 'MiniMax H3 Max', model: 'minimax/MiniMax-H3-Max', kind: 'video' },
  { name: 'Seedance 1.5 Pro', model: 'bytedance/seedance-v1.5-pro', kind: 'video' },
  { name: 'Dreamina Seedance 2.0', model: 'bytedance-seed/seedance-2.0', kind: 'video' },
  { name: 'dreamina-seedance-2.0-720p', model: 'bytedance-seed/seedance-2.0', kind: 'video' },
  { name: 'Dreamina Seedance 2.5', model: 'bytedance-seed/seedance-2.5', kind: 'video' },
  { name: 'dreamina-seedance-2.5-720p', model: 'bytedance-seed/seedance-2.5', kind: 'video' },
  { name: 'Gemini Omni Flash 1.1', model: 'google/gemini-omni-1.1-flash', kind: 'video' },
  { name: 'Kling 3.0 1080p (Pro)', model: 'kwaivgi/kling-v3.0-pro', kind: 'video' },
  { name: 'grok-imagine-video-480p', model: 'xai/grok-imagine-video', kind: 'video' },
  { name: 'grok-imagine-video-720p', model: 'xai/grok-imagine-video', kind: 'video' },
  { name: 'grok-imagine-video-1.5-720p', model: 'xai/grok-imagine-video-1.5', kind: 'video' },
  // Speech. Artificial Analysis names ElevenLabs and OpenAI models without the maker.
  { name: 'Eleven v3', model: 'elevenlabs/eleven-v3', kind: 'speech' },
  { name: 'v3 Conversational', model: 'elevenlabs/eleven-v3-conversational', kind: 'speech', board: 'analysis:tts' },
  { name: 'Multilingual v2', model: 'elevenlabs/eleven-multilingual-v2', kind: 'speech', board: 'analysis:tts' },
  { name: 'Flash v2.5', model: 'elevenlabs/eleven-flash-v2.5', kind: 'speech', board: 'analysis:tts' },
  { name: 'Turbo v2.5', model: 'elevenlabs/eleven-turbo-v2.5', kind: 'speech', board: 'analysis:tts' },
  { name: 'TTS-1', model: 'openai/tts-1', kind: 'speech', board: 'analysis:tts' },
  { name: 'OpenAudio S1', model: 'fish-audio/s1', kind: 'speech' },
  { name: 'Kokoro 82M v1.0', model: 'hexgrad/kokoro-82m', kind: 'speech' },
  { name: 'Voxtral 3 TTS', model: 'mistral/voxtral-mini-tts-3', kind: 'speech' },
  // Transcription. Streaming boards name the same model in streaming mode.
  { name: 'Voxtral Mini Transcribe 3', model: 'mistral/voxtral-mini-transcribe-3', kind: 'transcription' },
  { name: 'Voxtral Small Transcribe 3', model: 'mistral/voxtral-small-transcribe-3', kind: 'transcription' },
  { name: 'Scribe v2 RT', model: 'elevenlabs/scribe-v2-realtime', kind: 'transcription' },
  { name: 'Nova-3 RT', model: 'deepgram/nova-3', kind: 'transcription', board: 'analysis:stt' },
  { name: 'Chirp 3 Streaming', model: 'google/chirp-3', kind: 'transcription', board: 'analysis:stt' },
  { name: 'Qwen/Qwen3-ASR-0.6B-hf', model: 'qwen/qwen3-asr-0.6b', kind: 'transcription' },
  { name: 'Qwen/Qwen3-ASR-1.7B-hf', model: 'qwen/qwen3-asr-1.7b', kind: 'transcription' },
  { name: 'nvidia/Nemotron-3.5-Transcribe-30B-A4B', model: 'nvidia/nemotron-3.5-transcribe', kind: 'transcription' },
  // Embedding (MTEB): API models under another owner, and NVIDIA's BF16 checkpoints.
  { name: 'Cohere/Cohere-embed-v4.0', model: 'cohere/embed-v4.0', kind: 'embedding' },
  { name: 'bedrock/amazon-titan-embed-text-v1', model: 'amazon/titan-embed-text-v1', kind: 'embedding' },
  { name: 'bedrock/amazon-titan-embed-text-v2', model: 'amazon/titan-embed-text-v2', kind: 'embedding' },
  { name: 'perplexity-ai/pplx-embed-v1-0.6b', model: 'perplexity/pplx-embed-v1-0.6b', kind: 'embedding' },
  { name: 'perplexity-ai/pplx-embed-v1-4b', model: 'perplexity/pplx-embed-v1-4b', kind: 'embedding' },
  { name: 'nvidia/Nemotron-3-Embed-1B-BF16', model: 'nvidia/nemotron-3-embed-1b', kind: 'embedding' },
  { name: 'nvidia/Nemotron-3.5-Embed-1B-BF16', model: 'nvidia/nemotron-3.5-embed-1b', kind: 'embedding' },
  { name: 'nvidia/Nemotron-3.5-Embed-8B-BF16', model: 'nvidia/nemotron-3.5-embed-8b', kind: 'embedding' },
  ...([['voyage-3-large', 'voyage'], ['voyage-3.5', 'voyage'], ['voyage-code-2', 'voyage'], ['voyage-code-3', 'voyage'], ['voyage-finance-2', 'voyage'], ['voyage-law-2', 'voyage'],
    ['voyage-4', 'voyageai'], ['voyage-4-large', 'voyageai'], ['voyage-4-lite', 'voyageai']] as const).map(([m, lab]) => ({ name: `mongodb/${m}`, model: `${lab}/${m}`, kind: 'embedding' })),
];
