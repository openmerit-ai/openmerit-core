import test from 'node:test';
import assert from 'node:assert/strict';
import { activityWindow, windowRecords, historyExtent, intervalLabel, activityTime } from '../src/history.mjs';
const now = '2026-10-09T12:00:00Z';
const records = ['2020-01-01T00:00:00Z', '2026-09-20T12:00:00Z', '2026-10-05T12:00:00Z', now, '2999-01-01T00:00:00Z', 'invalid'].map(occurredAt => ({ occurredAt }));
test('history ranges include retained old evidence and reject future/invalid timestamps', () => {
  assert.equal(windowRecords(records, 0, now).length, 4);
  assert.equal(windowRecords(records, 720, now).length, 3);
  assert.equal(windowRecords(records, 168, now).length, 2);
  assert.equal(windowRecords(records, 24, now).length, 1);
  assert.equal(historyExtent(records, now).first, '2020-01-01T00:00:00.000Z');
  const boundary = [{ occurredAt: '2026-10-08T12:00:00Z' }, { occurredAt: '2026-10-08T11:59:59.999Z' }];
  assert.equal(windowRecords(boundary, 24, now).length, 1);
});
test('a dormant project chart spans its recorded dates with a nonzero empty or single-request domain', () => {
  const old = records.slice(0, 1), range = activityWindow(old, 0, now);
  assert.equal(range.end, Date.parse(old[0].occurredAt));
  assert.equal(range.end - range.start, 60000);
  const empty = activityWindow([], 0, now);
  assert.equal(empty.end - empty.start, 3600000);
  const span = activityWindow(records, 0, now);
  assert.equal(span.start, Date.parse(records[0].occurredAt));
  assert.equal(span.end, Date.parse(now));
});
test('long charts use calendar labels and correct interval units', () => {
  assert.match(activityTime(records[0].occurredAt, 400 * 86400000), /2020/);
  assert.match(activityTime(records[0].occurredAt, 60000, true), /2020/);
  assert.equal(intervalLabel(2 * 86400000), '2-day');
  assert.equal(intervalLabel(4 * 3600000), '4-hour');
  assert.equal(intervalLabel(24 * 60000), '24-minute');
});
