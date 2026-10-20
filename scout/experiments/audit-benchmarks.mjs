// Opt-in paid semantic checks; recommended models are not executed.
// Usage: node scout/experiments/audit-benchmarks.mjs /path/report.json
import { readFile, writeFile } from 'node:fs/promises';
import { prepareBenchmarks } from '../benchmarks.mjs';
const report = process.argv[2];
if (!report || process.argv.length !== 3 || !process.env.OPENAI_API_KEY) throw new Error('Supply a report path and OPENAI_API_KEY.');
const cases = JSON.parse(await readFile(new URL('./benchmark-cases.json',import.meta.url)));
const prepared=await prepareBenchmarks(cases.map(c=>({id:`fixture:${c.id}`,name:c.name,source:'fixture',definition:{title:c.name,description:c.description},tags:[]})),[],{apiKey:process.env.OPENAI_API_KEY});
const results=cases.map(c=>{const b=prepared.find(b=>b.id===`fixture:${c.id}`);const problems=[...(c.required||[]).filter(t=>!b.tags.includes(t)).map(t=>`missing ${t}`),...(c.excluded||[]).filter(t=>b.tags.includes(t)).map(t=>`extra ${t}`),...(c.family&&c.family!==b.family?[`family ${b.family}`]:[])];return{id:c.id,pass:!problems.length,problems,tags:b.tags,family:b.family,interpretation:b.interpretation};});
await writeFile(report,JSON.stringify(results,null,2));results.forEach(r=>console.log(JSON.stringify({id:r.id,pass:r.pass,problems:r.problems,tags:r.tags})));if(results.some(r=>!r.pass))process.exitCode=1;
