// Opt-in bounded comparison runner. Fixtures, credentials and results stay external.
// node --env-file=.env.demo scout/experiments/task-eval.mjs manifest.json new-output-directory
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { grade, failedScore } from './task-score.mjs';
const [manifestPath, output] = process.argv.slice(2);
if (!manifestPath || !output || !process.env.OPENROUTER_API_KEY) throw new Error('Manifest, output directory and OPENROUTER_API_KEY required');
const bytes = await readFile(manifestPath), manifest = JSON.parse(bytes);
const split = process.argv.includes('--holdout') ? 'holdout' : process.argv.includes('--calibration') ? 'calibration' : null;
const resume = process.argv.includes('--resume');
const budgetArgument = process.argv.find(arg => arg.startsWith('--budget-usd='));
const budgetUsd = budgetArgument ? Number(budgetArgument.split('=')[1]) : manifest.budgetUsd;
if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error('Invalid spending guard');
if (!resume) await mkdir(output);
else { const prior=JSON.parse(await readFile(resolve(output,'protocol.json'))); if(prior.split!==split || prior.manifestSha256!==createHash('sha256').update(bytes).digest('hex')) throw new Error('Cannot resume a different protocol'); }
if (!resume) await writeFile(resolve(output, 'protocol.json'), JSON.stringify({ manifest, split, budgetUsd, manifestSha256: createHash('sha256').update(bytes).digest('hex'), startedAt: new Date().toISOString(), provider: { require_parameters: true, allow_fallbacks: false } }, null, 2));
if (resume && budgetArgument) {
  const path = resolve(output, 'protocol.json'), prior = JSON.parse(await readFile(path));
  prior.budgetAmendments = [...(prior.budgetAmendments ?? []), { at: new Date().toISOString(), budgetUsd, note: 'Spending guard only; cases, models, grading, provider settings and frozen rankings unchanged. Resume dispatches only unstarted calls.' }];
  await writeFile(path, JSON.stringify(prior, null, 2));
}
const jobs = manifest.tasks.flatMap(t => t.cases.filter(c => !split || c.split === split).flatMap((c,i) => t.models.map((_,j) => ({ task: t.id, c, model: t.models[(i+j)%t.models.length] }))));
const rows=resume?(await readFile(resolve(output,'results.jsonl'),'utf8')).trim().split('\n').map(JSON.parse):[];
const done=new Set(rows.map(r=>[r.task,r.caseId,r.model].join('|')));
const remaining=jobs.filter(j=>!done.has([j.task,j.c.id,j.model].join('|')));
let next=0, spent=rows.reduce((n,r)=>n+(r.usage?.cost??0),0), reserved=0, stop=false, unknownReserve=rows.filter(r=>r.errorCode==='TimeoutError'||r.httpStatus===200&&typeof r.usage?.cost!=='number').length*.25;
async function worker() {
  while(next<remaining.length && !stop) {
    if(spent+unknownReserve+reserved+.25>budgetUsd) { stop=true; break; }
    const {task,c,model}=remaining[next++]; reserved+=.25;
    let content=[{type:'text',text:c.prompt}];
    if(c.path) {const image=await readFile(c.path);if(createHash('sha256').update(image).digest('hex')!==c.sha256)throw new Error('Image changed');content.push({type:'image_url',image_url:{url:'data:image/jpeg;base64,'+image.toString('base64')}});}
    const messages=[...(c.system?[{role:'system',content:c.system}]:[]),{role:'user',content}];
    const body={model,messages,max_tokens:c.kind==='invoice'?8192:4096,provider:{require_parameters:true,allow_fallbacks:false},...(c.tools?{tools:c.tools,tool_choice:'auto'}:{response_format:{type:'json_schema',json_schema:{name:'extraction',strict:true,schema:c.schema}}})};
    const row={task,caseId:c.id,model,startedAt:new Date().toISOString()},start=performance.now();
    try {
      const r=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENROUTER_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(manifest.timeoutMs)});
      const data=await r.json();Object.assign(row,{httpStatus:r.status,id:data.id,provider:data.provider,returnedModel:data.model,usage:data.usage,finishReason:data.choices?.[0]?.finish_reason,message:data.choices?.[0]?.message??{},errorCode:data.error?.code});
      row.score=r.ok?grade(row.message,c):failedScore(c);
      if(typeof row.usage?.cost==='number')spent+=row.usage.cost;else if(r.ok)unknownReserve+=.25;
    } catch(e){row.errorCode=e.name;row.score=failedScore(c);unknownReserve+=.25;}
    row.latencyMs=Math.round(performance.now()-start);reserved-=.25;rows.push(row);
    await appendFile(resolve(output,'results.jsonl'),JSON.stringify(row)+'\n');
    console.log(JSON.stringify({completed:rows.length,task,model,case:c.id,status:row.httpStatus??row.errorCode,correct:row.score.correct,ms:row.latencyMs,cost:row.usage?.cost??null}));
  }
}
await Promise.all(Array.from({length:manifest.maxConcurrent},worker));
await writeFile(resolve(output,'completion.json'),JSON.stringify({planned:jobs.length,completed:rows.length,knownCostUsd:spent,unknownCostReservationUsd:unknownReserve,stoppedEarly:stop,finishedAt:new Date().toISOString()},null,2));
