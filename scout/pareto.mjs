import {referenceWork,workloadFor,taskWeights,qualityIndifference} from './comparison.mjs';

// Common latent quality across every connected benchmark, in score units of an
// average benchmark. Each evaluation keeps its own difficulty offset, scale and
// noise; each model has one shrunk estimate with a standard error. These are
// fixed modelling priors, not tuned per model, task or prompt.
const priorScale=.2,noisePrior=.02,noiseStrength=4,slopeStrength=.02,minimumSlope=.05,iterations=80;
// Configurations within this many standard errors (plus the indifference band)
// of the strongest estimate are not credibly worse than it.
export const qualityTolerance=1;
// Gaps smaller than this share of the spread of model estimates on the task are
// treated as practically equal, so the margin scales with the evaluations a
// task uses. Two points remain the floor for tightly bunched cohorts.
export const qualityIndifferenceShare=.15;
// With three or more connected evaluations, one whose scores correlate below
// this with the estimate from the others (over enough shared models) is left out.
const minimumAgreement=.3,minimumAgreementModels=5;

const lowerBound=(values,x)=>{let lo=0,hi=values.length;while(lo<hi){const mid=(lo+hi)>>>1;if(values[mid]<x)lo=mid+1;else hi=mid;}return lo;};

// Model-level observations: duplicate routes share their model's evidence and
// never add votes. Calibration observations join as one more evaluation.
function observations(candidates,weights) {
  const total=Object.values(weights).reduce((a,b)=>a+b,0),rows=new Map();
  for(const c of candidates){
    if(rows.has(c.model.id))continue;
    const m=new Map();
    for(const e of c.evidence){
      const tags=e.definition?.tags??[],weight=tags.reduce((n,t)=>n+(weights[t]??0),0);
      if(weight>0&&Number.isFinite(e.score))m.set(e.benchmark,{score:e.score,weight,family:e.definition.family??e.benchmark,tags});
    }
    const direct=c.taskObservation??c.measured,quality=direct&&(direct.effectiveQuality??direct.quality);
    if(Number.isFinite(quality)){const id=`calibration:${direct.profile?.id??direct.profileId??''}`,prior=m.get(id);m.set(id,{score:quality,weight:prior?.weight??total,family:id,tags:prior?.tags??Object.keys(weights)});}
    rows.set(c.model.id,m);
  }
  return rows;
}

