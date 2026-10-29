// Recovered deployed fixture data, not a new model selection.
const model = (id: string, name: string, releasedAt: string) => ({ id, name, releasedAt, url: `https://openrouter.ai/${id}` });
export const releaseModels = [
  model('qwen/qwen3.6-plus', 'Qwen3.6 Plus', '2026-04-02'),
  model('google/gemini-3.1-flash-lite', 'Gemini 3.1 Flash Lite', '2026-05-07'),
  model('xiaomi/mimo-v2.5-pro', 'MiMo-V2.5 Pro', '2026-04-22'),
  model('qwen/qwen3.7-plus', 'Qwen3.7 Plus', '2026-06-03'),
  model('google/gemma-4-26b-a4b-it', 'Gemma 4 26B A4B', '2026-04-03'),
  model('google/gemma-4-31b-it', 'Gemma 4 31B', '2026-04-02'),
  model('xiaomi/mimo-v2.5', 'MiMo-V2.5', '2026-04-22'),
];
export const releaseSteps = ['Read release brief', 'Check changelog', 'Compare API schemas', 'Inspect migration', 'Review dependencies', 'Read test report', 'Decide readiness', 'Write rollout handoff'];
const capabilities = ['Requirement extraction', 'Markdown extraction', 'API compatibility', 'SQL analysis', 'Advisory filtering', 'Test evidence', 'Policy reasoning', 'Structured writing'];
const steps = (indices: number[]) => indices.map((index, i) => ({ task: releaseSteps[i], model: releaseModels[index]!.id, name: releaseModels[index]!.name, capability: capabilities[i] }));
export const releaseRoutes = [
  { id: 'release/original-v1', name: 'Original model mix', role: 'Incumbent', steps: steps([0, 1, 2, 2, 1, 0, 3, 1]) },
  { id: 'release/lean-v2', name: 'Measured model mix', role: 'Challenger', steps: steps([4, 5, 6, 6, 4, 5, 3, 4]) },
];
