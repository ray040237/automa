import test from 'node:test';
import assert from 'node:assert';
import { truncateObservation, MAX_OBSERVATION_CHARS } from './events';

/* ---------------- truncateObservation（T-82 自 window.test.js 迁入） ---------------- */

test('观察值截断到 8K 并标记', () => {
  const long = 'x'.repeat(MAX_OBSERVATION_CHARS + 5000);
  const r = truncateObservation(long);
  assert.ok(r.truncated);
  assert.ok(r.text.startsWith('x'.repeat(100)));
  assert.ok(r.text.includes('已截断'));
  assert.ok(r.text.length < long.length);
});

test('未超限的观察值原样返回且 truncated=false', () => {
  const r = truncateObservation('short');
  assert.equal(r.text, 'short');
  assert.equal(r.truncated, false);
});