export function estimateQuality(candidates,weights,excluded=new Set()) {
  const rows=observations(candidates,weights),byBenchmark=new Map();
  for(const [model,m] of rows)for(const [benchmark,o] of m){if(excluded.has(benchmark))continue;const list=byBenchmark.get(benchmark)??[];list.push({model,...o});byBenchmark.set(benchmark,list);}
  // A benchmark run by one model links nothing and cannot rank it.
  for(const [id,list] of byBenchmark)if(list.length<2)byBenchmark.delete(id);
  // Correlated series in one family share that family's weight.
  const families=new Map();for(const [,list] of byBenchmark)families.set(list[0].family,(families.get(list[0].family)??0)+1);
  const parent=new Map(),find=x=>{while(parent.get(x)!==x){parent.set(x,parent.get(parent.get(x)));x=parent.get(x);}return x;};
  for(const [,list] of byBenchmark)for(const o of list){if(!parent.has(o.model))parent.set(o.model,o.model);parent.set(find(o.model),find(list[0].model));}
  const sizes=new Map();for(const m of parent.keys())sizes.set(find(m),(sizes.get(find(m))??0)+1);
  const root=[...sizes].sort((a,b)=>b[1]-a[1]||String(a[0]).localeCompare(String(b[0])))[0]?.[0];
  const estimates=new Map();
  if(root===undefined||sizes.get(root)<2)return {estimates,models:0,benchmarks:0};
  const models=[...parent.keys()].filter(m=>find(m)===root),index=new Map(models.map((m,i)=>[m,i]));
  const benchmarks=[...byBenchmark].filter(([,list])=>index.has(list[0].model)).map(([id,list])=>({id,weight:list[0].weight/families.get(list[0].family),obs:list.map(o=>({m:index.get(o.model),y:o.score}))}));
  const meanWeight=benchmarks.reduce((n,b)=>n+b.weight,0)/benchmarks.length;
  for(const b of benchmarks){b.weight/=meanWeight;b.a=1;b.mean=b.obs.reduce((n,o)=>n+o.y,0)/b.obs.length;b.beta=b.mean;b.noise=noisePrior**2;}
  const byModel=models.map(()=>[]);for(const b of benchmarks)for(const o of b.obs)byModel[o.m].push({b,y:o.y});
  const theta=byModel.map(list=>list.reduce((n,{b,y})=>n+y-b.mean,0)/list.length),se=models.map(()=>priorScale);
  for(let step=0;step<iterations;step++){
    for(let i=0;i<models.length;i++){
      let num=0,den=1/priorScale**2;
      for(const {b,y} of byModel[i]){num+=b.weight*b.a*(y-b.beta)/b.noise;den+=b.weight*b.a**2/b.noise;}
      theta[i]=num/den;se[i]=1/Math.sqrt(den);
    }
    for(const b of benchmarks){
      const n=b.obs.length,tm=b.obs.reduce((s,o)=>s+theta[o.m],0)/n;let sxx=0,sxy=0;
      for(const o of b.obs){sxx+=(theta[o.m]-tm)**2;sxy+=(theta[o.m]-tm)*(o.y-b.mean);}
      // Slopes shrink toward the average scale so two models cannot define one.
      b.a=Math.max(minimumSlope,(sxy+slopeStrength)/(sxx+slopeStrength));b.beta=b.mean-b.a*tm;
      const ssr=b.obs.reduce((s,o)=>s+(o.y-b.beta-b.a*theta[o.m])**2,0);
      b.noise=(ssr+noiseStrength*noisePrior**2)/(Math.max(0,n-2)+noiseStrength);
    }
    // Identify the scale: mean model at zero, weighted average slope of one.
    const scale=benchmarks.reduce((s,b)=>s+b.weight*b.a,0)/benchmarks.reduce((s,b)=>s+b.weight,0);
    for(let i=0;i<theta.length;i++)theta[i]*=scale;for(const b of benchmarks)b.a/=scale;
    const center=theta.reduce((a,b)=>a+b,0)/theta.length;for(let i=0;i<theta.length;i++)theta[i]-=center;for(const b of benchmarks)b.beta+=b.a*center;
  }
  // Report each standard error on the final identified scale. When a model's
  // evaluations disagree about it, that spread is uncertainty the fitted noise
  // alone does not capture.
  for(let i=0;i<models.length;i++){
    let den=1/priorScale**2;for(const {b} of byModel[i])den+=b.weight*b.a**2/b.noise;
    const reads=byModel[i].map(({b,y})=>(y-b.beta)/b.a-theta[i]),n=reads.length;
    se[i]=Math.sqrt(1/den+(n>1?reads.reduce((s,r)=>s+r*r,0)/(n-1)/n:0));
  }
  const sorted=[...theta].sort((a,b)=>a-b);
  models.forEach((m,i)=>{
    const below=lowerBound(sorted,theta[i]),ties=lowerBound(sorted,theta[i]+Number.EPSILON*8)-below;
    estimates.set(m,{value:theta[i],se:se[i],percentile:(below+(ties-1)/2)/(models.length-1),benchmarks:byModel[i].map(x=>x.b.id)});
  });
  // An evaluation that disagrees with the factor estimated from the others
  // measures something else. A narrow score range gives it tiny noise and
  // outsized weight, so the factor would bend to it rather than reject it.
  if(!excluded.size&&benchmarks.length>2){
    const unrelated=benchmarks.filter(b=>{
      const others=estimateQuality(candidates,weights,new Set([b.id])).estimates,pairs=b.obs.filter(o=>others.has(models[o.m])).map(o=>[o.y,others.get(models[o.m]).value]);
      return pairs.length>=minimumAgreementModels&&correlation(pairs)<minimumAgreement;
    });
    if(unrelated.length&&unrelated.length<benchmarks.length)return estimateQuality(candidates,weights,new Set(unrelated.map(b=>b.id)));
  }
  return {estimates,models:models.length,benchmarks:benchmarks.length,spread:Math.sqrt(theta.reduce((s,x)=>s+x*x,0)/theta.length)};
}
function correlation(pairs) {
  const n=pairs.length,mx=pairs.reduce((s,p)=>s+p[0],0)/n,my=pairs.reduce((s,p)=>s+p[1],0)/n;
  let sxy=0,sxx=0,syy=0;for(const [x,y] of pairs){sxy+=(x-mx)*(y-my);sxx+=(x-mx)**2;syy+=(y-my)**2;}
  return sxx&&syy?sxy/Math.sqrt(sxx*syy):0;
}

