// A small, explicit vocabulary keeps prompt matching local and explainable.
export const capabilities = {
  documents: { label: 'Document understanding', terms: ['invoice', 'receipt', 'document', 'pdf', 'ocr', 'scan', 'scanned', 'billing', 'purchase order', 'handwriting', 'form', 'bill', 'passport', 'bank statement'], benchmark: /ocr|document|textvqa|chartqa|gdp\.pdf|mtvqa/i },
  structured: { label: 'Structured output', terms: ['json', 'schema', 'extract', 'extraction', 'fields', 'parse', 'parsing', 'classify', 'classification', 'categorize', 'csv', 'structured'], benchmark: /ifbench|instruction|ifeval|function.call|bfcl|superglue/i },
  coding: { label: 'Code & engineering', terms: ['code', 'coding', 'program', 'programming', 'function', 'debug', 'bug', 'repository', 'refactor', 'python', 'javascript', 'typescript', 'sql', 'build an app', 'unit test', 'website', 'next js', 'react', 'vue', 'svelte', 'rust', 'golang', 'java', 'ruby', 'csharp', 'c sharp', 'html', 'css', 'api', 'backend', 'frontend', 'web app', 'webapp', 'app', 'git', 'pull request', 'test suite', 'authentication', 'database', 'software', 'script'], benchmark: /swe|code|coding|aider|terminal|cursor|weirdml|algotune|ale.bench|webdev|gso/i },
  reasoning: { label: 'Reasoning', terms: ['reason', 'reasoning', 'logic', 'logical', 'solve', 'plan', 'planning', 'compare', 'decide', 'analyze', 'analyse', 'analysis', 'puzzle'], benchmark: /arc|bbh|simplebench|reason|anli|piqa|hellaswag|winogrande|puzzle|enigma|mindcube/i },
  math: { label: 'Math & science', terms: ['math', 'mathematics', 'calculate', 'calculation', 'equation', 'proof', 'theorem', 'physics', 'science', 'scientific', 'statistics'], benchmark: /math|aime|gsm8k|proof|critpt|science|scicode|surface.evolver/i },
  knowledge: { label: 'Knowledge & research', terms: ['research', 'search', 'fact', 'facts', 'factual', 'question', 'answer', 'knowledge', 'explain', 'learn', 'medical', 'legal', 'contract', 'law', 'medicine', 'biology', 'chemistry', 'citation', 'cite', 'finance'], benchmark: /gpqa|mmlu|hle|omniscience|trivia|simpleqa|openbook|health|research|forecast/i },
  writing: { label: 'Writing & language', terms: ['write', 'writing', 'rewrite', 'email', 'story', 'stories', 'copywriting', 'blog', 'marketing', 'tone', 'creative', 'edit', 'translation', 'translate', 'summarize', 'summary', 'summarise', 'support ticket', 'customer support', 'reply', 'respond', 'draft', 'article', 'post', 'headline', 'newsletter', 'caption', 'grammar', 'proofread', 'spanish', 'french', 'german', 'arabic', 'chinese', 'japanese'], benchmark: /writing|fiction|lambada|language|translation/i },
  vision: { label: 'Visual understanding', terms: ['image', 'images', 'photo', 'photos', 'picture', 'screenshot', 'visual', 'chart', 'diagram', 'invoice', 'receipt', 'scan', 'scanned', 'ocr', 'pdf', 'photo', 'photograph', 'photographs', 'diagram', 'drawing'], benchmark: /mmmu|mmbench|mme$|mmstar|mmvet|mm[t-]bench|seedbench|vision|visual|ocr|chartqa|textvqa|realworld|blink|ai2d|qbench|hallusion|pope|llavabench|coco|ccbench|vcr|abench|spatial|geobench/i },
  agents: { label: 'Tools & agents', terms: ['agent', 'agents', 'tool', 'tools', 'browser', 'automate', 'automation', 'workflow', 'function calling', 'computer use', 'web search', 'browse', 'click', 'navigate', 'booking', 'book a flight'], benchmark: /agent|tau|osworld|os.world|balrog|cybench|exploit|posttrain|metr|remote.labor|vending|itbench|gdpval|furniture|gbaeval/i },
  context: { label: 'Long context', terms: ['long', 'book', 'books', 'entire', 'transcript', 'transcripts', 'summarize', 'summary', 'hundred pages', 'context', 'summarise', 'large codebase', 'full codebase'], benchmark: /lcr|cl.bench|fiction|graphwalk/i },
};

