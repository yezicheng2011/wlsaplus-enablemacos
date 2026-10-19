import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInThisContext} from 'node:vm';
import test from 'node:test';

runInThisContext(readFileSync(new URL('../Resources/school-parser.js', import.meta.url), 'utf8'));
const {words, count, datedTime} = globalThis.SchoolParserHelpers;
test('school dates use Shanghai time regardless of the computer timezone', () => {
  assert.equal(datedTime('20261019', '8:05 AM'), '2026-10-19T00:05:00.000Z');
  assert.equal(datedTime('20261019', '12:05 AM'), '2026-10-18T16:05:00.000Z');
  assert.equal(datedTime('20261019', '1:05 下午'), '2026-10-19T05:05:00.000Z');
  assert.equal(datedTime('20250229', '8:00'), null);
  assert.equal(datedTime('20240229', '24:00'), null);
  assert.equal(datedTime('20240229', '13:00 PM'), null);
});
test('school numbers preserve zero and distinguish absent scores', () => {
  assert.equal(count('0'), 0);
  assert.equal(count(''), null);
  assert.equal(count('not graded'), null);
  assert.equal(count('1,200'), 1200);
  assert.equal(words('  class\n  room  '), 'class room');
});
