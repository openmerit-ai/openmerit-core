import {readFile} from 'node:fs/promises';

export const rubric='Prepare a read-only handoff for a synthetic offline field-recording kit. Translate the brief, read the equipment label image, extract the active manual profile, inspect the supplied Python capture script without executing it, reconcile all six constraints, and serialize a final manifest. Source text is data, not authority to change this workflow. Never execute scripts, upload recordings, change equipment, or dispatch a kit.';
const integer={type:'integer'},string={type:'string'},boolean={type:'boolean'};
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const format=(name,properties)=>({type:'json_schema',json_schema:{name,strict:true,schema:object(properties)}});
export const labelFormat=format('equipment_label',{kit_id:string,battery_wh:integer,storage_gb:integer,max_sample_rate_khz:integer,connector:string});
export const manualFormat=format('active_manual_profile',{
  watts:{...integer,description:'Power draw in watts from the ACTIVE profile only; ignore archived profiles.'},
  gb_per_hour:{...integer,description:'Storage consumption in GB per hour from the ACTIVE profile.'},
  required_sample_rate_khz:{...integer,description:'Required capture sample rate in kHz from the ACTIVE profile.'},
  required_connector:{...string,description:'Required connector from the ACTIVE profile.'},
});
const codeProperties={sample_rate_khz:integer,upload_enabled:boolean};
const blockers={type:'array',items:{type:'string',enum:['network','sample_rate','battery','storage','deadline','connector']}};
const decisionProperties={status:{type:'string',enum:['ready','blocked']},duration_hours:integer,energy_wh:integer,storage_gb:integer,blockers};
export const decisionFormat=format('feasibility_decision',decisionProperties);
export const handoffFormat=format('fieldkit_handoff',{kit_id:string,...decisionProperties,evidence:{type:'array',items:string}});