export function benchmarkCapabilities(name) {
  const tags = Object.entries(capabilities).filter(([, value]) => value.benchmark.test(name)).map(([key]) => key);
  return tags.length ? tags : ['reasoning'];
}

export function interpretPrompt(prompt) {
  const singular = { repositories: 'repository', categories: 'category', stories: 'story', summaries: 'summary', replies: 'reply', analyses: 'analysis', indices: 'index' };
  const text = prompt.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ')
    .replace(/\b(repositories|categories|stories|summaries|replies|analyses|indices)\b/g, word => singular[word])
    .replace(/\b(invoices|receipts|documents|schemas|functions|equations|screenshots|emails|tests|tickets|fields|images|photos|pages|contracts|agents|tools|charts|diagrams|scripts|bugs|books|transcripts)\b/g, word => word.slice(0, -1))
    .replace(/\b(extracting|extracted)\b/g, 'extract').replace(/\bdebugging\b/g, 'debug');
  const normalizeTerm = term => term.replace(/\b(fields|images|photos|tools|agents|books|transcripts)\b/g, word => word.slice(0, -1));
  let hits = Object.entries(capabilities).map(([id, value]) => ({ id, label: value.label,
    matches: value.terms.filter(term => ` ${text} `.includes(` ${normalizeTerm(term)} `)) })).filter(v => v.matches.length);
  const textOnly = /\b(plain text|text only|already extracted|already transcribed|pasted text|from emails?|email text)\b/.test(text);
  const explicitImage = /\b(image|photo|screenshot|scan|scanned|ocr|pdf|upload|attach|visual)\b/.test(text);
  const needsVision = (hits.some(v => v.id === 'vision') || /\b(invoice|receipt|bill|passport)\b/.test(text)) && (!textOnly || explicitImage);
  if (textOnly && !explicitImage) hits = hits.filter(v => !['vision', 'documents'].includes(v.id));
  if (/\b(?:[1-9]\d{1,}) page\b/.test(text) && !hits.some(v => v.id === 'context')) hits.push({ id: 'context', label: capabilities.context.label, matches: ['many pages'] });
  const needsStructured = /\b(json|schema|structured)\b/.test(text);
  const unsupported = /\b(generate|create|draw|paint)\b.{0,35}\b(image|images|video|music|audio|picture|logo)\b|\b(text to speech|speech to text|transcribe|transcription|audio generation|image generation|video generation|speech synthesis)\b/.test(text);
  // "Write unit tests" is engineering, not creative writing.
  if (hits.some(v => v.id === 'coding') && !/\b(story|stories|creative|marketing|copywriting|tone)\b/.test(text)) hits = hits.filter(v => v.id !== 'writing');
  const weights = Object.fromEntries(hits.map(v => [v.id, Math.min(3, v.matches.length)]));
  if (weights.documents) weights.documents *= 2;
  if (weights.structured && /\b(classify|categorize|classification|sentiment|extract|parse)\b/.test(text)) weights.writing = 0;
  for (const key of Object.keys(weights)) if (!weights[key]) delete weights[key];
  hits = hits.filter(v => weights[v.id]);
  if (!hits.length) { weights.knowledge = 1; weights.reasoning = 1; }
  return { capabilities: hits.map(({ id, label }) => ({ id, label })), keywords: [...new Set(hits.flatMap(v => v.matches))], weights, needsVision, needsStructured, unsupported, fallback: !hits.length };
}
