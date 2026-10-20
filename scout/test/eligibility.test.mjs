import test from 'node:test';
import assert from 'node:assert/strict';
import snapshot from '../snapshot.json' with {type:'json'};
import {registry} from '../registry.mjs';
import {matchEligibility,prepareEligibility,metadataAllows,eligibilityWarnings} from '../eligibility.mjs';
import {createIndex,recommend} from '../rank.mjs';
import {prepareSearch,retrieve,narrowIndex} from '../search-index.mjs';
import {stageCatalogue,createSnapshotReader,putJSON} from '../store.mjs';
import {toRecords,toSnapshot} from '../records.mjs';
import {parseProviderCatalogue,mergeCatalogues} from '../catalogue.mjs';
import {createRecommender} from '../recommend.mjs';

const intent={version:'1',required:['creator'],preferred:[],status:'pending'};
const answer=(value='eligible',confidence=.99,capture=()=>{})=>async(_url,o)=>{const b=JSON.parse(o.body);capture(b);return Response.json({answers:b.questions.map(q=>q.type==='predicate'?{name:q.name,type:'predicate',probability:value==='eligible'?confidence:1-confidence}:{name:q.name,type:'choice',choice:value==='eligible'?q.choices.find(c=>!['excluded','not_a_match','no_documented_match'].includes(c.value)).value:(q.name.startsWith('available_')?'no_documented_match':q.name.startsWith('confirm_')?'not_a_match':'excluded'),confidence})});};
const directory={version:'1',profiles:[
 {modelId:'a',endpointId:'a-router',source:'models',facts:{creator:'Maker',contextTokens:128000}},
 {modelId:'a',endpointId:'a-direct',source:'native',facts:{creator:'Maker',contextTokens:256000}},
 {modelId:'b',endpointId:'b-router',source:'models',facts:{creator:'Maker',contextTokens:null}},
]};
class Bucket{data=new Map();reads=[];async put(k,v){this.data.set(k,String(v));}async get(k){this.reads.push(k);const v=this.data.get(k);return v===undefined?null:{json:async()=>JSON.parse(v)};}async head(k){return this.data.has(k)?{}:null;}}

