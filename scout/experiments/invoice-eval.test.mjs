import test from 'node:test';
import assert from 'node:assert/strict';
import { matches, score, summarize } from './invoice-eval.mjs';

const document = { truth: { vendor_name: 'BRISA, S.A.', invoice_number: 'FS 001/99', invoice_date: '2019-01-23', currency: 'EUR', tax: null, total: 1.35 } };
test('scores faithful fields while tolerating typography', () => {
  const result = score(JSON.stringify({ ...document.truth, vendor_name: 'Brisa S.A.', invoice_number: 'FS001/99' }), document);
  assert.equal(result.correct, 6);
  assert.equal(result.exactInvoice, true);
  assert.equal(matches('invoice_number', 'FS001/98', 'FS001/99'), false);
});
test('missing fields, inferred zero, wrong types and extra keys fail', () => {
  assert.equal(score('{}', document).correct, 0);
  assert.equal(score('null', document).validSchema, false);
  assert.equal(score(JSON.stringify({ ...document.truth, tax: 0 }), document).correct, 5);
  assert.equal(score(JSON.stringify({ ...document.truth, total: '1.35' }), document).validSchema, false);
  assert.equal(score(JSON.stringify({ ...document.truth, extra: 1 }), document).exactInvoice, false);
});
test('does not repair fenced JSON and accepts only declared aliases', () => {
  assert.equal(score('```json\n' + JSON.stringify(document.truth) + '\n```', document).validJson, false);
  const short = JSON.stringify({ ...document.truth, invoice_number: '001/99' });
  assert.equal(score(short, document).correct, 5);
  assert.equal(score(short, { ...document, aliases: { invoice_number: ['001/99'] } }).correct, 6);
});
test('keeps absent calls in accuracy denominator and unknown costs unknown', () => {
  const [summary] = summarize([], Array(8).fill(document));
  assert.equal(summary.totalFields, 48);
  assert.equal(summary.correctFields, 0);
  assert.equal(summary.totalCostUsd, null);
  assert.equal(summary.medianLatencyMs, null);
});
