// Bounded, one-shot image extraction audit. Never imports credentials into artifacts.
// Run: node --env-file=.env.demo scout/experiments/invoice-eval.mjs manifest.json output-directory
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const fields = ['vendor_name', 'invoice_number', 'invoice_date', 'currency', 'tax', 'total'];
export const models = ['openai/gpt-5-mini', 'google/gemini-3-flash-preview', 'google/gemini-2.5-pro', 'openai/gpt-5', 'openai/gpt-4.1', 'openai/gpt-4.1-mini'];
export const prompt = `Extract these six fields from the attached invoice into one JSON object: vendor_name, invoice_number, invoice_date, currency, tax, total.
Use the seller/issuer name, not the customer or payment processor. Preserve the printed invoice identifier and its series/prefix. Convert the invoice issue date to YYYY-MM-DD. Use an ISO currency code only when the currency is explicit in the document (including a currency symbol). Monetary values must be JSON numbers, with a decimal point, and must faithfully match the document. Tax means the total VAT/sales-tax AMOUNT printed on the invoice, not a percentage, taxable base, or other charge. Do not calculate an absent tax amount. Return null for any missing or unreadable field rather than guessing. Return only the six-field JSON object, without Markdown or explanation.`;
export const schema = {
  type: 'object', additionalProperties: false, required: fields,
  properties: Object.fromEntries(fields.map(field => [field, { type: [field === 'tax' || field === 'total' ? 'number' : 'string', 'null'] }])),
};
const hash = value => createHash('sha256').update(value).digest('hex');
const vendor = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const identifier = value => value.toUpperCase().replace(/\s/g, '');
export function matches(field, actual, expected) {
  if (actual === null || expected === null) return actual === expected;
  if (typeof actual !== typeof expected) return false;
  if (field === 'tax' || field === 'total') return Number.isFinite(actual) && Math.abs(actual - expected) < 0.005;
  if (field === 'vendor_name') return vendor(actual) === vendor(expected);
  if (field === 'invoice_number') return identifier(actual) === identifier(expected);
  return actual === expected;
}
export function score(text, document) {
  let value;
  try { value = JSON.parse(text); } catch { return { validJson: false, validSchema: false, correct: 0, exactInvoice: false, fields: {} }; }
  const object = value !== null && typeof value === 'object' && !Array.isArray(value);
  const validSchema = object && Object.keys(value).length === fields.length && fields.every(field =>
    Object.hasOwn(value, field) && (value[field] === null || typeof value[field] === (field === 'tax' || field === 'total' ? 'number' : 'string')));
  const results = Object.fromEntries(fields.map(field => [field, object && Object.hasOwn(value, field) &&
    [document.truth[field], ...(document.aliases?.[field] ?? [])].some(expected => matches(field, value[field], expected))]));
  const correct = Object.values(results).filter(Boolean).length;
  return { validJson: true, validSchema, correct, exactInvoice: validSchema && correct === fields.length, fields: results, value };
}
export function summarize(records, documents) {
  return models.map(model => {
    const rows = records.filter(row => row.model === model);
    const times = rows.filter(row => row.httpStatus === 200 && row.score.validSchema).map(row => row.latencyMs).sort((a,b) => a-b);
    const costs = rows.map(row => row.usage?.cost).filter(value => typeof value === 'number');
    return { model, completed: rows.length, planned: documents.length, correctFields: rows.reduce((n,row) => n + row.score.correct, 0), totalFields: documents.length * fields.length,
      exactInvoices: rows.filter(row => row.score.exactInvoice).length, validJson: rows.filter(row => row.score.validJson).length, validSchema: rows.filter(row => row.score.validSchema).length,
      costKnownCalls: costs.length, totalCostUsd: costs.length ? costs.reduce((a,b) => a+b, 0) : null,
      meanCostUsd: costs.length === rows.length && rows.length ? costs.reduce((a,b) => a+b, 0) / rows.length : null,
      medianLatencyMs: times.length ? (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2 : null,
      latencyRangeMs: times.length ? [times[0], times.at(-1)] : null,
      providers: [...new Set(rows.map(row => row.provider).filter(Boolean))],
    };
  });
}
async function run() {
  const [manifestPath, destination] = process.argv.slice(2);
  if (!manifestPath || !destination || !process.env.OPENROUTER_API_KEY) throw new Error('Expected manifest, new output directory, and OPENROUTER_API_KEY');
  const bytes = await readFile(manifestPath);
  const manifest = JSON.parse(bytes);
  if (manifest.documents.length !== 8) throw new Error('This bounded audit expects exactly eight documents');
  await mkdir(destination); // Refuse to overwrite or accidentally repeat a previous run.
  const images = new Map();
  for (const document of manifest.documents) {
    const image = await readFile(document.path);
    if (hash(image) !== document.sha256) throw new Error(`Image checksum mismatch: ${document.id}`);
    images.set(document.id, `data:image/jpeg;base64,${image.toString('base64')}`);
  }
  const requestSettings = { response_format: { type: 'json_schema', json_schema: { name: 'invoice', strict: true, schema } }, max_tokens: 8192,
    provider: { require_parameters: true, allow_fallbacks: false } };
  await writeFile(resolve(destination, 'protocol.json'), JSON.stringify({ startedAt: new Date().toISOString(), manifestSha256: hash(bytes), models, prompt, requestSettings,
    concurrency: 2, timeoutMs: 90000, retries: 0, spendingGuardUsd: 2, perInFlightReservationUsd: 0.20, manifest }, null, 2));
  const jobs = manifest.documents.flatMap((document, i) => models.map((_, j) => ({ document, model: models[(i + j) % models.length] })));
  const records = [];
  let next = 0, totalCost = 0, reserved = 0, stop = false;
  async function worker() {
    while (next < jobs.length && !stop) {
      if (totalCost + reserved + 0.20 > 2) { stop = true; break; }
      const { document, model } = jobs[next++];
      reserved += 0.20;
      const started = performance.now();
      const record = { documentId: document.id, model, startedAt: new Date().toISOString() };
      try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, ...requestSettings, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: images.get(document.id) } }] }] }),
          signal: AbortSignal.timeout(90000),
        });
        const body = await response.json();
        Object.assign(record, { httpStatus: response.status, id: body.id, returnedModel: body.model, provider: body.provider,
          finishReason: body.choices?.[0]?.finish_reason, usage: body.usage, content: body.choices?.[0]?.message?.content ?? '', error: body.error,
          score: score(body.choices?.[0]?.message?.content ?? '', document) });
        if (typeof body.usage?.cost === 'number') totalCost += body.usage.cost;
        else if (response.ok) stop = true; // Do not continue spending if actual cost accounting is absent.
      } catch (error) {
        record.error = { name: error.name, message: error.name === 'TimeoutError' ? 'Request exceeded 90 seconds' : 'Request failed' };
        record.score = score('', document);
        stop = true; // Unknown charge; preserve failure, do not retry.
      }
      record.latencyMs = Math.round(performance.now() - started);
      records.push(record);
      reserved -= 0.20;
      await appendFile(resolve(destination, 'results.jsonl'), JSON.stringify(record) + '\n');
      console.log(JSON.stringify({ completed: records.length, model, document: document.id, status: record.httpStatus ?? record.error?.name, correct: record.score.correct, ms: record.latencyMs, cost: record.usage?.cost ?? null }));
    }
  }
  await Promise.all([worker(), worker()]);
  await writeFile(resolve(destination, 'summary.json'), JSON.stringify({ finishedAt: new Date().toISOString(), plannedCalls: jobs.length, completedCalls: records.length, totalKnownCostUsd: totalCost, stoppedEarly: stop, models: summarize(records, manifest.documents) }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await run();