test('semantic metadata checks deduplicate relevant facts, not model names',async()=>{
 let request;
 const r=await matchEligibility('A Maker model',intent,directory,{apiKey:'fixture',fetcher:answer('eligible',.99,b=>request=b)});
 assert.equal(r.checkedFacts,1);assert.equal(r.groups,1);assert.deepEqual(r.allowedModelIds,['a','b']);assert.equal(r.allowedEndpointIds.length,3);
 assert.ok(JSON.stringify(request).includes('Maker'));assert.ok(!JSON.stringify(request).includes('a-router'));
});
test('route capacities remain separate and explicit inventories intersect before semantic work',async()=>{
 let request;
 const r=await matchEligibility('A sufficiently large context',{...intent,required:['contextTokens']},directory,{apiKey:'fixture',modelIds:['a'],endpointIds:['a-router','a-direct'],fetcher:answer('eligible',.99,b=>request=b)});
 assert.equal(r.checkedFacts,1);assert.deepEqual(r.allowedEndpointIds,['a-router']);assert.ok(JSON.stringify(request).includes('128000'));assert.ok(!JSON.stringify(request).includes('256000'));
 const empty=await matchEligibility('Anything',intent,directory,{apiKey:'fixture',modelIds:[],fetcher:()=>assert.fail('Empty inventory must make no eligibility call')});assert.deepEqual(empty.allowedEndpointIds,[]);
});
test('unknown, weak, refused and malformed eligibility never grant a route',async()=>{
 for(const [value,confidence]of[['excluded',.99],['eligible',.24]]) {
  const r=await matchEligibility('A restricted model',intent,directory,{apiKey:'fixture',fetcher:answer(value,confidence)});assert.deepEqual(r.allowedEndpointIds,[]);
 }
 await assert.rejects(matchEligibility('A restricted model',intent,directory,{apiKey:'fixture',fetcher:async()=>Response.json({answers:[{name:'eligible_group',type:'refusal'}]})}),/Incomplete/);
 await assert.rejects(matchEligibility('A restricted model',intent,null,{apiKey:'fixture'}),/not prepared/);
});
test('coupled conditions are evaluated together with an explicit clock and no generated query code',async()=>{
 const known={...directory,profiles:directory.profiles.map(p=>({...p,facts:{...p.facts,family:'Line',releasedAt:'2026-09-20'}}))};
 let request;await matchEligibility('Maker or another family after last month',{...intent,coupled:true,required:['creator','family','releasedAt']},known,{apiKey:'fixture',now:Date.UTC(2026,9,16),fetcher:answer('eligible',.99,b=>request=b)});
 assert.ok(request.input.startsWith('Maker or another family after last month'));assert.ok(request.input.includes('2026-10-16T00:00:00.000Z'));assert.ok(request.questions[0].instructions.includes(JSON.stringify({creator:'Maker',family:'Line',releasedAt:'2026-09-20'})));
});
test('metadata gate protects native contracts and cannot be bypassed by calibration',()=>{
 const task={kind:'classify',labelSpace:'supplied',needsVision:false,needsTools:false,needsStructured:false,weights:{structured:3},workload:{input:'short',output:'short',priority:'balanced'},selection:{...intent,status:'ok',allowedModelIds:[],allowedEndpointIds:[],allowedRepositories:[]}};
 const r=recommend(createIndex(snapshot),'Only an unavailable creator',Date.parse(snapshot.checkedAt),task);assert.deepEqual(r.recommendations,[]);
 assert.equal(metadataAllows(task,'openai:decisions:gpt-6-luna'),false);
});
test('constraints apply before capability caps, including candidates absent from every global pool',()=>{
 const base=snapshot.models[0], b=snapshot.benchmarks.find(b=>b.tags.length),cap=b.tags[0];
 const models=Array.from({length:5},(_,i)=>({...base,id:'candidate-'+i,evidence:[{...base.evidence[0],benchmark:b.id,score:1-i/10}],endpoints:[{...base.endpoints?.[0],id:'route-'+i}]}));
 const tiny={...snapshot,models,catalogue:models,registry:{...registry,policy:{...registry.policy,candidateLimit:1}}};
 const search=prepareSearch(tiny),task={weights:{[cap]:3},workload:{priority:'balanced'},selection:{...intent,status:'ok',allowedModelIds:['candidate-4'],allowedEndpointIds:['route-4'],allowedRepositories:[]}};
 assert.ok(!search.byCapability[cap].quality.includes('candidate-4'));assert.deepEqual(retrieve({search},task),['candidate-4']);
});
test('published metadata pools and local retrieval preserve the same restricted evidence',async()=>{
 const prepared=structuredClone(snapshot);
 for(const m of prepared.catalogue??prepared.models){m.facts=[{field:'creator',value:m.provider,url:'https://example.com',basis:'Fixture attribution'}];for(const e of m.endpoints??[])e.context=m.context;}
 const records=toRecords(prepared),full=toSnapshot(records),directory=prepareEligibility(full),pick=directory.profiles.find(p=>full.models.some(m=>m.id===p.modelId));
 const allowed=directory.profiles.filter(p=>p.modelId===pick.modelId);
 const task={kind:'other',weights:{reasoning:3,knowledge:1},workload:{priority:'balanced'},selection:{...intent,status:'ok',allowedModelIds:[pick.modelId],allowedEndpointIds:allowed.map(p=>p.endpointId),allowedRepositories:[]}};
 const bucket=new Bucket(),staged=await stageCatalogue(bucket,records);await putJSON(bucket,'active.json',staged);
 const view=await createSnapshotReader(bucket).view();assert.equal((await view.loadEligibility()).version,'1');
 const lazy=await view.loadTask(task,null,null),local=narrowIndex(createIndex(full),task,null,null);
 assert.deepEqual(lazy.models.map(m=>m.id),local.models.map(m=>m.id));assert.ok(lazy.models.length>0);assert.ok(!bucket.reads.some(k=>k.startsWith('catalogues/')));
});
test('provider catalogue retains family and release provenance, and route context does not leak across hosts',()=>{
 const model={id:'one',name:'One',family:'line',release_date:'2026-09-20',modalities:{input:['text'],output:['text']},limit:{context:200000},cost:{input:1,output:2}};
 const feed={name:'Creator',models:Object.fromEntries(Array.from({length:10},(_,i)=>['one-'+i,{...model,id:'one-'+i}]))};
 const rows=parseProviderCatalogue({openai:feed,google:{name:'Other',models:{}}},'2026-10-16T00:00:00Z');
 assert.equal(rows[0].facts.find(f=>f.field==='family').value,'line');assert.equal(rows[0].facts.find(f=>f.field==='releasedAt').value,'2026-09-20');assert.equal(rows[0].endpoints[0].context,200000);
 const router={...rows[0],facts:[],endpoints:[{...rows[0].endpoints[0],id:'router-route',context:100000}]};
 const merged=mergeCatalogues([router],[rows[0]])[0];assert.deepEqual(merged.endpoints.map(e=>e.context),[100000,200000]);
});
test('an unavailable eligibility service fails the search instead of widening the inventory',async()=>{
 const recommendTask=createRecommender({apiKey:'fixture',fetcher:async(_u,o)=>{
  const b=JSON.parse(o.body);if(b.questions.some(q=>q.name.startsWith('eligible_')))throw new Error('Unavailable');
  return Response.json({answers:b.questions.map(q=>({name:q.name,type:'choice',choice:q.name==='selection_scope'?'required':q.name==='selection_creator'?'filter':q.choices[0].value,confidence:.99}))});
 }});
 await assert.rejects(recommendTask(createIndex({...snapshot,selectionMetadataVersion:'1'}),'Only a particular creator'),e=>e.status===503&&/restrictions/.test(e.message));
});

