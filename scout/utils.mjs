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
export async function fetchJSON(fetcher,url,init,timeoutMs) {
  const controller=new AbortController(),signal=init.signal?AbortSignal.any([controller.signal,init.signal]):controller.signal;let timer;
  try{return await Promise.race([
    Promise.resolve().then(()=>fetcher(url,{...init,signal})).then(async response=>{
      const body=await response.json().catch(error=>{if(response.ok)throw error;return null;});
      return {response,body};
    }),
    new Promise((_resolve,reject)=>{timer=setTimeout(()=>{const error=new DOMException('Provider request timed out.','TimeoutError');controller.abort(error);reject(error);},timeoutMs);}),
  ]);}finally{clearTimeout(timer);controller.abort();}
}