// Three-objective skyline. Equal triples are retained together. Missing
// objectives cannot dominate or be dominated.
function supportedFrontier(candidates) {
  const retained=candidates.filter(c=>!c.frontierComplete),group=candidates.filter(c=>c.frontierComplete);
  group.sort((a,b)=>b.scopeQuality-a.scopeQuality||a.reference.cost-b.reference.cost||a.reference.seconds-b.reference.seconds);
  const costs=[...new Set(group.map(c=>c.reference.cost))].sort((a,b)=>a-b),tree=Array(costs.length+1).fill(Infinity);
  const query=i=>{let value=Infinity;for(i++;i>0;i-=i&-i)value=Math.min(value,tree[i]);return value;};
  const insert=(i,value)=>{for(i++;i<tree.length;i+=i&-i)tree[i]=Math.min(tree[i],value);};
  for(let i=0;i<group.length;){let j=i+1;const c=group[i];while(j<group.length&&group[j].scopeQuality===c.scopeQuality&&group[j].reference.cost===c.reference.cost&&group[j].reference.seconds===c.reference.seconds)j++;
    const position=lowerBound(costs,c.reference.cost);if(query(position)>c.reference.seconds)retained.push(...group.slice(i,j));insert(position,c.reference.seconds);i=j;
  }
  return retained;
}

