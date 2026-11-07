// node --test tools/test_saved.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../app/js/saved.js';

const empty = () => S.parse(null);
const upc = { kind: 'upc', value: '00681131328944', label: 'Barcode 6 81131 32894 4' };

test('a saved item starts with its current notices marked seen', () => {
  const l = S.add(empty(), upc, ['fda:F-1', 'fda:F-2'], '2026-11-07T00:00:00Z');
  assert.equal(l.items.length, 1);
  assert.deepEqual(l.items[0].seen, ['fda:F-1', 'fda:F-2']);
  assert.deepEqual(l.items[0].fresh, []);
  assert.ok(S.has(l, { kind: 'upc', value: upc.value }));
});

test('a later check flags only notices that were not there when saved', () => {
  let l = S.add(empty(), upc, ['fda:F-1']);
  l = S.record(l, upc, ['fda:F-1', 'fda:F-9']);
  assert.deepEqual(l.items[0].fresh, ['fda:F-9']);
  l = S.record(l, upc, ['fda:F-1']); // a notice dropping out of the results does not clear the flag
  assert.deepEqual(l.items[0].fresh, ['fda:F-9']);
  l = S.markRead(l, upc);
  assert.deepEqual(l.items[0].fresh, []);
  assert.ok(l.items[0].seen.includes('fda:F-9'));
  l = S.record(l, upc, ['fda:F-1', 'fda:F-9']);
  assert.deepEqual(l.items[0].fresh, []);
});

test('saving again refreshes one entry instead of adding a second', () => {
  let l = S.add(empty(), upc, ['a']);
  l = S.add(l, { kind: 'name', value: 'dresser', label: '“dresser”' }, []);
  l = S.add(l, upc, ['a', 'b']);
  assert.equal(l.items.length, 2);
  assert.equal(l.items[0].value, upc.value);
  assert.deepEqual(l.items[0].seen, ['a', 'b']);
  assert.equal(S.remove(l, upc).items.length, 1);
});

test('the list is capped and survives bad or foreign storage', () => {
  let l = empty();
  for (let i = 0; i < S.MAX_ITEMS + 5; i += 1) l = S.add(l, { kind: 'name', value: `q${i}`, label: `q${i}` }, []);
  assert.equal(l.items.length, S.MAX_ITEMS);
  assert.deepEqual(S.parse('not json'), empty());
  assert.deepEqual(S.parse('{"items":[{"kind":"x","value":"1"},{"kind":"upc","value":"1"}]}').items.length, 1);
  const round = S.parse(S.serialise(l));
  assert.equal(round.items.length, S.MAX_ITEMS);
});

test('a check is due after six hours, and never for an empty list', () => {
  const t0 = Date.parse('2026-11-07T00:00:00Z');
  let l = S.add(empty(), upc, []);
  assert.ok(S.due(l, t0));
  l = S.stamp(l, '2026-11-07T00:00:00Z');
  assert.ok(!S.due(l, t0 + 5 * 3600e3));
  assert.ok(S.due(l, t0 + 6 * 3600e3));
  assert.ok(!S.due(empty(), t0));
});

test('blocked storage reads as unavailable instead of throwing', () => {
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(S.load(blocked), null);
  assert.equal(S.store(blocked, empty()), false);
});
