// Parse syntax only. Never import, evaluate, source, or interpolate project code.
import { parser as python } from '@lezer/python';
import { parser as javascript } from '@lezer/javascript';
import { parseDocument, isMap, isSeq, isScalar, isAlias, LineCounter } from 'yaml';
import TOML from '@iarna/toml';

const identifier = /^[A-Za-z_$][\w$]*$/;
const endpointField = key => /^(?:base_?url|api_?base|endpoint(?:_?url)?|(?:[A-Z][A-Z0-9_]*_)?(?:BASE_URL|API_BASE|ENDPOINT(?:_URL)?)(?:_\d+)?|OPENMERIT_LOCAL_URL|OLLAMA_HOST)$/i.test(key);
const modelField = key => /^(?:(?:[\w]+_)?models?(?:_ids?|_names?)?|modelName|modelId|model_name_or_path|pretrained_model_name_or_path)$/i.test(key) && !/^(?:model_creator|model_provider|model_type|model_path|model_dir|model_cache|model_kwargs)$/i.test(key);
const taskField = key => /^(?:task(?:_id|_name)?|taskName|taskId)$/i.test(key);
const candidateField = key => /(?:candidate|benchmark|leaderboard|strong_model|weak_model|models$)/i.test(key);
const sensitive = key => /(?:key|token|secret|password|credential|prompt|message|content|response|header|payload|input|output)/i.test(key);
const children = node => { const out=[]; for(let c=node.firstChild;c;c=c.nextSibling) out.push(c); return out; };
const nodeText = (node, body) => node ? body.slice(node.from,node.to) : '';
const lineAt = (body, offset) => body.slice(0,offset).split('\n').length;
const literal = raw => {
  // Leave escapes, interpolated strings and multiline text unresolved. IDs and
  // endpoint literals do not need general-purpose string evaluation.
  const m=raw.match(/^(?:r|u)?(['"`])([^\r\n]*?)\1$/i);
  return m && !/[\\$\x00-\x1f]/.test(m[2]) && !/^[fFbB]/.test(raw) ? m[2] : null;
};
const fnTypes = new Set(['FunctionDefinition','FunctionDeclaration','FunctionExpression','ArrowFunction','MethodDeclaration']);
const scopeTypes = new Set([...fnTypes,'Script','Block','ClassDefinition','ClassDeclaration']);
function scope(node) { for(let p=node.parent;p;p=p.parent) if(scopeTypes.has(p.name)) return p; return node; }
function scopeChain(node) { const out=[];for(let p=node;p;p=p.parent)if(scopeTypes.has(p.name))out.push(p);return out; }
function namedFunction(node, body) {
  for(let p=node;p;p=p.parent) if(fnTypes.has(p.name)) {
    const n=children(p).find(c=>['VariableName','VariableDefinition','PropertyDefinition'].includes(c.name));
    if(n) return nodeText(n,body);
    if(p.name==='ArrowFunction' && p.parent?.name==='VariableDeclaration') return nodeText(children(p.parent).find(c=>c.name==='VariableDefinition'),body);
  }
  return null;
}
function riskyBranch(node) { for(let p=node.parent;p && p.name!=='Script';p=p.parent) if(/^(IfStatement|ForStatement|WhileStatement|TryStatement|SwitchStatement|MatchStatement)$/.test(p.name)) return true; return false; }

export function parseCode(body, file) {
  const py=/\.py$/.test(file), parser=py?python:javascript.configure({dialect:'ts jsx'});
  const tree=parser.parse(body), nodes=[], issues=[], entries=[];
  const cursor=tree.cursor();
  do { nodes.push(cursor.node); if(nodes.length>50000) return {entries:[],issues:[{code:'syntax-budget',line:1}]}; } while(cursor.next());
  if(nodes.some(n=>n.type.isError)) return {entries:[],issues:[{code:'syntax-error',line:lineAt(body,nodes.find(n=>n.type.isError).from)}]};
  const txt=n=>nodeText(n,body), assignments=new Map();
  const key=(sc,name)=>`${sc.from}:${sc.to}:${name}`;
  const bind=(sc,name,value,at,ambiguous=false)=>{
    if(!identifier.test(name))return;
    const k=key(sc,name), a=assignments.get(k)||[];a.push({node:value,at,ambiguous});assignments.set(k,a);
  };
  for(const n of nodes) {
    const cs=children(n);
    if(['VariableDeclaration','AssignStatement','AssignmentExpression'].includes(n.name)) {
      for(let i=0;i<cs.length;i++) if(['Equals','AssignOp'].includes(cs[i].name)) {
        const left=cs.slice(0,i).filter(c=>['VariableDefinition','VariableName'].includes(c.name)).at(-1);
        if(left)bind(scope(n),txt(left),cs[i+1],n.from,riskyBranch(n));
      }
    }
    // Parameters shadow enclosing declarations, even when their value is unknown.
    if(n.name==='ParamList')for(const c of cs)if(['VariableDefinition','VariableName'].includes(c.name))bind(scope(n),txt(c),null,n.from,true);
  }
  function binding(name,node) {
    for(const sc of scopeChain(node)) {
      const a=assignments.get(key(sc,name));if(!a)continue;
      return a.length===1 && !a[0].ambiguous && a[0].at<node.from ? a[0].node : null;
    }
    return null;
  }
  const unresolved = node => [{unresolved:true,line:lineAt(body,node?.from||0)}];
  function evaluate(n, seen=new Set(), depth=0) {
    if(!n || depth>8 || seen.has(n.from))return unresolved(n);
    seen=new Set([...seen,n.from]);const raw=txt(n), cs=children(n), value=literal(raw);
    if(value!==null)return [{value,basis:'literal',line:lineAt(body,n.from)}];
    if(n.name==='ArrayExpression'||n.name==='TupleExpression')return cs.filter(c=>!['[',']','(',')',','].includes(c.name)).flatMap(c=>evaluate(c,seen,depth+1)).map(v=>({...v,candidate:true}));
    if(n.name==='VariableName') {
      if(sensitive(raw))return unresolved(n);
      const b=binding(raw,n);return b?evaluate(b,seen,depth+1).map(v=>({...v,basis:v.basis==='literal'?'reference':v.basis})):unresolved(n);
    }
    if(['ParenthesizedExpression','TypeAssertion','AsExpression'].includes(n.name))return evaluate(cs.find(c=>/Expression|VariableName|String/.test(c.name)),seen,depth+1);
    const env=raw.match(/^(?:process\.env|import\.meta\.env)\.([A-Z][A-Z0-9_]*)$/)||raw.match(/^(?:process\.env|os\.environ)\[['"]([A-Z][A-Z0-9_]*)['"]\]$/);
    if(env&&sensitive(env[1]))return unresolved(n);
    if(env)return [{env:env[1],basis:'environment-reference',line:lineAt(body,n.from)}];
    if(n.name==='MemberExpression') {
      const base=cs[0], member=cs.find(c=>c.name==='PropertyName'||c.name==='String');
      const b=base?.name==='VariableName'?binding(txt(base),n):null;
      const field=member?(literal(txt(member))??txt(member)):null;
      if(field&&sensitive(field))return unresolved(n);
      const props=b?pairs(b).filter(p=>p.key===field):[];
      if(props.length===1)return evaluate(props[0].node,seen,depth+1).map(v=>({...v,basis:'reference'}));
    }
    if(n.name==='CallExpression') {
      const call=txt(cs[0]),args=children(cs.find(c=>c.name==='ArgList')||n).filter(c=>!['(',')',','].includes(c.name));
      if(['os.getenv','os.environ.get'].includes(call)) {
        const field=literal(txt(args[0]));
        if(field && !sensitive(field) && /^[A-Z][A-Z0-9_]*$/.test(field))return [{env:field,basis:'environment-reference',line:lineAt(body,n.from)},...args.slice(1,2).flatMap(a=>evaluate(a,seen,depth+1)).map(v=>({...v,basis:'fallback',env:field}))];
      }
    }
    if(n.name==='BinaryExpression' && cs.some(c=>['??','||','or'].includes(txt(c))))return cs.filter(c=>!['LogicOp','or'].includes(c.name)).flatMap((c,i)=>evaluate(c,seen,depth+1).map(v=>({...v,...(i?{basis:'fallback'}:{})})));
    if(['ConditionalExpression'].includes(n.name))return cs.filter(c=>/Expression|String|VariableName/.test(c.name)).slice(1).flatMap(c=>evaluate(c,seen,depth+1).map(v=>({...v,basis:'branch'})));
    return unresolved(n);
  }
  function pairs(n) {
    const cs=children(n), out=[];
    if(n.name==='ObjectExpression')for(const c of cs.filter(c=>c.name==='Property')){
      const ps=children(c), colon=ps.findIndex(p=>p.name===':');
      if(colon>0)out.push({key:literal(txt(ps[0]))??txt(ps[0]),node:ps[colon+1],at:ps[0].from});
      else if(ps.length===1 && ps[0].name==='VariableName')out.push({key:txt(ps[0]),node:ps[0],at:ps[0].from});
    }
    if(['DictionaryExpression','ArgList'].includes(n.name))for(let i=1;i<cs.length-1;i++)if([':', 'AssignOp'].includes(cs[i].name))out.push({key:literal(txt(cs[i-1]))??txt(cs[i-1]),node:cs[i+1],at:cs[i-1].from});
    return out;
  }
  function privateContext(node) {
    for(let p=node;p;p=p.parent) {
      if(pairs(p).some(pair=>sensitive(pair.key)&&pair.node&&pair.node.from<=node.from&&pair.node.to>=node.to))return true;
      if(['VariableDeclaration','AssignStatement'].includes(p.name)) {
        const cs=children(p), at=cs.findIndex(c=>['Equals','AssignOp'].includes(c.name));
        if(at>0&&sensitive(txt(cs.slice(0,at).find(c=>['VariableName','VariableDefinition'].includes(c.name)))))return true;
      }
    }
    return false;
  }
  function emit(field,n,at,group,extra={}) {
    if(sensitive(field)||privateContext(n))return;
    const kind=endpointField(field)?'endpoint':modelField(field)?'model':taskField(field)?'task':null;if(!kind)return;
    const values=evaluate(n);
    for(const v of values) {
      if(v.unresolved){issues.push({code:'unresolved-expression',line:lineAt(body,at),field});continue;}
      entries.push({kind,field,...v,line:lineAt(body,at),group,task:namedFunction(n,body),candidate:candidateField(field)||v.candidate||false,...extra});
    }
  }
  for(const n of nodes) {
    if(privateContext(n))continue;
    const ps=pairs(n);for(const p of ps)emit(p.key,p.node,p.at,`object:${n.from}`);
    if(['VariableDeclaration','AssignStatement'].includes(n.name)){
      const cs=children(n),i=cs.findIndex(c=>['Equals','AssignOp'].includes(c.name)),left=cs.slice(0,i).find(c=>['VariableName','VariableDefinition'].includes(c.name));
      if(i>0&&left)emit(txt(left),cs[i+1],left.from,`assignment:${n.from}`);
    }
    if(n.name!=='CallExpression' && n.name!=='NewExpression')continue;
    const cs=children(n), callee=cs.find(c=>/Expression|VariableName/.test(c.name)),call=txt(callee),args=cs.find(c=>c.name==='ArgList');if(!args)continue;
    const named=[...pairs(args),...children(args).filter(c=>c.name==='ObjectExpression').flatMap(pairs)];
    const inferenceCall=/(?:chat\.completions\.create|responses\.create|messages\.create|embeddings\.create|generateContent|generateText|streamText|litellm\.(?:completion|acompletion|embedding)|(?:^|\.)(?:SentenceTransformer|pipeline|from_pretrained))$/.test(call);
    if(!inferenceCall)continue;
    let endpoints=named.filter(p=>endpointField(p.key)).flatMap(p=>evaluate(p.node).map(v=>({...v,line:lineAt(body,p.at),field:p.key})));
    const receiver=call.split('.')[0], b=binding(receiver,n);
    if(!endpoints.length && b && /^(CallExpression|NewExpression)$/.test(b.name)) {
      const a=children(b).find(c=>c.name==='ArgList');
      if(a)endpoints=[...pairs(a),...children(a).filter(c=>c.name==='ObjectExpression').flatMap(pairs)].filter(p=>endpointField(p.key)).flatMap(p=>evaluate(p.node).map(v=>({...v,line:lineAt(body,p.at),field:p.key})));
    }
    const group=`call:${n.from}`,task=namedFunction(n,body);
    if(task)entries.push({kind:'task',field:'function',value:task,basis:'call-site',line:lineAt(body,n.from),group,task,endpoints});
    for(const p of named.filter(p=>modelField(p.key)||endpointField(p.key)||taskField(p.key)))emit(p.key,p.node,p.at,group,{task,endpoints,inferenceCall:true});
    if(/(?:SentenceTransformer|from_pretrained)$/.test(call)){
      const arg=children(args).find(c=>!['(',')',','].includes(c.name));if(arg)emit('model',arg,arg.from,group,{task,endpoints:[],localLibrary:true,inferenceCall:true});
    }
  }
  return {entries,issues};
}

export function parseConfig(body,file) {
  const entries=[],issues=[];
  const add=(field,value,line,group,extra={})=>{
    if(sensitive(field))return;
    const kind=endpointField(field)?'endpoint':modelField(field)?'model':taskField(field)?'task':null;if(!kind)return;
    if(typeof value!=='string')return;
    const env=value.match(/^\$\{([A-Z][A-Z0-9_]*)\}$/)||value.match(/^os\.environ\/([A-Z][A-Z0-9_]*)$/);
    if(env)entries.push({kind,field,env:env[1],basis:'environment-reference',line,group,...extra});
    else if(/[$`\r\n\x00-\x1f]/.test(value))issues.push({code:'unresolved-expression',line,field});
    else entries.push({kind,field,value,basis:'literal',line,group,candidate:candidateField(field),...extra});
  };
  if(/(?:^|\/)\.env(?:\.[\w.-]+)?$/.test(file)) {
    for(const [i,line]of body.split('\n').entries()){
      const m=line.match(/^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/);if(!m)continue;
      const raw=m[2].replace(/\s+#.*$/,'');const value=/^["']/.test(raw)?literal(raw):raw;
      if(value!==null) {
        if(!sensitive(m[1])&&!endpointField(m[1])&&!modelField(m[1])&&!taskField(m[1])&&value.length<=2048&&!/[$`\r\n\x00-\x1f]/.test(value))entries.push({kind:'binding',field:m[1],value,line:i+1,environmentDeclaration:true});
        else add(m[1],value,i+1,`env:${i}`,{environmentDeclaration:true});
      }
    }
    return {entries,issues};
  }
  const walk=(value,path=[],line=1,locate=()=>line)=>{
    if(!value||typeof value!=='object')return;
    if(path.length>40){issues.push({code:'syntax-budget',line});return;}
    for(const [field,v]of Object.entries(value)){
      if(sensitive(field))continue;
      const group=path.join('.'),at=locate(field,typeof v==='string'?v:null);
      if(Array.isArray(v))for(const item of v){if(typeof item==='string')add(field,item,at,group,{candidate:true});else walk(item,[...path,field,String(v.indexOf(item))],at,locate);}
      else if(typeof v==='string')add(field,v,at,group);
      else walk(v,[...path,field],at,locate);
    }
  };
  try {
    if(/\.toml$/.test(file)) {
      TOML.parse(body); // Validate the complete document before extracting fields.
      let table='root', serial=0, multiline=null;
      for(const [i,raw] of body.split('\n').entries()) {
        if(multiline){if(raw.includes(multiline))multiline=null;continue;}
        const triple=raw.match(/(['"]){3}/)?.[0];
        if(triple&&raw.indexOf(triple)===raw.lastIndexOf(triple)){multiline=triple;continue;}
        const section=raw.match(/^\s*(\[\[?.*?\]\]?)\s*(?:#.*)?$/);
        if(section){table=`${section[1]}:${++serial}`;continue;}
        const field=raw.match(/^\s*([A-Za-z0-9_-]+|"[^"\\]*"|'[^']*')\s*=\s*(.+)$/);
        if(!field)continue;
        let value;
        try {value=TOML.parse(`value = ${field[2]}`).value;}catch{
          if(endpointField(field[1])||modelField(field[1])||taskField(field[1]))issues.push({code:'unresolved-expression',line:i+1,field:field[1]});
          continue;
        }
        const key=field[1].replace(/^['"]|['"]$/g,'');
        if(sensitive(key))continue;
        if(typeof value==='string')add(key,value,i+1,table);
        else if(Array.isArray(value))for(const [j,item] of value.entries()) {
          if(typeof item==='string')add(key,item,i+1,table,{candidate:true});
          else walk(item,[table,key,String(j)],i+1);
        }
        else walk(value,[table,key],i+1);
      }
    } else {
      // JSON is a YAML subset, but strict JSON syntax is checked independently.
      if(/\.json$/.test(file))JSON.parse(body);
      const lines=new LineCounter(),doc=parseDocument(body,{lineCounter:lines,logLevel:'silent',uniqueKeys:true,customTags:[],schema:'core'});
      if(doc.errors.length)throw Error('Invalid configuration');
      const visit=(node,path=[],depth=0)=>{
        if(depth>40){issues.push({code:'syntax-budget',line:1});return;}
        if(isAlias(node)){issues.push({code:'unresolved-alias',line:lines.linePos(node.range?.[0]||0).line});return;}
        if(isSeq(node)){for(const [i,item] of node.items.entries())visit(item,[...path,String(i)],depth+1);return;}
        if(isMap(node))for(const pair of node.items){
          if(!isScalar(pair.key)||typeof pair.key.value!=='string')continue;
          const field=pair.key.value;if(sensitive(field))continue;
          const at=lines.linePos(pair.key.range?.[0]||0).line,group=path.join('.');
          if(isScalar(pair.value))add(field,pair.value.value,at,group,{alias:field==='model_name'&&node.items.some(p=>isScalar(p.key)&&p.key.value==='litellm_params')});
          else if(isSeq(pair.value))for(const [i,item]of pair.value.items.entries()){if(isScalar(item))add(field,item.value,lines.linePos(item.range?.[0]||0).line,group,{candidate:true});else visit(item,[...path,field,String(i)],depth+1);}
          else visit(pair.value,[...path,field],depth+1);
        }
      };visit(doc.contents);
    }
  }catch{issues.push({code:'syntax-error',line:1});}
  return {entries,issues};
}