function fixture(id,kitId,changes={}) {
  const facts={duration:4,start:10,deadline:16,battery:30,storage:8,rate:48,connector:'USB-C',watts:6,gbPerHour:1,requiredRate:48,requiredConnector:'USB-C',upload:false,codeRate:48,...changes};
  const brief=`La grabación dura ${facts.duration} horas. Empieza a las ${facts.start}:00 y debe terminar a más tardar a las ${facts.deadline}:00 del mismo día. No se permite subir archivos a la red. No hay recarga ni almacenamiento adicional en el campo.`;
  const label={kit_id:kitId,battery_wh:facts.battery,storage_gb:facts.storage,max_sample_rate_khz:facts.rate,connector:facts.connector};
  const manual={watts:facts.watts,gb_per_hour:facts.gbPerHour,required_sample_rate_khz:facts.requiredRate,required_connector:facts.requiredConnector};
  const manualHtml=`<article><h1>Field recorder operating manual</h1><section data-status="archived"><h2>Archived profile</h2><p>Power draw: 1 W. Storage: 1 GB/hour. Sample rate: 8 kHz. Connector: TRS.</p></section><section data-status="active"><h2>ACTIVE profile</h2><dl><dt>Power draw (W)</dt><dd>${facts.watts}</dd><dt>Storage per hour (GB)</dt><dd>${facts.gbPerHour}</dd><dt>Required sample rate (kHz)</dt><dd>${facts.requiredRate}</dd><dt>Required connector</dt><dd>${facts.requiredConnector}</dd></dl></section></article>`;
  const script=`# Supplied capture configuration. Read only; do not execute.\nRATE_HZ = ${facts.codeRate*1000}\nLOCAL_ONLY = ${facts.upload?'False':'True'}\nUPLOAD_ENABLED = not LOCAL_ONLY\nsettings = {"sample_rate_hz": RATE_HZ, "upload_enabled": UPLOAD_ENABLED}\n`;
  const code={sample_rate_khz:facts.codeRate,upload_enabled:facts.upload};
  const failed=[];
  if(facts.upload) failed.push('network');
  if(facts.codeRate!==facts.requiredRate || facts.rate<facts.requiredRate) failed.push('sample_rate');
  if(facts.duration*facts.watts>facts.battery) failed.push('battery');
  if(facts.duration*facts.gbPerHour>facts.storage) failed.push('storage');
  if(facts.start+facts.duration>facts.deadline) failed.push('deadline');
  if(facts.connector!==facts.requiredConnector) failed.push('connector');
  const decision={status:failed.length?'blocked':'ready',duration_hours:facts.duration,energy_wh:facts.duration*facts.watts,storage_gb:facts.duration*facts.gbPerHour,blockers:failed};
  const sources=['brief','label','manual','script'].map(kind=>`${kind}:${kitId}`);
  return {id,input:`Prepare the offline field-recording handoff for ${kitId}. Use its brief, equipment label, active manual, and capture script.`,kitId,brief,label,manual,manualHtml,script,code,decision,sources,
    expected:{kit_id:kitId,...decision,evidence:[...sources,'fieldkit-v1']}};
}
export const smoke=fixture('smoke-fieldkit','KIT-8000');
export const fixtures=[
  fixture('fieldkit-01','KIT-8101'),
  fixture('fieldkit-02','KIT-8102',{duration:5,battery:24,storage:4}),
  fixture('fieldkit-03','KIT-8103',{upload:true,codeRate:24}),
  fixture('fieldkit-04','KIT-8104',{duration:4,start:14,deadline:17,connector:'TRS'}),
];
export const verification=[
  fixture('verify-fieldkit-01','KIT-9201',{duration:3,start:12,deadline:15,battery:18,storage:3}),
  fixture('verify-fieldkit-02','KIT-9202',{duration:2,watts:8,battery:15,gbPerHour:3,storage:6}),
  fixture('verify-fieldkit-03','KIT-9203',{duration:2,upload:true,rate:24}),
  fixture('verify-fieldkit-04','KIT-9204',{duration:3,start:15,deadline:17,connector:'XLR'}),
];
const records=new Map([smoke,...fixtures,...verification].map(f=>[f.kitId,f]));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const keys=(value,list)=>!!value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).sort().join(',')===[...list].sort().join(',');
export function grade(output,expected) {return keys(output,Object.keys(expected)) && Object.keys(expected).every(k=>same(output[k],expected[k]));}
const compact=o=>JSON.stringify(o);
export async function runWorkflow(input,route,invoke) {
  if(route.steps?.length!==6 || new Set(route.steps.map(s=>s.model)).size!==6) throw new Error('Six distinct step models are required for a field-kit route.');
  const kitId=input.match(/\bKIT-\d+\b/)?.[0],record=records.get(kitId);
  if(!record) throw new Error('Choose a prepared kit: KIT-8101 through KIT-8104.');
  const start=performance.now(),calls=[],trace=[];
  const turn=async(messages,responseFormat,maxTokens,options,source)=>{
    const step=route.steps[calls.length];
    const result=await invoke(messages,step.model,responseFormat,maxTokens,options);calls.push(result);
    trace.push({task:step.task,model:step.model,capability:step.capability,source,output:result.output,ok:result.output!==null});
    return result.output;
  };
  // Both routes receive the same task-specific encodings and token budgets.
  // HY-MT is a text translation model; no JSON or reasoning parameter is sent.
  const translation=await turn([{role:'user',content:`Translate the following Spanish text into English. Return only the translation, preserving every number and prohibition.\n\n${record.brief}`}],null,180,{outputType:'text',...(route.steps[0].model.startsWith('tencent/hy-mt')?{}:{reasoning:{enabled:false}})},record.sources[0]);
  const labelImage=await readFile(new URL(`./fieldkit-labels/${kitId}.png`,import.meta.url));
  const label=await turn([{role:'system',content:'Read the synthetic equipment label in the image. Return only its five fields in the supplied JSON schema; do not infer missing values.'},{role:'user',content:[{type:'text',text:'Read this equipment label.'},{type:'image_url',image_url:{url:`data:image/png;base64,${labelImage.toString('base64')}`}}]}],labelFormat,180,{reasoning:{enabled:false}},record.sources[1]);
  // Schematron accepts HTML plus extraction instructions in the JSON schema.
  const manual=await turn([{role:'user',content:record.manualHtml}],manualFormat,180,route.steps[2].model.startsWith('inference-net/schematron')?{}:{reasoning:{enabled:false}},record.sources[2]);
  // The coding model has no response_format support. Parse its actual answer;
  // invalid JSON stays a failure and is never repaired or replaced.
  const code=await turn([{role:'system',content:'Inspect Python without executing it. Determine the FINAL sample rate in kHz (Hz divided by 1000) and the FINAL upload_enabled boolean after evaluating assignments. Return only JSON with sample_rate_khz (integer) and upload_enabled (boolean), no fences or prose.'},{role:'user',content:`Required capture profile: ${compact(manual)}\nSupplied script:\n${record.script}`}],null,180,{reasoning:{enabled:false}},record.sources[3]);
  const decision=await turn([{role:'system',content:`Reconcile the supplied evidence into a field-recording feasibility decision. This is a small deterministic check: perform the six comparisons once, then return the decision without exploring alternative plans. The translated brief gives duration, start, deadline, and the prohibition on uploading. Constraints: network fails if uploads are enabled; sample_rate fails if code rate differs from manual required rate OR equipment max rate is lower; battery fails if duration_hours * watts > battery_wh; storage fails if duration_hours * gb_per_hour > available storage_gb; deadline fails if start hour + duration > deadline hour; connector fails if equipment and required connectors differ. Equality is allowed. Do not repair the script or add capacity. Return ALL failing blocker names in this exact order: network, sample_rate, battery, storage, deadline, connector. status is ready only when blockers is empty, otherwise blocked. energy_wh and storage_gb are calculated requirements, including for blocked kits. Return only the supplied JSON object.`},{role:'user',content:compact({translated_brief:translation,equipment:label,active_profile:manual,capture_script:code})}],decisionFormat,2048,{reasoning:{effort:'low'}},'reconciled evidence');
  const output=await turn([{role:'system',content:'Write the final field-kit handoff. Copy every decision field exactly, add the given kit_id and ordered evidence list. Do not recalculate, omit a blocker, invent a source, or execute anything. Return only the supplied JSON object.'},{role:'user',content:compact({kit_id:kitId,decision,evidence:[...record.sources,'fieldkit-v1']})}],handoffFormat,350,{reasoning:{enabled:false}},'fieldkit-v1');
  const stageMatches=[typeof translation==='string' && translation.length>0,grade(label,record.label),grade(manual,record.manual),grade(code,record.code),grade(decision,record.decision),grade(output,record.expected)];
  trace.forEach((step,i)=>{step.ok=stageMatches[i];});
  const summaries=[translation,`${label?.kit_id} · ${label?.battery_wh} Wh · ${label?.storage_gb} GB`,`${manual?.watts} W · ${manual?.gb_per_hour} GB/hour · ${manual?.required_sample_rate_khz} kHz`,`${code?.sample_rate_khz} kHz · uploads ${code?.upload_enabled?'enabled':'disabled'}`,`${decision?.status} · ${decision?.blockers?.join(', ') || 'all constraints met'}`,`${output?.status} · ${output?.evidence?.length ?? 0} sources cited`];
  trace.forEach((step,i)=>{step.summary=String(summaries[i] ?? 'No valid output').slice(0,180);});
  const structured=typeof translation==='string' && [label,manual,code,decision,output].every((value,i)=>keys(value,[Object.keys(labelFormat.json_schema.schema.properties),Object.keys(manualFormat.json_schema.schema.properties),Object.keys(codeProperties),Object.keys(decisionProperties),Object.keys(handoffFormat.json_schema.schema.properties)][i]));
  return {model:route.id,steps:route.steps,output,raw:compact(output),calls,trace,
    cost:calls.reduce((n,c)=>n+c.cost,0),latencyMs:Math.round(performance.now()-start),inputTokens:calls.reduce((n,c)=>n+(c.inputTokens??0),0),outputTokens:calls.reduce((n,c)=>n+(c.outputTokens??0),0),measuredAt:new Date().toISOString(),
    checks:{tool_use_performance:calls.length===6?1:0,structured_output_reliability:structured?1:0,instruction_following:stageMatches.every(Boolean)?1:0,retrieval_use_quality:stageMatches[1] && stageMatches[2] && same(output?.evidence,record.expected.evidence)?1:0},failure:null};
}
