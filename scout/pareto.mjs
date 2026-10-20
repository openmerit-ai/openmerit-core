import {referenceWork,workloadFor,taskWeights,compareQuality} from './comparison.mjs';
import {stable} from './utils.mjs';

const lowerBound=(values,x)=>{let lo=0,hi=values.length;while(lo<hi){const mid=(lo+hi)>>>1;if(values[mid]<x)lo=mid+1;else hi=mid;}return lo;};
function commonScopeQuality(candidates,weights) {
  const first=candidates[0];if(!first)return true;
  const zero={...first,evidence:first.evidence.map(e=>({...e,score:0}))};
  const values=new Map();
  for(const c of candidates){const direct=c.taskObservation??c.measured;const value=direct?(direct.effectiveQuality??direct.quality):compareQuality(c,zero,weights)?.difference;if(value===undefined||values.has(c.model.id)&&values.get(c.model.id)!==value)return false;values.set(c.model.id,value);c.scopeQuality=value;}
  const sorted=[...values.values()].sort((a,b)=>a-b),prefix=[0];for(const x of sorted)prefix.push(prefix.at(-1)+x);
  for(const c of candidates){const x=c.scopeQuality,lo=lowerBound(sorted,x-.2),hi=lowerBound(sorted,x+.2),n=sorted.length;
    const signal=lo*.5+(x*(hi-lo)-(prefix[hi]-prefix[lo]))/.4-(n-hi)*.5;
    c.quality=n>1?.5+signal/(n-1):null;c.comparedModels=n-1;c.comparisonCoverage=n>1?1:0;
    c.frontierComplete=c.quality!==null&&c.reference.cost!==null&&c.reference.seconds!==null;
  }
  return true;
}

// Three-objective skyline, independently within each comparable quality scope.
// Equal triples are retained together. Missing objectives cannot dominate.
function supportedFrontier(candidates) {
  const groups=new Map(),retained=candidates.filter(c=>!c.frontierComplete);
  for(const c of candidates.filter(c=>c.frontierComplete)){const g=groups.get(c.qualityScope)??[];g.push(c);groups.set(c.qualityScope,g);}
  for(const group of groups.values()){
    group.sort((a,b)=>b.scopeQuality-a.scopeQuality||a.reference.cost-b.reference.cost||a.reference.seconds-b.reference.seconds);
    const costs=[...new Set(group.map(c=>c.reference.cost))].sort((a,b)=>a-b),tree=Array(costs.length+1).fill(Infinity);
    const query=i=>{let value=Infinity;for(i++;i>0;i-=i&-i)value=Math.min(value,tree[i]);return value;};
    const insert=(i,value)=>{for(i++;i<tree.length;i+=i&-i)tree[i]=Math.min(tree[i],value);};
    for(let i=0;i<group.length;){let j=i+1;const c=group[i];while(j<group.length&&group[j].scopeQuality===c.scopeQuality&&group[j].reference.cost===c.reference.cost&&group[j].reference.seconds===c.reference.seconds)j++;
      const position=lowerBound(costs,c.reference.cost);if(query(position)>c.reference.seconds)retained.push(...group.slice(i,j));insert(position,c.reference.seconds);i=j;
    }
  }
  return retained;
}