test('unknown facts are absent from postings and make no semantic call',async()=>{
 const r=await matchEligibility('Only a verified creator',intent,{version:'1',profiles:[{...directory.profiles[0],facts:{creator:null}}]},{apiKey:'fixture',fetcher:()=>assert.fail('No known fact to evaluate')});
 assert.deepEqual(r.allowedEndpointIds,[]);assert.equal(r.unknownEndpoints,1);
 assert.match(eligibilityWarnings({selection:r})[0],/No verified matching model/);
});
test('a confident no-value decision overrides isolated false-positive answers',async()=>{
 const r=await matchEligibility('An unavailable family',intent,directory,{apiKey:'fixture',fetcher:async(u,o)=>{
  const response=await answer()(u,o),body=await response.json();body.answers=body.answers.map(a=>a.name.startsWith('available_')?{...a,choice:'no_documented_match'}:a);return Response.json(body);
 }});assert.deepEqual(r.allowedEndpointIds,[]);
});
test('individual refusals abstain, while malformed and duplicated answers fail closed',async()=>{
 const r=await matchEligibility('A restricted creator',intent,directory,{apiKey:'fixture',fetcher:async(_u,o)=>Response.json({answers:JSON.parse(o.body).questions.map(q=>({name:q.name,type:'refusal'}))})});assert.deepEqual(r.allowedEndpointIds,[]);
 for(const mutate of [a=>({...a,probability:'0.99'}),a=>({...a,probability:1.01})])await assert.rejects(matchEligibility('A restricted creator',intent,directory,{apiKey:'fixture',fetcher:async(u,o)=>{
  const body=await(await answer()(u,o)).json();body.answers=body.answers.map(a=>a.type==='predicate'?mutate(a):a);return Response.json(body);
 }}),/Invalid/);
 await assert.rejects(matchEligibility('A restricted creator',intent,directory,{apiKey:'fixture',fetcher:async(u,o)=>{const body=await(await answer()(u,o)).json();body.answers[1]=body.answers[0];return Response.json(body);}}),/Invalid/);
});
test('prepared fact hints use posting membership and stale hints fall back to the complete index',async()=>{
 const other={...directory.profiles[0],modelId:'c',endpointId:'c',facts:{creator:'Other'}};
 const d={...directory,profiles:[...directory.profiles,other]};
 const hinted=await matchEligibility('A permitted creator',{...intent,hints:{creator:'Maker'}},d,{apiKey:'fixture',fetcher:answer()});
 assert.deepEqual(hinted.allowedModelIds,['a','b']);assert.equal(hinted.checkedFacts,1);
 const stale=await matchEligibility('A permitted creator',{...intent,hints:{creator:'Missing'}},d,{apiKey:'fixture',fetcher:answer()});assert.deepEqual(stale.allowedModelIds,['a','b','c']);assert.equal(stale.checkedFacts,2);
});
test('hourly postings keep route capacities separate and do not turn repository owners into creators',()=>{
 const model={id:'a',name:'A',facts:[{field:'creator',value:'Maker'}],endpoints:directory.profiles.slice(0,2).map(p=>({id:p.endpointId,source:p.source,context:p.facts.contextTokens,provider:'Host'}))};
 const d=prepareEligibility({catalogue:[model],specialists:[{id:'Publisher/repo',revision:'revision',pipeline:'classification'}]});
 const creator=d.facets.creator.find(e=>d.profiles[e.profile].facts.creator==='Maker');assert.equal(creator.members.length,2);
 const capacities=d.facets.contextTokens.map(e=>d.profiles[e.profile].facts.contextTokens);assert.ok(capacities.includes(128000)&&capacities.includes(256000));
 assert.ok(!d.vocabulary.creator.includes('Publisher'));assert.equal(d.profiles.find(p=>p.repository)?.facts.creator,null);
});
