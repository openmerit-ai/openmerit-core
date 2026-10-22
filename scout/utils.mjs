export const stable = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable(value))))].map(b => b.toString(16).padStart(2, '0')).join('');
export const chunks = (rows, size) => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));
export async function concurrent(rows, count, fn) {
  const result = new Array(rows.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(count, rows.length) }, async () => {
    while (next < rows.length) { const i = next++; result[i] = await fn(rows[i], i); }
  }));
  return result;
}
export const choice = (name, instructions, values) => ({ name, type: 'choice', instructions, choices: Object.entries(values).map(([value, description]) => ({ value, description })) });
export function decode(questions, answers) {
  if (!Array.isArray(answers) || answers.length !== questions.length) throw new Error('Incomplete semantic response.');
  return questions.map(q => {
    const matches = answers.filter(a => a.name === q.name), a = matches[0];
    if (matches.length !== 1 || a.type !== 'choice' || !q.choices.some(c => c.value === a.choice) || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1) throw new Error('Invalid semantic response.');
    return a;
  });
}
export function publicURL(value) {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || !u.hostname.includes('.') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/.test(u.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname) || /\.(local|internal)$/.test(u.hostname)) return null;
    return u.href;
  } catch { return null; }
}
export const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
export const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;

// Bound both headers and body consumption, even when a transport fails to
// settle its promise after cancellation. Every provider adapter shares this.
const diagnosticCollectors=new WeakMap();
// A computation-local transport carries no visitor or account context.
export function diagnosticTransport(fetcher,generations) {
  const transport=(...args)=>fetcher(...args);
  diagnosticCollectors.set(transport,generations);return transport;
}
export function failureCode(error) {
  if(['TimeoutError','AbortError'].includes(error?.name))return 'timeout';
  const known=['insufficient_quota','credit_balance_exhausted','billing_hard_limit_reached','organization_usage_limit_exceeded','rate_limit_exceeded'];
  if(known.includes(error?.code))return error.code;
  if(error?.providerStatus===429)return 'rate_limited';
  if(error?.providerStatus)return 'http_error';
  if(error instanceof TypeError)return 'transport_error';
  const message=error?.message??'';
  if(/refused/i.test(message))return 'refusal';
  if(/incomplete/i.test(message))return 'incomplete';
  if(/invalid|conflicting/i.test(message))return 'validation_error';
  if(/deadline|timed out/i.test(message))return 'timeout';
  return 'provider_error';
}
export async function fetchJSON(fetcher,url,init,timeoutMs) {
  const controller=new AbortController(),signal=init.signal?AbortSignal.any([controller.signal,init.signal]):controller.signal;let timer;
  const generations=diagnosticCollectors.get(fetcher),operation= /^https:\/\/api\.openai\.com\/v1\/(responses|decisions|embeddings)$/.exec(url)?.[1];
  const started=performance.now();let generation;
  if(generations&&operation&&generations.length<40){
    generation={id:crypto.randomUUID(),operation,startedAt:new Date().toISOString(),durationMs:0,pending:true};
    const model=JSON.parse(init.body).model;
    if(['gpt-6-luna','text-embedding-3-small'].includes(model))generation.model=model;
    generations.push(generation);
  }
  try{return await Promise.race([
    Promise.resolve().then(()=>fetcher(url,{...init,signal})).then(async response=>{
      if(generation){generation.providerStatus=response.status;if(!response.ok)generation.code=response.status===429?'rate_limited':'http_error';}
      const body=await response.json().catch(error=>{if(response.ok)throw error;return null;});
      if(generation){
        const usage=body?.usage;
        for(const [key,value] of Object.entries({inputTokens:usage?.input_tokens??usage?.prompt_tokens,outputTokens:usage?.output_tokens??usage?.completion_tokens,cachedInputTokens:usage?.input_tokens_details?.cached_tokens??usage?.prompt_tokens_details?.cached_tokens}))if(Number.isSafeInteger(value)&&value>=0)generation[key]=value;
        if(!response.ok)generation.code=failureCode({providerStatus:response.status,code:body?.error?.code});
        else if(body?.status&&body.status!=='completed')generation.code='incomplete';
        else if(body?.output?.some(i=>i.content?.some(c=>c.type==='refusal')))generation.code='refusal';
      }
      return {response,body};
    }),
    new Promise((_resolve,reject)=>{timer=setTimeout(()=>{const error=new DOMException('Provider request timed out.','TimeoutError');controller.abort(error);reject(error);},timeoutMs);}),
  ]);}catch(error){if(generation)generation.code=failureCode(error);throw error;}finally{if(generation){generation.durationMs=Math.max(0,Math.round(performance.now()-started));generation.pending=false;}clearTimeout(timer);controller.abort();}
}
