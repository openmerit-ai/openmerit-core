// Offline, opt-in: derive only calibration aggregates. Holdout rows are rejected.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { workloadFor } from '../comparison.mjs';
const mean = values => values.reduce((a,b) => a+b,0) / values.length;
const median = values => { const sorted=[...values].sort((a,b)=>a-b); return (sorted[Math.floor((sorted.length-1)/2)]+sorted[Math.floor(sorted.length/2)])/2; };
export function buildEvidence(manifest, rows, protocolSha256) {
  const profiles = [];
  const byTask = new Map(manifest.tasks.map(t=>[t.id,t]));
  const seen = new Set();
  for (const row of rows) {
    const t=byTask.get(row.task), c=t?.cases.find(c=>c.id===row.caseId), key=[row.task,row.caseId,row.model].join('|');
    if (!c || c.split !== 'calibration' || !t.models.includes(row.model) || seen.has(key)) throw new Error('Only unique, planned calibration observations are allowed');
    seen.add(key);
  }
  const availability = new Map();
  for (const row of rows) { const a=availability.get(row.model)??{successes:0,attempts:0}; a.attempts++;if(row.httpStatus===200)a.successes++;availability.set(row.model,a); }
  for (const task of manifest.tasks) {
    if (task.healthOnly) continue;
    const cases=task.cases.filter(c=>c.split==='calibration'), observations=rows.filter(r=>r.task===task.id), models=[];
    if (cases.length < 6 || observations.length !== cases.length * task.models.length) continue;
    for (const id of task.models) {
      const runs=observations.filter(r=>r.model===id), costs=runs.map(r=>r.usage?.cost).filter(c=>Number.isFinite(c)&&c>=0);
      if (runs.length !== cases.length || runs.some(r=>!Number.isFinite(r.latencyMs)||r.latencyMs<0||!Number.isFinite(r.score?.correct)||!(r.score.total>0)||r.score.correct<0||r.score.correct>r.score.total)) throw new Error('Invalid calibration results');
      models.push({id,cases:runs.length,quality:mean(runs.map(r=>r.httpStatus===200&&(r.score.schemaValid??r.score.validSchema)?r.score.correct/r.score.total:0)),validSchema:runs.filter(r=>r.httpStatus===200&&(r.score.schemaValid??r.score.validSchema)).length,validJson:runs.filter(r=>r.httpStatus===200&&r.score.validJson).length,meanCostUsd:costs.length?mean(costs):null,costKnownCalls:costs.length,medianSeconds:median(runs.map(r=>r.latencyMs/1000)),providers:[...new Set(runs.map(r=>r.provider).filter(Boolean))]});
    }
    for (const model of models) { const a=availability.get(model.id);model.availability={...a,rate:a.successes/a.attempts};model.effectiveQuality=Math.min(model.quality,a.attempts-a.successes>=2?model.availability.rate:1); }
    const work=workloadFor(task.task), scope={kind:task.task.kind,vision:!!task.task.needsVision,tools:!!task.task.needsTools,structured:!!task.task.needsStructured,outputFormat:task.task.needsStructured?'json':null,memory:task.task.needsMemory?'persistent':task.task.requirements?.memory??'none',agentic:!!task.task.weights.agents,input:work.input,output:work.output,capabilities:Object.entries(task.task.weights).filter(([,weight])=>weight>=3).map(([tag])=>tag)};
    const label={extract:scope.vision?'Visual field extraction':'Text field extraction',classify:'Rule-based classification',dispatch:'Single-function dispatch',sql:'Read-only SQL generation',calculate:'Short numerical problems',retrieve:'Long-text record retrieval',code:'Specified code functions',act:'Dependent tool actions',remember:'External memory across sessions'}[scope.kind];
    if (!label || models.length<5) continue;
    profiles.push({id:task.id,label,split:'calibration',scope,casesPerModel:cases.length,measuredAt:new Date(Math.min(...observations.map(r=>Date.parse(r.startedAt)))).toISOString(),lastMeasuredAt:new Date(Math.max(...observations.map(r=>Date.parse(r.startedAt)))).toISOString(),protocolSha256,models});
  }
  return {version:1,methodology:'Equal-case field accuracy (schema and request errors score zero), mean reported USD charge (unknown charges omitted, count disclosed), median full request time including failures. Two or more failed requests cap quality by observed HTTP success across calibration tasks, so an unreliable route cannot regain full credit from one clean task slice. Separate calibration split only. Seven-day expiry; matched task shape and current catalogue eligibility required.',limitations:'Small development corpus and selected candidate pool, not a catalogue-wide or statistically validated optimum. Provider routing and latency can change. Text fixtures are authored; visual calibration uses eight public Portuguese invoices, not every document type. Four new payment slips and one new invoice are held out and never ingested.',visualSource:{title:'Invoice dataset — Cruz and Castelli (2022)',url:'https://zenodo.org/records/6371710',license:'https://creativecommons.org/licenses/by/4.0/'},profiles};
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 const [manifestPath,resultsPath,output]=process.argv.slice(2);if(!output)throw new Error('Expected manifest, calibration results and output paths');
 const bytes=await readFile(manifestPath), rows=(await readFile(resultsPath,'utf8')).trim().split('\n').map(JSON.parse);
 const data=buildEvidence(JSON.parse(bytes),rows,createHash('sha256').update(bytes).digest('hex'));await writeFile(output,JSON.stringify(data,null,2)+'\n');console.log({profiles:data.profiles.length,observations:data.profiles.reduce((n,p)=>n+p.casesPerModel*p.models.length,0)});
}
