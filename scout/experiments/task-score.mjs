import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import { score as invoiceScore } from './invoice-eval.mjs';

export const totalFields = c => c.kind === 'invoice' ? 6 : ['tools', 'sql'].includes(c.kind) ? 1 : Object.keys(c.truth).length;
export const failedScore = c => ({ correct: 0, total: totalFields(c), exactInvoice: false, validJson: false, schemaValid: false });
function valid(value, schema) {
  if (value === null) return [schema.type].flat().includes('null');
  if (schema.enum && !schema.enum.some(v => isDeepStrictEqual(v, value))) return false;
  const type = Array.isArray(value) ? 'array' : typeof value;
  if (![schema.type].flat().includes(type) && !(type === 'number' && Number.isInteger(value) && schema.type === 'integer')) return false;
  if (type === 'object') return (schema.required ?? []).every(k => k in value) && Object.keys(value).every(k => schema.properties[k] && valid(value[k], schema.properties[k]));
  if (type === 'array') return value.every(v => valid(v, schema.items));
  return true;
}

// Execute only a SELECT against fixture data in a fresh, in-memory SQLite DB.
// No model-generated shell/JavaScript is executed. The authorizer rejects writes,
// attachments and extension/file functions; the progress handler bounds work.
const sqlGrade = `import json,sqlite3,sys
x=json.load(sys.stdin); db=sqlite3.connect(':memory:')
for table in x['tables']:
 db.execute(table['create'])
 db.executemany(table['insert'],table['rows'])
allowed={sqlite3.SQLITE_SELECT,sqlite3.SQLITE_READ,sqlite3.SQLITE_FUNCTION,sqlite3.SQLITE_RECURSIVE}
def authorize(action,arg1,arg2,dbname,trigger):
 if action not in allowed: return sqlite3.SQLITE_DENY
 if action==sqlite3.SQLITE_FUNCTION and (arg2 or '').lower() not in {'count','sum','avg','min','max','coalesce','ifnull','nullif','round','abs','lower','upper','length','substr','strftime','date','datetime','julianday','row_number','rank','dense_rank'}: return sqlite3.SQLITE_DENY
 return sqlite3.SQLITE_OK
db.set_authorizer(authorize);db.set_progress_handler(lambda:1,100000)
try:
 result=[list(r) for r in db.execute(x['sql']).fetchmany(1000)]
 print(json.dumps({'correct':result==x['expected'],'rows':result}))
except Exception as e: print(json.dumps({'correct':False,'error':type(e).__name__}))
`;
export function grade(message, c) {
  if (c.kind === 'invoice') { const result = invoiceScore(message.content ?? '', c); return { ...result, correct: result.validSchema ? result.correct : 0, schemaValid: result.validSchema, total: 6 }; }
  if (c.kind === 'tools') {
    const calls = message.tool_calls ?? []; let args = null, validJson = true;
    try { if (calls.length) args = JSON.parse(calls[0].function.arguments); } catch { validJson = false; }
    const exact = c.expected ? calls.length === 1 && validJson && calls[0].function.name === c.expected.name && isDeepStrictEqual(args, c.expected.arguments)
      : calls.length === 0 && typeof message.content === 'string' && message.content.trim().length > 0 && (!c.clarification || /order.{0,30}(id|number)|(provide|share|which).{0,50}order/i.test(message.content));
    return { correct: Number(exact), total: 1, exactInvoice: exact, validJson, schemaValid: exact, value: { calls, text: message.content } };
  }
  let value; try { value = JSON.parse(message.content ?? ''); } catch { return failedScore(c); }
  const schemaValid = valid(value, c.schema);
  if (c.kind === 'sql') {
    let result = { correct: false };
    if (schemaValid) {
      const process = spawnSync('python3', ['-c', sqlGrade], { input: JSON.stringify({ ...c.database, sql: value.sql }), encoding: 'utf8', timeout: 2000, maxBuffer: 100000 });
      try { result = JSON.parse(process.stdout); } catch { /* failed/limited execution is a failed query */ }
    }
    return { correct: Number(result.correct), total: 1, exactInvoice: result.correct, validJson: true, schemaValid, value, result };
  }
  const correct = schemaValid ? Object.entries(c.truth).filter(([k,v]) => isDeepStrictEqual(value[k],v)).length : 0;
  return { correct, total: totalFields(c), exactInvoice: schemaValid && isDeepStrictEqual(value,c.truth), validJson: true, schemaValid, value };
}
