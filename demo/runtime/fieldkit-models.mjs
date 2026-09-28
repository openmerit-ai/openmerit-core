// Two operator-prepared, heterogeneous routes. These are configurations to
// evaluate, not a claim that OpenMerit discovered every assignment itself.
const model=(id,name,releasedAt,capability)=>({id,name,releasedAt,capability,url:`https://openrouter.ai/${id}`});
export const originalKitModels=[
  model('qwen/qwen3.6-plus','Qwen3.6 Plus','2026-04-02','Multilingual generalist'),
  model('qwen/qwen3.6-flash','Qwen3.6 Flash','2026-04-27','Efficient multimodal model'),
  model('google/gemini-3.1-flash-lite','Gemini 3.1 Flash Lite','2026-05-07','Efficient multimodal model'),
  model('xiaomi/mimo-v2.5-pro','MiMo-V2.5 Pro','2026-04-22','Large coding and reasoning model'),
  model('qwen/qwen3.7-plus','Qwen3.7 Plus','2026-06-03','General reasoning model'),
  model('google/gemma-4-31b-it','Gemma 4 31B','2026-04-02','Dense instruction model'),
];
export const specialistKitModels=[
  model('tencent/hy-mt2-1.8b','Hy-MT2 1.8B','2026-08-20','1.8B translation specialist'),
  model('perceptron/perceptron-mk1.5','Perceptron Mk1.5','2026-09-25','Visual perception model'),
  model('inference-net/schematron-v2-turbo','Schematron V2 Turbo','2026-09-12','3B HTML-to-JSON extractor'),
  model('poolside/laguna-xs-2.1','Laguna XS 2.1','2026-07-02','33B / 3B-active coding model'),
  model('qwen/qwen3.7-plus','Qwen3.7 Plus','2026-06-03','General reasoning model'),
  model('google/gemma-4-26b-a4b-it','Gemma 4 26B A4B','2026-04-03','Compact instruction model'),
];
export const kitSteps=['Translate brief','Read label','Extract limits','Inspect code','Check feasibility','Write handoff'];
export const kitCapabilities=['Translation','Vision','HTML extraction','Code analysis','Constraint reasoning','Structured writing'];
const steps=models=>models.map((m,i)=>({task:kitSteps[i],model:m.id,name:m.name,capability:kitCapabilities[i]}));
export const kitRoutes=[
  {id:'fieldkit/original-v2',name:'Original model mix',role:'Incumbent',steps:steps(originalKitModels)},
  {id:'fieldkit/specialists-v2',name:'Task-fit model mix',role:'Challenger',steps:steps(specialistKitModels)},
];
export const kitRequirements=Object.fromEntries([...originalKitModels,...specialistKitModels].map((m,i)=>{
  const step=i%6;
  return [m.id,{parameters:[...([1,2,4,5].includes(step)?['structured_outputs']:[]),'max_tokens'],modalities:step===1?['text','image']:['text']}];
}));