// Quality is comparable only within a common evaluation scope. Incomplete
// objectives remain provisional; missing measurements never become zeros.
export function prepareObjectives(candidates,task) {
  const workload=workloadFor(task),weights=taskWeights(task),groups=new Map();
  for(const c of candidates) {
    const direct=c.taskObservation??c.measured;
    // Calibration quality can support a matching operation. Its episode bill
    // and duration are a different workload from the common token reference;
    // they cannot replace that reference for just some points on the frontier.
    c.reference=c.measured?{cost:c.measured.meanCostUsd,seconds:c.measured.medianSeconds}:referenceWork(c.model,workload);
    c.qualityScope=direct?`measured:${direct.profile?.id??direct.profileId??task.calibrationProfile??''}`:stable(c.evidence.map(e=>[e.benchmark,e.metric??'',e.definition?.interpretation?.sourceHash??'']).sort((a,b)=>stable(a).localeCompare(stable(b))));
    const group=groups.get(c.qualityScope)??[];group.push(c);groups.set(c.qualityScope,group);
    c.comparedModels=0;c.comparisonCoverage=0;
  }
  if(groups.size===1&&commonScopeQuality(candidates,weights))return {workload,groups:groups.size};
  const identities=new Set(candidates.map(c=>c.model.id)),totalWeight=Object.values(weights).reduce((a,b)=>a+b,0);
  const peers=new Map();for(const c of candidates)for(const e of c.evidence){const rows=peers.get(e.benchmark)??[];rows.push(c);peers.set(e.benchmark,rows);}
  for(const c of candidates) {
    let signal=0,scopeSignal=0,comparisons=0,coverage=0;const seen=new Set([c.model.id]);
    // A route must not get extra quality votes because another model has many
    // hosts. Unknown overlap contributes no advantage to the common cohort.
    const neighbors=new Set(c.evidence.flatMap(e=>peers.get(e.benchmark)??[]));
    if(c.taskObservation||c.measured)for(const other of groups.get(c.qualityScope))neighbors.add(other);
    for(const other of neighbors)if(!seen.has(other.model.id)) {
      const a=c.taskObservation??c.measured,b=other.taskObservation??other.measured;
      const comparison=a&&b&&c.qualityScope===other.qualityScope?{difference:(a.effectiveQuality??a.quality)-(b.effectiveQuality??b.quality),comparedWeight:totalWeight}:compareQuality(c,other,weights);
      if(!comparison)continue;seen.add(other.model.id);
      signal+=Math.max(-.5,Math.min(.5,comparison.difference/.4));
      if(c.qualityScope===other.qualityScope)scopeSignal+=comparison.difference;
      coverage+=comparison.comparedWeight/totalWeight;comparisons++;
    }
    c.quality=comparisons?.5+signal/Math.max(1,identities.size-1):null;
    c.scopeQuality=scopeSignal;
    c.comparedModels=comparisons;c.comparisonCoverage=coverage/Math.max(1,identities.size-1);
    c.frontierComplete=c.quality!==null&&c.reference.cost!==null&&c.reference.seconds!==null;
  }
  return {workload,groups:groups.size};
}
export function dominates(a,b) {
  if(a.qualityScope!==b.qualityScope||!a.frontierComplete||!b.frontierComplete)return false;
  return a.scopeQuality>=b.scopeQuality&&a.reference.cost<=b.reference.cost&&a.reference.seconds<=b.reference.seconds&&
    (a.scopeQuality>b.scopeQuality||a.reference.cost<b.reference.cost||a.reference.seconds<b.reference.seconds);
}
export function selectPareto(candidates,task,{limit=5}={}) {
  const count=candidates.length;
  const scope=prepareObjectives(candidates,task);
  const frontier=supportedFrontier(candidates);
  const priority=task.workload?.priority??'balanced';
  // Preferences order eligible frontier points; they never change eligibility.
  const q=c=>c.quality??-1,cost=c=>c.reference.cost??Infinity,time=c=>c.reference.seconds??Infinity;
  const preference=c=>c.preference??0;
  const compare=(a,b)=>preference(b)-preference(a)||(priority==='cost'?cost(a)-cost(b):priority==='latency'?time(a)-time(b):0)||q(b)-q(a)||cost(a)-cost(b)||time(a)-time(b)||a.model.id.localeCompare(b.model.id)||a.model.endpoint.id.localeCompare(b.model.endpoint.id);
  frontier.sort(compare);
  const selected=[],ids=new Set();
  const take=c=>{if(c&&!ids.has(c.model.id)&&selected.length<limit){ids.add(c.model.id);selected.push(c);}};
  for(const c of frontier)take(c);
  selected.sort(compare);
  candidates.splice(0,candidates.length,...selected);
  return {workload:scope.workload,weights:{quality:null,cost:null,latency:null},frontier:{version:2,scope:scope.groups===1&&frontier.every(c=>c.frontierComplete)?'comparable':'partial',qualityGroups:scope.groups,eligibleConfigurations:frontier.length,comparedConfigurations:count,completeConfigurations:frontier.filter(c=>c.frontierComplete).length,selectedModels:selected.length,policy:'Explicit priorities and preferences, then supported quality and known cost/time, among non-dominated configurations. No reserved cost or speed slots.'}};
}