export function prepareObjectives(candidates,task) {
  const workload=workloadFor(task),weights=taskWeights(task),total=Object.values(weights).reduce((a,b)=>a+b,0);
  const fit=estimateQuality(candidates,weights);
  for(const c of candidates) {
    // Calibration episode bills and durations are a different workload from
    // the common token reference; they never replace it for some candidates.
    c.reference=c.measured?{cost:c.measured.meanCostUsd,seconds:c.measured.medianSeconds}:referenceWork(c.model,workload);
    const estimate=fit.estimates.get(c.model.id);
    c.scopeQuality=estimate?.value??null;c.qualitySE=estimate?.se??null;
    c.qualityScope=estimate?'common':`disconnected:${c.model.id}`;
    c.quality=estimate&&fit.models>1?estimate.percentile:null;
    c.comparedModels=estimate?fit.models-1:0;
    const covered=new Set(c.evidence.filter(e=>estimate?.benchmarks.includes(e.benchmark)).flatMap(e=>e.definition?.tags??[]));
    if(estimate&&(c.taskObservation??c.measured))for(const t of Object.keys(weights))covered.add(t);
    c.comparisonCoverage=estimate&&total?Object.entries(weights).reduce((n,[t,w])=>n+(covered.has(t)?w:0),0)/total:0;
    c.frontierComplete=Number.isFinite(c.scopeQuality)&&c.reference.cost!==null&&c.reference.seconds!==null;
  }
  return {workload,models:fit.models,benchmarks:fit.benchmarks,margin:Math.max(qualityIndifference,qualityIndifferenceShare*(fit.spread??0))};
}
export function dominates(a,b) {
  if(a.qualityScope!==b.qualityScope||!a.frontierComplete||!b.frontierComplete)return false;
  return a.scopeQuality>=b.scopeQuality&&a.reference.cost<=b.reference.cost&&a.reference.seconds<=b.reference.seconds&&
    (a.scopeQuality>b.scopeQuality||a.reference.cost<b.reference.cost||a.reference.seconds<b.reference.seconds);
}
const providerOf=c=>c.model.provider??c.model.id.split('/')[0];
export function selectPareto(candidates,task,{limit=5,providerLimit=2}={}) {
  const count=candidates.length,scope=prepareObjectives(candidates,task),priority=workloadFor(task).priority;
  const estimated=candidates.filter(c=>Number.isFinite(c.scopeQuality)),best=estimated.reduce((x,c)=>!x||c.scopeQuality>x.scopeQuality?c:x,null);
  const qualified=[],unverified=[];
  for(const c of candidates){
    if(!Number.isFinite(c.scopeQuality)){unverified.push(c);continue;}
    // Not credibly worse than the strongest estimate. This is a relative
    // evidence policy, NOT a verified task-accuracy threshold.
    const gap=best.scopeQuality-c.scopeQuality,allowance=scope.margin+qualityTolerance*Math.hypot(c.qualitySE,best.qualitySE);
    if(gap<=allowance+Number.EPSILON*4)qualified.push(c);
  }
  const qualityGate={status:qualified.length?'proxy-qualified':'unverified',margin:scope.margin,marginShare:qualityIndifferenceShare,tolerance:qualityTolerance,qualifiedConfigurations:qualified.length,unverifiedConfigurations:unverified.length,excludedConfigurations:count-qualified.length-unverified.length};
  const frontier=supportedFrontier(qualified.length?qualified:unverified);
  const q=c=>c.scopeQuality??-Infinity,cost=c=>c.reference.cost??Infinity,time=c=>c.reference.seconds??Infinity,preference=c=>c.preference??0;
  const tie=(a,b)=>preference(b)-preference(a)||a.model.id.localeCompare(b.model.id)||a.model.endpoint.id.localeCompare(b.model.endpoint.id);
  const orders={quality:(a,b)=>q(b)-q(a)||cost(a)-cost(b)||time(a)-time(b)||tie(a,b),cost:(a,b)=>cost(a)-cost(b)||time(a)-time(b)||q(b)-q(a)||tie(a,b),latency:(a,b)=>time(a)-time(b)||cost(a)-cost(b)||q(b)-q(a)||tie(a,b)};
  // Without established quality, keep the explicitly unverified discovery list
  // in known-cost order; no pick can claim a quality role.
  const order=!qualified.length?orders.cost:orders[priority]??orders.quality;
  frontier.sort(order);
  // Labelled tradeoffs among the supported frontier, never outside it.
  const roles=new Map();
  if(qualified.length){
    const known=(value,list)=>list.filter(c=>Number.isFinite(value(c)));
    const pick=(role,list,compare)=>{const c=[...list].sort(compare)[0];if(c)roles.set(c,[...(roles.get(c)??[]),role]);};
    pick('quality',frontier,orders.quality);pick('value',known(cost,frontier),orders.cost);pick('speed',known(time,frontier),orders.latency);
  }
  const selected=[],ids=new Set(),providers=new Map();
  const take=(c,capped)=>{
    if(!c||ids.has(c.model.id)||selected.length>=limit||capped&&(providers.get(providerOf(c))??0)>=providerLimit)return;
    ids.add(c.model.id);providers.set(providerOf(c),(providers.get(providerOf(c))??0)+1);selected.push(c);
  };
  // A balanced search keeps each labelled tradeoff; explicit priorities follow their order.
  if(priority==='balanced')for(const c of roles.keys())take(c,false);
  for(const c of frontier)take(c,true);
  // The provider cap diversifies; it does not leave supported places empty.
  for(const c of frontier)take(c,false);
  selected.sort(order);
  for(const c of selected)c.pick=[...roles].filter(([x])=>x.model.id===c.model.id).flatMap(([,r])=>r);
  candidates.splice(0,candidates.length,...selected);
  return {workload:scope.workload,weights:{quality:null,cost:null,latency:null},frontier:{version:4,scope:qualityGate.status==='proxy-qualified'&&frontier.every(c=>c.frontierComplete)?'comparable':'partial',qualityModels:scope.models,qualityBenchmarks:scope.benchmarks,qualityGate,eligibleConfigurations:frontier.length,comparedConfigurations:count,completeConfigurations:frontier.filter(c=>c.frontierComplete).length,selectedModels:selected.length,priority,
    policy:'One latent quality estimate across all connected evaluations, with per-evaluation difficulty, scale and noise. Configurations not credibly worse than the strongest estimate (the larger of two points and 0.15 of the spread of model estimates on the task, plus one combined standard error that grows when a model’s evaluations disagree) enter supported Pareto selection over quality, reference cost and time. Balanced searches keep the strongest, lowest-cost and fastest frontier points, then order by estimated quality, with at most two models per provider unless places would remain empty. Unknown quality is provisional, never a pass. This does not establish a task-specific accuracy threshold.'}};
}
