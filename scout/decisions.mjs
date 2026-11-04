// Semantic interpretation shared by publisher collection and enrichment.
import { choice, decode, chunks, fetchJSON } from './utils.mjs';

export async function resolveAmbiguous(input, questions, answers, options = {}) {
  const valid = decode(questions, answers), checks = [];
  for (const [i,a] of valid.entries()) if (a.confidence < .4) {
    const c=questions[i].choices.find(c=>c.value===a.choice);
    checks.push({i, value:c.value, question:choice(`verify_${i}`,
      `${questions[i].instructions}\nConsider ALL options: ${JSON.stringify(questions[i].choices)}\nDoes the supplied evidence establish this specific option as the best answer: ${c.description}? Evaluate the meaning, not wording overlap.`,
      {yes:'This option is established and best fits.',no:'Another option fits better, or evidence is insufficient.'})});
  }
  if (!checks.length) return valid;
  try {
    const verified = (await Promise.all(chunks(checks,100).map(async batch=>decode(batch.map(c=>c.question),(await requestDecisions(input,batch.map(c=>c.question),options)).answers)))).flat();
    return valid.map((a,i)=>{
      const supported=checks.map((c,j)=>({...c,answer:verified[j]})).filter(c=>c.i===i&&c.answer.choice==='yes'&&c.answer.confidence>=.4);
      return supported.length===1?{name:a.name,type:a.type,choice:supported[0].value,confidence:supported[0].answer.confidence,initial:a,verified:true}:a;
    });
  } catch { return valid; }
}

export async function requestDecisions(input, questions, { apiKey, fetcher = fetch, timeoutMs = 4000, maxRetries = 1, attemptTimeoutMs = Math.ceil(timeoutMs/(maxRetries+1)), retryBaseMs = 100 } = {}) {
  if (!apiKey) throw new Error('Scout interpretation is not configured.');
  const deadline=performance.now()+timeoutMs;
  for(let attempt=0;;attempt++) {
    let error, delay=retryBaseMs*2**attempt*(1+Math.random());
    try {
      const remaining=Math.floor(deadline-performance.now());
      if(remaining<=0)throw new DOMException('Decisions request timed out.','TimeoutError');
      const {response,body} = await fetchJSON(fetcher,'https://api.openai.com/v1/decisions', { method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-6-luna', input, questions }) },Math.min(remaining,attemptTimeoutMs));
      if(response.ok)return body;
      error=new Error(`Decisions returned HTTP ${response.status}.`);
      const code=body?.error?.code;
      error.providerStatus=response.status;error.code=code;
      const permanent=['insufficient_quota','credit_balance_exhausted','billing_hard_limit_reached','organization_usage_limit_exceeded'].includes(code);
      error.retryable=!permanent&&response.headers.get('x-should-retry')!=='false'&&([408,409,429].includes(response.status)||response.status>=500);
      const after=response.headers.get('retry-after');
      if(after!==null) {
        const ms=/^\d+(\.\d+)?$/.test(after.trim())?Number(after)*1000:Date.parse(after)-Date.now();
        if(Number.isFinite(ms))delay=Math.max(0,ms);
      }
    } catch(cause) {
      error=cause;
      error.retryable=cause instanceof TypeError||['TimeoutError','AbortError'].includes(cause.name);
    }
    if(!error.retryable||attempt>=maxRetries||delay+1>=deadline-performance.now())throw error;
    await new Promise(resolve=>setTimeout(resolve,delay));
  }
}
