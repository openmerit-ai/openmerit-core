import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexRepository, indexDiagnostics, INDEX_LIMITS, endpointIdentity } from '../src/repository-index.mjs';
import { parseCode } from '../src/repository-syntax.mjs';
import { createCollector, loadConfig } from '../src/collect.mjs';
import { serviceInventory } from '../client/services.mjs';
import { requestCountKnown } from '../client/routes.mjs';
async function fixture(t, files) {
  const root=await mkdtemp(join(tmpdir(),'terminal-repository-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const [path,body]of Object.entries(files)){await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),body);}
  return root;
}
const values=(index,kind)=>index.references.filter(r=>r.kind===kind).map(r=>r.value);
const py=`import os
from openai import OpenAI
UPSTREAM = os.getenv("UPSTREAM_BASE_URL", "http://127.0.0.1:8317/v1")
client = OpenAI(base_url=UPSTREAM)
def triage(ticket):
    return client.chat.completions.create(model="gpt-5.5", messages=[])
def resolve(ticket):
    return client.chat.completions.create(model="openrouter/tencent/hy3-preview", messages=[])
embedder = SentenceTransformer("all-MiniLM-L6-v2")
`;

test('friend-shaped project indexes custom variables, Python calls, private servers and nested configs without network calls',async t=>{
  const root=await fixture(t,{
    '.env':'UPSTREAM_BASE_URL=http://localhost:4000/v1\nOPENMERIT_LOCAL_URL=http://127.0.0.1:8317/v1\nGRADER_BASE_URL=http://172.30.4.29:8000/v1\nSGI_JUDGE_BASE_URL_1=https://api.openai.com/v1\nSGI_JUDGE_BASE_URL_2=https://openrouter.ai/api/v1\nSGI_JUDGE_BASE_URL_3=https://router.huggingface.co/v1\n',
    'app/support.py':py,
    'services/proxy/router.yaml':'routes:\n  hf:\n    base_url: https://router.huggingface.co/v1\n    model: Qwen2.5-72B-Instruct\n  decision:\n    api_base: https://api.typesafe.ai/v1/systemone\n    model: typesafe/jev-1.13\n  embedding:\n    base_url: http://172.30.5.197:8000/v1\n    model: gte_Qwen2-7B-instruct\n',
    'services/proxy/runtime.toml':'[local]\nbase_url = "http://localhost:8000/v1"\nmodel = "Llama-3.1-8B-Instruct"\n',
  });
  t.mock.method(globalThis,'fetch',()=>assert.fail('Static declarations must not trigger requests'));
  const data=await createCollector(root,await loadConfig(root))();const index=data.repository;
  for(const value of ['localhost:4000/v1','127.0.0.1:8317/v1','172.30.4.29:8000/v1','localhost:8000/v1','api.typesafe.ai/v1/systemone'])assert.ok(values(index,'endpoint').includes(value),value);
  for(const value of ['gpt-5.5','openrouter/tencent/hy3-preview','all-MiniLM-L6-v2','typesafe/jev-1.13','gte_Qwen2-7B-instruct'])assert.ok(values(index,'model').includes(value),value);
  assert.ok(values(index,'task').includes('triage'));assert.ok(values(index,'task').includes('resolve'));
  const model=data.models.find(m=>m.name==='gpt-5.5');assert.equal(model.provider,'localhost:4000/v1');assert.equal(model.state,'declared');
  assert.ok(serviceInventory(data).find(s=>s.name==='Hugging Face Router'));
  for(const key of ['records','hosts','deployments','taskSummaries'])assert.deepEqual(data[key],[]);
  assert.equal(requestCountKnown(data),false);assert.equal(data.discovery.runtimeCandidates,0);
  assert.ok(index.references.every(r=>r.line>=1&&!r.file.startsWith('/')));
});

test('TypeScript SDK references and object fields resolve within lexical scope',async t=>{
  const root=await fixture(t,{'src/app.ts':`import OpenAI from 'openai';
const settings = {baseURL: 'https://openrouter.ai/api/v1', model: 'google/gemini-3.6-flash'};
const client = new OpenAI({baseURL: settings.baseURL});
async function draft(ticket: string) { return client.chat.completions.create({model: settings.model, messages: []}); }
async function unknown(settings: any) { return client.chat.completions.create({model: settings.model, messages: []}); }
`});
  const data=await indexRepository(root);assert.ok(data.models.find(m=>m.name==='google/gemini-3.6-flash'&&m.provider==='OpenRouter'));
  assert.ok(data.issues.some(i=>i.code==='unresolved-expression'&&i.line===5));
  assert.ok(data.references.some(r=>r.task==='draft'&&r.kind==='model'&&r.endpointIds.length));
});

test('benchmark candidates, examples, fallbacks, aliases and placeholders stay separate from application inventory',async t=>{
  const root=await fixture(t,{
    'benchmarks/models.yaml':'models: [gpt-4o, gpt-5.5, gemini-2.5-flash]\nbase_url: https://openrouter.ai/api/v1\n',
    'examples/client.py':'client = OpenAI(base_url="https://api.openai.com/v1")\nmodel = "example-only"\n',
    'config.json':JSON.stringify({candidate_models:['gemma-2-9b','Qwen3-8B'],base_url:'https://url.here/v1'}),
    'fallback.py':'client = OpenAI(base_url=os.getenv("PRIVATE_BASE_URL", "https://api.openai.com/v1"))\n',
  });const index=await indexRepository(root);
  assert.deepEqual(index.models,[]);assert.deepEqual(index.inventory,[]);
  assert.ok(index.references.some(r=>r.context==='benchmark'));
  assert.ok(index.references.some(r=>r.context==='example'));
  assert.ok(index.references.some(r=>r.context==='candidate'));
  assert.ok(index.references.some(r=>r.context==='fallback'));
  assert.ok(index.issues.some(i=>i.code==='placeholder-endpoint'));
});

test('custom HTTPS IP and serving hosts remain declared endpoints without guessed vendors',async t=>{
  const root=await fixture(t,{'inference.yaml':'routes:\n  ailab:\n    base_url: https://180.163.156.42:21020/v1\n    model: deepseek-v3-0324\n  intern:\n    base_url: https://intern.openxlab.org.cn/api/v1\n    model: intern-s1\n  embedding:\n    base_url: https://sd3g8mam6uj313gtp0fbg.apigateway-cn-beijing.volceapi.com/v1\n    model: text-embedding-3-large\n'});
  const index=await indexRepository(root);assert.equal(index.inventory.length,3);assert.ok(index.inventory.every(i=>i.kind==='unknown'));
  assert.equal(index.models.find(m=>m.name==='intern-s1').provider,'intern.openxlab.org.cn/api/v1');
});

test('redacts credentials, payloads and resource path/query values without evaluating expressions',async t=>{
  const root=await fixture(t,{
    '.env':'OPENAI_API_KEY=PRIVATE_SECRET\nUPSTREAM_BASE_URL=https://api.openai.com/v1?key=PRIVATE_SECRET\n',
    'app.py':'client = OpenAI(base_url="https://private-resource.openai.azure.com/openai/v1?token=PRIVATE_SECRET", api_key="PRIVATE_SECRET")\nresult = client.chat.completions.create(model="gpt-5", messages=[{"content": "PRIVATE_PROMPT"}])\nmodel = make_model("PRIVATE_PAYLOAD")\n',
    'config.yaml':'base_url: https://custom.example.org/v1\nprompt: PRIVATE_PROMPT\ncredentials:\n  model: PRIVATE_SECRET\n',
    'bad.json':'{"base_url":"https://user:PRIVATE_SECRET@api.openai.com/v1"}',
    'secrets.json':'{"model":"PRIVATE_SECRET"}',
  });const data=await indexRepository(root);const output=JSON.stringify(data);
  assert.doesNotMatch(output,/PRIVATE_|private-resource|api_key|key=|token=/);
  assert.ok(data.issues.some(i=>i.code==='unresolved-expression'));
  assert.equal(data.inventory.find(i=>i.name==='Azure OpenAI').evidence[0].endpointHost,'….openai.azure.com');
  const diagnostics=JSON.stringify(indexDiagnostics(data));assert.doesNotMatch(diagnostics,/app\.py|gpt-5|openai|UPSTREAM|PRIVATE/);
});

test('comments, strings, unrelated payload objects and malformed code do not become declarations',async t=>{
  const root=await fixture(t,{
    'app.py':'# model = "comment-model"\n# base_url = "https://api.openai.com/v1"\ntext = "model=not-a-declaration"\n',
    'bad.py':'client = OpenAI(base_url="https://api.openai.com/v1"\n',
    'bad.json':'{ "model": "malformed", ',
  });const data=await indexRepository(root);assert.equal(data.references.length,0);assert.equal(data.issues.filter(i=>i.code==='syntax-error').length,2);
});

test('conflicting or computed values are unresolved, not chosen by file order',async t=>{
  const root=await fixture(t,{
    '.env':'UPSTREAM_BASE_URL=https://api.openai.com/v1\n',
    '.env.local':'UPSTREAM_BASE_URL=https://openrouter.ai/api/v1\n',
    'app.py':'client = OpenAI(base_url=os.getenv("UPSTREAM_BASE_URL"))\nmodel = "first-model"\nmodel = "second-model"\ndef call():\n    return client.chat.completions.create(model=model)\n',
  });const data=await indexRepository(root);assert.ok(data.issues.some(i=>i.code==='ambiguous-environment'));
  assert.ok(data.issues.some(i=>i.code==='unresolved-expression'&&i.line===5));
  assert.ok(data.models.every(m=>m.provider==='Unattributed'));
});

test('scanner stays inside root and reports read budgets, policy exclusions and symlinks',async t=>{
  const root=await fixture(t,{'node_modules/pkg/index.js':'model = "dependency-only"','.claude/config.json':'{"model":"harness-only"}','big.py':'x'.repeat(200),'ok.json':'{"model":"valid-model"}'});
  const outside=await fixture(t,{'other.json':'{"model":"outside-model"}'});await symlink(join(outside,'other.json'),join(root,'link.json'));
  let data=await indexRepository(root,{...INDEX_LIMITS,fileBytes:100});assert.deepEqual(values(data,'model'),['valid-model']);assert.equal(data.summary.skipped.symlink,1);assert.equal(data.summary.skipped.oversized,1);assert.ok(data.summary.skipped.policy>=2);
  data=await indexRepository(root,{...INDEX_LIMITS,files:1});assert.equal(data.summary.truncated,true);assert.ok(data.issues.some(i=>i.code==='scan-limit'));
});

test('removed declarations disappear on the normal rescan and discovery can be disabled',async t=>{
  const root=await fixture(t,{'app.py':'client = OpenAI(base_url="https://api.openai.com/v1")\nresult = client.responses.create(model="configured-model")\n'});
  let now=Date.now();t.mock.method(Date,'now',()=>now);t.mock.method(globalThis,'fetch',()=>assert.fail('No network'));
  const config=await loadConfig(root),collect=createCollector(root,config);let data=await collect();assert.ok(data.models.length);
  await rm(join(root,'app.py'));now+=61000;data=await collect();assert.equal(data.models.length,0);assert.equal(data.repository.references.length,0);
  config.discovery=false;data=await createCollector(root,config)();assert.equal(data.repository,null);
});

test('literal model catalogs do not establish request count or loaded residency',async t=>{
  const root=await fixture(t,{'app.json':'{"base_url":"http://localhost:4000/v1","model":"gpt-5.5","task":"Draft customer reply"}'});
  t.mock.method(globalThis,'fetch',()=>assert.fail('No probe of static code/config URLs'));
  const data=await createCollector(root,await loadConfig(root))();assert.equal(data.models[0].state,'declared');assert.equal(data.models[0].memoryBytes,null);assert.equal(requestCountKnown(data),false);assert.deepEqual(data.records,[]);assert.deepEqual(data.hosts,[]);
  assert.ok(values(data.repository,'task').includes('Draft customer reply'));
});


test('arbitrary non-secret environment aliases resolve only when an inference field references them',async t=>{
  const root=await fixture(t,{'.env':'MY_CHAT_URL=https://openrouter.ai/api/v1\nMY_MODEL=google/gemini-2.5-flash\nUNRELATED_SETTING=do-not-retain\nPRIVATE_TOKEN=do-not-retain\n','app.py':'client = OpenAI(base_url=os.getenv("MY_CHAT_URL"))\ndef draft():\n    return client.responses.create(model=os.getenv("MY_MODEL"))\n'});
  const index=await indexRepository(root);
  assert.ok(index.models.some(m=>m.provider==='OpenRouter'&&m.name==='google/gemini-2.5-flash'));
  assert.doesNotMatch(JSON.stringify(index),/do-not-retain|UNRELATED_SETTING|PRIVATE_TOKEN/);
});

test('nested payload and credential fields are not indexed as configuration',async t=>{
  const root=await fixture(t,{'app.ts':`const payload = {messages: [{content: {model: 'PRIVATE_PAYLOAD', baseURL: 'https://private-payload.local/v1'}}], credentials: {model: 'PRIVATE_CREDENTIAL'}};
const client = new OpenAI({baseURL: 'https://api.openai.com/v1'});
client.responses.create({model: 'gpt-5', input: 'ignored', metadata: {note: 'ignored'}});
`,'app.py':'client.responses.create(model="gpt-5", messages=[{"model": "PRIVATE_MESSAGE", "content": {"base_url": "https://private-content.local"}}])\n'});
  const index=await indexRepository(root);assert.doesNotMatch(JSON.stringify(index),/PRIVATE_|private-payload|private-content/);
  assert.ok(index.models.some(m=>m.name==='gpt-5'));
});

test('TOML locations and root YAML sequences preserve evidence and LiteLLM aliases stay out of model inventory',async t=>{
  const root=await fixture(t,{'routes.toml':'[a]\nbase_url = "https://api.openai.com/v1"\nmodel = "gpt-5"\n[b]\nbase_url = "https://openrouter.ai/api/v1"\nmodel = "gpt-5"\n','routes.yaml':'- model_name: customer-reply\n  litellm_params:\n    model: openrouter/google/gemini-2.5-flash\n    api_base: https://openrouter.ai/api/v1\n'});
  const index=await indexRepository(root);
  assert.ok(index.references.some(r=>r.file==='routes.toml'&&r.kind==='model'&&r.line===6));
  assert.ok(index.models.some(m=>m.name==='gpt-5'&&m.provider==='OpenRouter'));
  assert.ok(index.references.some(r=>r.value==='customer-reply'&&r.context==='alias'));
  assert.ok(!index.models.some(m=>m.name==='customer-reply'));
  assert.ok(index.models.some(m=>m.name==='openrouter/google/gemini-2.5-flash'));
});

test('unlinked model fields and Hub download configuration do not establish inference inventory',async t=>{
  const root=await fixture(t,{'.env':'HF_ENDPOINT=https://huggingface.co\nMODEL_ID=Qwen/Qwen3-8B\n','database.json':'{"model":"Customer"}'});
  const index=await indexRepository(root);assert.deepEqual(index.inventory,[]);assert.deepEqual(index.models,[]);
  assert.ok(index.references.every(r=>r.context==='unlinked'));
  assert.ok(index.issues.some(i=>i.code==='non-inference-endpoint'));
});


test('credential references and multiline prose cannot enter selected declaration values',async t=>{
  const root=await fixture(t,{'app.py':'API_KEY = "PRIVATE_CREDENTIAL"\nsettings = {"password": "PRIVATE_PASSWORD"}\nclient.responses.create(model=API_KEY)\nclient.responses.create(model=settings.password)\n','config.toml':`description = """
model = "PRIVATE_PROSE"
base_url = "https://private-prose.local/v1"
"""
[serve]
model = "gpt-5"
base_url = "https://api.openai.com/v1"
`});
  const index=await indexRepository(root);assert.doesNotMatch(JSON.stringify(index),/PRIVATE_|private-prose/);
  assert.ok(index.models.some(m=>m.name==='gpt-5'));
});


test('linked endpoints retain their actual declaration line without duplicating call fields',async t=>{
  const root=await fixture(t,{'app.py':'client = OpenAI(base_url="https://openrouter.ai/api/v1")\ndef reply():\n    return client.responses.create(model="gpt-5")\n','config.yaml':'model: gemini-2.5-flash\nbase_url: https://api.openai.com/v1\n'});
  const index=await indexRepository(root);
  const codeEndpoints=index.references.filter(r=>r.kind==='endpoint'&&r.file==='app.py');assert.equal(codeEndpoints.length,1);assert.equal(codeEndpoints[0].line,1);
  const configEndpoints=index.references.filter(r=>r.kind==='endpoint'&&r.file==='config.yaml');assert.equal(configEndpoints.length,1);assert.equal(configEndpoints[0].line,2);
  const models=index.references.filter(r=>r.kind==='model'&&r.file==='app.py');assert.equal(models.length,1);assert.equal(models[0].context,'application');
  assert.deepEqual(models[0].endpointIds,[codeEndpoints[0].id]);
});
